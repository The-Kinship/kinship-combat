'use strict';
// Pick a fight: one member challenges another. If it is accepted, both take turns pressing attack or heal until one is at 0 HP.
// No automation: every action is a button press. The loser gets a "Lost a fight" status, the winner "Won a fight", for 10 minutes.
import { randomInt } from 'node:crypto';
import { fail } from './engine.mjs';
import { who, rand } from './items.mjs';
import { findMember } from './lookup.mjs';
import { applyStatus, rollBonuses } from './status-core.mjs';

const HP = 30, HEALS = 3, ATK_DIE = 8, HEAL_DIE = 6, STATUS_MINUTES = 10;
const PENDING_MS = 120000, TURN_MS = 180000, KEEP_MS = 600000;
const ICON = 'game:10205';
const die = (sides, bonus) => { const raw = 1 + randomInt(sides); return { raw, total: Math.max(1, raw + bonus) }; };
const mod = boosts => boosts.filter(b => b.v).map(b => `, ${b.v > 0 ? '+' : ''}${b.v} ${b.label}`).join('');

async function nameOf(db, id) { return (await db.prepare('SELECT name FROM members WHERE id = ?').bind(id).first())?.name || '(removed)'; }

async function finish(db, d, winnerId, why) {
  const loserId = winnerId === d.a_id ? d.b_id : d.a_id, now = new Date().toISOString();
  await db.prepare("UPDATE duels SET status = 'done', winner = ?, turn = '', updated_at = ? WHERE id = ?").bind(winnerId, now, d.id).run();
  for (const [id, won] of [[winnerId, true], [loserId, false]]) {
    try {   // a full status list should never stop a fight from ending
      await applyStatus(db, id, won
        ? { name: 'Won a fight', description: 'You came out on top in a fight.', icon: ICON, minutes: STATUS_MINUTES, isDebuff: false, sourceId: 'dm' }
        : { name: 'Lost a fight', description: 'You lost a fight.', icon: ICON, minutes: STATUS_MINUTES, isDebuff: true, sourceId: 'dm' });
    } catch (e) { /* skip */ }
  }
  void why;
}

/** Cleans up old duels and ends duels where nobody answered. Cheap when there is nothing to do. */
async function tidy(db) {
  const now = Date.now();
  await db.prepare("UPDATE duels SET status = 'expired', updated_at = ? WHERE status = 'pending' AND created_at < ?").bind(new Date(now).toISOString(), new Date(now - PENDING_MS).toISOString()).run();
  const stale = (await db.prepare("SELECT * FROM duels WHERE status = 'active' AND updated_at < ?").bind(new Date(now - TURN_MS).toISOString()).all()).results;
  for (const d of stale) {   // whoever's turn it was walked away, so the other one wins
    const log = JSON.parse(d.log); log.push('The fight was abandoned.');
    await db.prepare('UPDATE duels SET log = ? WHERE id = ?').bind(JSON.stringify(log.slice(-10)), d.id).run();
    await finish(db, d, d.turn === d.a_id ? d.b_id : d.a_id, 'abandoned');
  }
  await db.prepare('DELETE FROM duels WHERE updated_at < ?').bind(new Date(now - KEEP_MS).toISOString()).run();
}

async function view(db, d, me) {
  const mineA = d.a_id === me.id, foeId = mineA ? d.b_id : d.a_id;
  const youWon = d.winner === me.id;
  return {
    id: d.id, status: d.status, challenger: mineA, foe: await nameOf(db, foeId), you: await nameOf(db, me.id),
    youHp: mineA ? d.a_hp : d.b_hp, foeHp: mineA ? d.b_hp : d.a_hp, max: HP, healsLeft: mineA ? d.a_heals : d.b_heals,
    yourTurn: d.status === 'active' && d.turn === me.id, log: JSON.parse(d.log), youWon: d.status === 'done' ? youWon : null, createdAt: d.created_at,
  };
}

export async function handleDuels(request, db, path, { json, input, rate }) {
  const post = request.method === 'POST';
  const me = await who(db, request);
  await tidy(db);

  const current = () => db.prepare("SELECT * FROM duels WHERE (a_id = ? OR b_id = ?) ORDER BY updated_at DESC, created_at DESC LIMIT 1").bind(me.id, me.id).first();

  if (!post && path === '/duels/mine') {
    const d = await current();
    return json({ duel: d ? await view(db, d, me) : null });
  }
  if (!post) fail('Endpoint not found.', 404);

  if (path === '/duels') {   // challenge someone
    await rate(db, 'duel-new:' + me.id, 10);
    const d = await input(request), foe = await findMember(db, d.target);
    if (!foe) fail('That person is not in the RP system, so you can not pick a fight with them.', 404);
    if (foe.id === me.id) fail('You can not fight yourself.');
    const busy = id => db.prepare("SELECT 1 AS x FROM duels WHERE (a_id = ? OR b_id = ?) AND status IN ('pending', 'active')").bind(id, id).first();
    if (await busy(me.id)) fail('You already have a fight going. Finish it first.', 409);
    if (await busy(foe.id)) fail(`${foe.name} is busy with another fight.`, 409);
    const id = rand(6), now = new Date().toISOString();
    await db.prepare("INSERT INTO duels (id, a_id, b_id, status, a_hp, b_hp, a_heals, b_heals, turn, log, winner, created_at, updated_at) VALUES (?,?,?,'pending',?,?,?,?,'','[]','',?,?)").bind(id, me.id, foe.id, HP, HP, HEALS, HEALS, now, now).run();
    return json({ duel: await view(db, await db.prepare('SELECT * FROM duels WHERE id = ?').bind(id).first(), me) }, 201);
  }

  const m = path.match(/^\/duels\/([a-f0-9]{12})\/(accept|refuse|cancel|act|forfeit)$/);
  if (!m) fail('Endpoint not found.', 404);
  const [, id, route] = m;
  await rate(db, 'duel-act:' + me.id, 120);
  const d = await db.prepare('SELECT * FROM duels WHERE id = ? AND (a_id = ? OR b_id = ?)').bind(id, me.id, me.id).first();
  if (!d) fail('That fight is over.', 404);
  const now = new Date().toISOString(), log = JSON.parse(d.log);

  if (route === 'accept' || route === 'refuse') {
    if (d.status !== 'pending' || d.b_id !== me.id) fail('There is nothing to answer.', 409);
    if (route === 'refuse') { await db.prepare("UPDATE duels SET status = 'refused', updated_at = ? WHERE id = ?").bind(now, id).run(); }
    else {
      const first = randomInt(2) === 0 ? d.a_id : d.b_id;
      log.push(`${await nameOf(db, first)} moves first.`);
      await db.prepare("UPDATE duels SET status = 'active', turn = ?, log = ?, updated_at = ? WHERE id = ?").bind(first, JSON.stringify(log), now, id).run();
    }
  } else if (route === 'cancel') {
    if (d.status !== 'pending' || d.a_id !== me.id) fail('There is nothing to cancel.', 409);
    await db.prepare("UPDATE duels SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(now, id).run();
  } else if (route === 'forfeit') {
    if (d.status !== 'active') fail('That fight is not going.', 409);
    log.push(`${await nameOf(db, me.id)} gives up.`);
    await db.prepare('UPDATE duels SET log = ? WHERE id = ?').bind(JSON.stringify(log.slice(-10)), id).run();
    await finish(db, d, d.a_id === me.id ? d.b_id : d.a_id, 'forfeit');
  } else {   // act
    if (d.status !== 'active') fail('That fight is not going.', 409);
    if (d.turn !== me.id) fail('It is not your turn.', 409);
    const kind = (await input(request)).kind;
    if (kind !== 'attack' && kind !== 'heal') fail('Choose attack or heal.');
    const mineA = d.a_id === me.id, foeId = mineA ? d.b_id : d.a_id, myName = await nameOf(db, me.id), foeName = await nameOf(db, foeId);
    const boosts = await rollBonuses(db, me.id);
    let aHp = d.a_hp, bHp = d.b_hp, aHeals = d.a_heals, bHeals = d.b_heals;
    if (kind === 'attack') {
      const v = boosts.map(b => ({ label: b.label, v: b.atk })), r = die(ATK_DIE, v.reduce((n, b) => n + b.v, 0));
      if (mineA) bHp = Math.max(0, bHp - r.total); else aHp = Math.max(0, aHp - r.total);
      log.push(`${myName} hits ${foeName} for ${r.total} (d${ATK_DIE}: ${r.raw}${mod(v)}).`);
    } else {
      if ((mineA ? aHeals : bHeals) <= 0) fail('You have no heals left in this fight.', 409);
      const v = boosts.map(b => ({ label: b.label, v: b.heal })), r = die(HEAL_DIE, v.reduce((n, b) => n + b.v, 0));
      const was = mineA ? aHp : bHp, healed = Math.min(HP, was + r.total), gained = healed - was;
      if (mineA) { aHp = healed; aHeals--; } else { bHp = healed; bHeals--; }
      log.push(`${myName} heals ${gained} (d${HEAL_DIE}: ${r.raw}${mod(v)}).`);
    }
    const next = foeId;
    await db.prepare('UPDATE duels SET a_hp = ?, b_hp = ?, a_heals = ?, b_heals = ?, turn = ?, log = ?, updated_at = ? WHERE id = ?').bind(aHp, bHp, aHeals, bHeals, next, JSON.stringify(log.slice(-10)), now, id).run();
    const after = { ...d, a_hp: aHp, b_hp: bHp };
    if (aHp <= 0 || bHp <= 0) {
      log.push(`${aHp <= 0 ? await nameOf(db, d.a_id) : await nameOf(db, d.b_id)} goes down.`);
      await db.prepare('UPDATE duels SET log = ? WHERE id = ?').bind(JSON.stringify(log.slice(-10)), id).run();
      await finish(db, after, aHp <= 0 ? d.b_id : d.a_id, 'ko');
    }
  }
  return json({ duel: await view(db, await db.prepare('SELECT * FROM duels WHERE id = ?').bind(id).first(), me) });
}

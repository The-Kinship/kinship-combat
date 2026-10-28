'use strict';
// Quests: an Advocate writes a quest as ordered steps; players talk to targeted NPCs and the server moves them along.
// Step types: talk (the NPC speaks), give (hand over an Advocate-made item, which is used up), receive (the NPC gives an item).
import { fail } from './engine.mjs';
import { roomOf } from './nearby.mjs';
import { randomInt } from 'node:crypto';
import { who, rand, str, nameKey, itemFields, inventory, ownerSlots, CAP, STACK } from './items.mjs';
import { applyStatus, bonus, rollBonuses, checkRoom, findActive, removeByName } from './status-core.mjs';

const ICON = /^(game:\d{1,7}|site:[A-Za-z0-9._-]{1,60})$/;
function grant(g, at) {
  if (!g || typeof g !== 'object') fail(`${at} status is not valid.`);
  const icon = str(g.icon, `${at} status icon`, 80);
  if (!ICON.test(icon)) fail('Choose an icon for the status.');
  const minutes = g.minutes === undefined || g.minutes === null ? 0 : g.minutes;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 43200) fail('A status can last from 1 minute to 30 days. Use 0 to last until removed.');
  return { name: str(g.name, `${at} status name`, 30), description: str(g.description, `${at} status description`, 200, false), icon, minutes, isDebuff: g.isDebuff === true, atk: bonus(g.atk, 'Attack bonus'), heal: bonus(g.heal, 'Heal bonus') };
}

const MAX_QUESTS = 60, MAX_STEPS = 12, MAX_ACTIVE = 15;
const TYPES = ['talk', 'give', 'receive', 'look', 'listen', 'search', 'arrive', 'fight'];   // arrive: the plugin reports it when you walk into the spot's radius
const whole = (v, name, lo, hi, dflt) => { if (v === undefined || v === null) return dflt; if (!Number.isInteger(v) || v < lo || v > hi) fail(`${name} must be a whole number from ${lo} to ${hi}.`); return v; };
function fightSpec(f) {
  f = f && typeof f === 'object' ? f : {};
  return { npcHp: whole(f.npcHp, 'Enemy HP', 1, 999, 30), npcDie: whole(f.npcDie, 'Enemy die', 2, 100, 8), npcBonus: whole(f.npcBonus, 'Enemy bonus', -50, 50, 0),
    playerHp: whole(f.playerHp, 'Player HP', 1, 999, 30), playerDie: whole(f.playerDie, 'Player die', 2, 100, 8), playerBonus: whole(f.playerBonus, 'Player bonus', -50, 50, 0) };
}
const SPOT = ['look', 'listen', 'search', 'arrive'];
// A step can say something different to some people: by the gender on the faction roster (the plugin sends it) or by a status they have.
// Each variant needs a gender, a status, or both (both must match). The first one that matches wins; otherwise the normal text is used.
const MAX_VARIANTS = 6;
const genderOf = v => String(v ?? '').trim().toLowerCase().slice(0, 30);
function variants(list, at) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_VARIANTS) fail(`${at} can have up to ${MAX_VARIANTS} different versions of its text.`);
  return list.map((v, i) => {
    if (!v || typeof v !== 'object') fail(`${at} version ${i + 1} is not valid.`);
    const gender = genderOf(v.gender), status = str(v.status, `${at} version ${i + 1} status`, 30, false);
    if (!gender && !status) fail(`${at} version ${i + 1} needs a gender or a status to match.`);
    return { gender, status, text: str(v.text, `${at} version ${i + 1} text`, 600) };
  });
}
async function pickText(db, me, st) {
  for (const v of st.variants || []) {
    if (v.gender && v.gender !== me.gender) continue;
    if (v.status && !(await findActive(db, me.id, v.status))) continue;
    return v.text;
  }
  return st.text;
}
const needMsg = st => `${st.needText || 'You are not ready for this yet.'}\n\nRequires status: ${st.needs}`;
const num = (v, name, lim) => { if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > lim) fail(`${name} is not valid.`); return Math.round(v * 100) / 100; };
function place(d, needRadius = false) {
  if (!d || typeof d !== 'object') fail('A step that happens at a spot needs a location. Stand there and use "Use this location".');
  if (!Number.isInteger(d.territory) || d.territory < 0 || d.territory > 65535) fail('That zone is not valid.');
  if (!Number.isInteger(d.map) || d.map < 0 || d.map > 1000000) fail('That map is not valid.');
  let radius = 0;
  if (needRadius || d.radius !== undefined) { if (!Number.isInteger(d.radius) || d.radius < 1 || d.radius > 100) fail('The radius is how many yalms around the spot it works, from 1 to 100.'); radius = d.radius; }
  return { radius, room: roomOf(d.room), zone: str(d.zone, 'Zone', 80, false), territory: d.territory, map: d.map, x: num(d.x, 'Position', 20000), y: num(d.y, 'Position', 20000), z: num(d.z, 'Position', 20000), mapX: num(d.mapX, 'Map position', 500), mapY: num(d.mapY, 'Map position', 500) };
}

function steps(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_STEPS) fail(`A quest needs 1 to ${MAX_STEPS} steps.`);
  return list.map((s, i) => {
    const at = `Step ${i + 1}`;
    if (!s || typeof s !== 'object' || !TYPES.includes(s.type)) fail(`${at} needs a type.`);
    const spot = SPOT.includes(s.type), fight = s.type === 'fight';
    const out = { type: s.type, npc: spot ? '' : str(s.npc, `${at} character name`, 40), text: str(s.text, `${at} text`, 600), hint: str(s.hint, `${at} hint`, 150, false) };
    const alt = variants(s.variants, at);
    if (alt.length) out.variants = alt;
    if (spot || (fight && s.place)) out.place = place(s.place, s.type === 'arrive');
    if (fight) out.fight = fightSpec(s.fight);
    const needs = str(s.needs, `${at} required status`, 30, false);
    if (needs) { out.needs = needs; out.needText = str(s.needText, `${at} message when missing`, 200, false); out.takesNeeded = s.takesNeeded === true; }
    if (s.grants) out.grants = grant(s.grants, at);
    if (s.type === 'give') out.item = str(s.item, `${at} item to hand over`, 40);
    if (s.type === 'receive' && (!s.gift || typeof s.gift !== 'object')) fail(`${at} needs an item to give.`);
    if ((s.type === 'receive' || s.type === 'search' || fight) && s.gift && typeof s.gift === 'object') {
      out.gift = itemFields(s.gift);
      out.once = s.once === true;
    }
    return out;
  });
}
// Area notices: text that pops up whenever someone on the quest walks into a spot, whatever step they are on. It never moves the quest along.
const MAX_NOTICES = 8;
function notices(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_NOTICES) fail(`A quest can have up to ${MAX_NOTICES} area notices.`);
  return list.map((n, i) => {
    if (!n || typeof n !== 'object') fail(`Area notice ${i + 1} is not valid.`);
    return { place: place(n.place, true), text: str(n.text, `Area notice ${i + 1} text`, 600), repeat: n.repeat === true };
  });
}
const SELECT_P = 'SELECT p.quest_id, p.step, p.done, q.title, q.intro, q.steps, q.notices FROM quest_progress p JOIN quests q ON q.id = p.quest_id WHERE p.member_id = ? ORDER BY p.updated_at';
function mineView(r) {
  const list = JSON.parse(r.steps), cur = r.done ? null : list[r.step];
  return { questId: r.quest_id, title: r.title, intro: r.intro, step: r.step, total: list.length, done: r.done === 1, failed: r.done === 2,
    notices: r.done ? [] : JSON.parse(r.notices || '[]').map((n, index) => ({ index, place: n.place, repeat: n.repeat })),   // where, never what they say
    current: cur ? { type: cur.type, npc: cur.npc, item: cur.item || '', hint: cur.hint, place: cur.place || null } : null };
}
const rollDie = (sides, bonus) => { const raw = 1 + randomInt(sides); return { raw, total: Math.max(1, raw + bonus) }; };
const bonusText = b => (b ? ` ${b > 0 ? '+' : '-'}${Math.abs(b)}` : '');
function fightView(q, st, me, f, status, extra = {}) {
  const spec = st.fight;
  return { questId: q.quest_id, npc: st.npc, playerName: me.name, playerHp: f.player_hp, playerMax: spec.playerHp, npcHp: f.npc_hp, npcMax: spec.npcHp, log: JSON.parse(f.log), status, ...extra };
}
async function insertGift(db, ownerId, f) {
  const id = rand(8);
  const r = await db.prepare("INSERT INTO items (id, owner_id, creator_id, name, icon, description, flavor, use_label, use_text, requires, requires_consume, st_name, st_desc, st_icon, st_debuff, st_minutes, st_type, st_cure, cures, recipe, consumable, created_at) SELECT ?,?,'dm',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM items WHERE owner_id = ?) < ?")
    .bind(id, ownerId, f.name, f.icon, f.description, f.flavor, f.useLabel, f.useText, f.requires, f.requiresConsume, f.stName, f.stDesc, f.stIcon, f.stDebuff, f.stMinutes, f.stType, f.stCure, f.cures, '', f.consumable, new Date().toISOString(), ownerId, CAP * STACK).run();
  if (r.meta.changes !== 1) return false;
  if ((await ownerSlots(db, ownerId)) > CAP) { await db.prepare('DELETE FROM items WHERE id = ?').bind(id).run(); return false; }
  return true;
}

// Moves one player past one step: checks what the step needs, hands over or takes items, and keeps first-come finds to one winner.
async function runStep(db, me, r, list, st) {
  const stop = text => ({ quest: r.title, ok: false, text, finished: false, gained: [] });
  const said = await pickText(db, me, st);   // chosen before this step changes anything about the player
  const now = new Date().toISOString(), last = r.step + 1 >= list.length;
  const claim = () => db.prepare('UPDATE quest_progress SET step = step + 1, done = ?, updated_at = ? WHERE member_id = ? AND quest_id = ? AND step = ?').bind(last ? 1 : 0, now, me.id, r.quest_id, r.step).run();
  const revert = () => db.prepare('UPDATE quest_progress SET step = ?, done = 0 WHERE member_id = ? AND quest_id = ?').bind(r.step, me.id, r.quest_id).run();
  let held = null, gained = [];
  if (st.needs && !(await findActive(db, me.id, st.needs))) return stop(needMsg(st));
  if (st.grants) { try { await checkRoom(db, me.id, st.grants.name); } catch (e) { if (e.status) return stop(e.message); throw e; } }
  if (st.type === 'give') {
    held = await db.prepare("SELECT id FROM items WHERE owner_id = ? AND creator_id = 'dm' AND lower(name) = ? LIMIT 1").bind(me.id, st.item.toLowerCase()).first();
    if (!held) return stop(`${st.npc} is waiting for something. You don't have it.`);
  }
  let won = false;
  if (st.once && st.gift) {
    const w = await db.prepare('INSERT INTO quest_claims (quest_id, step, member_id, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING').bind(r.quest_id, r.step, me.id, now).run();
    if (w.meta.changes !== 1) {
      await db.prepare('UPDATE quest_progress SET done = 2, updated_at = ? WHERE member_id = ? AND quest_id = ? AND step = ? AND done = 0').bind(now, me.id, r.quest_id, r.step).run();
      return { quest: r.title, ok: false, failed: true, text: 'Someone else got here first, and there is nothing left to find. This quest has failed.', finished: false, gained: [] };
    }
    won = true;
  }
  const undo = async () => { await revert(); if (won) await db.prepare('DELETE FROM quest_claims WHERE quest_id = ? AND step = ? AND member_id = ?').bind(r.quest_id, r.step, me.id).run(); };
  if ((await claim()).meta.changes !== 1) { if (won) await db.prepare('DELETE FROM quest_claims WHERE quest_id = ? AND step = ? AND member_id = ?').bind(r.quest_id, r.step, me.id).run(); return null; }
  if (held) {
    const gone = await db.prepare('DELETE FROM items WHERE id = ? AND owner_id = ?').bind(held.id, me.id).run();
    if (gone.meta.changes !== 1) { await undo(); return stop('That item is no longer with you.'); }
  }
  if (st.gift) {
    if (!(await insertGift(db, me.id, st.gift))) { await undo(); return stop('Your inventory is full. Make room, then try again.'); }
    gained = [st.gift.name];
  }
  if (st.needs && st.takesNeeded) await removeByName(db, me.id, st.needs);
  let statusGained = '';
  if (st.grants) { await applyStatus(db, me.id, { ...st.grants, sourceId: 'dm' }); statusGained = st.grants.name; }
  return { quest: r.title, ok: true, text: said, finished: last, gained, statusGained };
}

export async function handleQuests(request, db, path, { json, input, rate, ip, checkCreate }) {
  const post = request.method === 'POST';

  if (post && path.startsWith('/quests/admin/')) {
    await rate(db, 'quest-admin:' + ip, 60);
    const d = await input(request), level = checkCreate(d.adminPassword);
    if (path === '/quests/admin/list') {
      const { results } = await db.prepare('SELECT * FROM quests ORDER BY created_at, rowid').all();
      const prog = (await db.prepare('SELECT p.quest_id, p.step, p.done, m.name FROM quest_progress p JOIN members m ON m.id = p.member_id ORDER BY m.name_key').all()).results;
      const claims = (await db.prepare('SELECT c.quest_id, c.step, m.name FROM quest_claims c LEFT JOIN members m ON m.id = c.member_id').all()).results;
      return json({ quests: results.map(q => ({ id: q.id, title: q.title, intro: q.intro, steps: JSON.parse(q.steps), startPlace: q.start_place ? JSON.parse(q.start_place) : null, startText: q.start_text, notices: JSON.parse(q.notices || '[]'),
        players: prog.filter(p => p.quest_id === q.id).map(p => ({ name: p.name, step: p.step, done: p.done === 1, failed: p.done === 2 })),
        claims: claims.filter(c => c.quest_id === q.id).map(c => ({ step: c.step, name: c.name || '(removed)' })) })) });
    }
    if (path === '/quests/admin/save') {
      const title = str(d.title, 'Quest title', 60), intro = str(d.intro, 'Quest introduction', 400, false), list = steps(d.steps), areas = JSON.stringify(notices(d.notices));
      if (level === 'scene') for (const s of list) if (s.grants) { s.grants.atk = 0; s.grants.heal = 0; }   // roll bonuses on a status are for Advocates (creation password) only
      const startPlace = d.startPlace ? JSON.stringify(place(d.startPlace)) : '', startText = d.startPlace ? str(d.startText, 'Text at the starting spot', 600) : '';
      if (d.questId) {
        const id = str(d.questId, 'Quest', 20);
        const r = await db.prepare('UPDATE quests SET title=?, intro=?, steps=?, start_place=?, start_text=?, notices=? WHERE id=?').bind(title, intro, JSON.stringify(list), startPlace, startText, areas, id).run();
        if (r.meta.changes !== 1) fail('That quest no longer exists.', 404);
        // A shorter quest finishes anyone who was past the new end.
        await db.prepare('UPDATE quest_progress SET done = 1 WHERE quest_id = ? AND done = 0 AND step >= ?').bind(id, list.length).run();
        return json({ saved: true, id });
      }
      if ((await db.prepare('SELECT count(*) AS total FROM quests').first()).total >= MAX_QUESTS) fail('There are too many quests. Delete one first.', 409);
      const id = rand(6);
      await db.prepare('INSERT INTO quests (id, title, intro, steps, start_place, start_text, notices, created_at) VALUES (?,?,?,?,?,?,?,?)').bind(id, title, intro, JSON.stringify(list), startPlace, startText, areas, new Date().toISOString()).run();
      return json({ saved: true, id }, 201);
    }
    if (path === '/quests/admin/delete') {
      const id = str(d.questId, 'Quest', 20);
      await db.prepare('DELETE FROM quest_progress WHERE quest_id = ?').bind(id).run();
      await db.prepare('DELETE FROM quest_fights WHERE quest_id = ?').bind(id).run();
      await db.prepare('DELETE FROM quest_claims WHERE quest_id = ?').bind(id).run();
      const r = await db.prepare('DELETE FROM quests WHERE id = ?').bind(id).run();
      if (r.meta.changes !== 1) fail('That quest no longer exists.', 404);
      return json({ deleted: true });
    }
    if (path === '/quests/admin/reset-claims') {
      await db.prepare('DELETE FROM quest_claims WHERE quest_id = ?').bind(str(d.questId, 'Quest', 20)).run();
      return json({ reset: true });
    }
    if (path === '/quests/admin/assign' || path === '/quests/admin/unassign') {
      const to = await db.prepare('SELECT id, name FROM members WHERE name_key = ?').bind(nameKey(str(d.to, 'Member', 40))).first();
      if (!to) fail('No member has that name.', 404);
      const id = str(d.questId, 'Quest', 20);
      if (!(await db.prepare('SELECT id FROM quests WHERE id = ?').bind(id).first())) fail('That quest no longer exists.', 404);
      if (path === '/quests/admin/unassign') { await db.prepare('DELETE FROM quest_progress WHERE member_id = ? AND quest_id = ?').bind(to.id, id).run(); await db.prepare('DELETE FROM quest_fights WHERE member_id = ? AND quest_id = ?').bind(to.id, id).run(); return json({ unassigned: true, to: to.name }); }
      const have = await db.prepare('SELECT done FROM quest_progress WHERE member_id = ? AND quest_id = ?').bind(to.id, id).first();
      if (!have && (await db.prepare('SELECT count(*) AS total FROM quest_progress WHERE member_id = ? AND done = 0').bind(to.id).first()).total >= MAX_ACTIVE) fail(`${to.name} already has ${MAX_ACTIVE} quests going.`, 409);
      await db.prepare('INSERT INTO quest_progress (member_id, quest_id, step, done, updated_at) VALUES (?,?,0,0,?) ON CONFLICT(member_id, quest_id) DO UPDATE SET step = 0, done = 0, updated_at = excluded.updated_at').bind(to.id, id, new Date().toISOString()).run();
      await db.prepare('DELETE FROM quest_fights WHERE member_id = ? AND quest_id = ?').bind(to.id, id).run();
      return json({ assigned: true, to: to.name }, 201);
    }
    fail('Endpoint not found.', 404);
  }

  const me = await who(db, request);

  if (!post && path === '/quests/mine') {
    const { results } = await db.prepare(SELECT_P).bind(me.id).all();
    return json({ quests: results.map(mineView) });
  }

  if (post && (path === '/quests/fight/start' || path === '/quests/fight/attack')) {
    await rate(db, 'quest-fight:' + me.id, 90);
    const d = await input(request), starting = path === '/quests/fight/start';
    me.gender = genderOf(d.gender);
    const { results } = await db.prepare(SELECT_P.replace('ORDER BY', 'AND p.done = 0 ORDER BY')).bind(me.id).all();
    let row = null, list = null, st = null;
    for (const r of results) {
      const l = JSON.parse(r.steps), cur = l[r.step];
      if (!cur || cur.type !== 'fight') continue;
      const hit = starting
        ? (cur.place ? (Number.isInteger(d.territory) && cur.place.territory === d.territory) : nameKey(cur.npc) === nameKey(String(d.npc ?? '')))
        : r.quest_id === String(d.questId ?? '');
      if (hit) { row = r; list = l; st = cur; break; }
    }
    if (!row) {
      if (!starting) await db.prepare('DELETE FROM quest_fights WHERE member_id = ? AND quest_id = ?').bind(me.id, String(d.questId ?? '')).run();
      return json({ fight: null });
    }
    if (st.needs && !(await findActive(db, me.id, st.needs))) return json({ fight: null, text: needMsg(st) });
    const now = new Date().toISOString(), spec = st.fight;
    let f = await db.prepare('SELECT * FROM quest_fights WHERE member_id = ? AND quest_id = ?').bind(me.id, row.quest_id).first();
    if (f && f.step !== row.step) { await db.prepare('DELETE FROM quest_fights WHERE member_id = ? AND quest_id = ?').bind(me.id, row.quest_id).run(); f = null; }
    if (starting) {
      if (!f) {
        await db.prepare('INSERT INTO quest_fights (member_id, quest_id, step, player_hp, npc_hp, log, updated_at) VALUES (?,?,?,?,?,?,?)').bind(me.id, row.quest_id, row.step, spec.playerHp, spec.npcHp, JSON.stringify([`${st.npc} squares up to you.`]), now).run();
        f = await db.prepare('SELECT * FROM quest_fights WHERE member_id = ? AND quest_id = ?').bind(me.id, row.quest_id).first();
      }
      return json({ fight: fightView(row, st, me, f, f.npc_hp <= 0 ? 'blocked' : 'active') });
    }
    if (!f) return json({ fight: null });
    const log = JSON.parse(f.log);
    const finish = async () => {
      const line = await runStep(db, me, row, list, st);
      if (line && line.ok) {
        await db.prepare('DELETE FROM quest_fights WHERE member_id = ? AND quest_id = ?').bind(me.id, row.quest_id).run();
        return json({ fight: fightView(row, st, me, { ...f, log: JSON.stringify(log.slice(-8)) }, 'won', { result: line }), items: await inventory(db, me.id) });
      }
      if (line && line.failed) {
        await db.prepare('DELETE FROM quest_fights WHERE member_id = ? AND quest_id = ?').bind(me.id, row.quest_id).run();
        return json({ fight: fightView(row, st, me, { ...f, log: JSON.stringify(log.slice(-8)) }, 'failed', { result: line }) });
      }
      await db.prepare('UPDATE quest_fights SET log = ?, updated_at = ? WHERE member_id = ? AND quest_id = ?').bind(JSON.stringify(log.slice(-8)), now, me.id, row.quest_id).run();
      return json({ fight: fightView(row, st, me, { ...f, log: JSON.stringify(log.slice(-8)) }, 'blocked', { result: line }) });
    };
    if (f.npc_hp <= 0) return await finish();       // the fight was won but the reward was held up, so try again
    const boosts = await rollBonuses(db, me.id), boost = boosts.reduce((n, b) => n + b.atk, 0);
    const mine = rollDie(spec.playerDie, spec.playerBonus + boost);
    f.npc_hp = Math.max(0, f.npc_hp - mine.total);
    log.push(`You strike ${st.npc} for ${mine.total} (d${spec.playerDie}: ${mine.raw}${bonusText(spec.playerBonus)}${boosts.filter(b => b.atk).map(b => `, ${b.atk > 0 ? '+' : ''}${b.atk} ${b.label}`).join('')}).`);
    if (f.npc_hp <= 0) { log.push(`${st.npc} goes down.`); return await finish(); }
    const theirs = rollDie(spec.npcDie, spec.npcBonus);
    f.player_hp = Math.max(0, f.player_hp - theirs.total);
    log.push(`${st.npc} hits you for ${theirs.total} (d${spec.npcDie}: ${theirs.raw}${bonusText(spec.npcBonus)}).`);
    if (f.player_hp <= 0) {
      log.push('You fall.');
      await db.prepare('DELETE FROM quest_fights WHERE member_id = ? AND quest_id = ?').bind(me.id, row.quest_id).run();
      return json({ fight: fightView(row, st, me, { ...f, log: JSON.stringify(log.slice(-8)) }, 'lost') });
    }
    await db.prepare('UPDATE quest_fights SET player_hp = ?, npc_hp = ?, log = ?, updated_at = ? WHERE member_id = ? AND quest_id = ?').bind(f.player_hp, f.npc_hp, JSON.stringify(log.slice(-8)), now, me.id, row.quest_id).run();
    return json({ fight: fightView(row, st, me, { ...f, log: JSON.stringify(log.slice(-8)) }, 'active') });
  }

  // A failed quest (someone else took a once-only find) can be deleted. Finished and active quests cannot, so rewards can't be repeated.
  if (post && path === '/quests/abandon') {
    await rate(db, 'quest-abandon:' + me.id, 30);
    const id = str((await input(request)).questId, 'Quest', 20);
    const r = await db.prepare('DELETE FROM quest_progress WHERE member_id = ? AND quest_id = ? AND done = 2').bind(me.id, id).run();
    if (r.meta.changes !== 1) fail('Only a failed quest can be deleted.', 409);
    await db.prepare('DELETE FROM quest_fights WHERE member_id = ? AND quest_id = ?').bind(me.id, id).run();
    return json({ deleted: true });
  }

  // Spots where a quest can be picked up. Only the place goes out, never the quest's name or what it says.
  if (!post && path === '/quests/starts') {
    const { results } = await db.prepare("SELECT q.id, q.start_place FROM quests q WHERE q.start_place != '' AND NOT EXISTS (SELECT 1 FROM quest_progress p WHERE p.quest_id = q.id AND p.member_id = ?)").bind(me.id).all();
    return json({ starts: results.map(r => ({ questId: r.id, place: JSON.parse(r.start_place) })) });
  }
  if (post && path === '/quests/offer') {
    await rate(db, 'quest-offer:' + me.id, 60);
    const d = await input(request);
    const q = await db.prepare("SELECT id, title, intro, start_text FROM quests WHERE id = ? AND start_place != ''").bind(str(d.questId, 'Quest', 20)).first();
    if (!q || await db.prepare('SELECT 1 AS x FROM quest_progress WHERE member_id = ? AND quest_id = ?').bind(me.id, q.id).first()) return json({ offer: null });
    return json({ offer: { questId: q.id, title: q.title, intro: q.intro, text: q.start_text } });
  }
  if (post && path === '/quests/accept') {
    await rate(db, 'quest-accept:' + me.id, 30);
    const d = await input(request), questId = str(d.questId, 'Quest', 20);
    const q = await db.prepare('SELECT id, start_place FROM quests WHERE id = ?').bind(questId).first();
    if (!q) fail('That quest is no longer available.', 404);
    let item = null;
    if (d.itemId) {
      item = await db.prepare("SELECT id, consumable FROM items WHERE id = ? AND owner_id = ? AND creator_id = 'dm' AND starts_quest = ?").bind(str(d.itemId, 'Item', 20), me.id, questId).first();
      if (!item) fail('That item no longer offers this quest.', 409);
    } else if (!q.start_place) fail('That quest cannot be started that way.', 403);
    if (await db.prepare('SELECT 1 AS x FROM quest_progress WHERE member_id = ? AND quest_id = ?').bind(me.id, questId).first()) fail('You have already taken this up.', 409);
    if ((await db.prepare('SELECT count(*) AS total FROM quest_progress WHERE member_id = ? AND done = 0').bind(me.id).first()).total >= MAX_ACTIVE) fail(`You already have ${MAX_ACTIVE} quests going.`, 409);
    const r = await db.prepare('INSERT INTO quest_progress (member_id, quest_id, step, done, updated_at) VALUES (?,?,0,0,?) ON CONFLICT DO NOTHING').bind(me.id, questId, new Date().toISOString()).run();
    if (r.meta.changes !== 1) fail('You have already taken this up.', 409);
    if (item && item.consumable) await db.prepare('DELETE FROM items WHERE id = ? AND owner_id = ?').bind(item.id, me.id).run();
    return json({ accepted: true, items: await inventory(db, me.id) }, 201);
  }
  // The plugin reports walking into an area notice; the server checks the quest is in progress and the zone matches, then sends the words.
  if (post && path === '/quests/notice') {
    await rate(db, 'quest-notice:' + me.id, 120);
    const d = await input(request), questId = str(d.questId, 'Quest', 20);
    if (!Number.isInteger(d.index) || !Number.isInteger(d.territory)) fail('That notice is not valid.');
    const r = await db.prepare('SELECT q.notices FROM quest_progress p JOIN quests q ON q.id = p.quest_id WHERE p.member_id = ? AND p.quest_id = ? AND p.done = 0').bind(me.id, questId).first();
    const n = r ? JSON.parse(r.notices || '[]')[d.index] : null;
    if (!n || n.place.territory !== d.territory) return json({ text: '' });
    return json({ text: n.text });
  }
  if (post && (path === '/quests/talk' || path === '/quests/act')) {
    await rate(db, 'quest-talk:' + me.id, 60);
    const d = await input(request), talking = path === '/quests/talk';
    me.gender = genderOf(d.gender);
    let npc = '', kind = '', territory = -1;
    if (talking) npc = nameKey(str(d.npc, 'Character', 60));
    else {
      kind = d.type;
      if (!SPOT.includes(kind)) fail('Choose look, listen or search.');
      if (!Number.isInteger(d.territory)) fail('Your location is not known.');
      territory = d.territory;
    }
    const { results } = await db.prepare(SELECT_P.replace('ORDER BY', 'AND p.done = 0 ORDER BY')).bind(me.id).all();
    const out = [];
    for (const r of results) {
      const list = JSON.parse(r.steps), st = list[r.step];
      if (!st) continue;
      if (talking ? (SPOT.includes(st.type) || st.type === 'fight' || nameKey(st.npc) !== npc) : (st.type !== kind || st.place.territory !== territory)) continue;
      const line = await runStep(db, me, r, list, st);
      if (line) out.push(line);
    }
    return json({ results: out, items: await inventory(db, me.id) });
  }
  fail('Endpoint not found.', 404);
}

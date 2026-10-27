'use strict';
// The Kinship bank: every member has a purse of gold. Only someone with the bank password can create or remove gold.
// Members can pay each other. Gold is only RP: real gil changes hands in the game with a banker.
import { fail } from './engine.mjs';
import { who, str, nameKey } from './items.mjs';

export const MAX_AMOUNT = 1000000, MAX_BALANCE = 1000000000;
const LOG_CAP = 5000;
export const amountOf = v => { if (!Number.isInteger(v) || v < 1 || v > MAX_AMOUNT) fail(`The amount must be a whole number from 1 to ${MAX_AMOUNT.toLocaleString('en-US')}.`); return v; };
export async function note(db, memberId, delta, text) {
  await db.prepare('INSERT INTO gold_log (member_id, delta, note, created_at) VALUES (?,?,?,?)').bind(memberId, delta, text, new Date().toISOString()).run();
  await db.prepare('DELETE FROM gold_log WHERE id <= (SELECT max(id) - ? FROM gold_log)').bind(LOG_CAP).run();
}
async function history(db, id) {
  const { results } = await db.prepare('SELECT delta, note, created_at FROM gold_log WHERE member_id = ? ORDER BY id DESC LIMIT 15').bind(id).all();
  return results.map(r => ({ delta: r.delta, note: r.note, at: r.created_at }));
}
export const balance = async (db, id) => (await db.prepare('SELECT gold FROM members WHERE id = ?').bind(id).first())?.gold ?? 0;

/** Takes gold out of a member's purse. False if they do not have it. */
export async function spend(db, memberId, amount, text) {
  const r = await db.prepare('UPDATE members SET gold = gold - ? WHERE id = ? AND gold >= ?').bind(amount, memberId, amount).run();
  if (r.meta.changes !== 1) return false;
  await note(db, memberId, -amount, text);
  return true;
}
/** Adds gold to a member's purse, or returns false when it would go over the cap. Pass force to give it back no matter what. */
export async function earn(db, memberId, amount, text, force = false) {
  const r = force
    ? await db.prepare('UPDATE members SET gold = gold + ? WHERE id = ?').bind(amount, memberId).run()
    : await db.prepare('UPDATE members SET gold = gold + ? WHERE id = ? AND gold + ? <= ?').bind(amount, memberId, amount, MAX_BALANCE).run();
  if (r.meta.changes !== 1) return false;
  await note(db, memberId, amount, text);
  return true;
}

export async function handleBank(request, db, path, { json, input, rate, ip, checkBank }) {
  const post = request.method === 'POST';

  if (post && path.startsWith('/bank/admin/')) {
    await rate(db, 'bank-admin:' + ip, 30);
    const d = await input(request); checkBank(d.bankPassword);
    if (path === '/bank/admin/list') {
      const balances = (await db.prepare('SELECT name, gold FROM members ORDER BY name_key').all()).results.map(r => ({ name: r.name, gold: r.gold }));
      const total = (await db.prepare('SELECT COALESCE(SUM(gold), 0) AS total FROM members').first()).total;
      const recent = (await db.prepare('SELECT l.delta, l.note, l.created_at, m.name FROM gold_log l LEFT JOIN members m ON m.id = l.member_id ORDER BY l.id DESC LIMIT 30').all()).results
        .map(r => ({ name: r.name || '(removed)', delta: r.delta, note: r.note, at: r.created_at }));
      return json({ balances, total, recent });
    }
    if (path === '/bank/admin/mint' || path === '/bank/admin/take') {
      const mint = path.endsWith('mint'), amount = amountOf(d.amount), why = str(d.note, 'Note', 60, false);
      const to = await db.prepare('SELECT id, name, gold FROM members WHERE name_key = ?').bind(nameKey(str(d.to, 'Member', 40))).first();
      if (!to) fail('No member has that name.', 404);
      let r;
      if (mint) r = await db.prepare('UPDATE members SET gold = gold + ? WHERE id = ? AND gold + ? <= ?').bind(amount, to.id, amount, MAX_BALANCE).run();
      else r = await db.prepare('UPDATE members SET gold = gold - ? WHERE id = ? AND gold >= ?').bind(amount, to.id, amount).run();
      if (r.meta.changes !== 1) fail(mint ? `${to.name} cannot hold that much gold.` : `${to.name} only has ${to.gold} gold.`, 409);
      await note(db, to.id, mint ? amount : -amount, why || (mint ? 'From the Kinship bank' : 'Taken by the Kinship bank'));
      return json({ to: to.name, gold: await balance(db, to.id) }, mint ? 201 : 200);
    }
    fail('Endpoint not found.', 404);
  }

  const me = await who(db, request);
  if (!post && path === '/bank/me') return json({ gold: await balance(db, me.id), history: await history(db, me.id) });
  if (post && path === '/bank/pay') {
    await rate(db, 'bank-pay:' + me.id, 20);
    const d = await input(request), amount = amountOf(d.amount);
    const to = await db.prepare('SELECT id, name FROM members WHERE name_key = ?').bind(nameKey(str(d.to, 'Recipient', 40))).first();
    if (!to) fail('No member has that name.', 404);
    if (to.id === me.id) fail('That gold is already yours.');
    if ((await balance(db, to.id)) + amount > MAX_BALANCE) fail(`${to.name} cannot hold that much gold.`, 409);
    const debit = await db.prepare('UPDATE members SET gold = gold - ? WHERE id = ? AND gold >= ?').bind(amount, me.id, amount).run();
    if (debit.meta.changes !== 1) fail(`You only have ${await balance(db, me.id)} gold.`, 409);
    await db.prepare('UPDATE members SET gold = gold + ? WHERE id = ?').bind(amount, to.id).run();
    await note(db, me.id, -amount, 'Paid ' + to.name);
    await note(db, to.id, amount, 'From ' + me.name);
    return json({ gold: await balance(db, me.id), history: await history(db, me.id) });
  }
  fail('Endpoint not found.', 404);
}

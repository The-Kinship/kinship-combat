'use strict';
// Mail: a member writes to another member, optionally with gold and up to 3 item stacks. Gold and items leave the sender
// when the mail is sent and wait inside the mail until the recipient collects them. Unopened mail can be recalled.
// Mail lives 30 days. When it runs out, anything attached goes back to the sender once, then is gone if it runs out again.
import { fail } from './engine.mjs';
import { who, rand, str, nameKey, stackViews, ownerRows, fits, unitRow, groupIds, stacks, CAP, STACK } from './items.mjs';
import { amountOf, spend, earn } from './bank.mjs';

export const INBOX = 30, SLOTS = 3, DAYS = 30;
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();

const fromName = (r, meId, admin) => admin ? (r.from_name || '(removed)')
  : r.returned ? 'Returned mail' : r.anonymous && r.from_id !== meId ? 'Anonymous' : (r.from_name || '(removed)');
async function attached(db, id) { return ownerRows(db, 'm' + id); }
const SELECT = 'SELECT m.*, f.name AS from_name, t.name AS to_name FROM mails m LEFT JOIN members f ON f.id = m.from_id LEFT JOIN members t ON t.id = m.to_id';

async function brief(db, r, me) {
  const slots = stacks(await attached(db, r.id)).length;
  return { id: r.id, from: fromName(r, me.id), to: r.to_name || '(removed)', subject: r.subject, anonymous: !!r.anonymous, gold: r.gold, slots, unread: r.to_id === me.id && !r.read_at, returned: !!r.returned, sentAt: r.sent_at, expiresAt: r.expires_at };
}

/** Anything attached goes back to the sender: gold to their purse (no cap) and items deleted if they cannot hold them is avoided by the caller checking fits first. */
async function bounce(db, r, why) {
  if (r.gold > 0) await earn(db, r.from_id, r.gold, why, true);
  await db.prepare("UPDATE items SET owner_id = ? WHERE owner_id = ?").bind(r.from_id, 'm' + r.id).run();
  await db.prepare('DELETE FROM mails WHERE id = ?').bind(r.id).run();
}

/** Takes care of mail that has run out. Cheap when there is none. */
export async function sweep(db) {
  const now = iso(Date.now());
  const { results } = await db.prepare('SELECT * FROM mails WHERE expires_at < ? LIMIT 20').bind(now).all();
  for (const r of results) {
    const items = await attached(db, r.id);
    const sender = await db.prepare('SELECT id FROM members WHERE id = ?').bind(r.from_id).first();
    if (r.gold === 0 && items.length === 0) { await db.prepare('DELETE FROM mails WHERE id = ?').bind(r.id).run(); continue; }
    if (!r.returned && sender) {   // first expiry: it goes back to the sender as returned mail, with 30 more days
      await db.prepare("UPDATE mails SET to_id = from_id, returned = 1, read_at = NULL, subject = ?, sent_at = ?, expires_at = ? WHERE id = ?")
        .bind(('Returned: ' + r.subject).slice(0, 70), now, iso(Date.now() + DAY * DAYS), r.id).run();
    } else {   // second expiry, or no sender left: gold back to the purse, items gone
      if (r.gold > 0 && sender) await earn(db, r.from_id, r.gold, 'Mail expired', true);
      await db.prepare("DELETE FROM items WHERE owner_id = ?").bind('m' + r.id).run();
      await db.prepare('DELETE FROM mails WHERE id = ?').bind(r.id).run();
    }
  }
}

export async function handleMail(request, db, path, { json, input, rate, ip, checkCreate }) {
  const post = request.method === 'POST';
  await sweep(db);

  if (post && (path === '/mail/admin/list' || path === '/mail/admin/delete')) {
    await rate(db, 'mail-admin:' + ip, 30);
    const d = await input(request); checkCreate(d.adminPassword);
    if (path === '/mail/admin/list') {
      const { results } = await db.prepare(SELECT + ' ORDER BY m.sent_at DESC LIMIT 300').all();
      return json({ mails: results.map(r => ({ id: r.id, from: r.from_name || '(removed)', to: r.to_name || '(removed)', subject: r.subject, anonymous: !!r.anonymous, gold: r.gold, returned: !!r.returned, sentAt: r.sent_at })) });
    }
    const r = await db.prepare('SELECT * FROM mails WHERE id = ?').bind(str(d.mailId, 'Mail', 20)).first();
    if (!r) fail('That mail no longer exists.', 404);
    if (r.gold > 0) await earn(db, r.from_id, r.gold, 'Mail removed by an Advocate', true);
    await db.prepare('DELETE FROM items WHERE owner_id = ?').bind('m' + r.id).run();
    await db.prepare('DELETE FROM mails WHERE id = ?').bind(r.id).run();
    return json({ deleted: true });
  }

  const me = await who(db, request);

  if (!post && path === '/mail/count') {
    const row = await db.prepare('SELECT count(*) AS total, sum(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread FROM mails WHERE to_id = ?').bind(me.id).first();
    return json({ total: row.total || 0, unread: row.unread || 0, capacity: INBOX });
  }
  if (!post && path === '/mail') {
    const inbox = (await db.prepare(SELECT + ' WHERE m.to_id = ? ORDER BY m.sent_at DESC LIMIT 60').bind(me.id).all()).results;
    const sent = (await db.prepare(SELECT + ' WHERE m.from_id = ? AND m.to_id != m.from_id AND m.read_at IS NULL AND m.returned = 0 ORDER BY m.sent_at DESC LIMIT 30').bind(me.id).all()).results;
    return json({ inbox: await Promise.all(inbox.map(r => brief(db, r, me))), outbox: await Promise.all(sent.map(r => brief(db, r, me))), capacity: INBOX });
  }

  if (post && path === '/mail') {
    await rate(db, 'mail-send:' + me.id, 20);
    const d = await input(request);
    const toName = str(d.to, 'Who it is for', 40), subject = str(d.subject, 'Subject', 60), body = str(d.body, 'Message', 1500, false);
    const to = await db.prepare('SELECT id, name FROM members WHERE name_key = ?').bind(nameKey(toName)).first();
    if (!to) fail('No member has that name.', 404);
    if (to.id === me.id) fail('You cannot send mail to yourself.');
    if ((await db.prepare('SELECT count(*) AS n FROM mails WHERE to_id = ?').bind(to.id).first()).n >= INBOX) fail(`${to.name}'s mailbox is full.`, 409);
    const gold = d.gold === undefined || d.gold === null || d.gold === 0 ? 0 : amountOf(d.gold);
    const wanted = d.items === undefined || d.items === null ? [] : d.items;
    if (!Array.isArray(wanted) || wanted.length > SLOTS) fail(`A mail can carry up to ${SLOTS} items.`);
    // work out exactly which units go in before anything moves
    const taken = [], used = new Set();
    for (const w of wanted) {
      const itemId = str(w?.itemId, 'Item', 20), count = w.count === undefined ? 1 : w.count;
      if (!Number.isInteger(count) || count < 1 || count > STACK) fail(`Send from 1 to ${STACK} of an item.`);
      if (!(await unitRow(db, itemId, me.id))) fail('One of those items is not in your inventory.', 404);
      const group = (await groupIds(db, me.id, itemId)).filter(x => !used.has(x));
      if (count > group.length) fail(`You only have ${group.length} of one of those.`, 409);
      const units = [itemId, ...group.filter(x => x !== itemId)].slice(0, count);
      units.forEach(u => used.add(u)); taken.push(...units);
    }
    const rows = (await ownerRows(db, me.id)).filter(r => taken.includes(r.id));
    if (!(await fits(db, 'mail-check', SLOTS, { add: rows }))) fail(`A mail can carry up to ${SLOTS} different items.`, 409);
    const id = rand(6), now = Date.now();
    if (gold > 0 && !(await spend(db, me.id, gold, `Mail to ${to.name}`))) fail('You do not have that much gold.', 409);
    await db.prepare('INSERT INTO mails (id, from_id, to_id, subject, body, anonymous, gold, returned, sent_at, expires_at) VALUES (?,?,?,?,?,?,?,0,?,?)')
      .bind(id, me.id, to.id, subject, body, d.anonymous === true ? 1 : 0, gold, iso(now), iso(now + DAY * DAYS)).run();
    for (const u of taken) {
      const r = await db.prepare('UPDATE items SET owner_id = ? WHERE id = ? AND owner_id = ?').bind('m' + id, u, me.id).run();
      if (r.meta.changes !== 1) { await bounce(db, { id, from_id: me.id, gold }, 'Mail could not be sent'); fail('Something changed while sending. Nothing was sent.', 409); }
    }
    return json({ sent: true, to: to.name, id }, 201);
  }

  const m = path.match(/^\/mail\/([a-f0-9]{12})(?:\/(collect|delete|recall))?$/);
  if (!m) fail('Endpoint not found.', 404);
  const [, id, route] = m;
  const r = await db.prepare(SELECT + ' WHERE m.id = ?').bind(id).first();
  if (!r || (r.to_id !== me.id && r.from_id !== me.id)) fail('That mail does not exist.', 404);
  const mineToRead = r.to_id === me.id;

  if (!post && !route) {
    if (!mineToRead) fail('That mail is not addressed to you.', 403);
    if (!r.read_at) { await db.prepare('UPDATE mails SET read_at = ? WHERE id = ?').bind(iso(Date.now()), id).run(); r.read_at = 'now'; }
    return json({ mail: { ...(await brief(db, r, me)), body: r.body, items: stackViews(await attached(db, id), me.id) } });
  }
  if (!post) fail('Endpoint not found.', 404);

  if (route === 'collect') {
    if (!mineToRead) fail('That mail is not addressed to you.', 403);
    await rate(db, 'mail-collect:' + me.id, 30);
    const rows = await attached(db, id);
    if (r.gold === 0 && rows.length === 0) fail('There is nothing attached.', 409);
    if (!(await fits(db, me.id, CAP, { add: rows }))) fail(`Your inventory is full (${CAP} slots). Make room first.`, 409);
    if (r.gold > 0) {
      const grab = await db.prepare('UPDATE mails SET gold = 0 WHERE id = ? AND gold = ?').bind(id, r.gold).run();
      if (grab.meta.changes !== 1) fail('Already collected.', 409);
      if (!(await earn(db, me.id, r.gold, r.returned ? `Returned mail: ${r.subject}` : `Mail: ${r.subject}`))) {
        await db.prepare('UPDATE mails SET gold = gold + ? WHERE id = ?').bind(r.gold, id).run();
        fail('You cannot carry that much gold.', 409);
      }
    }
    for (const x of rows) await db.prepare('UPDATE items SET owner_id = ? WHERE id = ? AND owner_id = ?').bind(me.id, x.id, 'm' + id).run();
    await db.prepare('UPDATE mails SET read_at = COALESCE(read_at, ?) WHERE id = ?').bind(iso(Date.now()), id).run();
    return json({ collected: true, got: r.gold, items: stackViews(await ownerRows(db, me.id), me.id) });
  }
  if (route === 'delete') {
    if (!mineToRead) fail('That mail is not addressed to you.', 403);
    if (r.gold > 0 || (await attached(db, id)).length > 0) fail('Collect what is attached first.', 409);
    await db.prepare('DELETE FROM mails WHERE id = ?').bind(id).run();
    return json({ deleted: true });
  }
  if (route === 'recall') {
    if (r.from_id !== me.id || r.returned) fail('Only the sender can take back a mail.', 403);
    if (r.read_at) fail('It has already been opened.', 409);
    const rows = await attached(db, id);
    if (!(await fits(db, me.id, CAP, { add: rows }))) fail(`Your inventory is full (${CAP} slots). Make room first.`, 409);
    await bounce(db, r, `Mail taken back: ${r.subject}`);
    return json({ recalled: true, items: stackViews(await ownerRows(db, me.id), me.id) });
  }
  fail('Endpoint not found.', 404);
}

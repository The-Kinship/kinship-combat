'use strict';
// The Embershade Lounge: opening hours, a menu with prices, staff clock in and out with pay, and a receipt book of what was sold.
// Everyone registered can see the menu and hours and use the tools while clocked in. Managers (SMs or the Lounge Manager tag) run the rest.
import { fail } from './engine.mjs';
import { who, rand, str, nameKey, itemFields, isStaff } from './items.mjs';
import { earn, MAX_AMOUNT } from './bank.mjs';
import { insertGift } from './quests.mjs';

export const MAX_MENU = 60, MAX_SHIFT_MIN = 720, KEEP_DAYS = 90, MAX_QTY = 20;
const iso = ms => new Date(ms).toISOString();
const whole = (v, name, lo, hi, dflt) => { if (v === undefined || v === null) return dflt; if (!Number.isInteger(v) || v < lo || v > hi) fail(`${name} must be a whole number from ${lo.toLocaleString('en-US')} to ${hi.toLocaleString('en-US')}.`); return v; };
const isManager = me => isStaff(me.tags) || String(me.tags || '').split(',').map(t => t.trim()).includes('Lounge Manager');
const kv = async (db, k, dflt = '') => (await db.prepare('SELECT v FROM lounge_kv WHERE k = ?').bind(k).first())?.v ?? dflt;
const setKv = (db, k, v) => db.prepare('INSERT INTO lounge_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v).run();
const shiftGold = s => Math.floor(s.minutes * s.rate / 60);


// Everything sold since the night began: per item with who sold how many (everyone who worked or sold appears on every item, zeros included),
// per person totals, and hours worked. Used by the live receipt book and saved when a night is closed.
async function tonight(db, nightStart) {
  const sold = (await db.prepare('SELECT s.name, s.price, m.name AS who, sum(s.qty) AS count FROM lounge_sales s JOIN members m ON m.id = s.member_id WHERE s.at >= ? GROUP BY s.name, s.price, m.name').bind(nightStart).all()).results;
  const shifts = (await db.prepare('SELECT m.name, s.minutes, s.end_at FROM lounge_shifts s JOIN members m ON m.id = s.member_id WHERE s.start_at >= ? OR s.end_at IS NULL').bind(nightStart).all()).results;
  const people = [...new Set([...shifts.map(r => r.name), ...sold.map(r => r.who)])].sort((x, y) => x.localeCompare(y));
  const items = (await db.prepare('SELECT name, price, sum(qty) AS count FROM lounge_sales WHERE at >= ? GROUP BY name, price ORDER BY name').bind(nightStart).all()).results.map(r => ({
    name: r.name, price: r.price, count: r.count, total: r.count * r.price,
    by: people.map(who => ({ name: who, count: sold.find(x => x.name === r.name && x.price === r.price && x.who === who)?.count ?? 0 })),
  }));
  return {
    items, count: items.reduce((n, i) => n + i.count, 0), total: items.reduce((n, i) => n + i.total, 0),
    people: people.map(name => ({ name, count: sold.filter(x => x.who === name).reduce((n, x) => n + x.count, 0), total: sold.filter(x => x.who === name).reduce((n, x) => n + x.count * x.price, 0), minutes: shifts.filter(x => x.name === name).reduce((n, x) => n + x.minutes, 0) })),
  };
}

async function view(db, me, msg = '', extra = {}) {
  const manager = isManager(me), nightStart = await kv(db, 'night_start', '1970-01-01T00:00:00.000Z');
  const menu = (await db.prepare('SELECT * FROM lounge_menu ORDER BY rowid').all()).results.map(m => ({ id: m.id, name: m.name, price: m.price, description: m.description, gift: m.gift ? JSON.parse(m.gift) : null }));
  const working = (await db.prepare('SELECT s.start_at, m.name FROM lounge_shifts s JOIN members m ON m.id = s.member_id WHERE s.end_at IS NULL ORDER BY s.start_at LIMIT 100').all()).results.map(r => ({ name: r.name, since: r.start_at }));
  const open = await db.prepare('SELECT start_at FROM lounge_shifts WHERE member_id = ? AND end_at IS NULL').bind(me.id).first();
  const unpaid = (await db.prepare('SELECT minutes, rate FROM lounge_shifts WHERE member_id = ? AND paid = 0 AND end_at IS NOT NULL').bind(me.id).all()).results;
  const mine = await db.prepare('SELECT coalesce(sum(qty), 0) AS count, coalesce(sum(qty * price), 0) AS total FROM lounge_sales WHERE member_id = ? AND at >= ?').bind(me.id, nightStart).first();
  const out = {
    ...extra, msg, canManage: manager, pf: { text: await kv(db, 'pf_text'), minutes: Number(await kv(db, 'pf_minutes', '55')), postedAt: await kv(db, 'pf_posted_at'), postedBy: await kv(db, 'pf_posted_by') }, hours: await kv(db, 'hours'), rate: Number(await kv(db, 'rate', '0')), nightStart, menu, working,
    me: { since: open ? open.start_at : '', unpaidMinutes: unpaid.reduce((n, s) => n + s.minutes, 0), unpaidGold: unpaid.reduce((n, s) => n + shiftGold(s), 0), soldCount: mine.count, soldTotal: mine.total },
  };
  if (manager) {
    out.tonight = await tonight(db, nightStart);
    out.nights = (await db.prepare('SELECT id, closed_at, sold, total FROM lounge_nights ORDER BY closed_at DESC LIMIT 52').all()).results.map(r => ({ id: r.id, closedAt: r.closed_at, count: r.sold, total: r.total }));
    const staff = new Map();
    const rows = (await db.prepare("SELECT m.name, s.minutes, s.rate, s.end_at FROM lounge_shifts s JOIN members m ON m.id = s.member_id WHERE s.end_at IS NULL OR s.paid = 0 LIMIT 500").all()).results;
    for (const r of rows) {
      const e = staff.get(r.name) || { name: r.name, minutes: 0, gold: 0, clockedIn: false };
      if (r.end_at === null) e.clockedIn = true; else { e.minutes += r.minutes; e.gold += shiftGold(r); }
      staff.set(r.name, e);
    }
    out.staff = [...staff.values()];
  }
  return out;
}

async function endShift(db, memberId, by) {
  const s = await db.prepare('SELECT id, start_at FROM lounge_shifts WHERE member_id = ? AND end_at IS NULL').bind(memberId).first();
  if (!s) return false;
  const now = Date.now(), minutes = Math.min(MAX_SHIFT_MIN, Math.max(0, Math.round((now - Date.parse(s.start_at)) / 60000)));
  await db.prepare('UPDATE lounge_shifts SET end_at = ?, minutes = ?, ended_by = ? WHERE id = ?').bind(iso(now), minutes, by, s.id).run();
  return true;
}
async function memberByName(db, v) {
  const m = await db.prepare('SELECT id, name FROM members WHERE name_key = ?').bind(nameKey(str(v, 'Who', 40))).first();
  if (!m) fail('No member has that name.', 404);
  return m;
}

export async function handleLounge(request, db, path, { json, input, rate }) {
  const post = request.method === 'POST';
  const me = await who(db, request);
  if (!post && path === '/lounge') return json({ lounge: await view(db, me) });
  if (!post) fail('Endpoint not found.', 404);
  await rate(db, 'lounge:' + me.id, 120);
  const d = await input(request);
  const needManager = () => { if (!isManager(me)) fail('Only managers can do that.', 403); };

  if (path === '/lounge/clock') {
    if (d.in === true) {
      try { await db.prepare('INSERT INTO lounge_shifts (id, member_id, start_at, rate) VALUES (?,?,?,?)').bind(rand(6), me.id, iso(Date.now()), Number(await kv(db, 'rate', '0'))).run(); }
      catch { fail('You are already clocked in.', 409); }
      return json({ lounge: await view(db, me, 'Clocked in.') }, 201);
    }
    if (!(await endShift(db, me.id, me.name))) fail('You are not clocked in.', 409);
    return json({ lounge: await view(db, me, 'Clocked out.') });
  }

  if (path === '/lounge/sell') {
    if (!(await db.prepare('SELECT 1 AS x FROM lounge_shifts WHERE member_id = ? AND end_at IS NULL').bind(me.id).first())) fail('Clock in first.', 409);
    const item = await db.prepare('SELECT * FROM lounge_menu WHERE id = ?').bind(str(d.menuId, 'Menu item', 20)).first();
    if (!item) fail('That menu item no longer exists.', 404);
    const qty = whole(d.qty, 'The amount', 1, MAX_QTY, 1);
    const giveTo = d.to === undefined || d.to === null || String(d.to).trim() === '' ? null : await memberByName(db, d.to);
    if (giveTo && !item.gift) fail('That menu item has no item to hand over.');
    if (giveTo) {
      const made = [];
      for (let i = 0; i < qty; i++) {
        const id = await insertGift(db, giveTo.id, JSON.parse(item.gift));
        if (!id) { for (const x of made) await db.prepare('DELETE FROM items WHERE id = ?').bind(x).run(); fail(`${giveTo.name}'s inventory is full. Nothing was sold.`, 409); }
        made.push(id);
      }
    }
    await db.prepare('INSERT INTO lounge_sales (id, member_id, menu_id, name, price, qty, at) VALUES (?,?,?,?,?,?,?)').bind(rand(6), me.id, item.id, item.name, item.price, qty, iso(Date.now())).run();
    return json({ lounge: await view(db, me, `Sold ${qty} ${item.name} for ${(qty * item.price).toLocaleString('en-US')}.` + (giveTo ? ` Handed over to ${giveTo.name}.` : '')) }, 201);
  }
  if (path === '/lounge/undo') {
    const last = await db.prepare('SELECT id, name, qty FROM lounge_sales WHERE member_id = ? AND at >= ? ORDER BY at DESC LIMIT 1').bind(me.id, iso(Date.now() - 15 * 60000)).first();
    if (!last) fail('You have no sale from the last 15 minutes to take back.', 404);
    await db.prepare('DELETE FROM lounge_sales WHERE id = ?').bind(last.id).run();
    return json({ lounge: await view(db, me, `Took back ${last.qty} ${last.name}.`) });
  }

  if (path === '/lounge/pf/posted') {
    await setKv(db, 'pf_posted_at', iso(Date.now())); await setKv(db, 'pf_posted_by', me.name);
    return json({ lounge: await view(db, me, 'Thank you! The reminder will tell you when to refresh the listing.') });
  }

  needManager();
  if (path === '/lounge/pf/save') {
    await setKv(db, 'pf_text', str(d.text, 'Party Finder text', 192, false));
    await setKv(db, 'pf_minutes', String(whole(d.minutes, 'Minutes', 5, 120, 55)));
    return json({ lounge: await view(db, me, 'Party Finder text saved.') });
  }
  if (path === '/lounge/night') {
    const r = await db.prepare('SELECT report FROM lounge_nights WHERE id = ?').bind(str(d.id, 'Night', 20)).first();
    if (!r) fail('That night is no longer saved.', 404);
    return json({ lounge: await view(db, me), night: JSON.parse(r.report) });
  }
  if (path === '/lounge/info') {
    await setKv(db, 'hours', str(d.hours, 'Hours', 300, false));
    await setKv(db, 'rate', String(whole(d.rate, 'The hourly pay', 0, MAX_AMOUNT, 0)));
    return json({ lounge: await view(db, me, 'Saved.') });
  }
  if (path === '/lounge/menu/save') {
    const name = str(d.name, 'Name', 40), description = str(d.description, 'Description', 300, false), price = whole(d.price, 'The price', 0, MAX_AMOUNT, 0);
    const gift = d.gift && typeof d.gift === 'object' && String(d.gift.name ?? '').trim() ? JSON.stringify(itemFields(d.gift)) : '';
    if (d.id) {
      const r = await db.prepare('UPDATE lounge_menu SET name = ?, price = ?, description = ?, gift = ? WHERE id = ?').bind(name, price, description, gift, str(d.id, 'Menu item', 20)).run();
      if (r.meta.changes !== 1) fail('That menu item no longer exists.', 404);
    } else {
      if ((await db.prepare('SELECT count(*) AS n FROM lounge_menu').first()).n >= MAX_MENU) fail(`The menu can hold up to ${MAX_MENU} items.`, 409);
      await db.prepare('INSERT INTO lounge_menu (id, name, price, description, gift) VALUES (?,?,?,?,?)').bind(rand(6), name, price, description, gift).run();
    }
    return json({ lounge: await view(db, me, 'Menu saved.') });
  }
  if (path === '/lounge/menu/delete') {
    await db.prepare('DELETE FROM lounge_menu WHERE id = ?').bind(str(d.id, 'Menu item', 20)).run();
    return json({ lounge: await view(db, me, 'Removed from the menu.') });
  }
  if (path === '/lounge/clockout') {
    const m = await memberByName(db, d.name);
    if (!(await endShift(db, m.id, me.name))) fail(`${m.name} is not clocked in.`, 409);
    return json({ lounge: await view(db, me, `Clocked out ${m.name}.`) });
  }
  if (path === '/lounge/pay') {
    const m = await memberByName(db, d.name);
    const rows = (await db.prepare('SELECT id, minutes, rate FROM lounge_shifts WHERE member_id = ? AND paid = 0 AND end_at IS NOT NULL').bind(m.id).all()).results;
    if (!rows.length) fail(`${m.name} has no unpaid shifts. If they are still clocked in, clock them out first.`, 409);
    const total = rows.reduce((n, s) => n + shiftGold(s), 0);
    for (const s of rows) await db.prepare('UPDATE lounge_shifts SET paid = 1 WHERE id = ?').bind(s.id).run();
    if (total > 0 && !(await earn(db, m.id, total, 'Embershade Lounge pay'))) {
      for (const s of rows) await db.prepare('UPDATE lounge_shifts SET paid = 0 WHERE id = ?').bind(s.id).run();
      fail(`${m.name}'s purse cannot hold that much gold.`, 409);
    }
    return json({ lounge: await view(db, me, `Paid ${m.name} ${total.toLocaleString('en-US')} gold into their bank.`) });
  }
  if (path === '/lounge/newnight') {
    const now = Date.now(), cutoff = iso(now - KEEP_DAYS * 86400000), start = await kv(db, 'night_start', '1970-01-01T00:00:00.000Z');
    const t = await tonight(db, start);
    let night = null;
    if (t.count > 0 || t.people.length > 0) {
      night = { nightStart: start, closedAt: iso(now), closedBy: me.name, ...t };
      await db.prepare('INSERT INTO lounge_nights (id, closed_at, closed_by, sold, total, report) VALUES (?,?,?,?,?,?)').bind(rand(6), night.closedAt, me.name, t.count, t.total, JSON.stringify(night)).run();
      await db.prepare('DELETE FROM lounge_nights WHERE id NOT IN (SELECT id FROM lounge_nights ORDER BY closed_at DESC LIMIT 300)').run();
    }
    await setKv(db, 'night_start', iso(now));
    await db.prepare('DELETE FROM lounge_sales WHERE at < ?').bind(cutoff).run();
    await db.prepare('DELETE FROM lounge_shifts WHERE paid = 1 AND end_at < ?').bind(cutoff).run();
    return json({ lounge: await view(db, me, night ? 'The night is saved to Past nights. A new night has started.' : 'A new night has started. The receipt book is clear.'), night });
  }
  fail('Endpoint not found.', 404);
}

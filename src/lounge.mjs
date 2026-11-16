'use strict';
// The Embershade Lounge: opening hours, a menu with prices, staff clock in and out with pay, and a receipt book of what was sold.
// Everyone registered can see the menu and hours and use the tools while clocked in. Managers (SMs or the Lounge Manager tag) run the rest.
import { fail } from './engine.mjs';
import { who, rand, str, nameKey, itemFields, isStaff } from './items.mjs';
import { earn, MAX_AMOUNT } from './bank.mjs';
import { insertGift } from './quests.mjs';

const PING_MS = 30 * 60000, PRESENT_MS = 60000, MANUAL_MS = 3 * 3600000, RETURN_MS = 5 * 60000;
export const ROLES = ['Manager', 'Security', 'Bartender', 'Server', 'Host', 'Entertainer', 'Cook', 'Other'];
export const MAX_SERVICES = 10, MAX_MENU = 60, MAX_SHIFT_MIN = 720, KEEP_DAYS = 90, MAX_QTY = 20;
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
  const services = (await db.prepare('SELECT m.name AS who, s.name, s.customer, s.rate, s.minutes, s.total FROM lounge_sessions s JOIN members m ON m.id = s.member_id WHERE s.closed_at >= ? ORDER BY s.closed_at').bind(nightStart).all()).results;
  const serviceTotal = services.reduce((n, x) => n + x.total, 0);
  const people = [...new Set([...shifts.map(r => r.name), ...sold.map(r => r.who), ...services.map(r => r.who)])].sort((x, y) => x.localeCompare(y));
  const items = (await db.prepare('SELECT name, price, sum(qty) AS count FROM lounge_sales WHERE at >= ? GROUP BY name, price ORDER BY name').bind(nightStart).all()).results.map(r => ({
    name: r.name, price: r.price, count: r.count, total: r.count * r.price,
    by: people.map(who => ({ name: who, count: sold.find(x => x.name === r.name && x.price === r.price && x.who === who)?.count ?? 0 })),
  }));
  return {
    items, count: items.reduce((n, i) => n + i.count, 0), total: items.reduce((n, i) => n + i.total, 0),
    services, serviceTotal, grand: items.reduce((n, i) => n + i.total, 0) + serviceTotal,
    people: people.map(name => ({ name, count: sold.filter(x => x.who === name).reduce((n, x) => n + x.count, 0), total: sold.filter(x => x.who === name).reduce((n, x) => n + x.count * x.price, 0), minutes: shifts.filter(x => x.name === name).reduce((n, x) => n + x.minutes, 0), serviceTotal: services.filter(x => x.who === name).reduce((n, x) => n + x.total, 0) })),
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
    ...extra, msg, canManage: manager, nightOpen: (await kv(db, 'night_open', '1')) !== '0',
    services: (await db.prepare('SELECT s.id, s.name, s.price, m.name AS who FROM lounge_services s JOIN members m ON m.id = s.member_id ORDER BY m.name, s.name LIMIT 300').all()).results,
    session: await mySession(db, me.id),
    sessions: (await db.prepare('SELECT m.name AS who, s.name, s.customer, s.ends_at FROM lounge_sessions s JOIN members m ON m.id = s.member_id WHERE s.closed_at IS NULL ORDER BY s.ends_at LIMIT 50').all()).results.map(r => ({ who: r.who, name: r.name, customer: r.customer, endsAt: r.ends_at })), pf: { text: await kv(db, 'pf_text'), minutes: Number(await kv(db, 'pf_minutes', '55')), postedAt: await kv(db, 'pf_posted_at'), postedBy: await kv(db, 'pf_posted_by') }, hours: await kv(db, 'hours'), rate: Number(await kv(db, 'rate', '0')), nightStart, menu, working,
    me: { since: open ? open.start_at : '', unpaidMinutes: unpaid.reduce((n, s) => n + s.minutes, 0), unpaidGold: unpaid.reduce((n, s) => n + shiftGold(s), 0), soldCount: mine.count, soldTotal: mine.total },
  };
  const now = Date.now();
  const roleRows = (await db.prepare('SELECT m.name, r.role FROM lounge_roles r JOIN members m ON m.id = r.member_id ORDER BY m.name LIMIT 400').all()).results;
  out.roles = [...new Set(roleRows.map(r => r.name))].map(name => ({ name, roles: ROLES.filter(x => roleRows.some(r => r.name === name && r.role === x)) }));
  out.working = out.working.map(w => ({ ...w, roles: out.roles.find(r => r.name === w.name)?.roles ?? [] }));
  out.pings = (await db.prepare('SELECT p.id, p.kind, p.text, p.created_at, p.responder FROM lounge_ping_targets t JOIN lounge_pings p ON p.id = t.ping_id WHERE t.member_id = ? AND t.done = 0 AND p.created_at >= ? ORDER BY p.created_at LIMIT 5').bind(me.id, iso(now - PING_MS)).all()).results
    .map(r => ({ id: r.id, kind: r.kind, text: r.text, at: r.created_at, responder: r.responder || '' }));
  out.adText = await kv(db, 'ad_text');
  const venue = await kv(db, 'venue');
  out.venue = venue ? JSON.parse(venue) : null;
  out.patrons = (await db.prepare('SELECT * FROM lounge_patrons WHERE last_seen >= ? OR (manual = 1 AND last_seen >= ?) ORDER BY arrived_at LIMIT 150').bind(iso(now - PRESENT_MS), iso(now - MANUAL_MS)).all()).results
    .map(r => ({ name: r.name, arrivedAt: r.arrived_at, helper: r.helper_name || '', mine: r.helper_id === me.id, helpedAt: r.helped_at || '', helpedBy: r.helped_by || '', manual: !!r.manual }));
  const nights = (await db.prepare('SELECT * FROM lounge_schedule WHERE ends_at >= ? ORDER BY starts_at LIMIT 40').bind(iso(now - 3600000)).all()).results;
  const roster = nights.length ? (await db.prepare('SELECT r.night_id, r.member_id, r.status, m.name FROM lounge_roster r JOIN members m ON m.id = r.member_id WHERE r.night_id IN (' + nights.map(() => '?').join(',') + ') ORDER BY m.name').bind(...nights.map(n => n.id)).all()).results : [];
  out.schedule = nights.map(n => ({ id: n.id, startsAt: n.starts_at, endsAt: n.ends_at, note: n.note, staff: roster.filter(r => r.night_id === n.id).map(r => ({ name: r.name, status: r.status })), mine: roster.find(r => r.night_id === n.id && r.member_id === me.id)?.status || '' }));
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

const sessionOf = r => ({ id: r.id, name: r.name, customer: r.customer, rate: r.rate, minutes: r.minutes, startedAt: r.started_at, endsAt: r.ends_at });
async function mySession(db, memberId) {
  const r = await db.prepare('SELECT * FROM lounge_sessions WHERE member_id = ? AND closed_at IS NULL').bind(memberId).first();
  return r ? sessionOf(r) : null;
}
// Closes a member's running service session and returns its receipt. The price is the hourly rate times the minutes booked.
async function closeSession(db, memberId, staffName) {
  const r = await db.prepare('SELECT * FROM lounge_sessions WHERE member_id = ? AND closed_at IS NULL').bind(memberId).first();
  if (!r) return null;
  const total = Math.round(r.rate * r.minutes / 60), closedAt = iso(Date.now());
  await db.prepare('UPDATE lounge_sessions SET closed_at = ?, total = ? WHERE id = ?').bind(closedAt, total, r.id).run();
  return { staff: staffName, service: r.name, customer: r.customer, rate: r.rate, minutes: r.minutes, total, closedAt };
}

async function endShift(db, memberId, by) {
  const s = await db.prepare('SELECT id, start_at FROM lounge_shifts WHERE member_id = ? AND end_at IS NULL').bind(memberId).first();
  if (!s) return false;
  const now = Date.now(), minutes = Math.min(MAX_SHIFT_MIN, Math.max(0, Math.round((now - Date.parse(s.start_at)) / 60000)));
  await db.prepare('UPDATE lounge_shifts SET end_at = ?, minutes = ?, ended_by = ? WHERE id = ?').bind(iso(now), minutes, by, s.id).run();
  await db.prepare('UPDATE lounge_patrons SET helper_id = NULL, helper_name = NULL WHERE helper_id = ?').bind(memberId).run();   // anyone they were helping goes back to waiting
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
    if (await mySession(db, me.id)) fail('Close your service session first, then clock out.', 409);
    if (!(await endShift(db, me.id, me.name))) fail('You are not clocked in.', 409);
    return json({ lounge: await view(db, me, 'Clocked out.') });
  }

  if (path === '/lounge/sell') {
    if ((await kv(db, 'night_open', '1')) === '0') fail('The night is closed. A manager needs to start a new night first.', 409);
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

  if (path === '/lounge/service/save') {
    const name = str(d.name, 'Service name', 40), price = whole(d.price, 'The price per hour', 0, MAX_AMOUNT, 0);
    if (d.id) {
      const r = await db.prepare('UPDATE lounge_services SET name = ?, price = ? WHERE id = ? AND member_id = ?').bind(name, price, str(d.id, 'Service', 20), me.id).run();
      if (r.meta.changes !== 1) fail('That service was not found.', 404);
    } else {
      if ((await db.prepare('SELECT count(*) AS n FROM lounge_services WHERE member_id = ?').bind(me.id).first()).n >= MAX_SERVICES) fail(`You can offer up to ${MAX_SERVICES} services.`, 409);
      await db.prepare('INSERT INTO lounge_services (id, member_id, name, price) VALUES (?,?,?,?)').bind(rand(6), me.id, name, price).run();
    }
    return json({ lounge: await view(db, me, 'Service saved.') });
  }
  if (path === '/lounge/service/delete') {
    await db.prepare('DELETE FROM lounge_services WHERE id = ? AND member_id = ?').bind(str(d.id, 'Service', 20), me.id).run();
    return json({ lounge: await view(db, me, 'Service removed.') });
  }
  if (path === '/lounge/session/start') {
    if (!(await db.prepare('SELECT 1 AS x FROM lounge_shifts WHERE member_id = ? AND end_at IS NULL').bind(me.id).first())) fail('Clock in first.', 409);
    const svc = await db.prepare('SELECT * FROM lounge_services WHERE id = ? AND member_id = ?').bind(str(d.serviceId, 'Service', 20), me.id).first();
    if (!svc) fail('That is not one of your services.', 404);
    const minutes = whole(d.minutes, 'The time', 15, 480, 60), customer = str(d.customer, 'Customer', 40, false), now = Date.now();
    try { await db.prepare('INSERT INTO lounge_sessions (id, member_id, name, customer, rate, minutes, started_at, ends_at) VALUES (?,?,?,?,?,?,?,?)').bind(rand(6), me.id, svc.name, customer, svc.price, minutes, iso(now), iso(now + minutes * 60000)).run(); }
    catch { fail('You already have a session running. Close it first.', 409); }
    return json({ lounge: await view(db, me, `Started ${svc.name} for ${minutes} minutes.`) }, 201);
  }
  if (path === '/lounge/session/extend') {
    const minutes = whole(d.minutes, 'The extra time', 15, 480, 30), cur = await mySession(db, me.id);
    if (!cur) fail('You have no session running.', 404);
    await db.prepare('UPDATE lounge_sessions SET minutes = minutes + ?, ends_at = ? WHERE id = ?').bind(minutes, iso(Date.parse(cur.endsAt) + minutes * 60000), cur.id).run();
    return json({ lounge: await view(db, me, `Added ${minutes} minutes.`) });
  }
  if (path === '/lounge/session/end' && !(d.name && String(d.name).trim())) {
    const receipt = await closeSession(db, me.id, me.name);
    if (!receipt) fail('You have no session running.', 404);
    return json({ lounge: await view(db, me, 'Session closed.'), receipt });
  }

  if (path === '/lounge/pf/posted') {
    await setKv(db, 'pf_posted_at', iso(Date.now())); await setKv(db, 'pf_posted_by', me.name);
    return json({ lounge: await view(db, me, 'Thank you! The reminder will tell you when to refresh the listing.') });
  }

  const clockedIn = async () => { if (!(await db.prepare('SELECT 1 AS x FROM lounge_shifts WHERE member_id = ? AND end_at IS NULL').bind(me.id).first())) fail('Clock in first.', 409); };
  const touchPatron = async (name, manual) => {
    const key = nameKey(name), now = Date.now(), old = await db.prepare('SELECT last_seen, manual FROM lounge_patrons WHERE name_key = ?').bind(key).first();
    if (!old) { await db.prepare('INSERT INTO lounge_patrons (name_key, name, arrived_at, last_seen, manual) VALUES (?,?,?,?,?)').bind(key, name, iso(now), iso(now), manual ? 1 : 0).run(); return; }
    const stale = now - Date.parse(old.last_seen) > (old.manual ? MANUAL_MS : RETURN_MS);
    if (stale) await db.prepare('UPDATE lounge_patrons SET name = ?, arrived_at = ?, last_seen = ?, manual = ?, helper_id = NULL, helper_name = NULL, helped_at = NULL, helped_by = NULL WHERE name_key = ?').bind(name, iso(now), iso(now), manual ? 1 : 0, key).run();
    else await db.prepare('UPDATE lounge_patrons SET last_seen = ?, manual = CASE WHEN ? = 1 THEN 1 ELSE manual END WHERE name_key = ?').bind(iso(now), manual ? 1 : 0, key).run();
  };
  if (path === '/lounge/patrons/report') {
    await clockedIn();
    if (!Array.isArray(d.names)) fail('Names must be a list.');
    const staffKeys = new Set((await db.prepare('SELECT m.name_key FROM lounge_shifts s JOIN members m ON m.id = s.member_id WHERE s.end_at IS NULL').all()).results.map(r => r.name_key));
    const seen = new Set();
    for (const raw of d.names.slice(0, 60)) {
      const name = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 40), key = nameKey(name);
      if (!name || seen.has(key) || staffKeys.has(key)) continue;
      seen.add(key); await touchPatron(name, false);
    }
    return json({ lounge: await view(db, me) });
  }
  if (path === '/lounge/patrons/add') {
    await clockedIn(); await touchPatron(str(d.name, 'Name', 40), true);
    return json({ lounge: await view(db, me, 'Added.') });
  }
  if (path === '/lounge/patrons/remove') {
    await clockedIn();
    await db.prepare("UPDATE lounge_patrons SET last_seen = '1970-01-01T00:00:00.000Z', manual = 0, helper_id = NULL, helper_name = NULL WHERE name_key = ?").bind(nameKey(str(d.name, 'Name', 40))).run();
    return json({ lounge: await view(db, me, 'Removed from the list.') });
  }
  if (path === '/lounge/patrons/help') {
    await clockedIn();
    const key = nameKey(str(d.name, 'Name', 40)), r = await db.prepare('UPDATE lounge_patrons SET helper_id = ?, helper_name = ? WHERE name_key = ? AND last_seen >= ? AND (helper_id IS NULL OR helper_id = ?)').bind(me.id, me.name, key, iso(Date.now() - MANUAL_MS), me.id).run();
    if (!r.meta.changes) {
      const p = await db.prepare('SELECT helper_name FROM lounge_patrons WHERE name_key = ?').bind(key).first();
      fail(p?.helper_name ? `${p.helper_name} is already helping them.` : 'They are not in the venue.', 409);
    }
    return json({ lounge: await view(db, me, 'You are helping them.') });
  }
  if (path === '/lounge/patrons/unhelp' || path === '/lounge/patrons/done') {
    const key = nameKey(str(d.name, 'Name', 40)), p = await db.prepare('SELECT helper_id, helper_name FROM lounge_patrons WHERE name_key = ?').bind(key).first();
    if (!p || !p.helper_id) fail('Nobody is helping them right now.', 409);
    if (p.helper_id !== me.id && !isManager(me)) fail(`Only ${p.helper_name} or a manager can do that.`, 403);
    if (path.endsWith('/done')) await db.prepare('UPDATE lounge_patrons SET helped_at = ?, helped_by = ?, helper_id = NULL, helper_name = NULL WHERE name_key = ?').bind(iso(Date.now()), p.helper_name, key).run();
    else await db.prepare('UPDATE lounge_patrons SET helper_id = NULL, helper_name = NULL WHERE name_key = ?').bind(key).run();
    return json({ lounge: await view(db, me, path.endsWith('/done') ? 'Marked as helped.' : 'Released. They are waiting for help again.') });
  }
  const sendPing = async (kind, text, role) => {
    const last = await db.prepare('SELECT created_at FROM lounge_pings WHERE from_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1').bind(me.id, kind).first();
    if (last && Date.now() - Date.parse(last.created_at) < 20000) fail('You just sent one of those. Give it a few seconds.', 429);
    const onShift = (await db.prepare('SELECT DISTINCT m.id, m.name, m.tags FROM lounge_shifts s JOIN members m ON m.id = s.member_id WHERE s.end_at IS NULL').all()).results.filter(r => r.id !== me.id);
    const ids = new Set((await db.prepare('SELECT member_id FROM lounge_roles WHERE role = ?').bind(role).all()).results.map(r => r.member_id));
    let targets = onShift.filter(r => ids.has(r.id));
    if (!targets.length && role === 'Manager') targets = onShift.filter(r => isManager(r));
    if (!targets.length) return null;
    const id = rand(6);
    await db.prepare('INSERT INTO lounge_pings (id, kind, from_id, from_name, text, created_at) VALUES (?,?,?,?,?,?)').bind(id, kind, me.id, me.name, text, iso(Date.now())).run();
    for (const t of targets) await db.prepare('INSERT INTO lounge_ping_targets (ping_id, member_id) VALUES (?,?)').bind(id, t.id).run();
    const old = iso(Date.now() - 86400000);
    await db.prepare('DELETE FROM lounge_ping_targets WHERE ping_id IN (SELECT id FROM lounge_pings WHERE created_at < ?)').bind(old).run();
    await db.prepare('DELETE FROM lounge_pings WHERE created_at < ?').bind(old).run();
    return targets.map(t => t.name);
  };
  if (path === '/lounge/call/manager' || path === '/lounge/call/security' || path === '/lounge/call/ban') {
    await clockedIn();
    let kind, text, role;
    if (path.endsWith('/manager')) {
      if (d.ic !== 'IC' && d.ic !== 'OOC') fail('Choose IC or OOC.');
      kind = 'manager'; role = 'Manager'; text = `${me.name} requests a manager (${d.ic})`;
    } else if (path.endsWith('/security')) { kind = 'security'; role = 'Security'; text = `${me.name} requests security`; }
    else {
      const patron = str(d.patron, 'The customer', 40), reason = str(d.reason, 'The reason', 200, false);
      kind = 'ban'; role = 'Manager'; text = `${me.name} has requested ${patron} be banned. Reason: ${reason || 'none given'}`;
    }
    const sent = await sendPing(kind, text, role);
    if (!sent) fail(kind === 'security' ? 'Nobody on shift has the Security position right now.' : 'No manager is on shift right now.', 409);
    return json({ lounge: await view(db, me, `Sent to ${sent.join(', ')}.`) });
  }
  if (path === '/lounge/call/respond') {
    const id = str(d.id, 'Call', 20);
    await db.prepare('UPDATE lounge_pings SET responder = ? WHERE id = ? AND responder IS NULL AND id IN (SELECT ping_id FROM lounge_ping_targets WHERE member_id = ?)').bind(me.name, id, me.id).run();
    await db.prepare('UPDATE lounge_ping_targets SET done = 1 WHERE ping_id = ? AND member_id = ?').bind(id, me.id).run();
    return json({ lounge: await view(db, me, 'Thank you, they know you are on the way.') });
  }
  if (path === '/lounge/call/dismiss') {
    await db.prepare('UPDATE lounge_ping_targets SET done = 1 WHERE ping_id = ? AND member_id = ?').bind(str(d.id, 'Call', 20), me.id).run();
    return json({ lounge: await view(db, me) });
  }
  if (path === '/lounge/schedule/rsvp') {
    const n = await db.prepare('SELECT id FROM lounge_schedule WHERE id = ?').bind(str(d.nightId, 'Night', 20)).first();
    if (!n) fail('That night is no longer on the schedule.', 404);
    if (d.on === true) await db.prepare("INSERT INTO lounge_roster (night_id, member_id, status) VALUES (?,?,'available') ON CONFLICT(night_id, member_id) DO NOTHING").bind(n.id, me.id).run();
    else await db.prepare('DELETE FROM lounge_roster WHERE night_id = ? AND member_id = ?').bind(n.id, me.id).run();
    return json({ lounge: await view(db, me, d.on === true ? 'Marked you as available.' : 'Removed you from that night.') });
  }

  needManager();
  if (path === '/lounge/roles/set') {
    const m = await memberByName(db, d.name);
    if (!Array.isArray(d.roles) || d.roles.some(r => !ROLES.includes(r))) fail('Unknown position.');
    await db.prepare('DELETE FROM lounge_roles WHERE member_id = ?').bind(m.id).run();
    for (const r of new Set(d.roles)) await db.prepare('INSERT INTO lounge_roles (member_id, role) VALUES (?,?)').bind(m.id, r).run();
    return json({ lounge: await view(db, me, `Positions saved for ${m.name}.`) });
  }
  if (path === '/lounge/venue/set') {
    const num = (v, k) => { if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 100000) fail(`${k} is not a valid position.`); return Math.round(v * 100) / 100; };
    const v = { room: str(d.room, 'Room', 60), x: num(d.x, 'x'), y: num(d.y, 'y'), z: num(d.z, 'z'), radius: whole(d.radius, 'Radius', 5, 300, 40), label: str(d.label, 'Label', 60, false) };
    await setKv(db, 'venue', JSON.stringify(v));
    return json({ lounge: await view(db, me, 'The venue spot is saved.') });
  }
  if (path === '/lounge/venue/clear') { await setKv(db, 'venue', ''); return json({ lounge: await view(db, me, 'The venue spot is cleared.') }); }
  if (path === '/lounge/ad/save') { await setKv(db, 'ad_text', str(d.text, 'Advert', 400, false)); return json({ lounge: await view(db, me, 'Advert saved.') }); }
  if (path === '/lounge/schedule/save') {
    const a = Date.parse(d.startsAt), b = Date.parse(d.endsAt);
    if (!Number.isFinite(a) || !Number.isFinite(b)) fail('Start and end times are not valid.');
    if (b <= a || b - a > 24 * 3600000) fail('A night must end after it starts and last at most 24 hours.');
    if (a < Date.now() - 86400000) fail('That night is in the past.');
    const note = str(d.note, 'Note', 200, false);
    let id = d.id ? String(d.id) : '';
    if (id) { const r = await db.prepare('UPDATE lounge_schedule SET starts_at = ?, ends_at = ?, note = ? WHERE id = ?').bind(iso(a), iso(b), note, id).run(); if (!r.meta.changes) fail('That night is gone.', 404); }
    else {
      if ((await db.prepare('SELECT count(*) AS n FROM lounge_schedule').first()).n >= 80) fail('The schedule is full. Remove old nights first.', 409);
      id = rand(6); await db.prepare('INSERT INTO lounge_schedule (id, starts_at, ends_at, note) VALUES (?,?,?,?)').bind(id, iso(a), iso(b), note).run();
    }
    const old = iso(Date.now() - 60 * 86400000);
    await db.prepare('DELETE FROM lounge_roster WHERE night_id IN (SELECT id FROM lounge_schedule WHERE ends_at < ?)').bind(old).run();
    await db.prepare('DELETE FROM lounge_schedule WHERE ends_at < ?').bind(old).run();
    return json({ lounge: await view(db, me, 'Night saved.') });
  }
  if (path === '/lounge/schedule/delete') {
    const id = str(d.id, 'Night', 20);
    await db.prepare('DELETE FROM lounge_roster WHERE night_id = ?').bind(id).run();
    await db.prepare('DELETE FROM lounge_schedule WHERE id = ?').bind(id).run();
    return json({ lounge: await view(db, me, 'Night removed.') });
  }
  if (path === '/lounge/roster/set') {
    const n = await db.prepare('SELECT id FROM lounge_schedule WHERE id = ?').bind(str(d.nightId, 'Night', 20)).first();
    if (!n) fail('That night is no longer on the schedule.', 404);
    const m = await memberByName(db, d.name);
    if (d.status === 'working') await db.prepare("INSERT INTO lounge_roster (night_id, member_id, status) VALUES (?,?,'working') ON CONFLICT(night_id, member_id) DO UPDATE SET status = 'working'").bind(n.id, m.id).run();
    else if (d.status === 'available') await db.prepare("INSERT INTO lounge_roster (night_id, member_id, status) VALUES (?,?,'available') ON CONFLICT(night_id, member_id) DO UPDATE SET status = 'available'").bind(n.id, m.id).run();
    else await db.prepare('DELETE FROM lounge_roster WHERE night_id = ? AND member_id = ?').bind(n.id, m.id).run();
    return json({ lounge: await view(db, me, 'Roster updated.') });
  }
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
  if (path === '/lounge/session/end') {
    const m = await memberByName(db, d.name), receipt = await closeSession(db, m.id, m.name);
    if (!receipt) fail(`${m.name} has no session running.`, 404);
    return json({ lounge: await view(db, me, `Closed ${m.name}'s session.`), receipt });
  }
  if (path === '/lounge/clockout') {
    const m = await memberByName(db, d.name);
    await closeSession(db, m.id, m.name);
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
  const closeNight = async () => {
    const now = Date.now(), cutoff = iso(now - KEEP_DAYS * 86400000), start = await kv(db, 'night_start', '1970-01-01T00:00:00.000Z');
    const t = await tonight(db, start);
    let night = null;
    if (t.count > 0 || t.people.length > 0) {
      night = { nightStart: start, closedAt: iso(now), closedBy: me.name, ...t };
      await db.prepare('INSERT INTO lounge_nights (id, closed_at, closed_by, sold, total, report) VALUES (?,?,?,?,?,?)').bind(rand(6), night.closedAt, me.name, t.count, t.grand, JSON.stringify(night)).run();
      await db.prepare('DELETE FROM lounge_nights WHERE id NOT IN (SELECT id FROM lounge_nights ORDER BY closed_at DESC LIMIT 300)').run();
    }
    await setKv(db, 'night_start', iso(now));
    await db.prepare('DELETE FROM lounge_sales WHERE at < ?').bind(cutoff).run();
    await db.prepare('DELETE FROM lounge_shifts WHERE paid = 1 AND end_at < ?').bind(cutoff).run();
    await db.prepare('DELETE FROM lounge_sessions WHERE closed_at < ?').bind(cutoff).run();
    return night;
  };
  if (path === '/lounge/closenight') {
    if ((await kv(db, 'night_open', '1')) === '0') fail('The night is already closed.', 409);
    const night = await closeNight(); await setKv(db, 'night_open', '0');
    return json({ lounge: await view(db, me, night ? 'The night is closed and saved to Past nights.' : 'The night is closed. Nothing had been sold.'), night });
  }
  if (path === '/lounge/startnight') {
    if ((await kv(db, 'night_open', '1')) !== '0') fail('A night is already open.', 409);
    await setKv(db, 'night_start', iso(Date.now())); await setKv(db, 'night_open', '1');
    return json({ lounge: await view(db, me, 'A new night has started. The receipt book is clear.') });
  }
  if (path === '/lounge/newnight') {
    const night = await closeNight(); await setKv(db, 'night_open', '1');
    return json({ lounge: await view(db, me, night ? 'The night is saved to Past nights. A new night has started.' : 'A new night has started. The receipt book is clear.'), night });
  }
  fail('Endpoint not found.', 404);
}

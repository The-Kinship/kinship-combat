'use strict';
// Statuses (buffs and debuffs) on members. A status is copied onto the member with its own text, with an optional end time.
import { fail } from './engine.mjs';
import { randomBytes } from 'node:crypto';

export const MAX_STATUS = 6;
// A roll bonus a status gives to attacks and to heals. Only Advocates, their items and their quests can set one.
export const bonus = (v, name) => { if (v === undefined || v === null || v === '') return 0; if (!Number.isInteger(v) || v < -5 || v > 5) fail(`${name} must be a whole number from -5 to 5.`); return v; };
/** Statuses an item gives just by being in someone's main inventory ("carried" items). One per name, so three crystals give one status. They never use up
 *  the six status slots, cannot be cured or removed, and are gone the moment the item is. Pass a member id for one person, or nothing for everyone. */
export async function carriedRows(db, memberId = null) {
  const sql = "SELECT i.owner_id AS member_id, m.name AS member_name, i.st_name, i.st_desc, i.st_icon, i.icon, i.st_debuff, i.st_type, i.st_cure, i.st_atk, i.st_heal FROM items i JOIN members m ON m.id = i.owner_id WHERE i.carried = 1 AND i.st_name != ''" + (memberId ? ' AND i.owner_id = ?' : '') + ' ORDER BY i.created_at, i.id';
  const { results } = await (memberId ? db.prepare(sql).bind(memberId) : db.prepare(sql)).all();
  const seen = new Set(), out = [];
  for (const r of results) { const k = r.member_id + '|' + String(r.st_name).toLowerCase().replace(/\s+/g, ' ').trim(); if (!seen.has(k)) { seen.add(k); out.push(r); } }
  return out;
}
export async function rollBonuses(db, memberId) {
  const { results } = await db.prepare('SELECT name, atk_bonus, heal_bonus FROM statuses WHERE member_id = ? AND (atk_bonus != 0 OR heal_bonus != 0) AND (expires_at IS NULL OR expires_at > ?)').bind(memberId, new Date().toISOString()).all();
  const out = results.map(r => ({ label: r.name, atk: r.atk_bonus, heal: r.heal_bonus }));
  for (const c of await carriedRows(db, memberId)) if (c.st_atk || c.st_heal) out.push({ label: c.st_name, atk: c.st_atk, heal: c.st_heal });
  // Worn gear counts too, but all of it together is capped at +5 / -5 so no outfit makes anyone unbeatable.
  const gear = (await db.prepare("SELECT gear_atk, gear_heal FROM items WHERE owner_id = ? AND (gear_atk != 0 OR gear_heal != 0) AND (lifespan_days = 0 OR worn_at IS NULL OR datetime(worn_at, '+' || lifespan_days || ' days') > datetime('now'))").bind('w' + memberId).all()).results;
  const cap = n => Math.max(-5, Math.min(5, n)), atk = cap(gear.reduce((n, g) => n + g.gear_atk, 0)), heal = cap(gear.reduce((n, g) => n + g.gear_heal, 0));
  if (atk !== 0 || heal !== 0) out.push({ label: 'Gear', atk, heal });
  return out;
}
/** Everyone's roll bonuses added up for the status bar: one "Combat Buff" (all the good bonuses together) and one "Combat Debuff" (all the bad ones),
 *  counting active statuses and worn gear (gear together capped at +5 / -5, like in rolls). Returns [{ memberId, name, kind, atk, heal }]. */
export async function combatTotals(db) {
  const now = new Date().toISOString(), by = new Map();
  const slot = (id, name) => { if (!by.has(id)) by.set(id, { name, buff: { atk: 0, heal: 0 }, debuff: { atk: 0, heal: 0 } }); return by.get(id); };
  const add = (e, atk, heal) => { for (const [k, v] of [['atk', atk], ['heal', heal]]) { if (v > 0) e.buff[k] += v; else if (v < 0) e.debuff[k] += v; } };
  const sts = (await db.prepare('SELECT s.member_id, m.name, s.atk_bonus, s.heal_bonus FROM statuses s JOIN members m ON m.id = s.member_id WHERE (s.atk_bonus != 0 OR s.heal_bonus != 0) AND (s.expires_at IS NULL OR s.expires_at > ?)').bind(now).all()).results;
  for (const r of sts) add(slot(r.member_id, r.name), r.atk_bonus, r.heal_bonus);
  for (const c of await carriedRows(db)) add(slot(c.member_id, c.member_name), c.st_atk, c.st_heal);
  const gear = (await db.prepare("SELECT substr(i.owner_id, 2) AS member_id, m.name, i.gear_atk, i.gear_heal FROM items i JOIN members m ON m.id = substr(i.owner_id, 2) WHERE i.owner_id LIKE 'w%' AND (i.gear_atk != 0 OR i.gear_heal != 0) AND (i.lifespan_days = 0 OR i.worn_at IS NULL OR datetime(i.worn_at, '+' || i.lifespan_days || ' days') > datetime('now'))").all()).results;
  const net = new Map(), cap = n => Math.max(-5, Math.min(5, n));
  for (const g of gear) { const e = net.get(g.member_id) || { name: g.name, atk: 0, heal: 0 }; e.atk += g.gear_atk; e.heal += g.gear_heal; net.set(g.member_id, e); }
  for (const [id, e] of net) add(slot(id, e.name), cap(e.atk), cap(e.heal));
  const out = [];
  for (const [memberId, e] of by) {
    if (e.buff.atk || e.buff.heal) out.push({ memberId, name: e.name, kind: 'buff', atk: e.buff.atk, heal: e.buff.heal });
    if (e.debuff.atk || e.debuff.heal) out.push({ memberId, name: e.name, kind: 'debuff', atk: e.debuff.atk, heal: e.debuff.heal });
  }
  return out;
}
export const statusKey = n => String(n).toLowerCase().replace(/\s+/g, ' ').trim();
const live = '(expires_at IS NULL OR expires_at > ?)';

export async function activeCount(db, memberId, exceptName) {
  return (await db.prepare(`SELECT count(*) AS total FROM statuses WHERE member_id = ? AND ${live} AND name_key != ?`).bind(memberId, new Date().toISOString(), exceptName ? statusKey(exceptName) : '').first()).total;
}
export async function checkRoom(db, memberId, name, who = 'You') {
  if ((await activeCount(db, memberId, name)) >= MAX_STATUS) fail(`${who} can only have ${MAX_STATUS} statuses at once.`, 409);
}
export async function applyStatus(db, memberId, s) {
  const now = new Date();
  await checkRoom(db, memberId, s.name, s.holderName || 'You');
  await db.prepare('DELETE FROM statuses WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(now.toISOString()).run();
  await db.prepare('DELETE FROM statuses WHERE member_id = ? AND name_key = ?').bind(memberId, statusKey(s.name)).run();
  const expires = s.minutes > 0 ? new Date(now.getTime() + s.minutes * 60000).toISOString() : null;
  await db.prepare('INSERT INTO statuses (id, member_id, name, name_key, icon, description, is_debuff, expires_at, source_id, created_at, st_type, st_cure, atk_bonus, heal_bonus) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(randomBytes(6).toString('hex'), memberId, s.name, statusKey(s.name), s.icon, s.description, s.isDebuff ? 1 : 0, expires, s.sourceId, now.toISOString(), s.type || '', s.cure || '', s.atk || 0, s.heal || 0).run();
}
export async function findActive(db, memberId, name, withCarried = true) {
  const row = await db.prepare(`SELECT id, name FROM statuses WHERE member_id = ? AND name_key = ? AND ${live} LIMIT 1`).bind(memberId, statusKey(name), new Date().toISOString()).first();
  if (row || !withCarried) return row;
  const k = statusKey(name), c = (await carriedRows(db, memberId)).find(r => statusKey(r.st_name) === k);   // a carried status counts for quest dialogue and requirements
  return c ? { id: 'carried', name: c.st_name } : null;
}
export async function removeByName(db, memberId, name) {
  await db.prepare('DELETE FROM statuses WHERE member_id = ? AND name_key = ?').bind(memberId, statusKey(name)).run();
}

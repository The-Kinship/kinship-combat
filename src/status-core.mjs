'use strict';
// Statuses (buffs and debuffs) on members. A status is copied onto the member with its own text, with an optional end time.
import { fail } from './engine.mjs';
import { randomBytes } from 'node:crypto';

export const MAX_STATUS = 6;
// A roll bonus a status gives to attacks and to heals. Only Advocates, their items and their quests can set one.
export const bonus = (v, name) => { if (v === undefined || v === null || v === '') return 0; if (!Number.isInteger(v) || v < -5 || v > 5) fail(`${name} must be a whole number from -5 to 5.`); return v; };
export async function rollBonuses(db, memberId) {
  const { results } = await db.prepare('SELECT name, atk_bonus, heal_bonus FROM statuses WHERE member_id = ? AND (atk_bonus != 0 OR heal_bonus != 0) AND (expires_at IS NULL OR expires_at > ?)').bind(memberId, new Date().toISOString()).all();
  return results.map(r => ({ label: r.name, atk: r.atk_bonus, heal: r.heal_bonus }));
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
export async function findActive(db, memberId, name) {
  return db.prepare(`SELECT id, name FROM statuses WHERE member_id = ? AND name_key = ? AND ${live} LIMIT 1`).bind(memberId, statusKey(name), new Date().toISOString()).first();
}
export async function removeByName(db, memberId, name) {
  await db.prepare('DELETE FROM statuses WHERE member_id = ? AND name_key = ?').bind(memberId, statusKey(name)).run();
}

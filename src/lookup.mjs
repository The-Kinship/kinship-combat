'use strict';
import { nameKey } from './items.mjs';

/** Finds a member by character name. Exact match first; otherwise a roster or in-game name that is a longer or shorter version of one
 *  registered name (for example "Sesen Silverborne" and "Sesen") is accepted when exactly one member fits. */
export async function findMember(db, name) {
  const key = nameKey(String(name ?? '').slice(0, 60));
  if (!key) return null;
  const exact = await db.prepare('SELECT id, name, name_key FROM members WHERE name_key = ?').bind(key).first();
  if (exact) return exact;
  const close = (await db.prepare('SELECT id, name, name_key FROM members').all()).results.filter(m => key.startsWith(m.name_key + ' ') || m.name_key.startsWith(key + ' '));
  return close.length === 1 ? close[0] : null;
}

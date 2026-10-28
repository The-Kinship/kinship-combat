'use strict';
// "Wipe the system": clears test data so the FC can start fresh. The characters named to keep stay registered (same sign-in and recovery
// code, same profile); every other character is removed with everything of theirs; all items, stashes, signs, mail, statuses, quest progress,
// gold history, duels, reports and encounters are cleared. Name nobody to keep and every character goes too (needs a stronger confirm phrase). Marks and bans are kept. Quests are only cleared if asked. Creation password only.
import { fail } from './engine.mjs';
import { str, removeMemberData, alphaGear, alphaCap, grantAlphaGold } from './items.mjs';
import { findMember } from './lookup.mjs';

export const KEEP_TABLES = ['members', 'players', 'profiles', 'marks', 'bans', 'settings'];
export const OPTIONAL_TABLES = ['quests'];
export const WIPE_TABLES = ['items', 'stashes', 'signs', 'gold_log', 'statuses', 'quest_progress', 'quest_claims', 'quest_fights', 'mails', 'worn', 'gear_notices', 'duels', 'reports', 'rooms', 'scenes', 'rate_limits'];
export const CONFIRM = 'WIPE EVERYTHING';
export const CONFIRM_ALL = 'WIPE ALL CHARACTERS';   // needed instead when nobody is kept

export async function handleWipe(request, db, path, { json, input, rate, ip, checkCreate }) {
  if (request.method === 'POST' && (path === '/system/admin/alpha' || path === '/system/admin/alpha-get')) {
    await rate(db, 'alpha-admin:' + ip, 20);
    const a = await input(request); checkCreate(a.adminPassword);
    if (path === '/system/admin/alpha') {
      if (typeof a.on !== 'boolean' && a.maxCharacters === undefined) fail('Say whether alpha mode is on or off.');
      if (typeof a.on === 'boolean') await db.prepare("INSERT INTO settings (key, value) VALUES ('alpha_gear', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(a.on ? '1' : '0').run();
    }
    if (path === '/system/admin/alpha' && a.maxCharacters !== undefined) {
      if (!Number.isInteger(a.maxCharacters) || a.maxCharacters < 0 || a.maxCharacters > 500) fail('The character limit must be a whole number from 0 to 500 (0 means no limit).');
      await db.prepare("INSERT INTO settings (key, value) VALUES ('alpha_max_chars', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(a.maxCharacters)).run();
    }
    const granted = path === '/system/admin/alpha' && a.on ? await grantAlphaGold(db) : 0;
    const characters = (await db.prepare('SELECT count(*) AS n FROM members').first()).n;
    return json({ alphaGear: await alphaGear(db), granted, maxCharacters: await alphaCap(db), characters });
  }
  if (request.method !== 'POST' || (path !== '/system/admin/wipe' && path !== '/system/admin/wipe-check')) fail('Endpoint not found.', 404);
  await rate(db, 'wipe-admin:' + ip, 10);
  const d = await input(request); checkCreate(d.adminPassword);
  if (!Array.isArray(d.keep) || d.keep.length > 12) fail('Name the characters to keep (up to 12), or leave the list empty to remove everyone.');
  const keep = [], missing = [];
  for (const n of d.keep) { const m = await findMember(db, str(n, 'Character name', 60)); if (m) keep.push(m); else missing.push(String(n).slice(0, 40)); }
  if (missing.length) fail(`Nobody is registered as: ${missing.join(', ')}. Nothing was changed.`, 404);
  const keepIds = new Set(keep.map(m => m.id)), withQuests = d.quests === true;
  const all = (await db.prepare('SELECT id, name, player_id FROM members').all()).results;
  const others = all.filter(m => !keepIds.has(m.id));
  const tables = withQuests ? [...WIPE_TABLES, ...OPTIONAL_TABLES] : WIPE_TABLES;

  if (path === '/system/admin/wipe-check') {
    const counts = {};
    for (const t of tables) if (t !== 'rate_limits') counts[t] = (await db.prepare(`SELECT count(*) AS n FROM ${t}`).first()).n;
    return json({ wipe: { keep: keep.map(m => m.name), remove: others.map(m => m.name), counts, done: false } });
  }
  const phrase = keep.length ? CONFIRM : CONFIRM_ALL;
  if (d.confirm !== phrase) fail(`Type ${phrase} to confirm.`);
  for (const m of others) await removeMemberData(db, m);
  for (const t of tables) await db.prepare(`DELETE FROM ${t}`).run();
  await db.prepare('UPDATE members SET gold = 0').run();
  return json({ wipe: { keep: keep.map(m => m.name), remove: others.map(m => m.name), counts: {}, done: true } });
}

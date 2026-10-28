'use strict';
// "Wipe the system": clears test data so the FC can start fresh. The characters named to keep stay registered (same sign-in and recovery
// code, same profile); every other character is removed with everything of theirs; all items, stashes, signs, mail, statuses, quest progress,
// gold history, duels, reports and encounters are cleared. Marks and bans are kept. Quests are only cleared if asked. Creation password only.
import { fail } from './engine.mjs';
import { str, removeMemberData } from './items.mjs';
import { findMember } from './lookup.mjs';

export const KEEP_TABLES = ['members', 'players', 'profiles', 'marks', 'bans'];
export const OPTIONAL_TABLES = ['quests'];
export const WIPE_TABLES = ['items', 'stashes', 'signs', 'gold_log', 'statuses', 'quest_progress', 'quest_claims', 'quest_fights', 'mails', 'worn', 'gear_notices', 'duels', 'reports', 'rooms', 'scenes', 'rate_limits'];
export const CONFIRM = 'WIPE EVERYTHING';

export async function handleWipe(request, db, path, { json, input, rate, ip, checkCreate }) {
  if (request.method !== 'POST' || (path !== '/system/admin/wipe' && path !== '/system/admin/wipe-check')) fail('Endpoint not found.', 404);
  await rate(db, 'wipe-admin:' + ip, 10);
  const d = await input(request); checkCreate(d.adminPassword);
  if (!Array.isArray(d.keep) || d.keep.length < 1 || d.keep.length > 12) fail('Name the characters to keep (at least one, up to 12).');
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
  if (d.confirm !== CONFIRM) fail(`Type ${CONFIRM} to confirm.`);
  for (const m of others) await removeMemberData(db, m);
  for (const t of tables) await db.prepare(`DELETE FROM ${t}`).run();
  await db.prepare('UPDATE members SET gold = 0').run();
  return json({ wipe: { keep: keep.map(m => m.name), remove: others.map(m => m.name), counts: {}, done: true } });
}

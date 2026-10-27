'use strict';
// Infringement tracker (Advocates only, creation password): marks against a character name, removing someone from the system, and bans.
// Marks and bans are kept by character name, so they survive the character being removed. A ban stops those names from registering again;
// someone could still register a different name with the member password, so changing that password is the hard stop.
import { fail } from './engine.mjs';
import { str, nameKey, removeMemberData } from './items.mjs';
import { findMember } from './lookup.mjs';

const now = () => new Date().toISOString();

async function resolve(db, name) {
  const given = str(name, 'Character name', 60), member = await findMember(db, given);
  if (member) return { key: member.name_key, name: member.name, member };
  const key = nameKey(given);
  const known = await db.prepare('SELECT name FROM marks WHERE name_key = ? UNION SELECT name FROM bans WHERE name_key = ?').bind(key, key).first();
  if (known) return { key, name: known.name, member: null };
  fail('Nobody is registered under that name, and nothing is recorded against it.', 404);
}
const addMark = (db, key, name, reason) => db.prepare('INSERT INTO marks (name_key, name, reason, created_at) VALUES (?,?,?,?)').bind(key, name, reason, now()).run();

/** Everyone who shares the player (the same recovery code) with this member, this member included. */
async function siblings(db, member) {
  const row = await db.prepare('SELECT player_id FROM members WHERE id = ?').bind(member.id).first();
  return (await db.prepare('SELECT id, name, name_key, player_id FROM members WHERE player_id = ?').bind(row.player_id).all()).results;
}

export async function handleMarks(request, db, path, { json, input, rate, ip, checkCreate }) {
  if (request.method !== 'POST' || !path.startsWith('/marks/admin/')) fail('Endpoint not found.', 404);
  await rate(db, 'marks-admin:' + ip, 60);
  const d = await input(request); checkCreate(d.adminPassword);

  if (path === '/marks/admin/list') {
    const marks = (await db.prepare('SELECT * FROM marks ORDER BY name_key, id').all()).results;
    const bans = (await db.prepare('SELECT * FROM bans ORDER BY name_key').all()).results;
    const members = (await db.prepare('SELECT name_key FROM members').all()).results.map(m => m.name_key);
    const people = new Map();
    const at = (key, name) => { if (!people.has(key)) people.set(key, { name, banned: false, banReason: '', registered: members.includes(key), marks: [] }); return people.get(key); };
    for (const m of marks) at(m.name_key, m.name).marks.push({ id: m.id, reason: m.reason, createdAt: m.created_at });
    for (const b of bans) { const p = at(b.name_key, b.name); p.banned = true; p.banReason = b.reason; }
    return json({ people: [...people.values()] });
  }
  if (path === '/marks/admin/add') {
    const who = await resolve(db, d.name), reason = str(d.reason, 'Reason', 200);
    await addMark(db, who.key, who.name, reason);
    return json({ added: true, name: who.name }, 201);
  }
  if (path === '/marks/admin/remove') {
    const r = await db.prepare('DELETE FROM marks WHERE id = ?').bind(Number(d.id)).run();
    if (r.meta.changes !== 1) fail('That mark is already gone.', 404);
    return json({ removed: true });
  }
  if (path === '/marks/admin/kick' || path === '/marks/admin/ban') {
    const ban = path.endsWith('/ban'), who = await resolve(db, d.name), reason = str(d.reason, 'Reason', 200);
    const people = who.member ? await siblings(db, who.member) : [];
    await addMark(db, who.key, who.name, (ban ? 'Banned: ' : 'Removed from the system: ') + reason);
    if (ban) for (const k of new Map([[who.key, who.name], ...people.map(m => [m.name_key, m.name])])) await db.prepare('INSERT OR REPLACE INTO bans (name_key, name, reason, created_at) VALUES (?,?,?,?)').bind(k[0], k[1], reason, now()).run();
    for (const m of people) await removeMemberData(db, m);
    return json({ removed: people.map(m => m.name), banned: ban });
  }
  if (path === '/marks/admin/unban') {
    const key = nameKey(str(d.name, 'Character name', 60));
    let row = await db.prepare('SELECT name_key FROM bans WHERE name_key = ?').bind(key).first();
    if (!row) { const close = (await db.prepare('SELECT name_key FROM bans').all()).results.filter(b => b.name_key.startsWith(key + ' ') || key.startsWith(b.name_key + ' ')); row = close.length === 1 ? close[0] : null; }
    if (!row) fail('That name is not banned.', 404);
    await db.prepare('DELETE FROM bans WHERE name_key = ?').bind(row.name_key).run();
    return json({ unbanned: true });
  }
  fail('Endpoint not found.', 404);
}

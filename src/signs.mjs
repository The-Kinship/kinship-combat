'use strict';
// Signs & markers: a named note left at a spot in the world. Everyone can find them and read them when close.
// Standing close enough is checked by the plugin. The server keeps the data and the limits.
import { fail } from './engine.mjs';
import { who, rand, str } from './items.mjs';
import { amountOf, spend, earn, MAX_BALANCE } from './bank.mjs';

const MAX_PER_MEMBER = 10, MAX_SIGNS = 500;
const num = (v, name, lim) => { if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > lim) fail(`${name} is not valid.`); return Math.round(v * 100) / 100; };
function place(d) {
  if (!Number.isInteger(d.territory) || d.territory < 0 || d.territory > 65535) fail('That zone is not valid.');
  if (!Number.isInteger(d.map) || d.map < 0 || d.map > 1000000) fail('That map is not valid.');
  return { zone: str(d.zone, 'Zone', 80, false), territory: d.territory, map: d.map, x: num(d.x, 'Position', 20000), y: num(d.y, 'Position', 20000), z: num(d.z, 'Position', 20000), mapX: num(d.mapX, 'Map position', 500), mapY: num(d.mapY, 'Map position', 500) };
}
const SELECT = 'SELECT s.*, m.name AS owner_name FROM signs s LEFT JOIN members m ON m.id = s.owner_id';
// The list leaves the text out so it stays small; the text comes with a single sign.
const sv = (r, meId, withText) => ({ id: r.id, name: r.name, zone: r.zone, territory: r.territory, map: r.map_id, x: r.x, y: r.y, z: r.z, mapX: r.map_x, mapY: r.map_y, ownerName: r.owner_name || '(removed)', mine: r.owner_id === meId, ...(withText ? { description: r.description, gold: r.gold || 0 } : {}) });

export async function handleSigns(request, db, path, { json, input, rate, ip, checkCreate }) {
  const post = request.method === 'POST';

  if (post && path === '/signs/admin/delete') {
    await rate(db, 'signs-admin:' + ip, 30);
    const d = await input(request); checkCreate(d.adminPassword);
    const sid = str(d.signId, 'Sign', 20), gone = await db.prepare('SELECT owner_id, name, gold FROM signs WHERE id = ?').bind(sid).first();
    const r = await db.prepare('DELETE FROM signs WHERE id = ?').bind(sid).run();
    if (r.meta.changes !== 1) fail('That sign no longer exists.', 404);
    if (gone && gone.gold > 0) await earn(db, gone.owner_id, gone.gold, `Returned from ${gone.name}`, true);
    return json({ deleted: true });
  }

  const me = await who(db, request);

  if (!post && path === '/signs') {
    const { results } = await db.prepare(SELECT + ' ORDER BY s.zone, s.name LIMIT 500').all();
    return json({ signs: results.map(r => sv(r, me.id, false)) });
  }
  if (post && path === '/signs') {
    await rate(db, 'sign-create:' + me.id, 20);
    const d = await input(request), p = place(d), name = str(d.name, 'Sign name', 40), description = str(d.description, 'Text', 1000);
    if ((await db.prepare('SELECT count(*) AS total FROM signs WHERE owner_id = ?').bind(me.id).first()).total >= MAX_PER_MEMBER) fail(`You can have ${MAX_PER_MEMBER} signs. Delete one first.`, 409);
    if ((await db.prepare('SELECT count(*) AS total FROM signs').first()).total >= MAX_SIGNS) fail('The sign system is full.', 503);
    const gold = d.gold === undefined || d.gold === null || d.gold === 0 ? 0 : amountOf(d.gold);
    const id = rand(6);
    if (gold > 0 && !(await spend(db, me.id, gold, `Left at the sign ${name}`))) fail('You do not have that much gold.', 409);
    await db.prepare('INSERT INTO signs (id, owner_id, name, description, zone, territory, map_id, x, y, z, map_x, map_y, gold, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, me.id, name, description, p.zone, p.territory, p.map, p.x, p.y, p.z, p.mapX, p.mapY, gold, new Date().toISOString()).run();
    return json({ sign: sv(await db.prepare(SELECT + ' WHERE s.id = ?').bind(id).first(), me.id, true) }, 201);
  }

  const m = path.match(/^\/signs\/([a-f0-9]{12})(?:\/(update|delete|claim))?$/);
  if (!m) fail('Endpoint not found.', 404);
  const [, id, route] = m;
  const row = await db.prepare(SELECT + ' WHERE s.id = ?').bind(id).first();
  if (!row) fail('That sign does not exist.', 404);

  if (!post && !route) return json({ sign: sv(row, me.id, true) });
  if (!post) fail('Endpoint not found.', 404);
  if (route === 'claim') {
    await rate(db, 'sign-claim:' + me.id, 20);
    const amount = row.gold || 0;
    if (amount <= 0) fail('There is nothing here to take.', 409);
    const grab = await db.prepare('UPDATE signs SET gold = 0 WHERE id = ? AND gold = ?').bind(id, amount).run();
    if (grab.meta.changes !== 1) fail('Someone got here first.', 409);
    if (!(await earn(db, me.id, amount, row.owner_id === me.id ? `Taken back from ${row.name}` : `Found at the sign ${row.name}`))) {
      await db.prepare('UPDATE signs SET gold = gold + ? WHERE id = ?').bind(amount, id).run();
      fail('You cannot carry that much gold.', 409);
    }
    return json({ claimed: amount, sign: sv(await db.prepare(SELECT + ' WHERE s.id = ?').bind(id).first(), me.id, true) });
  }
  if (row.owner_id !== me.id) fail('Only the person who made a sign can change it.', 403);

  if (route === 'delete') {
    await db.prepare('DELETE FROM signs WHERE id = ?').bind(id).run();
    if (row.gold > 0) await earn(db, row.owner_id, row.gold, `Returned from ${row.name}`, true);
    return json({ deleted: true });
  }
  const d = await input(request);
  const name = d.name === undefined ? row.name : str(d.name, 'Sign name', 40);
  const description = d.description === undefined ? row.description : str(d.description, 'Text', 1000);
  if (d.territory !== undefined) {
    const p = place(d);
    await db.prepare('UPDATE signs SET name=?, description=?, zone=?, territory=?, map_id=?, x=?, y=?, z=?, map_x=?, map_y=? WHERE id=?').bind(name, description, p.zone, p.territory, p.map, p.x, p.y, p.z, p.mapX, p.mapY, id).run();
  } else await db.prepare('UPDATE signs SET name=?, description=? WHERE id=?').bind(name, description, id).run();
  return json({ sign: sv(await db.prepare(SELECT + ' WHERE s.id = ?').bind(id).first(), me.id, true) });
}

'use strict';
// Stashes: a named spot in the world that holds items. Everyone can see public ones; private ones are for the owner only.
// Position rules (not in an instance, standing close enough) are checked by the plugin. The server keeps the data and the item rules.
import { fail } from './engine.mjs';
import { who, rand, str, view, inventory, CAP, ITEM_SELECT } from './items.mjs';

const STASH_CAP = 20, MAX_PER_MEMBER = 3, MAX_STASHES = 300;
const num = (v, name, lim) => { if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > lim) fail(`${name} is not valid.`); return Math.round(v * 100) / 100; };
function place(d) {
  if (!Number.isInteger(d.territory) || d.territory < 0 || d.territory > 65535) fail('That zone is not valid.');
  if (!Number.isInteger(d.map) || d.map < 0 || d.map > 1000000) fail('That map is not valid.');
  return { zone: str(d.zone, 'Zone', 80, false), territory: d.territory, map: d.map, x: num(d.x, 'Position', 20000), y: num(d.y, 'Position', 20000), z: num(d.z, 'Position', 20000), mapX: num(d.mapX, 'Map position', 500), mapY: num(d.mapY, 'Map position', 500) };
}
const SELECT = "SELECT s.*, m.name AS owner_name, (SELECT count(*) FROM items WHERE owner_id = 's' || s.id) AS count FROM stashes s LEFT JOIN members m ON m.id = s.owner_id";
const sv = (r, meId) => ({ id: r.id, name: r.name, zone: r.zone, territory: r.territory, map: r.map_id, x: r.x, y: r.y, z: r.z, mapX: r.map_x, mapY: r.map_y, ownerName: r.owner_name || '(removed)', mine: r.owner_id === meId, isPrivate: !!r.is_private, count: r.count, capacity: STASH_CAP });

async function open(db, id, me) {
  const r = await db.prepare(SELECT + ' WHERE s.id = ?').bind(id).first();
  if (!r || (r.is_private && r.owner_id !== me.id)) fail('That stash does not exist.', 404);
  return r;
}
async function contents(db, id, me) {
  const { results } = await db.prepare(ITEM_SELECT + ' WHERE i.owner_id = ? ORDER BY i.created_at, i.rowid').bind('s' + id).all();
  return results.map(r => view(r, me.id));
}
async function answer(json, db, id, me, status = 200) {
  const r = await open(db, id, me);
  return json({ stash: sv(r, me.id), stashItems: await contents(db, id, me), items: await inventory(db, me.id), capacity: CAP }, status);
}

export async function handleStashes(request, db, path, { json, input, rate }) {
  const me = await who(db, request), post = request.method === 'POST';

  if (!post && path === '/stashes') {
    const { results } = await db.prepare(SELECT + ' WHERE s.is_private = 0 OR s.owner_id = ? ORDER BY s.zone, s.name LIMIT 300').bind(me.id).all();
    return json({ stashes: results.map(r => sv(r, me.id)) });
  }
  if (post && path === '/stashes') {
    await rate(db, 'stash-create:' + me.id, 10);
    const d = await input(request), p = place(d), name = str(d.name, 'Stash name', 40);
    if ((await db.prepare('SELECT count(*) AS total FROM stashes WHERE owner_id = ?').bind(me.id).first()).total >= MAX_PER_MEMBER) fail(`You can have ${MAX_PER_MEMBER} stashes. Delete one first.`, 409);
    if ((await db.prepare('SELECT count(*) AS total FROM stashes').first()).total >= MAX_STASHES) fail('The stash system is full.', 503);
    const id = rand(6);
    await db.prepare('INSERT INTO stashes (id, owner_id, name, zone, territory, map_id, x, y, z, map_x, map_y, is_private, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, me.id, name, p.zone, p.territory, p.map, p.x, p.y, p.z, p.mapX, p.mapY, d.isPrivate === true ? 1 : 0, new Date().toISOString()).run();
    return answer(json, db, id, me, 201);
  }

  const m = path.match(/^\/stashes\/([a-f0-9]{12})(?:\/(update|delete|put|take))?$/);
  if (!m) fail('Endpoint not found.', 404);
  const [, id, route] = m;

  if (!post && !route) return answer(json, db, id, me);
  if (!post) fail('Endpoint not found.', 404);
  const stash = await open(db, id, me);

  if (route === 'update') {
    if (stash.owner_id !== me.id) fail('Only the owner can change a stash.', 403);
    const d = await input(request);
    const name = d.name === undefined ? stash.name : str(d.name, 'Stash name', 40);
    const priv = d.isPrivate === undefined ? stash.is_private : (d.isPrivate === true ? 1 : 0);
    if (d.territory !== undefined) {
      const p = place(d);
      await db.prepare('UPDATE stashes SET name=?, is_private=?, zone=?, territory=?, map_id=?, x=?, y=?, z=?, map_x=?, map_y=? WHERE id=?').bind(name, priv, p.zone, p.territory, p.map, p.x, p.y, p.z, p.mapX, p.mapY, id).run();
    } else await db.prepare('UPDATE stashes SET name=?, is_private=? WHERE id=?').bind(name, priv, id).run();
    return answer(json, db, id, me);
  }
  if (route === 'delete') {
    if (stash.owner_id !== me.id) fail('Only the owner can delete a stash.', 403);
    if (stash.count > 0) fail('Take everything out of the stash first.', 409);
    await db.prepare('DELETE FROM stashes WHERE id = ?').bind(id).run();
    return json({ deleted: true });
  }
  await rate(db, 'stash-move:' + me.id, 60);
  const d = await input(request), itemId = str(d.itemId, 'Item', 20), key = 's' + id;
  if (route === 'put') {
    const r = await db.prepare('UPDATE items SET owner_id = ? WHERE id = ? AND owner_id = ? AND (SELECT count(*) FROM items WHERE owner_id = ?) < ?').bind(key, itemId, me.id, key, STASH_CAP).run();
    if (r.meta.changes !== 1) {
      if (!(await db.prepare('SELECT id FROM items WHERE id = ? AND owner_id = ?').bind(itemId, me.id).first())) fail('That item is not in your inventory.', 404);
      fail(`The stash is full (${STASH_CAP} items).`, 409);
    }
  } else {
    const r = await db.prepare('UPDATE items SET owner_id = ? WHERE id = ? AND owner_id = ? AND (SELECT count(*) FROM items WHERE owner_id = ?) < ?').bind(me.id, itemId, key, me.id, CAP).run();
    if (r.meta.changes !== 1) {
      if (!(await db.prepare('SELECT id FROM items WHERE id = ? AND owner_id = ?').bind(itemId, key).first())) fail('That item is not in the stash.', 404);
      fail(`Your inventory is full (${CAP} items).`, 409);
    }
  }
  return answer(json, db, id, me);
}

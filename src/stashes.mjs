'use strict';
// Stashes: a named spot in the world that holds items. Everyone can see public ones; private ones are for the owner only.
// Position rules (not in an instance, standing close enough) are checked by the plugin. The server keeps the data and the item rules.
import { fail } from './engine.mjs';
import { who, rand, str, inventory, stackViews, ownerRows, stacks, fits, unitRow, groupIds, CAP, STACK } from './items.mjs';
import { amountOf, spend, earn, MAX_BALANCE } from './bank.mjs';
import { positionOf, isNear, mustBeNear, zoneCounts, NEARBY } from './nearby.mjs';

const STASH_CAP = 20, MAX_PER_MEMBER = 3, MAX_STASHES = 300;
const num = (v, name, lim) => { if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > lim) fail(`${name} is not valid.`); return Math.round(v * 100) / 100; };
function place(d) {
  if (!Number.isInteger(d.territory) || d.territory < 0 || d.territory > 65535) fail('That zone is not valid.');
  if (!Number.isInteger(d.map) || d.map < 0 || d.map > 1000000) fail('That map is not valid.');
  return { zone: str(d.zone, 'Zone', 80, false), territory: d.territory, map: d.map, x: num(d.x, 'Position', 20000), y: num(d.y, 'Position', 20000), z: num(d.z, 'Position', 20000), mapX: num(d.mapX, 'Map position', 500), mapY: num(d.mapY, 'Map position', 500) };
}
const SELECT = "SELECT s.*, m.name AS owner_name, (SELECT count(*) FROM items WHERE owner_id = 's' || s.id) AS count FROM stashes s LEFT JOIN members m ON m.id = s.owner_id";
const sv = (r, meId) => ({ id: r.id, name: r.name, zone: r.zone, territory: r.territory, map: r.map_id, x: r.x, y: r.y, z: r.z, mapX: r.map_x, mapY: r.map_y, ownerName: r.owner_name || '(removed)', mine: r.owner_id === meId, isPrivate: !!r.is_private, count: r.count, gold: r.gold || 0, capacity: STASH_CAP });

async function open(db, id, me, pos) {
  const r = await db.prepare(SELECT + ' WHERE s.id = ?').bind(id).first();
  if (!r || (r.is_private && r.owner_id !== me.id)) fail('That stash does not exist.', 404);
  if (r.owner_id !== me.id) mustBeNear(r, pos, 'stash');   // other people's stashes only open when you are standing at them
  return r;
}
async function contents(db, id, me) {
  return stackViews(await ownerRows(db, 's' + id), me.id);
}
async function answer(json, db, id, me, pos, status = 200) {
  const r = await open(db, id, me, pos), stashItems = await contents(db, id, me);
  r.count = stashItems.length;
  return json({ stash: sv(r, me.id), stashItems, items: await inventory(db, me.id), capacity: CAP }, status);
}

export async function handleStashes(request, db, path, { json, input: readBody, rate }) {
  const me = await who(db, request), post = request.method === 'POST', url = new URL(request.url);
  let body;
  const input = async () => (body ??= await readBody(request));   // the body can only be read once, and the position is in it
  const pos = () => positionOf(url, body);

  if (!post && path === '/stashes') {
    // You see your own stashes, and other people's only when you are close. For the rest you only get how many there are in each zone.
    const here = pos();
    const { results: all } = await db.prepare(SELECT + ' WHERE s.is_private = 0 OR s.owner_id = ? ORDER BY s.zone, s.name LIMIT 300').bind(me.id).all();
    const shown = all.filter(r => r.owner_id === me.id || isNear(r, here, NEARBY));
    const elsewhere = all.filter(r => r.owner_id !== me.id && !isNear(r, here, NEARBY));
    for (const r of shown) r.count = (await contents(db, r.id, me)).length;   // slots used, not single items
    return json({ stashes: shown.map(r => sv(r, me.id)), zones: zoneCounts(elsewhere), elsewhere: elsewhere.length });
  }
  if (post && path === '/stashes') {
    await rate(db, 'stash-create:' + me.id, 10);
    const d = await input(), p = place(d), name = str(d.name, 'Stash name', 40);
    if ((await db.prepare('SELECT count(*) AS total FROM stashes WHERE owner_id = ?').bind(me.id).first()).total >= MAX_PER_MEMBER) fail(`You can have ${MAX_PER_MEMBER} stashes. Delete one first.`, 409);
    if ((await db.prepare('SELECT count(*) AS total FROM stashes').first()).total >= MAX_STASHES) fail('The stash system is full.', 503);
    const id = rand(6);
    await db.prepare('INSERT INTO stashes (id, owner_id, name, zone, territory, map_id, x, y, z, map_x, map_y, is_private, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, me.id, name, p.zone, p.territory, p.map, p.x, p.y, p.z, p.mapX, p.mapY, d.isPrivate === true ? 1 : 0, new Date().toISOString()).run();
    return answer(json, db, id, me, pos(), 201);
  }

  const m = path.match(/^\/stashes\/([a-f0-9]{12})(?:\/(update|delete|put|take|put-gold|take-gold))?$/);
  if (!m) fail('Endpoint not found.', 404);
  const [, id, route] = m;

  if (!post && !route) return answer(json, db, id, me, pos());
  if (!post) fail('Endpoint not found.', 404);
  if (post) await input();   // read the body first: it carries the position
  const stash = await open(db, id, me, pos());

  if (route === 'update') {
    if (stash.owner_id !== me.id) fail('Only the owner can change a stash.', 403);
    const d = await input();
    const name = d.name === undefined ? stash.name : str(d.name, 'Stash name', 40);
    const priv = d.isPrivate === undefined ? stash.is_private : (d.isPrivate === true ? 1 : 0);
    if (d.territory !== undefined) {
      const p = place(d);
      await db.prepare('UPDATE stashes SET name=?, is_private=?, zone=?, territory=?, map_id=?, x=?, y=?, z=?, map_x=?, map_y=? WHERE id=?').bind(name, priv, p.zone, p.territory, p.map, p.x, p.y, p.z, p.mapX, p.mapY, id).run();
    } else await db.prepare('UPDATE stashes SET name=?, is_private=? WHERE id=?').bind(name, priv, id).run();
    return answer(json, db, id, me, pos());
  }
  if (route === 'delete') {
    if (stash.owner_id !== me.id) fail('Only the owner can delete a stash.', 403);
    if (stash.count > 0 || stash.gold > 0) fail('Take everything out of the stash first.', 409);
    await db.prepare('DELETE FROM stashes WHERE id = ?').bind(id).run();
    return json({ deleted: true });
  }
  if (route === 'put-gold' || route === 'take-gold') {
    await rate(db, 'stash-gold:' + me.id, 30);
    const amount = amountOf((await input()).amount);
    if (route === 'put-gold') {
      if (stash.gold + amount > MAX_BALANCE) fail('That stash cannot hold that much gold.', 409);
      if (!(await spend(db, me.id, amount, `Put in ${stash.name}`))) fail('You do not have that much gold.', 409);
      const r = await db.prepare('UPDATE stashes SET gold = gold + ? WHERE id = ? AND gold + ? <= ?').bind(amount, id, amount, MAX_BALANCE).run();
      if (r.meta.changes !== 1) { await earn(db, me.id, amount, `Returned from ${stash.name}`, true); fail('That stash cannot hold that much gold.', 409); }
    } else {
      const r = await db.prepare('UPDATE stashes SET gold = gold - ? WHERE id = ? AND gold >= ?').bind(amount, id, amount).run();
      if (r.meta.changes !== 1) fail(`The stash only has ${stash.gold} gold.`, 409);
      if (!(await earn(db, me.id, amount, `Took from ${stash.name}`))) {
        await db.prepare('UPDATE stashes SET gold = gold + ? WHERE id = ?').bind(amount, id).run();
        fail('You cannot carry that much gold.', 409);
      }
    }
    return answer(json, db, id, me, pos());
  }
  await rate(db, 'stash-move:' + me.id, 60);
  const d = await input(), itemId = str(d.itemId, 'Item', 20), key = 's' + id;
  const count = d.count === undefined ? 1 : d.count;
  if (!Number.isInteger(count) || count < 1 || count > 100) fail('Choose how many, from 1 to 100.');
  const [from, to, cap, toName] = route === 'put' ? [me.id, key, STASH_CAP, 'The stash'] : [key, me.id, CAP, 'Your inventory'];
  const unit = await unitRow(db, itemId, from);
  if (!unit) fail(route === 'put' ? 'That item is not in your inventory.' : 'That item is not in the stash.', 404);
  const group = await groupIds(db, from, itemId);
  if (count > group.length) fail(`There are only ${group.length}.`, 409);
  const units = [itemId, ...group.filter(x => x !== itemId)].slice(0, count);
  const rows = (await ownerRows(db, from)).filter(r => units.includes(r.id));
  if (!(await fits(db, to, cap, { add: rows }))) fail(`${toName} is full (${cap} slots).`, 409);
  for (const u of units) {
    const r = await db.prepare('UPDATE items SET owner_id = ? WHERE id = ? AND owner_id = ? AND (SELECT count(*) FROM items WHERE owner_id = ?) < ?').bind(to, u, from, to, cap * STACK).run();
    if (r.meta.changes !== 1) fail(`${toName} is full (${cap} slots).`, 409);
  }
  return answer(json, db, id, me, pos());
}

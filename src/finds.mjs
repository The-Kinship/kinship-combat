'use strict';
// World items ("finds"): a spot in the world that holds a copy of one of your items, like a herb growing by a tree.
// Anyone who walks up can pick one up. Modes: once (the first person takes it and it is gone), timer (back after a wait), always (never runs out).
// Standing close enough is checked by the plugin, like stashes and signs. The server keeps the data and the limits.
import { fail } from './engine.mjs';
import { who, rand, str, inventory, ownerSlots, CAP } from './items.mjs';
import { roomOf, positionOf, isNear, mustBeNear, NEARBY } from './nearby.mjs';

const MAX_PER_MEMBER = 20, MAX_FINDS = 400, MODES = ['once', 'timer', 'always'], MAX_MINUTES = 10080;
// The parts of an item a find hands out a copy of.
const COPY = ['name', 'icon', 'description', 'flavor', 'use_label', 'use_text', 'consumable', 'requires', 'requires_consume', 'st_name', 'st_desc', 'st_icon', 'st_debuff', 'st_minutes', 'cures', 'recipe', 'st_type', 'st_cure', 'starts_quest', 'st_atk', 'st_heal', 'wear_slot', 'gear_atk', 'gear_heal', 'lifespan_days'];
const num = (v, name, lim) => { if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > lim) fail(`${name} is not valid.`); return Math.round(v * 100) / 100; };
function place(d) {
  if (!Number.isInteger(d.territory) || d.territory < 0 || d.territory > 65535) fail('That zone is not valid.');
  if (!Number.isInteger(d.map) || d.map < 0 || d.map > 1000000) fail('That map is not valid.');
  return { room: roomOf(d.room), zone: str(d.zone, 'Zone', 80, false), territory: d.territory, map: d.map, x: num(d.x, 'Position', 20000), y: num(d.y, 'Position', 20000), z: num(d.z, 'Position', 20000), mapX: num(d.mapX, 'Map position', 500), mapY: num(d.mapY, 'Map position', 500) };
}
const SELECT = 'SELECT f.*, m.name AS creator_name FROM finds f LEFT JOIN members m ON m.id = f.creator_id';
const waiting = (r, now) => r.mode === 'once' ? r.taken === 1 : !!r.available_at && r.available_at > now;
const view = (r, meId, now) => {
  const item = JSON.parse(r.item), mine = r.creator_id === meId, wait = waiting(r, now);
  return { id: r.id, label: r.label, text: r.text, mode: r.mode, minutes: r.minutes, zone: r.zone, territory: r.territory, room: r.room || '', map: r.map_id, x: r.x, y: r.y, z: r.z, mapX: r.map_x, mapY: r.map_y,
    mine, state: wait ? (r.mode === 'once' ? 'gone' : 'waiting') : 'ready',
    secondsLeft: wait && r.mode === 'timer' ? Math.max(1, Math.ceil((new Date(r.available_at) - new Date(now)) / 1000)) : 0,
    ...(mine ? { itemName: item.name, itemIcon: item.icon } : {}) };
};

export async function handleFinds(request, db, path, { json, input, rate }) {
  const post = request.method === 'POST';
  const me = await who(db, request);
  const now = new Date().toISOString();

  if (!post && path === '/finds') {
    // Yours (all of them, with what state they are in), and other people's only when you are close and they are ready to pick up.
    const here = positionOf(new URL(request.url), null);
    const { results } = await db.prepare(SELECT + ' ORDER BY f.zone, f.label LIMIT 500').all();
    const shown = results.filter(r => r.creator_id === me.id || (isNear(r, here, NEARBY) && !waiting(r, now)));
    return json({ finds: shown.map(r => view(r, me.id, now)) });
  }
  if (post && path === '/finds') {
    await rate(db, 'find-create:' + me.id, 20);
    const d = await input(request), p = place(d), label = str(d.label, 'What it looks like', 40), text = str(d.text, 'Text', 300, false);
    if (!MODES.includes(d.mode)) fail('Choose once, timer or always.');
    let minutes = 0;
    if (d.mode === 'timer') { minutes = d.minutes === undefined ? 20 : d.minutes; if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) fail(`The wait can be from 1 minute to ${MAX_MINUTES} minutes.`); }
    const src = await db.prepare('SELECT * FROM items WHERE id = ? AND owner_id = ?').bind(str(d.itemId, 'Item', 20), me.id).first();
    if (!src) fail('Choose one of the items in your inventory.', 404);
    if ((await db.prepare('SELECT count(*) AS total FROM finds WHERE creator_id = ?').bind(me.id).first()).total >= MAX_PER_MEMBER) fail(`You can have ${MAX_PER_MEMBER} world items. Delete one first.`, 409);
    if ((await db.prepare('SELECT count(*) AS total FROM finds').first()).total >= MAX_FINDS) fail('There are too many world items.', 503);
    const item = {}; for (const k of COPY) item[k] = src[k];
    const id = rand(6);
    await db.prepare('INSERT INTO finds (id, creator_id, label, text, mode, minutes, item, zone, territory, map_id, room, x, y, z, map_x, map_y, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, me.id, label, text, d.mode, minutes, JSON.stringify(item), p.zone, p.territory, p.map, p.room, p.x, p.y, p.z, p.mapX, p.mapY, now).run();
    return json({ find: view(await db.prepare(SELECT + ' WHERE f.id = ?').bind(id).first(), me.id, now) }, 201);
  }

  const m = path.match(/^\/finds\/([a-f0-9]{12})\/(pickup|delete|reset)$/);
  if (!m || !post) fail('Endpoint not found.', 404);
  const [, id, route] = m;
  const row = await db.prepare(SELECT + ' WHERE f.id = ?').bind(id).first();
  if (!row) fail('That is no longer here.', 404);

  if (route === 'delete' || route === 'reset') {
    if (row.creator_id !== me.id) fail('Only the person who placed it can change it.', 403);
    if (route === 'delete') await db.prepare('DELETE FROM finds WHERE id = ?').bind(id).run();
    else await db.prepare('UPDATE finds SET taken = 0, available_at = NULL WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  // pickup
  const d = await input(request);
  mustBeNear(row, positionOf(new URL(request.url), d), 'spot');
  await rate(db, 'find-pickup:' + me.id, 30);
  if (waiting(row, now)) fail(row.mode === 'once' ? 'There is nothing left here.' : 'Nothing is here right now. Try again later.', 409);
  // Claim it first (so two people can't both take the last one), then hand over the copy.
  let claimed = true;
  if (row.mode === 'once') claimed = (await db.prepare('UPDATE finds SET taken = 1 WHERE id = ? AND taken = 0').bind(id).run()).meta.changes === 1;
  else if (row.mode === 'timer') {
    const back = new Date(Date.now() + row.minutes * 60000).toISOString();
    claimed = (await db.prepare('UPDATE finds SET available_at = ? WHERE id = ? AND (available_at IS NULL OR available_at <= ?)').bind(back, id, now).run()).meta.changes === 1;
  }
  if (!claimed) fail('Someone got here first.', 409);
  const undo = async () => { if (row.mode === 'once') await db.prepare('UPDATE finds SET taken = 0 WHERE id = ?').bind(id).run(); else if (row.mode === 'timer') await db.prepare('UPDATE finds SET available_at = ? WHERE id = ?').bind(row.available_at, id).run(); };
  const item = JSON.parse(row.item), itemId = rand(8);
  const cols = ['id', 'owner_id', 'creator_id', 'created_at', ...COPY];
  const r = await db.prepare(`INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(itemId, me.id, row.creator_id, now, ...COPY.map(k => item[k])).run();
  if (r.meta.changes !== 1) { await undo(); fail('Something went wrong. Try again.', 500); }
  if ((await ownerSlots(db, me.id)) > CAP) {
    await db.prepare('DELETE FROM items WHERE id = ?').bind(itemId).run(); await undo();
    fail('Your inventory is full. Make room, then try again.', 409);
  }
  return json({ picked: item.name, items: await inventory(db, me.id), find: view(await db.prepare(SELECT + ' WHERE f.id = ?').bind(id).first(), me.id, now) });
}

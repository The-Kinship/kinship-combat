'use strict';
// Armory: wearable items. A worn item is owned by 'w' + the wearer's id, so it is out of the bag and cannot be given, stashed or mailed.
// Gear can break: the timer starts the first time it is worn and keeps running. Broken gear becomes a plain "Broken" item.
import { fail } from './engine.mjs';
import { who, str, view, ownerRows, fits, unitRow, inventory, CAP } from './items.mjs';

export const SLOTS = ['helm', 'chest', 'cloak', 'legs', 'feet', 'ring1', 'ring2', 'necklace', 'weapon'];
export const BROKEN_TEXT = 'It seems to be broken and holds no use anymore.';
const worn = id => 'w' + id;
const expired = "lifespan_days > 0 AND worn_at IS NOT NULL AND datetime(worn_at, '+' || lifespan_days || ' days') <= datetime('now')";

/** Turns gear that has run out into broken items, and leaves a note for the owner. Cheap when nothing has broken. */
export async function sweepGear(db) {
  const { results } = await db.prepare(`SELECT id, owner_id, name FROM items WHERE ${expired} LIMIT 50`).all();
  for (const r of results) {
    const holder = r.owner_id.startsWith('w') ? r.owner_id.slice(1) : r.owner_id;
    await db.prepare("UPDATE items SET name = 'Broken ' || name, description = ?, flavor = '', wear_slot = '', gear_atk = 0, gear_heal = 0, lifespan_days = 0, use_label = '', use_text = '', requires = '', requires_consume = 0, st_name = '', st_desc = '', st_icon = '', st_atk = 0, st_heal = 0, cures = '', recipe = '', consumable = 0 WHERE id = ?").bind(BROKEN_TEXT, r.id).run();
    if (r.owner_id.startsWith('w')) {   // a broken piece comes off and goes back in the bag
      await db.prepare('UPDATE items SET owner_id = ? WHERE id = ?').bind(holder, r.id).run();
      await db.prepare('DELETE FROM worn WHERE item_id = ?').bind(r.id).run();
    }
    if (await db.prepare('SELECT 1 AS ok FROM members WHERE id = ?').bind(holder).first())
      await db.prepare('INSERT INTO gear_notices (member_id, text, created_at) VALUES (?,?,?)').bind(holder, `Your ${r.name} broke!`, new Date().toISOString()).run();
  }
}

async function state(db, me) {
  const rows = await ownerRows(db, worn(me.id)), at = (await db.prepare('SELECT slot, item_id FROM worn WHERE member_id = ?').bind(me.id).all()).results;
  const slots = SLOTS.map(slot => { const w = at.find(x => x.slot === slot), row = w && rows.find(r => r.id === w.item_id); return { slot, item: row ? view(row, me.id) : null }; });
  const cap = n => Math.max(-5, Math.min(5, n));
  const rawAtk = rows.reduce((n, r) => n + (r.gear_atk || 0), 0), rawHeal = rows.reduce((n, r) => n + (r.gear_heal || 0), 0);
  return { slots, bonus: { atk: cap(rawAtk), heal: cap(rawHeal), capped: cap(rawAtk) !== rawAtk || cap(rawHeal) !== rawHeal } };
}

export async function handleArmory(request, db, path, { json, input, rate }) {
  const post = request.method === 'POST';
  const me = await who(db, request);
  await sweepGear(db);

  if (!post && path === '/armory/check') {   // polled about once a minute: tells the plugin which pieces broke
    const { results } = await db.prepare('SELECT id, text FROM gear_notices WHERE member_id = ? ORDER BY id LIMIT 20').bind(me.id).all();
    for (const n of results) await db.prepare('DELETE FROM gear_notices WHERE id = ?').bind(n.id).run();
    return json({ broke: results.map(n => n.text) });
  }
  if (!post && path === '/armory') return json(await state(db, me));
  if (!post) fail('Endpoint not found.', 404);
  await rate(db, 'armory:' + me.id, 60);
  const d = await input(request);

  if (path === '/armory/equip') {
    const itemId = str(d.itemId, 'Item', 20), unit = await unitRow(db, itemId, me.id);
    if (!unit) fail('That item is not in your inventory.', 404);
    if (!unit.wear_slot) fail('That item cannot be worn.', 409);
    const at = (await db.prepare('SELECT slot, item_id FROM worn WHERE member_id = ?').bind(me.id).all()).results;
    let slot = unit.wear_slot;
    if (slot === 'ring') {
      const want = d.slot === 'ring1' || d.slot === 'ring2' ? d.slot : null;
      slot = want || (!at.find(x => x.slot === 'ring1') ? 'ring1' : !at.find(x => x.slot === 'ring2') ? 'ring2' : 'ring1');
    }
    const old = at.find(x => x.slot === slot), oldRow = old ? (await ownerRows(db, worn(me.id))).find(r => r.id === old.item_id) : null;
    if (!(await fits(db, me.id, CAP, { remove: [itemId], add: oldRow ? [oldRow] : [] }))) fail(`Your inventory is full (${CAP} slots). Make room first.`, 409);
    if (oldRow) { await db.prepare('UPDATE items SET owner_id = ? WHERE id = ?').bind(me.id, oldRow.id).run(); await db.prepare('DELETE FROM worn WHERE member_id = ? AND slot = ?').bind(me.id, slot).run(); }
    const r = await db.prepare('UPDATE items SET owner_id = ?, worn_at = COALESCE(worn_at, ?) WHERE id = ? AND owner_id = ?').bind(worn(me.id), new Date().toISOString(), itemId, me.id).run();
    if (r.meta.changes !== 1) fail('Something changed. Try again.', 409);
    await db.prepare('INSERT INTO worn (member_id, slot, item_id) VALUES (?,?,?)').bind(me.id, slot, itemId).run();
    return json({ ...(await state(db, me)), items: await inventory(db, me.id) });
  }
  if (path === '/armory/unequip') {
    if (!SLOTS.includes(d.slot)) fail('Choose a slot.');
    const w = await db.prepare('SELECT item_id FROM worn WHERE member_id = ? AND slot = ?').bind(me.id, d.slot).first();
    if (!w) fail('Nothing is worn there.', 404);
    const row = (await ownerRows(db, worn(me.id))).find(r => r.id === w.item_id);
    if (row && !(await fits(db, me.id, CAP, { add: [row] }))) fail(`Your inventory is full (${CAP} slots). Make room first.`, 409);
    await db.prepare('UPDATE items SET owner_id = ? WHERE id = ?').bind(me.id, w.item_id).run();
    await db.prepare('DELETE FROM worn WHERE member_id = ? AND slot = ?').bind(me.id, d.slot).run();
    return json({ ...(await state(db, me)), items: await inventory(db, me.id) });
  }
  fail('Endpoint not found.', 404);
}

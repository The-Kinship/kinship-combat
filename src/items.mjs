'use strict';
// RP items: members register once (name + member password), create items, hold up to CAPACITY, give them away, and use them.
// Items never touch the game. They only exist inside the plugin.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fail } from './engine.mjs';
import { applyStatus, checkRoom, findActive, removeByName } from './status-core.mjs';

const CAPACITY = 10, MAX_MEMBERS = 300, MAX_ITEMS = 3000, MAX_HELD = 3, STASH_CAP = 20, MAX_WITH = 3;
export const CAP = CAPACITY;
const sha = s => createHash('sha256').update(s).digest('hex');
export const rand = n => randomBytes(n).toString('hex');
export const nameKey = n => n.toLowerCase().replace(/\s+/g, ' ').trim();
const recoveryKey = c => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const ICON = /^(game:\d{1,7}|site:[A-Za-z0-9._-]{1,60})$/;

export function str(value, name, max, required = true) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${name} is required and must be at most ${max} characters.`);
  return value.trim();
}
function itemFields(data) {
  const name = str(data.name, 'Item name', 40), description = str(data.description, 'Description', 300, false), flavor = str(data.flavor, 'Flavor text', 150, false);
  const useText = str(data.useText, 'What happens when used', 400, false);
  let useLabel = str(data.useLabel, 'Use button label', 20, false);
  if (useText && !useLabel) useLabel = 'Use';
  if (!useText) useLabel = '';
  const requires = str(data.requires, 'Required item', 40, false);
  if (requires && !useText) fail('An item that needs something has to have an action, like Open. Fill in "What happens".');
  const stName = str(data.stName, 'Status name', 30, false), stDesc = str(data.stDesc, 'Status description', 200, false), cures = str(data.cures, 'Status to remove', 30, false);
  const stIcon = str(data.stIcon, 'Status icon', 80, false);
  if (stIcon && !ICON.test(stIcon)) fail('Choose an icon for the status.');
  const stMinutes = Number.isInteger(data.stMinutes) ? data.stMinutes : 0;
  if (stMinutes < 0 || stMinutes > 43200) fail('A status can last from 1 minute to 30 days. Use 0 to last until removed.');
  if ((stName || cures) && !useText) fail('An item that gives or removes a status needs an action. Fill in "What happens".');
  const icon = str(data.icon, 'Icon', 80);
  if (!ICON.test(icon)) fail('Choose an icon for the item.');
  return { name, icon, description, flavor, useLabel, useText, requires, requiresConsume: data.requiresConsume === true && requires ? 1 : 0, stName, stDesc, stIcon, stDebuff: data.stDebuff === true && stName ? 1 : 0, stMinutes: stName ? stMinutes : 0, cures, consumable: data.consumable === true && useText ? 1 : 0 };
}
// A reagent can name up to three other items it combines with, and say what they make. Stored as JSON: { with: [names], result: itemFields }.
function recipeJson(data) {
  if (!Array.isArray(data.with) || data.with.length === 0) return '';
  if (data.with.length > MAX_WITH) fail(`A recipe can use up to ${MAX_WITH} other items.`);
  const names = data.with.map(n => str(n, 'Reagent name', 40)), keys = names.map(nameKey);
  if (new Set(keys).size !== keys.length) fail('List each reagent once.');
  if (keys.includes(nameKey(String(data.name ?? '')))) fail('An item cannot be combined with another one of itself.');
  if (!data.result || typeof data.result !== 'object' || Array.isArray(data.result)) fail('Say what the combination makes.');
  return JSON.stringify({ with: names, result: itemFields(data.result) });
}
const asView = f => ({ name: f.name, icon: f.icon, description: f.description, flavor: f.flavor, useLabel: f.useLabel, useText: f.useText, consumable: !!f.consumable, requires: f.requires, requiresConsume: !!f.requiresConsume, stName: f.stName, stDesc: f.stDesc, stIcon: f.stIcon, stDebuff: !!f.stDebuff, stMinutes: f.stMinutes, cures: f.cures });
export const view = (row, meId) => {
  const mine = row.creator_id === meId && row.owner_id === meId;
  const v = { id: row.id, name: row.name, icon: row.icon, description: row.description, flavor: row.flavor, useLabel: row.use_label, consumable: !!row.consumable, canEdit: mine, canCombine: !!row.recipe, requires: row.requires || '', requiresConsume: !!row.requires_consume, holds: row.holds || 0 };
  if (mine) { v.useText = row.use_text; v.stName = row.st_name || ''; v.stDesc = row.st_desc || ''; v.stIcon = row.st_icon || ''; v.stDebuff = !!row.st_debuff; v.stMinutes = row.st_minutes || 0; v.cures = row.cures || ''; if (row.recipe) { const r = JSON.parse(row.recipe); v.combineWith = r.with; v.result = asView(r.result); } }
  return v;
};
export async function who(db, request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!token) fail('Sign in on the Items tab first.', 401);
  const row = await db.prepare('SELECT id, name, gold FROM members WHERE token_hash = ?').bind(sha(token)).first();
  if (!row) fail('Your sign-in is no longer valid. Use your recovery code on the Items tab.', 401);
  return row;
}
// Items can hold other items: a held item is owned by 'i' + the holder's id, so it sits in nobody's inventory until released.
export const ITEM_SELECT = "SELECT i.*, (SELECT count(*) FROM items c WHERE c.owner_id = 'i' || i.id) AS holds FROM items i";
async function purge(db, id) {   // delete an item and anything inside it
  const ids = [id];
  for (let n = 0; n < ids.length && ids.length < 60; n++) {
    const { results } = await db.prepare('SELECT id FROM items WHERE owner_id = ?').bind('i' + ids[n]).all();
    for (const r of results) ids.push(r.id);
  }
  for (const x of ids) await db.prepare('DELETE FROM items WHERE id = ?').bind(x).run();
}
const cleanOrphans = db => db.prepare("DELETE FROM items WHERE length(owner_id) = 17 AND substr(owner_id, 1, 1) = 'i' AND substr(owner_id, 2) NOT IN (SELECT id FROM items)").run();
export async function inventory(db, meId) {
  const { results } = await db.prepare(ITEM_SELECT + ' WHERE i.owner_id = ? ORDER BY i.created_at, i.rowid').bind(meId).all();
  return results.map(r => view(r, meId));
}

export async function handleItems(request, db, path, { json, input, rate, ip, checkCreate, checkMember }) {
  const post = request.method === 'POST';

  if (post && path === '/items/register') {
    await rate(db, 'items-register:' + ip, 10);
    const data = await input(request); checkMember(data.memberPassword);
    const name = str(data.name, 'Your name', 40); if (name.length < 2) fail('Your name must be at least 2 characters.');
    if ((await db.prepare('SELECT count(*) AS total FROM members').first()).total >= MAX_MEMBERS) fail('The item system is full.', 503);
    if (await db.prepare('SELECT id FROM members WHERE name_key = ?').bind(nameKey(name)).first()) fail('That name is already registered. If it is yours, use your recovery code.', 409);
    const token = rand(24), id = rand(8), recovery = rand(6).toUpperCase();
    await db.prepare('INSERT INTO members (id, name, name_key, token_hash, recovery_hash, created_at) VALUES (?,?,?,?,?,?)').bind(id, name, nameKey(name), sha(token), sha(recovery), new Date().toISOString()).run();
    return json({ token, memberId: id, name, recoveryCode: `${recovery.slice(0, 4)}-${recovery.slice(4, 8)}-${recovery.slice(8)}` }, 201);
  }
  if (post && path === '/items/recover') {
    await rate(db, 'items-recover:' + ip, 10);
    const data = await input(request), key = nameKey(str(data.name, 'Your name', 40));
    const row = await db.prepare('SELECT id, name, recovery_hash FROM members WHERE name_key = ?').bind(key).first();
    const given = Buffer.from(sha(recoveryKey(data.recoveryCode))), real = Buffer.from(row ? row.recovery_hash : sha('none'));
    if (!row || !timingSafeEqual(given, real)) fail('That name or recovery code is not right.', 403);
    const token = rand(24);
    await db.prepare('UPDATE members SET token_hash = ? WHERE id = ?').bind(sha(token), row.id).run();
    return json({ token, memberId: row.id, name: row.name });
  }

  // ---- DM tools (need the creation password) ----
  if (post && path.startsWith('/items/admin/')) {
    await rate(db, 'items-admin:' + ip, 30);
    const data = await input(request); checkCreate(data.adminPassword);
    if (path === '/items/admin/list') {
      const { results } = await db.prepare("SELECT i.id, i.name, i.icon, i.description, i.creator_id, COALESCE(o.name, 'Stash: ' || st.name, 'Inside: ' || b.name) AS owner, c.name AS creator FROM items i LEFT JOIN members o ON o.id = i.owner_id LEFT JOIN stashes st ON 's' || st.id = i.owner_id LEFT JOIN items b ON 'i' || b.id = i.owner_id LEFT JOIN members c ON c.id = i.creator_id ORDER BY i.created_at DESC LIMIT 300").all();
      const members = (await db.prepare('SELECT name FROM members ORDER BY name_key').all()).results.map(m => m.name);
      const stashes = (await db.prepare("SELECT s.id, s.name, s.zone, s.is_private, m.name AS owner, (SELECT count(*) FROM items WHERE owner_id = 's' || s.id) AS count FROM stashes s LEFT JOIN members m ON m.id = s.owner_id ORDER BY s.created_at DESC LIMIT 300").all()).results
        .map(r => ({ id: r.id, name: r.name, zone: r.zone, owner: r.owner || '(removed)', isPrivate: !!r.is_private, count: r.count }));
      return json({ stashes, items: results.map(r => ({ id: r.id, name: r.name, icon: r.icon, description: r.description, owner: r.owner || '(removed)', creator: r.creator_id === 'dm' ? '(DM gift)' : (r.creator || '(removed)') })), members });
    }
    if (path === '/items/admin/grant') {
      const f = itemFields(data), recipe = recipeJson(data);
      const copies = data.copies === undefined ? 1 : data.copies;
      if (!Number.isInteger(copies) || copies < 1 || copies > 10) fail('Copies must be a whole number from 1 to 10.');
      let owner, label, cap;
      if (data.stashId) {
        const stash = await db.prepare('SELECT id, name FROM stashes WHERE id = ?').bind(str(data.stashId, 'Stash', 20)).first();
        if (!stash) fail('That stash no longer exists.', 404);
        owner = 's' + stash.id; label = `The stash ${stash.name}`; cap = STASH_CAP;
      } else {
        const to = await db.prepare('SELECT id, name FROM members WHERE name_key = ?').bind(nameKey(str(data.to, 'Recipient', 40))).first();
        if (!to) fail('No member has that name.', 404);
        owner = to.id; label = `${to.name}'s inventory`; cap = CAPACITY;
      }
      if ((await db.prepare('SELECT count(*) AS total FROM items').first()).total + copies > MAX_ITEMS) fail('The item system is full.', 503);
      const have = (await db.prepare('SELECT count(*) AS total FROM items WHERE owner_id = ?').bind(owner).first()).total;
      if (have + copies > cap) fail(`${label} does not have room for ${copies}.`, 409);
      for (let i = 0; i < copies; i++)
        await db.prepare("INSERT INTO items (id, owner_id, creator_id, name, icon, description, flavor, use_label, use_text, requires, requires_consume, st_name, st_desc, st_icon, st_debuff, st_minutes, cures, recipe, consumable, created_at) VALUES (?,?,'dm',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .bind(rand(8), owner, f.name, f.icon, f.description, f.flavor, f.useLabel, f.useText, f.requires, f.requiresConsume, f.stName, f.stDesc, f.stIcon, f.stDebuff, f.stMinutes, f.cures, recipe, f.consumable, new Date().toISOString()).run();
      return json({ granted: true, copies }, 201);
    }
    if (path === '/items/admin/delete-stash') {
      const sid = str(data.stashId, 'Stash', 20);
      await db.prepare("DELETE FROM items WHERE owner_id = 's' || ?").bind(sid).run();
      const r = await db.prepare('DELETE FROM stashes WHERE id = ?').bind(sid).run();
      if (r.meta.changes !== 1) fail('That stash no longer exists.', 404);
      return json({ deleted: true });
    }
    if (path === '/items/admin/delete') {
      const itemId = str(data.itemId, 'Item', 20);
      if (!(await db.prepare('SELECT id FROM items WHERE id = ?').bind(itemId).first())) fail('That item no longer exists.', 404);
      await purge(db, itemId);
      return json({ deleted: true });
    }
    if (path === '/items/admin/remove-member') {
      const row = await db.prepare('SELECT id FROM members WHERE name_key = ?').bind(nameKey(str(data.name, 'Name', 40))).first();
      if (!row) fail('No member has that name.', 404);
      await db.prepare("DELETE FROM items WHERE owner_id IN (SELECT 's' || id FROM stashes WHERE owner_id = ?)").bind(row.id).run();
      await db.prepare('DELETE FROM stashes WHERE owner_id = ?').bind(row.id).run();
      await db.prepare('DELETE FROM signs WHERE owner_id = ?').bind(row.id).run();
      await db.prepare('DELETE FROM items WHERE owner_id = ? OR creator_id = ?').bind(row.id, row.id).run();
      await cleanOrphans(db);
      await db.prepare('DELETE FROM gold_log WHERE member_id = ?').bind(row.id).run();
      await db.prepare('DELETE FROM statuses WHERE member_id = ?').bind(row.id).run();
      await db.prepare('DELETE FROM members WHERE id = ?').bind(row.id).run();
      return json({ removed: true });
    }
    fail('Endpoint not found.', 404);
  }

  const me = await who(db, request);

  if (!post && path === '/items/me') return json({ memberId: me.id, name: me.name, gold: me.gold, capacity: CAPACITY, items: await inventory(db, me.id) });
  if (!post && path === '/items/members') {
    const { results } = await db.prepare('SELECT name FROM members WHERE id != ? ORDER BY name_key').bind(me.id).all();
    return json({ members: results.map(r => r.name) });
  }
  if (post && path === '/items') {
    await rate(db, 'items-create:' + me.id, 30);
    const body = await input(request), f = itemFields(body), recipe = recipeJson(body);
    if ((await db.prepare('SELECT count(*) AS total FROM items').first()).total >= MAX_ITEMS) fail('The item system is full.', 503);
    const id = rand(8);
    const r = await db.prepare('INSERT INTO items (id, owner_id, creator_id, name, icon, description, flavor, use_label, use_text, requires, requires_consume, st_name, st_desc, st_icon, st_debuff, st_minutes, cures, recipe, consumable, created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM items WHERE owner_id = ?) < ?')
      .bind(id, me.id, me.id, f.name, f.icon, f.description, f.flavor, f.useLabel, f.useText, f.requires, f.requiresConsume, f.stName, f.stDesc, f.stIcon, f.stDebuff, f.stMinutes, f.cures, recipe, f.consumable, new Date().toISOString(), me.id, CAPACITY).run();
    if (r.meta.changes !== 1) fail(`Your inventory is full (${CAPACITY} items). Delete or give one away first.`, 409);
    return json({ ok: true, id, items: await inventory(db, me.id) }, 201);
  }

  const m = path.match(/^\/items\/([a-f0-9]{16})\/(update|delete|give|use|seal|unseal|combine)$/);
  if (!m || !post) fail('Endpoint not found.', 404);
  const [, id, route] = m;
  const item = await db.prepare('SELECT * FROM items WHERE id = ? AND owner_id = ?').bind(id, me.id).first();
  if (!item) fail('That item is not in your inventory.', 404);

  if (route === 'update') {
    if (item.creator_id !== me.id) fail('Only the person who made an item can change it.', 403);
    const body = await input(request), f = itemFields(body), recipe = recipeJson(body);
    await db.prepare('UPDATE items SET name=?, icon=?, description=?, flavor=?, use_label=?, use_text=?, requires=?, requires_consume=?, st_name=?, st_desc=?, st_icon=?, st_debuff=?, st_minutes=?, cures=?, recipe=?, consumable=? WHERE id=? AND owner_id=?').bind(f.name, f.icon, f.description, f.flavor, f.useLabel, f.useText, f.requires, f.requiresConsume, f.stName, f.stDesc, f.stIcon, f.stDebuff, f.stMinutes, f.cures, recipe, f.consumable, id, me.id).run();
  } else if (route === 'delete') {
    await purge(db, id);
  } else if (route === 'combine') {
    if (!item.recipe) fail('This cannot be combined with anything.');
    const recipe = JSON.parse(item.recipe), f = recipe.result, picked = [{ id, name: item.name }], missing = [];
    // The other reagents must be made by whoever made this one (or granted by an Advocate), so a copied name is not enough.
    for (const name of recipe.with) {
      const ids = picked.map(p => p.id);
      const row = await db.prepare(`SELECT id, name FROM items WHERE owner_id = ? AND lower(name) = ? AND creator_id IN (?, 'dm') AND id NOT IN (${ids.map(() => '?').join(',')}) LIMIT 1`).bind(me.id, nameKey(name), item.creator_id, ...ids).first();
      if (row) picked.push(row); else missing.push(name);
    }
    if (missing.length) fail(`You still need ${missing.join(missing.length > 2 ? ', ' : ' and ')} to combine this.`, 409);
    if ((await db.prepare('SELECT count(*) AS total FROM items').first()).total >= MAX_ITEMS + picked.length) fail('The item system is full.', 503);
    for (const p of picked) await purge(db, p.id);
    await db.prepare('INSERT INTO items (id, owner_id, creator_id, name, icon, description, flavor, use_label, use_text, requires, requires_consume, st_name, st_desc, st_icon, st_debuff, st_minutes, cures, recipe, consumable, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(rand(8), me.id, item.creator_id, f.name, f.icon, f.description, f.flavor, f.useLabel, f.useText, f.requires, f.requiresConsume, f.stName, f.stDesc, f.stIcon, f.stDebuff, f.stMinutes, f.cures, '', f.consumable, new Date().toISOString()).run();
    return json({ combined: f.name, used: picked.map(p => p.name), items: await inventory(db, me.id) });
  } else if (route === 'seal') {
    const data = await input(request), inner = str(data.itemId, 'Item', 20);
    if (item.creator_id !== me.id) fail('Only the person who made an item can put things inside it.', 403);
    if (!item.use_text) fail('Give this item an action first (like Open), so it can be opened to get what is inside.');
    if (inner === id) fail('An item cannot hold itself.');
    const r = await db.prepare("UPDATE items SET owner_id = 'i' || ? WHERE id = ? AND owner_id = ? AND (SELECT count(*) FROM items WHERE owner_id = 'i' || ?) < ?").bind(id, inner, me.id, id, MAX_HELD).run();
    if (r.meta.changes !== 1) {
      if (!(await db.prepare('SELECT id FROM items WHERE id = ? AND owner_id = ?').bind(inner, me.id).first())) fail('That item is not in your inventory.', 404);
      fail(`An item can hold up to ${MAX_HELD} things.`, 409);
    }
  } else if (route === 'unseal') {
    if (item.creator_id !== me.id) fail('Only the person who made an item can take things out of it.', 403);
    const held = (await db.prepare('SELECT id FROM items WHERE owner_id = ?').bind('i' + id).all()).results;
    const have = (await db.prepare('SELECT count(*) AS total FROM items WHERE owner_id = ?').bind(me.id).first()).total;
    if (have + held.length > CAPACITY) fail('Not enough room in your inventory to take them out.', 409);
    await db.prepare('UPDATE items SET owner_id = ? WHERE owner_id = ?').bind(me.id, 'i' + id).run();
  } else if (route === 'give') {
    await rate(db, 'items-give:' + me.id, 30);
    const data = await input(request), to = await db.prepare('SELECT id, name FROM members WHERE name_key = ?').bind(nameKey(str(data.to, 'Recipient', 40))).first();
    if (!to) fail('No member has that name.', 404);
    if (to.id === me.id) fail('That item is already yours.');
    const r = await db.prepare('UPDATE items SET owner_id = ? WHERE id = ? AND owner_id = ? AND (SELECT count(*) FROM items WHERE owner_id = ?) < ?').bind(to.id, id, me.id, to.id, CAPACITY).run();
    if (r.meta.changes !== 1) fail(`${to.name}'s inventory is full.`, 409);
  } else if (route === 'use') {
    if (!item.use_text) fail('This item has nothing to use.');
    let key = null;
    if (item.requires) {
      // The key must be made by whoever made the box (or granted by an Advocate), so nobody can forge one by copying its name.
      key = await db.prepare("SELECT id FROM items WHERE owner_id = ? AND id != ? AND lower(name) = ? AND creator_id IN (?, 'dm') LIMIT 1").bind(me.id, id, nameKey(item.requires), item.creator_id).first();
      if (!key) fail(`You need ${item.requires} to do that.`, 409);
    }
    const curing = item.cures ? await findActive(db, me.id, item.cures) : null;
    if (item.cures && !curing) fail(`You have no ${item.cures} to cure.`, 409);
    if (item.st_name) await checkRoom(db, me.id, item.st_name);
    const held = (await db.prepare('SELECT id, name FROM items WHERE owner_id = ? ORDER BY created_at, id').bind('i' + id).all()).results;
    const have = (await db.prepare('SELECT count(*) AS total FROM items WHERE owner_id = ?').bind(me.id).first()).total;
    if (have - (item.consumable ? 1 : 0) - (key && item.requires_consume ? 1 : 0) + held.length > CAPACITY) fail('Not enough room in your inventory for what is inside. Make some space first.', 409);
    if (key && item.requires_consume) await db.prepare('DELETE FROM items WHERE id = ? AND owner_id = ?').bind(key.id, me.id).run();
    if (held.length) await db.prepare('UPDATE items SET owner_id = ? WHERE owner_id = ?').bind(me.id, 'i' + id).run();
    if (item.consumable) {
      const r = await db.prepare('DELETE FROM items WHERE id = ? AND owner_id = ?').bind(id, me.id).run();
      if (r.meta.changes !== 1) fail('That item is already gone.', 409);
    }
    if (item.cures) await removeByName(db, me.id, item.cures);
    if (item.st_name) await applyStatus(db, me.id, { name: item.st_name, icon: item.st_icon || item.icon, description: item.st_desc, isDebuff: !!item.st_debuff, minutes: item.st_minutes, sourceId: item.creator_id });
    return json({ text: item.use_text, statusGained: item.st_name || '', statusCured: curing ? curing.name : '', consumed: !!item.consumable, gained: held.map(h => h.name), keyUsed: key && item.requires_consume ? item.requires : '', items: await inventory(db, me.id) });
  }
  return json({ ok: true, items: await inventory(db, me.id) });
}

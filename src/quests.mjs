'use strict';
// Quests: an Advocate writes a quest as ordered steps; players talk to targeted NPCs and the server moves them along.
// Step types: talk (the NPC speaks), give (hand over an Advocate-made item, which is used up), receive (the NPC gives an item).
import { fail } from './engine.mjs';
import { who, rand, str, nameKey, itemFields, inventory, CAP } from './items.mjs';

const MAX_QUESTS = 60, MAX_STEPS = 12, MAX_ACTIVE = 15;
const TYPES = ['talk', 'give', 'receive'];

function steps(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_STEPS) fail(`A quest needs 1 to ${MAX_STEPS} steps.`);
  return list.map((s, i) => {
    const at = `Step ${i + 1}`;
    if (!s || typeof s !== 'object' || !TYPES.includes(s.type)) fail(`${at} needs a type: talk, give or receive.`);
    const out = { type: s.type, npc: str(s.npc, `${at} character name`, 40), text: str(s.text, `${at} dialogue`, 600), hint: str(s.hint, `${at} hint`, 150, false) };
    if (s.type === 'give') out.item = str(s.item, `${at} item to hand over`, 40);
    if (s.type === 'receive') { if (!s.gift || typeof s.gift !== 'object') fail(`${at} needs an item to give.`); out.gift = itemFields(s.gift); }
    return out;
  });
}
const SELECT_P = 'SELECT p.quest_id, p.step, p.done, q.title, q.intro, q.steps FROM quest_progress p JOIN quests q ON q.id = p.quest_id WHERE p.member_id = ? ORDER BY p.updated_at';
function mineView(r) {
  const list = JSON.parse(r.steps), cur = r.done ? null : list[r.step];
  return { questId: r.quest_id, title: r.title, intro: r.intro, step: r.step, total: list.length, done: !!r.done,
    current: cur ? { type: cur.type, npc: cur.npc, item: cur.item || '', hint: cur.hint } : null };
}
async function insertGift(db, ownerId, f) {
  const r = await db.prepare("INSERT INTO items (id, owner_id, creator_id, name, icon, description, flavor, use_label, use_text, requires, requires_consume, st_name, st_desc, st_icon, st_debuff, st_minutes, st_type, st_cure, cures, recipe, consumable, created_at) SELECT ?,?,'dm',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM items WHERE owner_id = ?) < ?")
    .bind(rand(8), ownerId, f.name, f.icon, f.description, f.flavor, f.useLabel, f.useText, f.requires, f.requiresConsume, f.stName, f.stDesc, f.stIcon, f.stDebuff, f.stMinutes, f.stType, f.stCure, f.cures, '', f.consumable, new Date().toISOString(), ownerId, CAP).run();
  return r.meta.changes === 1;
}

export async function handleQuests(request, db, path, { json, input, rate, ip, checkCreate }) {
  const post = request.method === 'POST';

  if (post && path.startsWith('/quests/admin/')) {
    await rate(db, 'quest-admin:' + ip, 60);
    const d = await input(request); checkCreate(d.adminPassword);
    if (path === '/quests/admin/list') {
      const { results } = await db.prepare('SELECT * FROM quests ORDER BY created_at, rowid').all();
      const prog = (await db.prepare('SELECT p.quest_id, p.step, p.done, m.name FROM quest_progress p JOIN members m ON m.id = p.member_id ORDER BY m.name_key').all()).results;
      return json({ quests: results.map(q => ({ id: q.id, title: q.title, intro: q.intro, steps: JSON.parse(q.steps),
        players: prog.filter(p => p.quest_id === q.id).map(p => ({ name: p.name, step: p.step, done: !!p.done })) })) });
    }
    if (path === '/quests/admin/save') {
      const title = str(d.title, 'Quest title', 60), intro = str(d.intro, 'Quest introduction', 400, false), list = steps(d.steps);
      if (d.questId) {
        const id = str(d.questId, 'Quest', 20);
        const r = await db.prepare('UPDATE quests SET title=?, intro=?, steps=? WHERE id=?').bind(title, intro, JSON.stringify(list), id).run();
        if (r.meta.changes !== 1) fail('That quest no longer exists.', 404);
        // A shorter quest finishes anyone who was past the new end.
        await db.prepare('UPDATE quest_progress SET done = 1 WHERE quest_id = ? AND step >= ?').bind(id, list.length).run();
        return json({ saved: true, id });
      }
      if ((await db.prepare('SELECT count(*) AS total FROM quests').first()).total >= MAX_QUESTS) fail('There are too many quests. Delete one first.', 409);
      const id = rand(6);
      await db.prepare('INSERT INTO quests (id, title, intro, steps, created_at) VALUES (?,?,?,?,?)').bind(id, title, intro, JSON.stringify(list), new Date().toISOString()).run();
      return json({ saved: true, id }, 201);
    }
    if (path === '/quests/admin/delete') {
      const id = str(d.questId, 'Quest', 20);
      await db.prepare('DELETE FROM quest_progress WHERE quest_id = ?').bind(id).run();
      const r = await db.prepare('DELETE FROM quests WHERE id = ?').bind(id).run();
      if (r.meta.changes !== 1) fail('That quest no longer exists.', 404);
      return json({ deleted: true });
    }
    if (path === '/quests/admin/assign' || path === '/quests/admin/unassign') {
      const to = await db.prepare('SELECT id, name FROM members WHERE name_key = ?').bind(nameKey(str(d.to, 'Member', 40))).first();
      if (!to) fail('No member has that name.', 404);
      const id = str(d.questId, 'Quest', 20);
      if (!(await db.prepare('SELECT id FROM quests WHERE id = ?').bind(id).first())) fail('That quest no longer exists.', 404);
      if (path === '/quests/admin/unassign') { await db.prepare('DELETE FROM quest_progress WHERE member_id = ? AND quest_id = ?').bind(to.id, id).run(); return json({ unassigned: true, to: to.name }); }
      const have = await db.prepare('SELECT done FROM quest_progress WHERE member_id = ? AND quest_id = ?').bind(to.id, id).first();
      if (!have && (await db.prepare('SELECT count(*) AS total FROM quest_progress WHERE member_id = ? AND done = 0').bind(to.id).first()).total >= MAX_ACTIVE) fail(`${to.name} already has ${MAX_ACTIVE} quests going.`, 409);
      await db.prepare('INSERT INTO quest_progress (member_id, quest_id, step, done, updated_at) VALUES (?,?,0,0,?) ON CONFLICT(member_id, quest_id) DO UPDATE SET step = 0, done = 0, updated_at = excluded.updated_at').bind(to.id, id, new Date().toISOString()).run();
      return json({ assigned: true, to: to.name }, 201);
    }
    fail('Endpoint not found.', 404);
  }

  const me = await who(db, request);

  if (!post && path === '/quests/mine') {
    const { results } = await db.prepare(SELECT_P).bind(me.id).all();
    return json({ quests: results.map(mineView) });
  }

  if (post && path === '/quests/talk') {
    await rate(db, 'quest-talk:' + me.id, 60);
    const d = await input(request), npc = nameKey(str(d.npc, 'Character', 60));
    const { results } = await db.prepare(SELECT_P.replace('ORDER BY', 'AND p.done = 0 ORDER BY')).bind(me.id).all();
    const out = [];
    for (const r of results) {
      const list = JSON.parse(r.steps), st = list[r.step];
      if (!st || nameKey(st.npc) !== npc) continue;
      const stop = text => out.push({ quest: r.title, ok: false, text, finished: false, gained: [] });
      let gained = [];
      if (st.type === 'give') {
        const held = await db.prepare("SELECT id FROM items WHERE owner_id = ? AND creator_id = 'dm' AND lower(name) = ? LIMIT 1").bind(me.id, st.item.toLowerCase()).first();
        if (!held) { stop(`${st.npc} is waiting for something. You don't have it.`); continue; }
        const claim = await db.prepare('UPDATE quest_progress SET step = step + 1, done = ?, updated_at = ? WHERE member_id = ? AND quest_id = ? AND step = ?').bind(r.step + 1 >= list.length ? 1 : 0, new Date().toISOString(), me.id, r.quest_id, r.step).run();
        if (claim.meta.changes !== 1) continue;
        const gone = await db.prepare('DELETE FROM items WHERE id = ? AND owner_id = ?').bind(held.id, me.id).run();
        if (gone.meta.changes !== 1) { await db.prepare('UPDATE quest_progress SET step = ?, done = 0 WHERE member_id = ? AND quest_id = ?').bind(r.step, me.id, r.quest_id).run(); stop('That item is no longer with you.'); continue; }
      } else if (st.type === 'receive') {
        const claim = await db.prepare('UPDATE quest_progress SET step = step + 1, done = ?, updated_at = ? WHERE member_id = ? AND quest_id = ? AND step = ?').bind(r.step + 1 >= list.length ? 1 : 0, new Date().toISOString(), me.id, r.quest_id, r.step).run();
        if (claim.meta.changes !== 1) continue;
        if (!(await insertGift(db, me.id, st.gift))) { await db.prepare('UPDATE quest_progress SET step = ?, done = 0 WHERE member_id = ? AND quest_id = ?').bind(r.step, me.id, r.quest_id).run(); stop('Your inventory is full. Make room, then talk to them again.'); continue; }
        gained = [st.gift.name];
      } else {
        const claim = await db.prepare('UPDATE quest_progress SET step = step + 1, done = ?, updated_at = ? WHERE member_id = ? AND quest_id = ? AND step = ?').bind(r.step + 1 >= list.length ? 1 : 0, new Date().toISOString(), me.id, r.quest_id, r.step).run();
        if (claim.meta.changes !== 1) continue;
      }
      out.push({ quest: r.title, ok: true, text: st.text, finished: r.step + 1 >= list.length, gained });
    }
    return json({ results: out, items: await inventory(db, me.id) });
  }
  fail('Endpoint not found.', 404);
}

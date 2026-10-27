'use strict';
// RP profiles: what other players see when they mouse over your character. Everything here is text the player wrote themselves;
// the portrait is only a link to an image (nothing is uploaded to this server).
import { fail } from './engine.mjs';
import { who, str } from './items.mjs';
import { findMember } from './lookup.mjs';

const MAX_FIELDS = 6;
const view = (m, p) => {
  let fields = []; try { fields = JSON.parse(p?.fields || '[]'); } catch { /* ignore */ }
  return { name: m.name, displayName: p?.display_name || '', portrait: p?.portrait || '', age: p?.age || '', race: p?.race || '', gender: p?.gender || '', glance: p?.glance || '', ooc: p?.ooc || '', fields };
};

function clean(d) {
  const portrait = str(d.portrait, 'Portrait link', 300, false);
  if (portrait && !/^https:\/\/[^\s"'<>]+$/i.test(portrait)) fail('The portrait link must start with https:// and be a direct link to an image.');
  const list = d.fields === undefined || d.fields === null ? [] : d.fields;
  if (!Array.isArray(list) || list.length > MAX_FIELDS) fail(`You can add up to ${MAX_FIELDS} custom fields.`);
  const fields = list.map((f, i) => ({ label: str(f?.label, `Custom field ${i + 1} title`, 24), value: str(f?.value, `Custom field ${i + 1} text`, 80, false) }));
  return {
    portrait, fields: JSON.stringify(fields), displayName: str(d.displayName, 'Name', 40, false),
    age: str(d.age, 'Age', 30, false), race: str(d.race, 'Race', 40, false), gender: str(d.gender, 'Gender', 30, false),
    glance: str(d.glance, 'At first glance', 500, false), ooc: str(d.ooc, 'OOC', 500, false),
  };
}

export async function handleProfiles(request, db, path, { json, input, rate, ip, checkCreate }) {
  const post = request.method === 'POST';

  if (post && path === '/profile/admin/clear-portrait') {   // an Advocate removes an inappropriate portrait link
    await rate(db, 'profile-admin:' + ip, 30);
    const d = await input(request); checkCreate(d.adminPassword);
    const target = await findMember(db, str(d.name, 'Character name', 60));
    if (!target) fail('Nobody is registered under that name.', 404);
    await db.prepare("UPDATE profiles SET portrait = '' WHERE member_id = ?").bind(target.id).run();
    return json({ cleared: true, name: target.name });
  }
  const me = await who(db, request);

  if (!post && path === '/profiles') {   // everyone in the RP system, so the plugin can show a tooltip for any registered character
    const members = (await db.prepare('SELECT id, name FROM members ORDER BY name_key LIMIT 300').all()).results;
    const rows = (await db.prepare('SELECT * FROM profiles').all()).results;
    return json({ profiles: members.map(m => view(m, rows.find(p => p.member_id === m.id))) });
  }
  if (!post && path === '/profile') {
    const row = await db.prepare('SELECT * FROM profiles WHERE member_id = ?').bind(me.id).first();
    return json({ profile: view(me, row) });
  }
  if (post && path === '/profile') {
    await rate(db, 'profile:' + me.id, 30);
    const c = clean(await input(request));
    await db.prepare('INSERT INTO profiles (member_id, display_name, portrait, age, race, gender, glance, ooc, fields, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET display_name=excluded.display_name, portrait=excluded.portrait, age=excluded.age, race=excluded.race, gender=excluded.gender, glance=excluded.glance, ooc=excluded.ooc, fields=excluded.fields, updated_at=excluded.updated_at')
      .bind(me.id, c.displayName, c.portrait, c.age, c.race, c.gender, c.glance, c.ooc, c.fields, new Date().toISOString()).run();
    const row = await db.prepare('SELECT * FROM profiles WHERE member_id = ?').bind(me.id).first();
    return json({ profile: view(me, row) });
  }
  fail('Endpoint not found.', 404);
}

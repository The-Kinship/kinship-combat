'use strict';
// RP scenes: a SM creates a scene, players join it with the code, and the SM sends popups to everyone or to chosen people.
import { randomBytes } from 'node:crypto';
import { makeMember, authenticate, fail } from './engine.mjs';

const MAX_MEMBERS = 60, MAX_SCENES = 300, KEEP_EVENTS = 100, STALE_DAYS = 7;

function str(value, name, max, required = true) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${name} is required and must be at most ${max} characters.`);
  return value.trim();
}
async function find(db, code) {
  const row = await db.prepare('SELECT state FROM scenes WHERE code = ?').bind(code).first();
  if (!row) fail('Scene not found. Check the code with your SM.', 404);
  return JSON.parse(row.state);
}
async function save(db, scene, revision) {
  const r = await db.prepare('UPDATE scenes SET state = ?, revision = ?, updated_at = ? WHERE code = ? AND revision = ?').bind(JSON.stringify(scene), scene.revision, scene.updatedAt, scene.code, revision).run();
  return r.meta.changes === 1;
}
// Re-reads the scene and applies a change, retrying if someone else changed it at the same moment.
async function mutate(db, code, change) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const scene = await find(db, code), revision = scene.revision;
    const result = change(scene);
    scene.revision++; scene.updatedAt = new Date().toISOString();
    if (await save(db, scene, revision)) return { scene, result };
  }
  fail('The scene is busy. Please try again.', 409);
}
function view(scene, member) {
  const v = { memberId: member.id, role: member.role, code: scene.code, title: scene.title, lastId: scene.nextId - 1 };
  if (member.role === 'dm') v.members = scene.members.filter(m => m.role !== 'dm').map(({ id, name, role }) => ({ id, name, role }));
  return v;
}
const eventsFor = (scene, member, after) => scene.events.filter(e => e.id > after && (!e.to || e.to.includes(member.id))).map(({ id, at, text, ooc, combat }) => ({ id, at, text, ooc, combat: combat || '' }));

export async function handleScenes(request, db, path, { json, input, rate, ip, checkCreate }) {
  if (request.method === 'POST' && path === '/scenes') {
    await rate(db, 'scene-create:' + ip, 8);
    const data = await input(request); checkCreate(data.createPassword);
    await db.prepare('DELETE FROM scenes WHERE updated_at < ?').bind(new Date(Date.now() - STALE_DAYS * 86400000).toISOString()).run();
    const count = await db.prepare('SELECT count(*) AS total FROM scenes').first();
    if (count.total >= MAX_SCENES) fail('The site has reached its scene capacity.', 503);
    const { member, token } = makeMember(data.name, 'dm');
    const now = new Date().toISOString();
    const scene = { code: randomBytes(9).toString('hex').toUpperCase(), title: str(data.title || 'RP scene', 'Scene name', 80), revision: 0, members: [member], events: [], nextId: 1, createdAt: now, updatedAt: now };
    await db.prepare('INSERT INTO scenes (code, revision, state, updated_at) VALUES (?, ?, ?, ?)').bind(scene.code, 0, JSON.stringify(scene), now).run();
    return json({ token, ...view(scene, member) }, 201);
  }
  const match = path.match(/^\/scenes\/([A-Fa-f0-9]{18})(?:\/(join|send|leave|close|kick))?$/);
  if (!match) fail('Endpoint not found.', 404);
  const code = match[1].toUpperCase(), route = match[2];

  if (route === 'join' && request.method === 'POST') {
    await rate(db, 'scene-join:' + ip, 20);
    const data = await input(request), { member, token } = makeMember(data.name, 'player');
    const { scene } = await mutate(db, code, s => { if (s.members.length >= MAX_MEMBERS) fail('This scene is full.'); s.members.push(member); });
    return json({ token, ...view(scene, member) }, 201);
  }

  const scene0 = await find(db, code);
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  const me = authenticate(scene0, bearer);

  if (!route && request.method === 'GET') {
    const raw = new URL(request.url).searchParams.get('after');
    const after = raw === null ? -1 : Number(raw);
    return json({ ...view(scene0, me), events: Number.isFinite(after) && after >= 0 ? eventsFor(scene0, me, after) : [] });
  }
  if (route === 'send' && request.method === 'POST') {
    if (me.role !== 'dm') fail('Only the SM can send popups.', 403);
    await rate(db, 'scene-send:' + me.id, 60);
    const data = await input(request), text = str(data.text, 'Popup text', 300), ooc = str(data.ooc, 'OOC note', 200, false);
    let combat = '';
    if (data.combat !== undefined && data.combat !== null && data.combat !== '') {
      if (typeof data.combat !== 'string' || !/^[A-Fa-f0-9]{18}$/.test(data.combat)) fail('That is not a combat room code.');
      combat = data.combat.toUpperCase();
      if (!(await db.prepare('SELECT code FROM rooms WHERE code = ?').bind(combat).first())) fail('That combat room does not exist.', 404);
    }
    let to = null;
    if (data.to !== undefined && data.to !== null) {
      if (!Array.isArray(data.to) || data.to.length > MAX_MEMBERS) fail('Recipients must be a list of people in the scene.');
      to = [...new Set(data.to)];
      if (to.length === 0) to = null;
    }
    const { scene, result } = await mutate(db, code, s => {
      if (to && !to.every(id => s.members.some(m => m.id === id && m.role !== 'dm'))) fail('Choose people who have joined this scene.');
      s.events.push({ id: s.nextId, at: new Date().toISOString(), text, ooc, to, combat }); s.nextId++;
      s.events = s.events.slice(-KEEP_EVENTS);
      return { delivered: to ? to.length : s.members.filter(m => m.role !== 'dm').length };
    });
    return json({ ok: true, delivered: result.delivered, lastId: scene.nextId - 1 });
  }
  if (route === 'leave' && request.method === 'POST') {
    if (me.role === 'dm') fail('The SM closes the scene instead of leaving it.');
    await mutate(db, code, s => { s.members = s.members.filter(m => m.id !== me.id); });
    return json({ left: true });
  }
  if (route === 'kick' && request.method === 'POST') {
    if (me.role !== 'dm') fail('Only the SM can remove people.', 403);
    const data = await input(request), id = str(data.memberId, 'Person', 60);
    const { result } = await mutate(db, code, s => {
      const target = s.members.find(m => m.id === id && m.role !== 'dm');
      if (!target) fail('That person is not in this scene.', 404);
      s.members = s.members.filter(m => m.id !== id); return target.name;
    });
    return json({ removed: true, name: result });
  }
  if (route === 'close' && request.method === 'POST') {
    if (me.role !== 'dm') fail('Only the SM can close the scene.', 403);
    await db.prepare('DELETE FROM scenes WHERE code = ?').bind(code).run();
    return json({ closed: true });
  }
  fail('Endpoint not found.', 404);
}

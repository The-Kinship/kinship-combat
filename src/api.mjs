import { makeRoom, makeMember, authenticate, publicRoom, apply, log, fail, expireIfDue } from './engine.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { handleScenes } from './scenes.mjs';
import { handleItems } from './items.mjs';
import { handleStashes } from './stashes.mjs';
import { handleSigns } from './signs.mjs';
import { handleBank } from './bank.mjs';
import { handleMail } from './mail.mjs';
import { handleArmory } from './armory.mjs';
import { handleProfiles } from './profiles.mjs';
import { handleReports } from './reports.mjs';
import { handleMarks } from './marks.mjs';
import { handleWipe } from './wipe.mjs';
import { handleDuels } from './duels.mjs';
import { handleStatuses } from './statuses.mjs';
import { handleQuests } from './quests.mjs';
import { handleSects } from './sects.mjs';
import { rollBonuses } from './status-core.mjs';
const json = (body,status = 200) => new Response(JSON.stringify(body),{ status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'} });
async function input(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail('Send JSON.',415);
  const reader = request.body?.getReader(); if (!reader) fail('Missing request body.');
  const decoder = new TextDecoder(); let bytes = 0, text = '';
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 24000) { await reader.cancel(); fail('Request is too large.',413); } text += decoder.decode(chunk.value,{ stream:true }); } } finally { reader.releaseLock(); }
  try { const data = JSON.parse(text+decoder.decode()); if (!data || Array.isArray(data) || typeof data !== 'object') fail('Send a JSON object.'); return data; } catch { fail('Invalid JSON.'); }
}
async function rate(db,key,maximum) {
  const minute = Math.floor(Date.now()/60000), hashed = createHash('sha256').update(key+':'+minute).digest('hex');
  const row = await db.prepare('INSERT INTO rate_limits (key, hits, expires) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET hits = hits + 1 RETURNING hits').bind(hashed,Date.now()+120000).first();
  if (row.hits > maximum) fail('Too many requests. Please wait a minute.',429);
}
async function find(db,code) { const row = await db.prepare('SELECT state FROM rooms WHERE code = ?').bind(code).first(); if (!row) fail('Room not found. Check the code with your SM.',404); return JSON.parse(row.state); }
async function update(db,room,revision) {
  const result = await db.prepare('UPDATE rooms SET state = ?, revision = ?, updated_at = ? WHERE code = ? AND revision = ?').bind(JSON.stringify(room),room.revision,new Date().toISOString(),room.code,revision).run();
  return result.meta.changes === 1;
}
// A timed encounter ends itself once its clock runs out; save that the first time anyone looks.
async function settle(db,code,room) {
  const revision = room.revision;
  if (!expireIfDue(room)) return room;
  return (await update(db,room,revision)) ? room : find(db,code);
}
const STALE_DAYS = 7;
// Creating an encounter or scene needs the creation password (a Cloudflare secret). Joining only needs a code.
function checkCreate(supplied,expected) {
  if (!expected) fail('Creating is switched off until the creation password is set in Cloudflare.',503);
  const a = createHash('sha256').update(String(supplied ?? '')).digest(), b = createHash('sha256').update(String(expected)).digest();
  if (!timingSafeEqual(a,b)) fail('That creation password is not right. Ask your SM or the FC leader.',403);
}
// Scenes, encounters and quests can also be run with an optional separate scene password (SCENE_PASSWORD), so someone can use those
// without holding the creation password that opens every other SM tool. Returns which password was used ('create' or 'scene').
function checkScene(supplied,createExpected,sceneExpected) {
  const h = v => createHash('sha256').update(String(v ?? '')).digest();
  if (createExpected && timingSafeEqual(h(supplied),h(createExpected))) return 'create';
  if (sceneExpected && timingSafeEqual(h(supplied),h(sceneExpected))) return 'scene';
  checkCreate(supplied,createExpected);
}
function checkMember(supplied,expected) {
  if (!expected) fail('Items are switched off until the member password is set in Cloudflare.',503);
  const a = createHash('sha256').update(String(supplied ?? '')).digest(), b = createHash('sha256').update(String(expected)).digest();
  if (!timingSafeEqual(a,b)) fail('That member password is not right. Ask your FC leader.',403);
}
function checkBank(supplied,expected) {
  if (!expected) fail('The Kinship bank is closed until the bank password is set in Cloudflare.',503);
  const a = createHash('sha256').update(String(supplied ?? '')).digest(), b = createHash('sha256').update(String(expected)).digest();
  if (!timingSafeEqual(a,b)) fail('That bank password is not right.',403);
}
// The faction website (GitHub Pages) may call the sect pages route from the browser; nothing else is opened up to other sites.
const SITE_ORIGINS = ['https://the-kinship.github.io'];
const siteOrigin = (request,extras) => {
  const origin = request.headers.get('origin'), path = new URL(request.url).pathname;
  if (!origin || !/^\/api\/sects\//.test(path)) return null;
  return [...SITE_ORIGINS,...String(extras.siteOrigins || '').split(',').map(x => x.trim()).filter(Boolean)].includes(origin) ? origin : null;
};
export async function handle(request,db,createPassword,memberPassword,bankPassword,extras = {}) {
  const origin = siteOrigin(request,extras);
  if (!origin) return handleInner(request,db,createPassword,memberPassword,bankPassword,extras,false);
  const cors = { 'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'86400','Vary':'Origin' };
  if (request.method === 'OPTIONS') return new Response(null,{ status:204,headers:cors });
  const res = await handleInner(request,db,createPassword,memberPassword,bankPassword,extras,true);
  const headers = new Headers(res.headers); for (const [k,v] of Object.entries(cors)) headers.set(k,v);
  return new Response(res.body,{ status:res.status,headers });
}
async function handleInner(request,db,createPassword,memberPassword,bankPassword,extras,fromSite) {
  try {
    if (!db) fail('The encounter database is not ready. Please try again shortly.',503);
    const path = new URL(request.url).pathname.replace(/^\/api/,'');
    if (request.method === 'GET' && path === '/health') { await db.prepare('SELECT code FROM rooms LIMIT 1').first(); return json({ok:true,service:'Kinship Combat'}); }
    if (!['GET','POST'].includes(request.method)) fail('Method not allowed.',405);
    if (request.method === 'POST') { const origin = request.headers.get('origin'); if (!fromSite && origin && origin !== new URL(request.url).origin) fail('This action must come from the Kinship Combat website.',403); }
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (path === '/sects' || path.startsWith('/sects/')) return await handleSects(request,db,path,{ json,input,rate,ip,hashKey:k => createHash('sha256').update(k).digest('hex'),extras });
    if (path === '/statuses' || path.startsWith('/statuses/')) return await handleStatuses(request,db,path,{ json,input,rate,ip,checkCreate:supplied => checkCreate(supplied,createPassword) });
    if (path === '/quests' || path.startsWith('/quests/')) return await handleQuests(request,db,path,{ json,input,rate,ip,checkCreate:supplied => checkScene(supplied,createPassword,extras.scenePassword) });
    if (path === '/bank' || path.startsWith('/bank/')) return await handleBank(request,db,path,{ json,input,rate,ip,checkBank:supplied => checkBank(supplied,bankPassword) });
    if (path === '/duels' || path.startsWith('/duels/')) return await handleDuels(request,db,path,{ json,input,rate });
    if (path.startsWith('/system/')) return await handleWipe(request,db,path,{ json,input,rate,ip,checkCreate:supplied => checkCreate(supplied,createPassword) });
    if (path.startsWith('/marks/')) return await handleMarks(request,db,path,{ json,input,rate,ip,checkCreate:supplied => checkCreate(supplied,createPassword) });
    if (path === '/reports' || path.startsWith('/reports/')) return await handleReports(request,db,path,{ json,input,rate,ip,checkCreate:supplied => checkCreate(supplied,createPassword) });
    if (path === '/profile' || path === '/profiles' || path.startsWith('/profile/')) return await handleProfiles(request,db,path,{ json,input,rate,ip,checkCreate:supplied => checkCreate(supplied,createPassword) });
    if (path === '/armory' || path.startsWith('/armory/')) return await handleArmory(request,db,path,{ json,input,rate });
    if (path === '/mail' || path.startsWith('/mail/')) return await handleMail(request,db,path,{ json,input,rate,ip,checkCreate:supplied => checkCreate(supplied,createPassword) });
    if (path === '/signs' || path.startsWith('/signs/')) return await handleSigns(request,db,path,{ json,input,rate,ip,checkCreate:supplied => checkCreate(supplied,createPassword) });
    if (path === '/stashes' || path.startsWith('/stashes/')) return await handleStashes(request,db,path,{ json,input,rate,ip });
    if (path === '/items' || path.startsWith('/items/')) return await handleItems(request,db,path,{ json,input,rate,ip,checkCreate:supplied => checkCreate(supplied,createPassword),checkMember:supplied => checkMember(supplied,memberPassword) });
    if (path === '/scenes' || path.startsWith('/scenes/')) return await handleScenes(request,db,path,{ json,input,rate,ip,checkCreate:supplied => checkScene(supplied,createPassword,extras.scenePassword) });
    if (request.method === 'POST' && path === '/rooms') {
      await rate(db,'create:'+ip,8);
      const data = await input(request); checkScene(data.createPassword,createPassword,extras.scenePassword);
      await db.prepare('DELETE FROM rooms WHERE updated_at < ?').bind(new Date(Date.now()-STALE_DAYS*86400000).toISOString()).run();
      const count = await db.prepare('SELECT count(*) AS total FROM rooms').first(); if (count.total >= 500) fail('The site has reached its encounter capacity.',503);
      const result = makeRoom(data.name,data.encounter);
      await db.prepare('INSERT INTO rooms (code,revision,state,updated_at) VALUES (?,?,?,?)').bind(result.room.code,0,JSON.stringify(result.room),result.room.updatedAt).run();
      await db.prepare('DELETE FROM rate_limits WHERE expires < ?').bind(Date.now()).run();
      return json({token:result.token,memberId:result.memberId,room:publicRoom(result.room,result.room.members[0])},201);
    }
    const match = path.match(/^\/rooms\/([A-Fa-f0-9]{18})(?:\/(join|actions|close))?$/); if (!match) fail('Endpoint not found.',404);
    const code = match[1].toUpperCase(), route = match[2]; let room = await settle(db,code,await find(db,code));
    if (route === 'join' && request.method === 'POST') {
      if (room.phase === 'ended') fail('This encounter is over.'); await rate(db,'join:'+ip,20); const data = await input(request), { member,token } = makeMember(data.name,'player');
      for (let attempt = 0; attempt < 4; attempt++) {
        if (room.members.length >= 40) fail('This room is full.');
        const revision = room.revision; room.members.push(member); room.revision++; log(room,member.name+' joined the room.');
        if (await update(db,room,revision)) return json({token,memberId:member.id,room:publicRoom(room,member)},201);
        room = await settle(db,code,await find(db,code));
      }
      fail('The room is busy. Please try joining again.',409);
    }
    const token = (request.headers.get('authorization') || '').replace(/^Bearer /,''); const member = authenticate(room,token);
    if (route === 'close' && request.method === 'POST') {
      if (member.role !== 'dm') fail('Only the SM can close the encounter.',403);
      await db.prepare('DELETE FROM rooms WHERE code = ?').bind(code).run();
      return json({closed:true});
    }
    if (!route && request.method === 'GET') return json({memberId:member.id,room:publicRoom(room,member)});
    if (route === 'actions' && request.method === 'POST') {
      await rate(db,'action:'+member.id,120); const command = await input(request);
      room = await settle(db,code,await find(db,code)); const actor = authenticate(room,token); const revision = room.revision;
      // A roll can carry the roller's RP account token so their statuses add to it. It is looked up here, never trusted from the client.
      let boosts = [];
      if (command?.type === 'roll' && typeof command.itemsToken === 'string' && command.itemsToken) {
        const who = await db.prepare('SELECT id FROM members WHERE token_hash = ?').bind(createHash('sha256').update(command.itemsToken).digest('hex')).first();
        if (who) boosts = await rollBonuses(db,who.id);
      }
      const changed = apply(room,actor,command,boosts);
      if (changed && !await update(db,room,revision)) fail('The encounter changed. Review the latest state and try again.',409);
      return json({memberId:member.id,room:publicRoom(room,actor)});
    }
    fail('Endpoint not found.',404);
  } catch (error) { if (!error.status) console.error('Encounter request failed:',error.name); return json({error:error.status ? error.message : 'The encounter could not be saved. Please retry.'},error.status || 500); }
}

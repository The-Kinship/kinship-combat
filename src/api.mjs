import { makeRoom, makeMember, authenticate, publicRoom, apply, log, fail, expireIfDue } from './engine.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { handleScenes } from './scenes.mjs';
import { handleItems } from './items.mjs';
import { handleStashes } from './stashes.mjs';
import { handleSigns } from './signs.mjs';
import { handleBank } from './bank.mjs';
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
async function find(db,code) { const row = await db.prepare('SELECT state FROM rooms WHERE code = ?').bind(code).first(); if (!row) fail('Room not found. Check the code with your DM.',404); return JSON.parse(row.state); }
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
  if (!timingSafeEqual(a,b)) fail('That creation password is not right. Ask your DM or the FC leader.',403);
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
export async function handle(request,db,createPassword,memberPassword,bankPassword,extras = {}) {
  try {
    if (!db) fail('The encounter database is not ready. Please try again shortly.',503);
    const path = new URL(request.url).pathname.replace(/^\/api/,'');
    if (request.method === 'GET' && path === '/health') { await db.prepare('SELECT code FROM rooms LIMIT 1').first(); return json({ok:true,service:'Kinship Combat'}); }
    if (!['GET','POST'].includes(request.method)) fail('Method not allowed.',405);
    if (request.method === 'POST') { const origin = request.headers.get('origin'); if (origin && origin !== new URL(request.url).origin) fail('This action must come from the Kinship Combat website.',403); }
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (path === '/sects' || path.startsWith('/sects/')) return await handleSects(request,db,path,{ json,input,rate,ip,hashKey:k => createHash('sha256').update(k).digest('hex'),extras });
    if (path === '/statuses' || path.startsWith('/statuses/')) return await handleStatuses(request,db,path,{ json,input,rate,ip,checkCreate:supplied => checkCreate(supplied,createPassword) });
    if (path === '/quests' || path.startsWith('/quests/')) return await handleQuests(request,db,path,{ json,input,rate,ip,checkCreate:supplied => checkCreate(supplied,createPassword) });
    if (path === '/bank' || path.startsWith('/bank/')) return await handleBank(request,db,path,{ json,input,rate,ip,checkBank:supplied => checkBank(supplied,bankPassword) });
    if (path === '/signs' || path.startsWith('/signs/')) return await handleSigns(request,db,path,{ json,input,rate,ip,checkCreate:supplied => checkCreate(supplied,createPassword) });
    if (path === '/stashes' || path.startsWith('/stashes/')) return await handleStashes(request,db,path,{ json,input,rate,ip });
    if (path === '/items' || path.startsWith('/items/')) return await handleItems(request,db,path,{ json,input,rate,ip,checkCreate:supplied => checkCreate(supplied,createPassword),checkMember:supplied => checkMember(supplied,memberPassword) });
    if (path === '/scenes' || path.startsWith('/scenes/')) return await handleScenes(request,db,path,{ json,input,rate,ip,checkCreate:supplied => checkCreate(supplied,createPassword) });
    if (request.method === 'POST' && path === '/rooms') {
      await rate(db,'create:'+ip,8);
      const data = await input(request); checkCreate(data.createPassword,createPassword);
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
      if (member.role !== 'dm') fail('Only the DM can close the encounter.',403);
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

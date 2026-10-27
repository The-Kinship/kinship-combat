import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of ['0001_init.sql','0002_scenes.sql'])sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(path==='/scenes'&&data.createPassword===undefined?{...data,createPassword:'letmein'}:data)}),db,'letmein');return {status:r.status,...await r.json()}};

async function scene(call,title='Mansion RP',players=['Ash','Bryn','Cole']){
  const dm=await call('POST','/scenes',{name:'Mira',title});assert.equal(dm.status,201);
  const joined=[];for(const n of players){const j=await call('POST',`/scenes/${dm.code}/join`,{name:n});assert.equal(j.status,201);joined.push(j)}
  return {dm,joined,code:dm.code};
}

test('a DM makes a scene, players join, and only the DM sees who is in it',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const s=await scene(call);
  assert.match(s.code,/^[A-F0-9]{18}$/);
  const dmView=await call('GET',`/scenes/${s.code}?after=0`,undefined,s.dm.token);
  assert.deepEqual(dmView.members.map(m=>m.name),['Ash','Bryn','Cole']);
  assert.equal('members' in (await call('GET',`/scenes/${s.code}?after=0`,undefined,s.joined[0].token)),false);
  assert.equal((await call('GET',`/scenes/${s.code}?after=0`)).status,401);
  assert.equal(JSON.stringify(dmView).includes('tokenHash'),false);
});

test('a popup to everyone reaches every player; a popup to chosen people reaches only them',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const s=await scene(call);
  const [ash,bryn,cole]=s.joined;
  const all=await call('POST',`/scenes/${s.code}/send`,{text:'You hear screaming from the house by the water.'},s.dm.token);
  assert.equal(all.status,200);assert.equal(all.delivered,3);
  const some=await call('POST',`/scenes/${s.code}/send`,{text:'Bandits charge out of the house!',ooc:'((Encounter started! Stay put.))',to:[ash.memberId,cole.memberId]},s.dm.token);
  assert.equal(some.delivered,2);
  const texts=async p=>(await call('GET',`/scenes/${s.code}?after=0`,undefined,p.token)).events.map(e=>e.text);
  assert.equal((await texts(ash)).length,2);assert.equal((await texts(cole)).length,2);
  assert.deepEqual(await texts(bryn),['You hear screaming from the house by the water.']);
  const ev=(await call('GET',`/scenes/${s.code}?after=0`,undefined,ash.token)).events[1];
  assert.equal(ev.ooc,'((Encounter started! Stay put.))');
});

test('polling only returns what is new, and after=-1 just says where things stand',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const s=await scene(call,'x',['Ash']);const ash=s.joined[0];
  await call('POST',`/scenes/${s.code}/send`,{text:'one'},s.dm.token);
  const start=await call('GET',`/scenes/${s.code}?after=-1`,undefined,ash.token);
  assert.deepEqual(start.events,[]);assert.equal(start.lastId,1);
  await call('POST',`/scenes/${s.code}/send`,{text:'two'},s.dm.token);
  const next=await call('GET',`/scenes/${s.code}?after=${start.lastId}`,undefined,ash.token);
  assert.deepEqual(next.events.map(e=>e.text),['two']);assert.equal(next.lastId,2);
  assert.deepEqual((await call('GET',`/scenes/${s.code}?after=${next.lastId}`,undefined,ash.token)).events,[]);
});

test('players cannot send popups, and bad recipients or empty text are refused',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const s=await scene(call);
  assert.equal((await call('POST',`/scenes/${s.code}/send`,{text:'hi'},s.joined[0].token)).status,403);
  assert.equal((await call('POST',`/scenes/${s.code}/send`,{text:'   '},s.dm.token)).status,400);
  assert.equal((await call('POST',`/scenes/${s.code}/send`,{text:'x'.repeat(301)},s.dm.token)).status,400);
  assert.equal((await call('POST',`/scenes/${s.code}/send`,{text:'hi',to:['not-a-member']},s.dm.token)).status,400);
  assert.equal((await call('POST',`/scenes/${s.code}/send`,{text:'hi',to:[s.dm.memberId]},s.dm.token)).status,400);   // the DM is not a recipient
});

test('two scenes run at the same time without seeing each other',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const onyx=await scene(call,'Onyx mansion',['Ash','Bryn']);
  const patrol=await scene(call,'Vanguard patrol',['Cole','Dax']);
  await call('POST',`/scenes/${onyx.code}/send`,{text:'The candles gutter out.'},onyx.dm.token);
  await call('POST',`/scenes/${patrol.code}/send`,{text:'Hoofbeats on the road.'},patrol.dm.token);
  const get=(s,p)=>call('GET',`/scenes/${s.code}?after=0`,undefined,p.token);
  assert.deepEqual((await get(onyx,onyx.joined[0])).events.map(e=>e.text),['The candles gutter out.']);
  assert.deepEqual((await get(patrol,patrol.joined[1])).events.map(e=>e.text),['Hoofbeats on the road.']);
  // a player's key for one scene does nothing in the other
  assert.equal((await call('GET',`/scenes/${patrol.code}?after=0`,undefined,onyx.joined[0].token)).status,401);
  assert.equal((await call('POST',`/scenes/${patrol.code}/send`,{text:'sneaky'},onyx.dm.token)).status,401);
});

test('leaving removes you from the DM list, and closing deletes the scene for everyone',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const s=await scene(call);
  assert.equal((await call('POST',`/scenes/${s.code}/leave`,{},s.joined[1].token)).left,true);
  assert.deepEqual((await call('GET',`/scenes/${s.code}?after=0`,undefined,s.dm.token)).members.map(m=>m.name),['Ash','Cole']);
  assert.equal((await call('POST',`/scenes/${s.code}/leave`,{},s.dm.token)).status,400);
  assert.equal((await call('POST',`/scenes/${s.code}/close`,{},s.joined[0].token)).status,403);
  assert.equal((await call('POST',`/scenes/${s.code}/close`,{},s.dm.token)).closed,true);
  assert.equal((await call('GET',`/scenes/${s.code}?after=0`,undefined,s.joined[0].token)).status,404);
});

test('cross-origin writes are refused and stale scenes are cleared',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const bad=await handle(new Request('https://kinship.test/api/scenes',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://other.test'},body:JSON.stringify({name:'x',title:'y',createPassword:'letmein'})}),db,'letmein');
  assert.equal(bad.status,403);
  const s=await scene(call,'Old',['Ash']);
  db.sqlite.prepare('UPDATE scenes SET updated_at = ? WHERE code = ?').run(new Date(Date.now()-8*86400000).toISOString(),s.code);
  await call('POST','/scenes',{name:'New',title:'Fresh'});
  assert.equal((await call('GET',`/scenes/${s.code}?after=0`,undefined,s.dm.token)).status,404);
});

test('creating needs the creation password, but joining only needs a code',async t=>{
  const db=database();t.after(()=>db.sqlite.close());
  const raw=(pw,expected='letmein')=>async(path,data)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://kinship.test'},body:JSON.stringify(pw===undefined?data:{...data,createPassword:pw})}),db,expected);return {status:r.status,...await r.json()}};
  assert.equal((await raw(undefined)('/scenes',{name:'x',title:'y'})).status,403);
  assert.equal((await raw('wrong')('/scenes',{name:'x',title:'y'})).status,403);
  assert.equal((await raw('wrong')('/rooms',{name:'x',encounter:'y'})).status,403);
  assert.equal((await raw('letmein','')('/scenes',{name:'x',title:'y'})).status,503);
  const ok=await raw('letmein')('/scenes',{name:'Mira',title:'Mansion'});assert.equal(ok.status,201);
  const room=await raw('letmein')('/rooms',{name:'Mira',encounter:'Fight'});assert.equal(room.status,201);
  assert.equal((await raw(undefined)(`/scenes/${ok.code}/join`,{name:'Ash'})).status,201);
  assert.equal((await raw(undefined)(`/rooms/${room.room.code}/join`,{name:'Ash'})).status,201);
});

test('the DM can remove someone from a scene and they lose access',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const s=await scene(call);const [ash,bryn]=s.joined;
  assert.equal((await call('POST',`/scenes/${s.code}/kick`,{memberId:bryn.memberId},ash.token)).status,403);
  const k=await call('POST',`/scenes/${s.code}/kick`,{memberId:bryn.memberId},s.dm.token);assert.equal(k.status,200);
  assert.equal((await call('GET',`/scenes/${s.code}?after=-1`,undefined,bryn.token)).status,401);
  assert.equal((await call('GET',`/scenes/${s.code}?after=-1`,undefined,ash.token)).status,200);
  assert.equal((await call('POST',`/scenes/${s.code}/kick`,{memberId:bryn.memberId},s.dm.token)).status,404);
  const dmView=await call('GET',`/scenes/${s.code}?after=-1`,undefined,s.dm.token);
  assert.deepEqual(dmView.members.map(m=>m.name),['Ash','Cole']);
});

test('a popup can carry a combat room code so players get a join button',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const s=await scene(call);const [ash,bryn]=s.joined;
  const room='ABCDEF0123456789AB';
  db.sqlite.prepare("INSERT INTO rooms (code, revision, state, updated_at) VALUES (?,?,?,?)").run(room,0,'{}',new Date().toISOString());
  assert.equal((await call('POST',`/scenes/${s.code}/send`,{text:'Fight!',combat:'not a code'},s.dm.token)).status,400);
  assert.equal((await call('POST',`/scenes/${s.code}/send`,{text:'Fight!',combat:'0123456789ABCDEF01'},s.dm.token)).status,404);   // no such room
  assert.equal((await call('POST',`/scenes/${s.code}/send`,{text:'Fight!',combat:room.toLowerCase(),to:[ash.memberId]},s.dm.token)).status,200);
  await call('POST',`/scenes/${s.code}/send`,{text:'Plain popup'},s.dm.token);
  const a=(await call('GET',`/scenes/${s.code}?after=0`,undefined,ash.token)).events;
  assert.equal(a[0].combat,room);assert.equal(a[1].combat,'');
  assert.equal((await call('GET',`/scenes/${s.code}?after=0`,undefined,bryn.token)).events.length,1);   // Bryn was not sent the code
});

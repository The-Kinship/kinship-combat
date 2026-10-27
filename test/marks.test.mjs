import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('migrations/'+f,'utf8'));
  const wrap=s=>({bind:(...a)=>({run:async()=>{const r=s.run(...a);return {meta:{changes:Number(r.changes)}}},first:async()=>s.get(...a)??null,all:async()=>({results:s.all(...a)})}),run:async()=>{const r=s.run();return {meta:{changes:Number(r.changes)}}},first:async()=>s.get()??null,all:async()=>({results:s.all()})});
  return {sqlite,prepare:q=>wrap(sqlite.prepare(q))}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpass');return {status:r.status,...await r.json()}};
async function join(call,name,code){const r=await call('POST','/items/register',{name,memberPassword:'fcpass',recoveryCode:code});assert.equal(r.status,201);return r}
const adm=(call,path,data)=>call('POST','/marks/admin/'+path,{adminPassword:'dmpass',...data});

test('marks, removing from the system, and bans (Advocates only)',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Tobin Grey'),alt=await join(call,'Tobin Alt',a.recoveryCode),b=await join(call,'Mira');
  assert.equal(alt.linked,true);
  assert.equal((await call('POST','/marks/admin/list',{adminPassword:'nope'})).status,403);
  assert.equal((await adm(call,'add',{name:'Nobody',reason:'x'})).status,404);
  assert.equal((await adm(call,'add',{name:'Tobin Grey',reason:''})).status,400);
  assert.equal((await adm(call,'add',{name:'Tobin Grey',reason:'Inappropriate portrait'})).status,201);
  assert.equal((await adm(call,'add',{name:'tobin  grey',reason:'Scammed gold in a trade'})).status,201);
  let list=(await adm(call,'list',{})).people;assert.equal(list.length,1);assert.equal(list[0].marks.length,2);assert.equal(list[0].registered,true);
  assert.equal((await adm(call,'remove',{id:list[0].marks[0].id})).status,200);
  assert.equal((await adm(call,'remove',{id:list[0].marks[0].id})).status,404);
  // removing from the system removes every character of that player but keeps the record
  const kick=await adm(call,'kick',{name:'Tobin Grey',reason:'Repeated scams'});assert.equal(kick.status,200);assert.deepEqual(kick.removed.sort(),['Tobin Alt','Tobin Grey']);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM members").get().n,1);
  list=(await adm(call,'list',{})).people;assert.equal(list[0].registered,false);assert.equal(list[0].banned,false);assert.ok(list[0].marks.some(m=>m.reason.startsWith('Removed from the system')));
  assert.equal((await call('GET','/items/me',undefined,a.token)).status,401);
  await join(call,'Tobin Grey');   // not banned, so a new registration is allowed
  // ban: names are blocked from registering again
  const ban=await adm(call,'ban',{name:'Tobin Grey',reason:'Harassment'});assert.equal(ban.status,200);assert.equal(ban.banned,true);
  db.sqlite.exec('DELETE FROM rate_limits');
  const again=await call('POST','/items/register',{name:'Tobin Grey',memberPassword:'fcpass'});assert.equal(again.status,403);
  assert.equal((await call('POST','/items/register',{name:'tobin   GREY',memberPassword:'fcpass'})).status,403);
  assert.equal((await adm(call,'unban',{name:'Nobody'})).status,404);
  assert.equal((await adm(call,'unban',{name:'Tobin Grey'})).status,200);
  db.sqlite.exec('DELETE FROM rate_limits');
  await join(call,'Tobin Grey');
  // a ban can also be placed on a name that is no longer registered but has a record
  await adm(call,'kick',{name:'Tobin Grey',reason:'again'});
  assert.equal((await adm(call,'ban',{name:'Tobin Grey',reason:'final'})).status,200);
});

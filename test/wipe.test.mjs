import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';
import { KEEP_TABLES, OPTIONAL_TABLES, WIPE_TABLES } from '../src/wipe.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('migrations/'+f,'utf8'));
  const wrap=s=>({bind:(...a)=>({run:async()=>{const r=s.run(...a);return {meta:{changes:Number(r.changes)}}},first:async()=>s.get(...a)??null,all:async()=>({results:s.all(...a)})}),run:async()=>{const r=s.run();return {meta:{changes:Number(r.changes)}}},first:async()=>s.get()??null,all:async()=>({results:s.all()})});
  return {sqlite,prepare:q=>wrap(sqlite.prepare(q))}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpass',{scenePassword:'scenepass'});return {status:r.status,...await r.json()}};
async function join(call,name,code){const r=await call('POST','/items/register',{name,memberPassword:'fcpass',recoveryCode:code});assert.equal(r.status,201);return r}
const count=(db,t)=>db.sqlite.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;

test('every table is either kept or wiped (a new table must be classified here)',()=>{
  const db=database();const tables=db.sqlite.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map(t=>t.name);
  for(const t of tables)assert.ok([...KEEP_TABLES,...OPTIONAL_TABLES,...WIPE_TABLES].includes(t),'table not classified for the wipe: '+t);
  db.sqlite.close();
});

test('wipe keeps the named characters and clears the rest',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Mira Vale'),alt=await join(call,'Mira Alt',a.recoveryCode),b=await join(call,'Tobin');
  await call('POST','/profile',{glance:'Tall'},a.token);
  await call('POST','/items',{name:'Rope',icon:'game:20001',description:'x'},a.token);
  await call('POST','/items',{name:'Rope',icon:'game:20001',description:'x'},b.token);
  await call('POST','/mail',{to:'Tobin',subject:'Hi',body:'x'},a.token);
  await call('POST','/statuses/self',{name:'Calm',icon:'game:10205',description:'x',minutes:0},a.token);
  await call('POST','/reports',{kind:'bug',text:'x'},b.token);
  await call('POST','/quests/admin/save',{adminPassword:'dmpass',title:'Q',steps:[{type:'talk',npc:'Guard',text:'Hello'}]});
  await call('POST','/marks/admin/add',{adminPassword:'dmpass',name:'Tobin',reason:'test'});
  db.sqlite.exec("UPDATE members SET gold = 50");
  const ok={adminPassword:'dmpass',keep:['Mira Vale','Mira Alt']};
  assert.equal((await call('POST','/system/admin/wipe-check',{...ok,adminPassword:'scenepass'})).status,403);   // not with the scene password
  assert.equal((await call('POST','/system/admin/wipe-check',{...ok,keep:'Mira'})).status,400);
  const miss=await call('POST','/system/admin/wipe-check',{...ok,keep:['Nobody Here']});assert.equal(miss.status,404);
  const check=await call('POST','/system/admin/wipe-check',ok);assert.equal(check.status,200);
  assert.deepEqual(check.wipe.remove,['Tobin']);assert.equal(check.wipe.counts.items,2);assert.equal(check.wipe.counts.quests,undefined);
  assert.equal(count(db,'items'),2);                                                                             // a check changes nothing
  assert.equal((await call('POST','/system/admin/wipe',ok)).status,400);                                          // needs the confirm phrase
  assert.equal((await call('POST','/system/admin/wipe',{...ok,confirm:'wipe'})).status,400);
  const done=await call('POST','/system/admin/wipe',{...ok,confirm:'WIPE EVERYTHING'});assert.equal(done.status,200);assert.equal(done.wipe.done,true);
  assert.equal(count(db,'members'),2);assert.equal(count(db,'players'),1);assert.equal(count(db,'profiles'),1);
  for(const t of ['items','mails','statuses','reports','gold_log','worn','duels','rooms','scenes'])assert.equal(count(db,t),0,t);
  assert.equal(count(db,'quests'),1);assert.equal(count(db,'marks'),1);                                           // quests and marks stay unless asked
  assert.equal(db.sqlite.prepare('SELECT max(gold) AS g FROM members').get().g,0);
  assert.equal((await call('GET','/items/me',undefined,a.token)).status,200);                                      // the kept character still signs in
  assert.equal((await call('GET','/items/me',undefined,b.token)).status,401);
  db.sqlite.exec('DELETE FROM rate_limits');
  const w2=await call('POST','/system/admin/wipe',{...ok,quests:true,confirm:'WIPE EVERYTHING'});assert.equal(w2.status,200);assert.equal(count(db,'quests'),0);
});

test('wipe with nobody kept removes every character, with a stronger confirm phrase',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Mira Vale'),b=await join(call,'Tobin');
  await call('POST','/items',{name:'Rope',icon:'game:20001',description:'x'},a.token);
  const none={adminPassword:'dmpass',keep:[]};
  const check=await call('POST','/system/admin/wipe-check',none);assert.equal(check.status,200);assert.equal(check.wipe.remove.length,2);
  assert.equal((await call('POST','/system/admin/wipe',{...none,confirm:'WIPE EVERYTHING'})).status,400);
  assert.equal(count(db,'members'),2);
  assert.equal((await call('POST','/system/admin/wipe',{...none,confirm:'WIPE ALL CHARACTERS'})).status,200);
  assert.equal(count(db,'members'),0);assert.equal(count(db,'players'),0);assert.equal(count(db,'items'),0);
});

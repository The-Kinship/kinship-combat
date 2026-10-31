import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpw');return {status:r.status,...await r.json()}};
const joinm=async(call,name)=>call('POST','/items/register',{name,memberPassword:'fcpass'});
const job=(extra={})=>({adminPassword:'dmpass',title:'Herbs',intro:'Fetch some herbs.',steps:[{type:'talk',npc:'Herbalist',text:'Thank you.'}],...extra});
test('the job board: everyone jobs, first-come jobs, giving up, and one-time rules',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await joinm(call,'Mira'),b=await joinm(call,'Kael');
  const every=await call('POST','/quests/admin/save',job({title:'Halloween',board:'main',boardMode:'all'}));assert.equal(every.status,201);
  const first=await call('POST','/quests/admin/save',job({title:'Fetch herbs',board:'main',boardMode:'first'}));assert.equal(first.status,201);
  const hidden=await call('POST','/quests/admin/save',job({title:'Not posted'}));assert.equal(hidden.status,201);
  const list=async tok=>(await call('GET','/quests/jobs',undefined,tok)).jobs;
  assert.deepEqual((await list(a.token)).map(j=>j.title).sort(),['Fetch herbs','Halloween']);   // the unposted quest never shows
  // first come: Mira takes it, Kael no longer sees it and cannot take it
  assert.equal((await call('POST','/quests/jobs/take',{questId:first.id},a.token)).status,201);
  assert.deepEqual((await list(b.token)).map(j=>j.title),['Halloween']);
  assert.equal((await call('POST','/quests/jobs/take',{questId:first.id},b.token)).status,409);
  assert.equal((await call('POST','/quests/jobs/take',{questId:first.id},a.token)).status,409);   // already hers
  // everyone job: both can take it, once each
  assert.equal((await call('POST','/quests/jobs/take',{questId:every.id},a.token)).status,201);
  assert.equal((await call('POST','/quests/jobs/take',{questId:every.id},b.token)).status,201);
  assert.equal((await call('POST','/quests/jobs/take',{questId:every.id},b.token)).status,409);
  assert.equal((await list(a.token)).length,0);
  // the taken quests show in the normal quest list
  assert.equal((await call('GET','/quests/mine',undefined,a.token)).quests.length,2);
  // giving a first-come job up (no progress yet) puts it back on the board for everyone, including her
  assert.equal((await call('POST','/quests/jobs/drop',{questId:first.id},a.token)).status,200);
  assert.deepEqual((await list(b.token)).map(j=>j.title),['Fetch herbs']);
  assert.deepEqual((await list(a.token)).map(j=>j.title),['Fetch herbs']);
  assert.equal((await call('POST','/quests/jobs/take',{questId:first.id},b.token)).status,201);
  assert.equal((await list(a.token)).length,0);
  // a job that was not posted cannot be taken
  assert.equal((await call('POST','/quests/jobs/take',{questId:hidden.id},a.token)).status,404);
  // a normal player cannot post jobs: the admin routes need the password
  assert.equal((await call('POST','/quests/admin/save',{...job({board:'main'}),adminPassword:'nope'})).status,403);
});
test('a finished job cannot be dropped or taken again, and giving up after progress is final',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await joinm(call,'Mira');
  const two=await call('POST','/quests/admin/save',job({title:'Two steps',board:'main',boardMode:'first',steps:[{type:'talk',npc:'Herbalist',text:'One.'},{type:'talk',npc:'Herbalist',text:'Two.'}]}));
  await call('POST','/quests/jobs/take',{questId:two.id},a.token);
  db.sqlite.prepare("UPDATE quest_progress SET step = 1 WHERE quest_id = ?").run(two.id);   // she got past step one
  assert.equal((await call('POST','/quests/jobs/drop',{questId:two.id},a.token)).status,200);
  assert.equal((await call('GET','/quests/jobs',undefined,a.token)).jobs.length,0);   // she cannot take it again
  assert.equal((await call('POST','/quests/jobs/take',{questId:two.id},a.token)).status,409);
  const b=await joinm(call,'Kael');   // but it is free for someone else
  assert.equal((await call('GET','/quests/jobs',undefined,b.token)).jobs.length,1);
  await call('POST','/quests/jobs/take',{questId:two.id},b.token);
  db.sqlite.prepare("UPDATE quest_progress SET done = 1 WHERE quest_id = ?").run(two.id);
  assert.equal((await call('POST','/quests/jobs/drop',{questId:two.id},b.token)).status,409);
  assert.equal((await call('GET','/quests/jobs',undefined,b.token)).jobs.length,0);
  const list=await call('POST','/quests/admin/list',{adminPassword:'dmpass'});
  assert.equal(list.quests[0].board,'main');assert.equal(list.quests[0].boardMode,'first');
});

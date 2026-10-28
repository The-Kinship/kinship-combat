import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('migrations/'+f,'utf8'));
  const wrap=s=>({bind:(...a)=>({run:async()=>{const r=s.run(...a);return {meta:{changes:Number(r.changes)}}},first:async()=>s.get(...a)??null,all:async()=>({results:s.all(...a)})}),run:async()=>{const r=s.run();return {meta:{changes:Number(r.changes)}}},first:async()=>s.get()??null,all:async()=>({results:s.all()})});
  return {sqlite,prepare:q=>wrap(sqlite.prepare(q))}}
const mk=(db,extras)=>async(method,path,data)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{'Content-Type':'application/json',Origin:'https://kinship.test'},body:JSON.stringify(data)}),db,'dmpass','fcpass','bankpass',extras);return {status:r.status,...await r.json()}};

test('a separate scene password starts scenes and encounters but opens no other SM tool',async t=>{
  const db=database();t.after(()=>db.sqlite.close());
  const call=mk(db,{scenePassword:'scenepass'});
  assert.equal((await call('POST','/scenes',{name:'A',title:'x',createPassword:'wrong'})).status,403);
  assert.equal((await call('POST','/scenes',{name:'A',title:'x',createPassword:'scenepass'})).status,201);
  assert.equal((await call('POST','/scenes',{name:'A',title:'x',createPassword:'dmpass'})).status,201);   // the creation password still works
  assert.equal((await call('POST','/rooms',{name:'A',encounter:'Fight',createPassword:'scenepass'})).status,201);
  assert.equal((await call('POST','/rooms',{name:'A',encounter:'Fight',createPassword:'wrong'})).status,403);
  // everything else still needs the creation password
  assert.equal((await call('POST','/marks/admin/list',{adminPassword:'scenepass'})).status,403);
  assert.equal((await call('POST','/reports/admin/list',{adminPassword:'scenepass'})).status,403);
  assert.equal((await call('POST','/items/admin/remove-member',{adminPassword:'scenepass',name:'X'})).status,403);
  assert.equal((await call('POST','/statuses/admin/add',{adminPassword:'scenepass',to:'X'})).status,403);
  // with no scene password set, nothing changes
  const plain=mk(db,{});
  assert.equal((await plain('POST','/scenes',{name:'A',title:'x',createPassword:'scenepass'})).status,403);
  assert.equal((await plain('POST','/scenes',{name:'A',title:'x',createPassword:'dmpass'})).status,201);
  // quests: the scene password can make and manage quests, but a status reward cannot carry roll bonuses
  const step=g=>({type:'talk',npc:'Guard',text:'Hello',grants:g});
  const grant={name:'Blessed',icon:'game:10205',minutes:10,atk:3,heal:2};
  const q1=await call('POST','/quests/admin/save',{adminPassword:'scenepass',title:'Tester quest',steps:[step(grant)]});assert.equal(q1.status,201);
  const q2=await call('POST','/quests/admin/save',{adminPassword:'dmpass',title:'SM quest',steps:[step(grant)]});assert.equal(q2.status,201);
  const list=await call('POST','/quests/admin/list',{adminPassword:'scenepass'});assert.equal(list.status,200);
  const get=id=>list.quests.find(q=>q.id===id).steps[0].grants;
  assert.equal(get(q1.id).atk,0);assert.equal(get(q1.id).heal,0);
  assert.equal(get(q2.id).atk,3);assert.equal(get(q2.id).heal,2);
  assert.equal((await call('POST','/quests/admin/delete',{adminPassword:'scenepass',questId:q1.id})).status,200);
  assert.equal((await call('POST','/quests/admin/save',{adminPassword:'wrong',title:'x',steps:[step(grant)]})).status,403);
});

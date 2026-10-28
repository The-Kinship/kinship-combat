import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('migrations/'+f,'utf8'));
  const wrap=s=>({bind:(...a)=>({run:async()=>{const r=s.run(...a);return {meta:{changes:Number(r.changes)}}},first:async()=>s.get(...a)??null,all:async()=>({results:s.all(...a)})}),run:async()=>{const r=s.run();return {meta:{changes:Number(r.changes)}}},first:async()=>s.get()??null,all:async()=>({results:s.all()})});
  return {sqlite,prepare:q=>wrap(sqlite.prepare(q))}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpass',{scenePassword:'scenepass'});return {status:r.status,...await r.json()}};

test('alpha gear switch: testers can add gear bonuses only while it is on',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await call('POST','/items/register',{name:'Mira Vale',memberPassword:'fcpass'});assert.equal(a.status,201);
  const gear={name:'Test Helm',icon:'game:20001',description:'x',wearSlot:'helm',gearAtk:3,gearHeal:-2};
  assert.equal((await call('GET','/items/me',undefined,a.token)).alphaGear,false);
  await call('POST','/items',gear,a.token);
  let row=db.sqlite.prepare("SELECT gear_atk, gear_heal FROM items WHERE name='Test Helm'").get();
  assert.equal(row.gear_atk,0);assert.equal(row.gear_heal,0);                                       // off: bonus ignored
  // only the creation password can flip it
  assert.equal((await call('POST','/system/admin/alpha',{adminPassword:'scenepass',on:true})).status,403);
  assert.equal((await call('POST','/system/admin/alpha',{adminPassword:'fcpass',on:true})).status,403);
  assert.equal((await call('POST','/system/admin/alpha',{adminPassword:'dmpass',on:'yes'})).status,400);
  assert.equal((await call('POST','/system/admin/alpha',{adminPassword:'dmpass',on:true})).alphaGear,true);
  assert.equal((await call('GET','/items/me',undefined,a.token)).alphaGear,true);
  await call('POST','/items',{...gear,name:'Alpha Helm',gearAtk:9},a.token);                         // 9 is out of range
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM items WHERE name='Alpha Helm'").get().n,0);
  await call('POST','/items',{...gear,name:'Alpha Helm'},a.token);
  row=db.sqlite.prepare("SELECT gear_atk, gear_heal FROM items WHERE name='Alpha Helm'").get();
  assert.equal(row.gear_atk,3);assert.equal(row.gear_heal,-2);
  // statuses still can't carry bonuses from members
  await call('POST','/items',{name:'Tonic',icon:'game:20001',description:'x',useText:'Drink',stName:'Fizzy',stDesc:'x',stIcon:'game:10205',stAtk:4},a.token);
  assert.equal(db.sqlite.prepare("SELECT st_atk FROM items WHERE name='Tonic'").get().st_atk,0);
  assert.equal((await call('POST','/system/admin/alpha',{adminPassword:'dmpass',on:false})).alphaGear,false);
  await call('POST','/items',{...gear,name:'Late Helm'},a.token);
  assert.equal(db.sqlite.prepare("SELECT gear_atk FROM items WHERE name='Late Helm'").get().gear_atk,0);
  assert.equal((await call('POST','/system/admin/alpha-get',{adminPassword:'dmpass'})).alphaGear,false);
});

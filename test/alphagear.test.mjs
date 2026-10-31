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

test('alpha mode gives each character 50 gold once',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const gold=n=>db.sqlite.prepare('SELECT gold FROM members WHERE name=?').get(n).gold;
  const early=await call('POST','/items/register',{name:'Early Bird',memberPassword:'fcpass'});assert.equal(early.status,201);
  assert.equal(gold('Early Bird'),0);                                                    // alpha off: nothing
  const on=await call('POST','/system/admin/alpha',{adminPassword:'dmpass',on:true});assert.equal(on.granted,1);
  assert.equal(gold('Early Bird'),50);                                                   // already registered: paid on switching on
  await call('POST','/items/register',{name:'Late Comer',memberPassword:'fcpass'});
  assert.equal(gold('Late Comer'),50);                                                   // registered during alpha: paid at once
  db.sqlite.exec("UPDATE members SET gold = 0");                                         // spent it all
  await call('POST','/system/admin/alpha',{adminPassword:'dmpass',on:false});
  assert.equal((await call('POST','/system/admin/alpha',{adminPassword:'dmpass',on:true})).granted,0);
  assert.equal(gold('Early Bird'),0);assert.equal(gold('Late Comer'),0);                 // never again
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM gold_log WHERE note='Alpha test starting gold'").get().n,2);
});

test('alpha mode can cap how many characters register',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const reg=n=>call('POST','/items/register',{name:n,memberPassword:'fcpass'});
  assert.equal((await call('POST','/system/admin/alpha',{adminPassword:'scenepass',on:true,maxCharacters:2})).status,403);
  assert.equal((await call('POST','/system/admin/alpha',{adminPassword:'dmpass',on:true,maxCharacters:-1})).status,400);
  const r=await call('POST','/system/admin/alpha',{adminPassword:'dmpass',on:true,maxCharacters:2});assert.equal(r.maxCharacters,2);assert.equal(r.characterCount,0);
  assert.equal((await reg('Tester One')).status,201);assert.equal((await reg('Tester Two')).status,201);
  const full=await reg('Stranger');assert.equal(full.status,403);assert.match(full.error,/full/);
  assert.equal((await call('POST','/system/admin/alpha-get',{adminPassword:'dmpass'})).characterCount,2);
  assert.equal((await call('POST','/system/admin/alpha',{adminPassword:'dmpass',maxCharacters:3})).maxCharacters,3);   // raise it without touching the other switch
  assert.equal((await reg('Stranger')).status,201);
  await call('POST','/system/admin/alpha',{adminPassword:'dmpass',on:false});                                       // cap only applies while alpha is on
  assert.equal((await reg('Anyone Else')).status,201);
});

test('alpha mode lets testers make themselves sick or cursed so they can try diagnosing',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await call('POST','/items/register',{name:'Mira',memberPassword:'fcpass'});
  const body={name:'Cold sweats',icon:'game:10205',isDebuff:true,statusType:'sickness',cureInfo:'Drink warm tea.'};
  assert.equal((await call('POST','/statuses/self',body,a.token)).status,201);
  let dx=await call('POST','/statuses/diagnose',{kind:'sickness',patient:'Mira'},a.token);
  assert.equal(dx.condition,'');   // not alpha: it was a plain status
  await call('POST','/system/admin/alpha',{adminPassword:'dmpass',on:true});
  assert.equal((await call('POST','/statuses/self',{...body,name:'Fever'},a.token)).status,201);
  assert.equal((await call('POST','/statuses/self',{...body,name:'Bad',statusType:'weird'},a.token)).status,400);
  let found='';for(let i=0;i<60&&!found;i++){db.sqlite.exec('DELETE FROM rate_limits');found=(await call('POST','/statuses/diagnose',{kind:'sickness',patient:'Mira'},a.token)).cure}
  assert.equal(found,'Drink warm tea.');
});

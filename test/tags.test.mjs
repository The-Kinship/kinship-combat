import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpw');return {status:r.status,...await r.json()}};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r}

test('SMs can tag registered characters, tags show on profiles, and the people list counts everyone',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Mira'),b=await join(call,'Kael');
  const admin=(p,d)=>call('POST','/items/admin/'+p,{adminPassword:'dmpass',...d});
  assert.equal((await call('POST','/items/admin/registered',{adminPassword:'nope'})).status,403);
  let r=await admin('registered',{});assert.equal(r.registered.length,2);assert.deepEqual(r.registered[0].tags,[]);assert.ok(r.tagChoices.includes('Onyx'));
  assert.equal((await admin('set-tags',{name:'Mira',tags:['Banker','SM','Onyx']})).status,200);
  assert.equal((await admin('set-tags',{name:'Mira',tags:['Wizard']})).status,400);
  assert.equal((await admin('set-tags',{name:'Nobody',tags:['SM']})).status,404);
  r=await admin('registered',{});assert.deepEqual(r.registered.find(p=>p.name==='Mira').tags,['SM','Banker','Onyx']);   // kept in list order
  const profiles=await call('GET','/profiles',undefined,b.token);
  assert.deepEqual(profiles.profiles.find(p=>p.name==='Mira').tags,['SM','Banker','Onyx']);
  assert.deepEqual(profiles.profiles.find(p=>p.name==='Kael').tags,[]);
  assert.deepEqual((await call('GET','/profile',undefined,a.token)).profile.tags,['SM','Banker','Onyx']);
  assert.equal((await admin('remove-member',{name:'Kael'})).status,200);
  assert.equal((await admin('registered',{})).registered.length,1);
});

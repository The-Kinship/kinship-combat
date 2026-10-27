import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('migrations/'+f,'utf8'));
  const wrap=s=>({bind:(...a)=>({run:async()=>{const r=s.run(...a);return {meta:{changes:Number(r.changes)}}},first:async()=>s.get(...a)??null,all:async()=>({results:s.all(...a)})}),run:async()=>{const r=s.run();return {meta:{changes:Number(r.changes)}}},first:async()=>s.get()??null,all:async()=>({results:s.all()})});
  return {sqlite,prepare:q=>wrap(sqlite.prepare(q))}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpass');return {status:r.status,...await r.json()}};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r.token}

test('profiles: save, everyone can read, bad links and too many fields are refused',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Mira Vale'),b=await join(call,'Tobin');
  assert.equal((await call('GET','/profiles')).status,401);
  let mine=await call('GET','/profile',undefined,a);assert.equal(mine.profile.name,'Mira Vale');assert.equal(mine.profile.glance,'');
  const body={displayName:'Sesen Silverborne of the Vale',portrait:'https://i.imgur.com/abc.png',age:'27',race:'Hyur',gender:'Female',glance:'A tall woman in a grey cloak.',ooc:'Slow replies at night',fields:[{label:'Voice',value:'Soft'},{label:'Scent',value:'Pine'}]};
  const saved=await call('POST','/profile',body,a);assert.equal(saved.status,200);assert.equal(saved.profile.fields.length,2);
  const all=await call('GET','/profiles',undefined,b);assert.equal(all.profiles.length,2);
  const mira=all.profiles.find(p=>p.name==='Mira Vale');assert.equal(mira.race,'Hyur');assert.equal(mira.displayName,'Sesen Silverborne of the Vale');assert.equal(mira.name,'Mira Vale');assert.equal(mira.portrait,'https://i.imgur.com/abc.png');assert.equal(all.profiles.find(p=>p.name==='Tobin').glance,'');
  assert.equal((await call('POST','/profile',{...body,portrait:'http://x.com/a.png'},a)).status,400);
  assert.equal((await call('POST','/profile',{...body,portrait:'javascript:alert(1)'},a)).status,400);
  assert.equal((await call('POST','/profile',{...body,fields:Array.from({length:7},()=>({label:'x',value:'y'}))},a)).status,400);
  assert.equal((await call('POST','/profile',{...body,fields:[{label:'',value:'y'}]},a)).status,400);
  assert.equal((await call('POST','/profile',{...body,glance:'x'.repeat(501)},a)).status,400);
  // saving again replaces; clearing the portrait is allowed; others' profiles are untouched
  const again=await call('POST','/profile',{glance:'Changed'},a);assert.equal(again.profile.glance,'Changed');assert.equal(again.profile.portrait,'');assert.deepEqual(again.profile.fields,[]);
  assert.equal((await call('GET','/profile',undefined,b)).profile.glance,'');
});

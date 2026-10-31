import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';
import { rollBonuses } from '../src/status-core.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpw');return {status:r.status,...await r.json()}};
const joinm=async(call,name)=>call('POST','/items/register',{name,memberPassword:'fcpass'});
const crystal={name:'Strange crystal',icon:'game:20001',description:'It glows.',carried:true,stName:'Anger',stDesc:'You feel short tempered.',stIcon:'game:10205',stDebuff:true};
const mine=async(call,tok)=>(await call('GET','/statuses',undefined,tok)).statuses;
test('a carried item gives its status while held, once, without using a slot, and it ends when the item goes',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await joinm(call,'Mira'),b=await joinm(call,'Kael');
  assert.equal((await call('POST','/items',crystal,a.token)).status,201);   // no action needed
  assert.equal((await call('POST','/items',crystal,a.token)).status,201);   // a second copy
  const list=(await mine(call,a.token)).filter(s=>s.memberName==='Mira'&&!s.combined);
  assert.equal(list.length,1);assert.equal(list[0].name,'Anger');assert.equal(list[0].carried,true);assert.equal(list[0].canRemove,false);
  // it does not use up the six slots
  for(let i=0;i<6;i++)assert.equal((await call('POST','/statuses/self',{name:'Mood '+i,icon:'game:10205'},a.token)).status,201);
  assert.equal((await mine(call,b.token)).filter(s=>s.memberName==='Mira'&&s.name==='Anger').length,1);   // everyone sees it
  // give one away: she still holds the other, so she keeps it; Kael gets it too
  const inv=(await call('GET','/items/me',undefined,a.token)).items;
  assert.equal(inv.length,1);assert.equal(inv[0].qty,2);
  assert.equal((await call('POST',`/items/${inv[0].id}/give`,{to:'Kael',count:1},a.token)).status,200);
  assert.equal((await mine(call,b.token)).filter(s=>s.memberName==='Kael'&&s.name==='Anger').length,1);
  assert.equal((await mine(call,b.token)).filter(s=>s.memberName==='Mira'&&s.name==='Anger').length,1);
  // delete her last one: the status is gone from her
  const left=(await call('GET','/items/me',undefined,a.token)).items[0];
  assert.equal((await call('POST',`/items/${left.id}/delete`,{},a.token)).status,200);
  assert.equal((await mine(call,b.token)).filter(s=>s.memberName==='Mira'&&s.name==='Anger').length,0);
  assert.equal((await mine(call,b.token)).filter(s=>s.memberName==='Kael'&&s.name==='Anger').length,1);
});
test('a carried item needs a status, can be edited, and its roll bonus counts',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await joinm(call,'Mira');
  assert.equal((await call('POST','/items',{name:'Plain',icon:'game:20001',carried:true},a.token)).status,400);
  assert.equal((await call('POST','/items',crystal,a.token)).status,201);
  const it=(await call('GET','/items/me',undefined,a.token)).items[0];assert.equal(it.carried,true);
  assert.equal((await call('POST',`/items/${it.id}/update`,{...crystal,carried:false,useText:'You rub it.',stMinutes:5},a.token)).status,200);
  assert.equal((await mine(call,a.token)).filter(s=>s.name==='Anger'&&s.carried).length,0);   // no longer carried
  assert.equal((await call('POST',`/items/${it.id}/update`,{...crystal},a.token)).status,200);
  assert.equal((await mine(call,a.token)).filter(s=>s.name==='Anger'&&s.carried).length,1);
  db.sqlite.prepare('UPDATE items SET st_atk = 2, st_heal = -1').run();   // an Advocate-set roll bonus on the carried status
  const memberId=db.sqlite.prepare('SELECT id FROM members').get().id;
  assert.deepEqual((await rollBonuses(db,memberId)).filter(b=>b.label==='Anger'),[{label:'Anger',atk:2,heal:-1}]);
  // using a carried item does not add a second, timed status
  const used=await call('POST',`/items/${it.id}/use`,{},a.token);assert.notEqual(used.status,200+1);
  assert.equal((await mine(call,a.token)).filter(s=>s.name==='Anger').length,1);
});

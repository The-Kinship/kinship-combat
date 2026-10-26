import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of ['0001_init.sql','0002_scenes.sql','0003_items.sql','0004_stashes.sql','0005_signs.sql','0006_item_requirements.sql','0007_bank.sql','0008_statuses.sql','0009_recipes.sql','0010_diagnosis.sql','0011_quests.sql','0012_quest_claims.sql'])sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass');return {status:r.status,...await r.json()}};
const spot={name:'Tree carving',description:'This tree seems to have marks carved into it. On closer inspection it reads "Help me".\nThe letters are fresh.',zone:'Mist',territory:339,map:72,x:10.5,y:2,z:-30.25,mapX:11.2,mapY:9.8};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r}

test('make a sign, everyone sees it in the list, the text comes with one sign',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  assert.equal((await call('GET','/signs')).status,401);
  const made=await call('POST','/signs',spot,a.token);assert.equal(made.status,201);assert.equal(made.sign.mine,true);assert.match(made.sign.description,/Help me/);
  const list=(await call('GET','/signs',undefined,b.token)).signs;
  assert.equal(list.length,1);assert.equal(list[0].name,'Tree carving');assert.equal(list[0].mine,false);assert.equal(list[0].ownerName,'Mira');assert.equal(list[0].description,undefined);
  const one=await call('GET',`/signs/${made.sign.id}`,undefined,b.token);assert.equal(one.status,200);assert.match(one.sign.description,/letters are fresh/);
  assert.equal((await call('GET','/signs/aaaaaaaaaaaa',undefined,b.token)).status,404);
});

test('bad input is refused and each member gets ten signs',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  assert.equal((await call('POST','/signs',{...spot,name:''},a.token)).status,400);
  assert.equal((await call('POST','/signs',{...spot,description:''},a.token)).status,400);
  assert.equal((await call('POST','/signs',{...spot,description:'x'.repeat(1001)},a.token)).status,400);
  assert.equal((await call('POST','/signs',{...spot,x:'far'},a.token)).status,400);
  for(let i=0;i<10;i++)assert.equal((await call('POST','/signs',{...spot,name:'S'+i},a.token)).status,201);
  assert.equal((await call('POST','/signs',spot,a.token)).status,409);
});

test('only the maker edits or deletes; advocates can delete with the creation password; removing a member clears their signs',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  const s=(await call('POST','/signs',spot,a.token)).sign;
  assert.equal((await call('POST',`/signs/${s.id}/update`,{name:'Hijack'},b.token)).status,403);
  assert.equal((await call('POST',`/signs/${s.id}/delete`,{},b.token)).status,403);
  const up=await call('POST',`/signs/${s.id}/update`,{name:'Carving',description:'New text',territory:340,map:73,x:1,y:1,z:1,mapX:1,mapY:1,zone:'Lavender Beds'},a.token);
  assert.equal(up.status,200);assert.equal(up.sign.name,'Carving');assert.equal(up.sign.zone,'Lavender Beds');assert.equal(up.sign.description,'New text');
  assert.equal((await call('POST','/signs/admin/delete',{adminPassword:'nope',signId:s.id})).status,403);
  assert.equal((await call('POST','/signs/admin/delete',{adminPassword:'dmpass',signId:s.id})).status,200);
  assert.equal((await call('GET','/signs',undefined,a.token)).signs.length,0);
  const s2=(await call('POST','/signs',spot,b.token)).sign;
  assert.equal((await call('POST','/items/admin/remove-member',{adminPassword:'dmpass',name:'Kael'})).status,200);
  assert.equal((await call('GET','/signs',undefined,a.token)).signs.length,0);
  const own=(await call('POST','/signs',spot,a.token)).sign;
  assert.equal((await call('POST',`/signs/${own.id}/delete`,{},a.token)).status,200);
});

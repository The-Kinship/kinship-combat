import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpw');return {status:r.status,...await r.json()}};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r}
const antidote={name:'Antidote',icon:'game:20002',description:'Bitter.',useLabel:'Drink',useText:'You feel better.',consumable:true,cures:'Chocolate poison'};

test('herbs combine into an antidote; missing herbs and forged herbs do not work',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  const mkItem=async(f,tok=a.token)=>{const r=await call('POST','/items',{icon:'game:20001',description:'',...f},tok);assert.equal(r.status,201);return r.items.find(i=>i.id===r.id)};
  assert.equal((await call('POST','/items',{name:'Herb A',icon:'game:20001',with:['Herb B']},a.token)).status,400);   // no result given
  assert.equal((await call('POST','/items',{name:'Herb A',icon:'game:20001',with:['Herb A'],result:antidote},a.token)).status,400);
  assert.equal((await call('POST','/items',{name:'Herb A',icon:'game:20001',with:['B','C','D','E'],result:antidote},a.token)).status,400);
  assert.equal((await call('POST','/items',{name:'Herb A',icon:'game:20001',with:['B','b'],result:antidote},a.token)).status,400);
  const herbA=await mkItem({name:'Herb A',with:['Herb B','herb c'],result:antidote});
  assert.equal(herbA.canCombine,true);assert.deepEqual(herbA.combineWith,['Herb B','herb c']);assert.equal(herbA.result.name,'Antidote');assert.equal(herbA.result.consumable,true);assert.equal(herbA.result.cures,'Chocolate poison');
  const herbC=await mkItem({name:'Herb C'});
  const missing=await call('POST',`/items/${herbA.id}/combine`,{},a.token);assert.equal(missing.status,409);assert.match(missing.error,/still need Herb B to combine/);
  const herbB=await mkItem({name:'Herb B'});
  const ok=await call('POST',`/items/${herbA.id}/combine`,{},a.token);assert.equal(ok.status,200);assert.equal(ok.combined,'Antidote');assert.deepEqual(ok.used.sort(),['Herb A','Herb B','Herb C']);
  assert.deepEqual(ok.items.map(i=>i.name),['Antidote']);assert.equal(ok.items[0].cures,'Chocolate poison');
  // forged herbs: someone else's items with the same names do not count
  const herbA2=await mkItem({name:'Herb A',with:['Herb B'],result:antidote});
  await call('POST',`/items/${herbA2.id}/give`,{to:'Kael'},a.token);
  await mkItem({name:'Herb B'},b.token);   // Kael makes his own fake Herb B
  const forged=await call('POST',`/items/${herbA2.id}/combine`,{},b.token);assert.equal(forged.status,409);
  assert.equal((await call('GET','/items/me',undefined,b.token)).items.length,2);   // nothing used up
  assert.equal((await call('POST',`/items/${herbB.id}/combine`,{},a.token)).status,404);   // not in inventory
  assert.equal((await call('POST',`/items/${(await mkItem({name:'Plain'})).id}/combine`,{},a.token)).status,400);
});

test('Advocates can make copies, into a member or a stash, and gifted reagents combine',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  const herb={name:'Herb A',icon:'game:20001',with:['Herb B'],result:antidote};
  assert.equal((await call('POST','/items/admin/grant',{...herb,adminPassword:'dmpass',to:'Mira',copies:101})).status,400);
  assert.equal((await call('POST','/items/admin/grant',{...herb,adminPassword:'dmpass',to:'Mira',copies:0})).status,400);
  const g=await call('POST','/items/admin/grant',{...herb,adminPassword:'dmpass',to:'Mira',copies:3});assert.equal(g.status,201);assert.equal(g.copies,3);
  {const inv=(await call('GET','/items/me',undefined,a.token)).items;assert.equal(inv.length,1);assert.equal(inv[0].qty,3);}   // identical copies share a slot
  const st=(await call('POST','/stashes',{name:'Herb patch',zone:'Mist',territory:339,map:72,x:1,y:1,z:1,mapX:1,mapY:1},a.token)).stash;
  assert.equal((await call('POST','/items/admin/grant',{name:'Herb B',icon:'game:20001',adminPassword:'dmpass',stashId:st.id,copies:5})).status,201);
  assert.equal((await call('GET',`/stashes/${st.id}`,undefined,a.token)).stashItems[0].qty,5);
  const hb=(await call('POST',`/stashes/${st.id}/take`,{itemId:(await call('GET',`/stashes/${st.id}`,undefined,a.token)).stashItems[0].id},a.token)).items;
  const herbA=hb.find(i=>i.name==='Herb A');assert.equal(herbA.canCombine,true);assert.equal(herbA.combineWith,undefined);   // only the maker sees the recipe
  const done=await call('POST',`/items/${herbA.id}/combine`,{},a.token);assert.equal(done.status,200);assert.equal(done.combined,'Antidote');
  assert.equal((await call('POST','/items/admin/grant',{name:'X',icon:'game:20001',adminPassword:'dmpass',stashId:'nope'})).status,404);
});

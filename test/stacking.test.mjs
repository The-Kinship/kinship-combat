import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass');return {status:r.status,...await r.json()}};
const herb={name:'Herb',icon:'game:20001',description:'A green sprig.'};
const join=async(call,name)=>(await call('POST','/items/register',{name,memberPassword:'fcpass'}));
const inv=async(call,tok)=>(await call('GET','/items/me',undefined,tok)).items;
const grant=(call,to,extra={})=>call('POST','/items/admin/grant',{...herb,adminPassword:'dmpass',to,...extra});

test('identical items share a slot, ten to a stack, and an eleventh starts a new one',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  for(let i=0;i<10;i++)assert.equal((await call('POST','/items',herb,a.token)).status,201);
  let items=await inv(call,a.token);assert.equal(items.length,1);assert.equal(items[0].qty,10);
  assert.equal((await call('POST','/items',herb,a.token)).status,201);
  items=await inv(call,a.token);assert.deepEqual(items.map(i=>i.qty),[10,1]);
  assert.equal((await call('POST','/items',{...herb,description:'Different.'},a.token)).status,201);   // not identical, own slot
  assert.equal((await inv(call,a.token)).length,3);
});

test('slots, not units, are the limit',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  for(let i=0;i<9;i++)await call('POST','/items',{...herb,name:'Item '+i},a.token);
  for(let i=0;i<10;i++)assert.equal((await call('POST','/items',herb,a.token)).status,201);   // fills the tenth slot
  const full=await call('POST','/items',herb,a.token);assert.equal(full.status,409);assert.match(full.error,/full/);
  assert.equal((await call('POST','/items',{...herb,name:'Other'},a.token)).status,409);
  assert.equal((await inv(call,a.token)).length,10);
});

test('using, giving and deleting move one unit at a time',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  const tea={...herb,name:'Tea',useLabel:'Drink',useText:'Warm.',consumable:true};
  for(let i=0;i<3;i++)await call('POST','/items',tea,a.token);
  let s=(await inv(call,a.token))[0];assert.equal(s.qty,3);
  const used=await call('POST',`/items/${s.id}/use`,{},a.token);assert.equal(used.items[0].qty,2);
  s=used.items[0];
  await call('POST',`/items/${s.id}/give`,{to:'Kael'},a.token);
  assert.equal((await inv(call,a.token))[0].qty,1);assert.equal((await inv(call,b.token))[0].qty,1);
  await call('POST',`/items/${(await inv(call,a.token))[0].id}/give`,{to:'Kael'},a.token);
  assert.equal((await inv(call,a.token)).length,0);assert.equal((await inv(call,b.token))[0].qty,2);   // stacks with Kael's own
  await call('POST',`/items/${(await inv(call,b.token))[0].id}/delete`,{},b.token);
  assert.equal((await inv(call,b.token))[0].qty,1);
});

test('giving fails only when the receiver has no slot and no matching stack with space',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  await grant(call,'Mira');   // made by the Advocate, so Mira's and Kael's copies are identical
  for(let i=0;i<9;i++)await call('POST','/items',{...herb,name:'Item '+i},b.token);
  await grant(call,'Kael');   // Kael: ten slots, herb stack of 1
  assert.equal((await call('POST',`/items/${(await inv(call,a.token))[0].id}/give`,{to:'Kael'},a.token)).status,200);   // joins his stack
  await grant(call,'Mira',{name:'Last'});
  const last=(await inv(call,a.token)).find(i=>i.name==='Last');
  assert.equal((await call('POST',`/items/${last.id}/give`,{to:'Kael'},a.token)).status,409);   // no slot for a new kind
});

test('stashes stack too, and editing an item edits the whole stack',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  for(let i=0;i<3;i++)await call('POST','/items',herb,a.token);
  const st=(await call('POST','/stashes',{name:'Patch',zone:'Mist',territory:339,map:72,x:1,y:1,z:1,mapX:1,mapY:1},a.token)).stash;
  const put=await call('POST',`/stashes/${st.id}/put`,{itemId:(await inv(call,a.token))[0].id},a.token);
  assert.equal(put.stashItems[0].qty,1);assert.equal(put.stash.count,1);assert.equal(put.items[0].qty,2);
  const one=(await inv(call,a.token))[0];
  await call('POST',`/items/${one.id}/update`,{...herb,description:'Edited.'},a.token);
  const after=await inv(call,a.token);assert.equal(after.length,1);assert.equal(after[0].qty,2);assert.equal(after[0].description,'Edited.');
  const took=await call('POST',`/stashes/${st.id}/take`,{itemId:put.stashItems[0].id},a.token);
  assert.equal(took.items.length,2);   // the stashed one still says "A green sprig.", so it is a different stack
});

test('advocate copies stack, and a gift that cannot fit is refused whole',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  assert.equal((await grant(call,'Mira',{copies:10})).status,201);
  assert.equal((await grant(call,'Mira',{copies:4})).status,201);
  assert.deepEqual((await inv(call,a.token)).map(i=>i.qty),[10,4]);
  for(let i=0;i<8;i++)await call('POST','/items',{...herb,name:'Fill '+i},a.token);   // 10 slots used
  assert.equal((await grant(call,'Mira',{name:'New',copies:2})).status,409);
  assert.equal((await inv(call,a.token)).length,10);   // nothing half-granted
});

test('members can make several at once, and too many are refused whole',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  const r=await call('POST','/items',{...herb,quantity:23},a.token);assert.equal(r.status,201);
  assert.deepEqual((await inv(call,a.token)).map(i=>i.qty),[10,10,3]);
  for(const bad of [0,101,2.5,'5'])assert.equal((await call('POST','/items',{...herb,name:'X',quantity:bad},a.token)).status,400);
  const over=await call('POST','/items',{...herb,name:'Big',quantity:80},a.token);assert.equal(over.status,409);   // 3 slots used, 8 more needed, only 7 left
  assert.equal((await inv(call,a.token)).length,3);   // nothing half-made
  assert.equal((await call('POST','/items',{...herb,name:'Fits',quantity:70},a.token)).status,201);   // exactly 7 slots
  assert.equal((await inv(call,a.token)).length,10);
});

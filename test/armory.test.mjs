import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';
import { rollBonuses } from '../src/status-core.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('migrations/'+f,'utf8'));
  const wrap=s=>({bind:(...a)=>({run:async()=>{const r=s.run(...a);return {meta:{changes:Number(r.changes)}}},first:async()=>s.get(...a)??null,all:async()=>({results:s.all(...a)})}),run:async()=>{const r=s.run();return {meta:{changes:Number(r.changes)}}},first:async()=>s.get()??null,all:async()=>({results:s.all()})});
  return {sqlite,prepare:q=>wrap(sqlite.prepare(q))}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpass');return {status:r.status,...await r.json()}};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r.token}
const gear=(over={})=>({name:'Iron Helm',icon:'game:20001',description:'x',wearSlot:'helm',...over});
const grant=(call,to,over)=>call('POST','/items/admin/grant',{...gear(over),to,adminPassword:'dmpass'});
const memberId=(db,name)=>db.sqlite.prepare('SELECT id FROM members WHERE name = ?').get(name).id;

test('members make wearable items but cannot give them bonuses; wear, swap and take off',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  assert.equal((await call('POST','/items',gear({wearSlot:'hat'}),a)).status,400);
  const made=await call('POST','/items',gear({gearAtk:3,lifespanDays:7}),a);assert.equal(made.status,201);
  let inv=(await call('GET','/items/me',undefined,a)).items;assert.equal(inv[0].wearSlot,'helm');assert.equal(inv[0].gearAtk,0);assert.equal(inv[0].lifespanDays,7);
  assert.equal((await call('POST','/items',{name:'Plain',icon:'game:20001',description:'x'},a)).status,201);
  const plain=(await call('GET','/items/me',undefined,a)).items.find(i=>i.name==='Plain');
  assert.equal((await call('POST','/armory/equip',{itemId:plain.id},a)).status,409);                  // not wearable
  const eq=await call('POST','/armory/equip',{itemId:inv[0].id},a);assert.equal(eq.status,200);
  assert.equal(eq.slots.find(s=>s.slot==='helm').item.name,'Iron Helm');assert.ok(eq.slots.find(s=>s.slot==='helm').item.breaksAt);
  assert.equal(eq.items.length,1);                                                                    // out of the bag
  // a second helm swaps with the first
  await call('POST','/items',gear({name:'Steel Helm'}),a);
  const steel=(await call('GET','/items/me',undefined,a)).items.find(i=>i.name==='Steel Helm');
  const sw=await call('POST','/armory/equip',{itemId:steel.id},a);assert.equal(sw.slots.find(s=>s.slot==='helm').item.name,'Steel Helm');assert.ok(sw.items.some(i=>i.name==='Iron Helm'));
  assert.equal((await call('POST','/armory/unequip',{slot:'feet'},a)).status,404);
  const off=await call('POST','/armory/unequip',{slot:'helm'},a);assert.equal(off.status,200);assert.equal(off.slots.find(s=>s.slot==='helm').item,null);assert.ok(off.items.some(i=>i.name==='Steel Helm'));
  // worn gear cannot be given away: it is not in the bag
  await call('POST','/armory/equip',{itemId:steel.id},a);
  assert.equal((await call('POST',`/items/${steel.id}/delete`,{},a)).status,404);
});

test('two rings, and a full bag stops swapping',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  for(const n of ['Ring A','Ring B','Ring C'])await call('POST','/items',gear({name:n,wearSlot:'ring'}),a);
  let inv=(await call('GET','/items/me',undefined,a)).items;
  await call('POST','/armory/equip',{itemId:inv.find(i=>i.name==='Ring A').id},a);
  let st=await call('POST','/armory/equip',{itemId:inv.find(i=>i.name==='Ring B').id},a);
  assert.equal(st.slots.find(s=>s.slot==='ring1').item.name,'Ring A');assert.equal(st.slots.find(s=>s.slot==='ring2').item.name,'Ring B');
  st=await call('POST','/armory/equip',{itemId:inv.find(i=>i.name==='Ring C').id,slot:'ring2'},a);
  assert.equal(st.slots.find(s=>s.slot==='ring2').item.name,'Ring C');assert.ok(st.items.some(i=>i.name==='Ring B'));
});

test('worn gear bonuses count in rolls, capped at +5 together; Advocates set them',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  assert.equal((await grant(call,'Mira',{name:'Blade',wearSlot:'weapon',gearAtk:3,gearHeal:-1})).status,201);
  assert.equal((await grant(call,'Mira',{name:'Plate',wearSlot:'chest',gearAtk:4})).status,201);
  assert.equal((await grant(call,'Mira',{name:'Bad',wearSlot:'feet',gearAtk:9})).status,400);
  const id=memberId(db,'Mira');
  assert.deepEqual(await rollBonuses(db,id),[]);                                                      // nothing until worn
  for(const i of (await call('GET','/items/me',undefined,a)).items)await call('POST','/armory/equip',{itemId:i.id},a);
  const b=await rollBonuses(db,id);assert.deepEqual(b,[{label:'Gear',atk:5,heal:-1}]);                // 3 + 4 capped to 5
  const state=await call('GET','/armory',undefined,a);assert.equal(state.bonus.atk,5);assert.equal(state.bonus.capped,true);assert.equal(state.bonus.heal,-1);
});

test('gear breaks after its lifespan, even in the bag, and the owner is told once',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  await grant(call,'Mira',{name:'Silver Necklace',wearSlot:'necklace',lifespanDays:3,gearAtk:2});
  await grant(call,'Mira',{name:'Spare Cloak',wearSlot:'cloak',lifespanDays:3});
  const inv=(await call('GET','/items/me',undefined,a)).items;
  const neck=inv.find(i=>i.name==='Silver Necklace'),cloak=inv.find(i=>i.name==='Spare Cloak');
  await call('POST','/armory/equip',{itemId:neck.id},a);await call('POST','/armory/equip',{itemId:cloak.id},a);await call('POST','/armory/unequip',{slot:'cloak'},a);
  assert.deepEqual((await call('GET','/armory/check',undefined,a)).broke,[]);
  db.sqlite.exec("UPDATE items SET worn_at = '2000-01-01T00:00:00.000Z' WHERE worn_at IS NOT NULL");
  const check=await call('GET','/armory/check',undefined,a);assert.equal(check.broke.length,2);assert.ok(check.broke.includes('Your Silver Necklace broke!'));
  assert.deepEqual((await call('GET','/armory/check',undefined,a)).broke,[]);                         // only told once
  const st=await call('GET','/armory',undefined,a);assert.ok(st.slots.every(s=>s.item===null));       // the necklace came off
  const items=(await call('GET','/items/me',undefined,a)).items;const broken=items.find(i=>i.name==='Broken Silver Necklace');
  assert.ok(broken);assert.match(broken.description,/broken and holds no use/);assert.equal(broken.wearSlot,undefined);
  assert.equal((await call('POST','/armory/equip',{itemId:broken.id},a)).status,409);
  assert.deepEqual(await rollBonuses(db,memberId(db,'Mira')),[]);
});

test('removing a member clears what they wear',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  await call('POST','/items',gear(),a);await call('POST','/armory/equip',{itemId:(await call('GET','/items/me',undefined,a)).items[0].id},a);
  assert.equal((await call('POST','/items/admin/remove-member',{adminPassword:'dmpass',name:'Mira'})).status,200);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM items").get().n,0);assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM worn").get().n,0);
});

test('anyone can look at what another character is wearing',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  await call('POST','/items',gear(),a);await call('POST','/armory/equip',{itemId:(await call('GET','/items/me',undefined,a)).items[0].id},a);
  const seen=await call('GET','/armory/of?name=mira',undefined,b);assert.equal(seen.status,200);assert.equal(seen.name,'Mira');assert.equal(seen.slots.find(s=>s.slot==='helm').item.name,'Iron Helm');assert.equal(seen.slots.find(s=>s.slot==='helm').item.canEdit,false);
  assert.equal((await call('GET','/armory/of?name=Nobody',undefined,b)).status,404);
  assert.equal((await call('GET','/armory/of?name=Mira')).status,401);
  const full=await call('GET','/armory/of?name='+encodeURIComponent('Mira Silverborne'),undefined,b);assert.equal(full.status,200);assert.equal(full.name,'Mira');   // roster uses the longer name
});

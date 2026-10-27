import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of ['0001_init.sql','0002_scenes.sql','0003_items.sql','0004_stashes.sql','0005_signs.sql','0006_item_requirements.sql','0007_bank.sql','0008_statuses.sql','0009_recipes.sql','0010_diagnosis.sql','0011_quests.sql','0012_quest_claims.sql','0013_quest_starts.sql','0014_quest_fights.sql','0015_gold_spots.sql','0016_players.sql','0017_status_bonuses.sql','0018_rooms.sql'])sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=(db,member='fcpass')=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass',member);return {status:r.status,...await r.json()}};
const cookie={name:'Burnt cookie',icon:'game:20001',description:'A charred round disc.',flavor:'Smells like charcoal.',useLabel:'Eat',useText:'All you taste is ash.',consumable:true};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r}

test('registering needs the member password, and names are unique',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  assert.equal((await call('POST','/items/register',{name:'Mira',memberPassword:'nope'})).status,403);
  assert.equal((await mk(db,'')('POST','/items/register',{name:'Mira',memberPassword:'x'})).status,503);
  const a=await join(call,'Mira Voss');assert.match(a.recoveryCode,/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
  assert.equal((await call('POST','/items/register',{name:'mira  voss',memberPassword:'fcpass'})).status,409);
  assert.equal((await call('GET','/items/me')).status,401);
});

test('create an item, see it in the inventory, and only the maker sees the use text',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Mira'),b=await join(call,'Kael');
  const made=await call('POST','/items',cookie,a.token);assert.equal(made.status,201);
  const inv=(await call('GET','/items/me',undefined,a.token)).items;
  assert.equal(inv.length,1);assert.equal(inv[0].canEdit,true);assert.equal(inv[0].useText,'All you taste is ash.');
  await call('POST',`/items/${inv[0].id}/give`,{to:'Kael'},a.token);
  const theirs=(await call('GET','/items/me',undefined,b.token)).items[0];
  assert.equal(theirs.canEdit,false);assert.equal('useText' in theirs,false);assert.equal(theirs.useLabel,'Eat');
  assert.equal((await call('POST',`/items/${theirs.id}/update`,cookie,b.token)).status,403);
});

test('bad items are refused and inventory holds ten',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  assert.equal((await call('POST','/items',{...cookie,icon:'http://evil'},a.token)).status,400);
  assert.equal((await call('POST','/items',{...cookie,name:''},a.token)).status,400);
  for(let i=0;i<10;i++)assert.equal((await call('POST','/items',{...cookie,name:'Item '+i},a.token)).status,201);
  const full=await call('POST','/items',cookie,a.token);assert.equal(full.status,409);assert.match(full.error,/full/);
});

test('using an item shows its text, and consumable items are used up',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  await call('POST','/items',cookie,a.token);await call('POST','/items',{...cookie,name:'Charm',consumable:false},a.token);
  const [c1,c2]=(await call('GET','/items/me',undefined,a.token)).items;
  const eat=await call('POST',`/items/${c1.id}/use`,{},a.token);assert.equal(eat.text,'All you taste is ash.');assert.equal(eat.consumed,true);assert.equal(eat.items.length,1);
  const charm=await call('POST',`/items/${c2.id}/use`,{},a.token);assert.equal(charm.consumed,false);assert.equal(charm.items.length,1);
  const plain=await call('POST','/items',{name:'Rock',icon:'game:1',description:'A rock.'},a.token);
  const rock=plain.items.find(i=>i.name==='Rock');assert.equal(rock.useLabel,'');
  assert.equal((await call('POST',`/items/${rock.id}/use`,{},a.token)).status,400);
});

test('giving needs a real member with room, and only the owner can give, edit or delete',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Mira'),b=await join(call,'Kael');
  const m1=(await call('POST','/items',cookie,a.token)).items[0];
  assert.equal((await call('POST',`/items/${m1.id}/give`,{to:'Nobody'},a.token)).status,404);
  assert.equal((await call('POST',`/items/${m1.id}/give`,{to:'Mira'},a.token)).status,400);
  assert.equal((await call('POST',`/items/${m1.id}/give`,{to:'Kael'},b.token)).status,404);
  for(let i=0;i<10;i++)await call('POST','/items',{...cookie,name:'K'+i},b.token);
  const full=await call('POST',`/items/${m1.id}/give`,{to:'Kael'},a.token);assert.equal(full.status,409);
  assert.equal((await call('GET','/items/me',undefined,a.token)).items.length,1);
  const kItem=(await call('GET','/items/me',undefined,b.token)).items[0];
  assert.equal((await call('POST',`/items/${kItem.id}/delete`,{},a.token)).status,404);
  assert.equal((await call('POST',`/items/${kItem.id}/delete`,{},b.token)).items.length,9);
  assert.deepEqual((await call('GET','/items/members',undefined,a.token)).members,['Kael']);
  const ok=await call('POST',`/items/${m1.id}/give`,{to:'Kael'},a.token);assert.equal(ok.items.length,0);
  const upd=await call('POST',`/items/${m1.id}/update`,cookie,a.token);assert.equal(upd.status,404);
});

test('a recovery code gets you back in and signs the old device out',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  await call('POST','/items',cookie,a.token);
  assert.equal((await call('POST','/items/recover',{name:'Mira',recoveryCode:'0000-0000-0000'})).status,403);
  const back=await call('POST','/items/recover',{name:'mira',recoveryCode:a.recoveryCode.toLowerCase()});assert.equal(back.status,200);
  assert.equal((await call('GET','/items/me',undefined,a.token)).status,401);
  assert.equal((await call('GET','/items/me',undefined,back.token)).items.length,1);
});

test('SMs can list and delete items and remove members, with the creation password only',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Mira');await call('POST','/items',cookie,a.token);
  assert.equal((await call('POST','/items/admin/list',{adminPassword:'fcpass'})).status,403);
  const list=await call('POST','/items/admin/list',{adminPassword:'dmpass'});assert.equal(list.items[0].owner,'Mira');assert.deepEqual(list.members,['Mira']);
  assert.equal((await call('POST','/items/admin/delete',{adminPassword:'dmpass',itemId:list.items[0].id})).status,200);
  await call('POST','/items',cookie,a.token);
  assert.equal((await call('POST','/items/admin/remove-member',{adminPassword:'dmpass',name:'Mira'})).status,200);
  assert.equal((await call('GET','/items/me',undefined,a.token)).status,401);
  assert.equal((await call('POST','/items/admin/list',{adminPassword:'dmpass'})).items.length,0);
});

test('a SM can gift an item straight into a member inventory, and the gift cannot be edited',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  assert.equal((await call('POST','/items/admin/grant',{...cookie,to:'Mira',adminPassword:'fcpass'})).status,403);
  assert.equal((await call('POST','/items/admin/grant',{...cookie,to:'Nobody',adminPassword:'dmpass'})).status,404);
  assert.equal((await call('POST','/items/admin/grant',{...cookie,to:'Mira',adminPassword:'dmpass'})).status,201);
  const [gift]=(await call('GET','/items/me',undefined,a.token)).items;
  assert.equal(gift.name,'Burnt cookie');assert.equal(gift.canEdit,false);
  assert.equal((await call('POST',`/items/${gift.id}/use`,{},a.token)).text,'All you taste is ash.');
  const list=await call('POST','/items/admin/list',{adminPassword:'dmpass'});assert.equal(list.items.length,0);
  for(let i=0;i<10;i++)await call('POST','/items/admin/grant',{...cookie,name:'G'+i,to:'Mira',adminPassword:'dmpass'});
  assert.equal((await call('POST','/items/admin/grant',{...cookie,to:'Mira',adminPassword:'dmpass'})).status,409);
  assert.equal((await call('POST','/items/admin/list',{adminPassword:'dmpass'})).items[0].creator,'(SM gift)');
});

test('locked box: needs a key in your inventory, can hold other items, key can be used up',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  const mkItem=async(f,tok=a.token)=>{const r=await call('POST','/items',{icon:'game:20001',description:'',...f},tok);assert.equal(r.status,201);return r.items.find(i=>i.id===r.id)};
  assert.equal((await call('POST','/items',{name:'Box',icon:'game:20001',requires:'Key'},a.token)).status,400);
  const key=await mkItem({name:"The Harbinger's Key"});
  const crystal=await mkItem({name:'Magic crystal'});
  const box=await mkItem({name:'Locked box',useLabel:'Open',useText:'The lock clicks open.',requires:"the harbinger's  key",requiresConsume:true,consumable:true});
  assert.equal(box.requires,"the harbinger's  key");
  const sealed=await call('POST',`/items/${box.id}/seal`,{itemId:crystal.id},a.token);assert.equal(sealed.status,200);
  assert.deepEqual(sealed.items.map(i=>i.name),["The Harbinger's Key",'Locked box']);assert.equal(sealed.items[1].holds,1);
  assert.equal((await call('POST',`/items/${box.id}/seal`,{itemId:box.id},a.token)).status,400);
  assert.equal((await call('POST',`/items/${box.id}/give`,{to:'Kael'},a.token)).status,200);   // give the locked box away
  const kb=(await call('GET','/items/me',undefined,b.token)).items;assert.equal(kb.length,1);assert.equal(kb[0].holds,1);
  const noKey=await call('POST',`/items/${box.id}/use`,{},b.token);assert.equal(noKey.status,409);assert.match(noKey.error,/You need/);
  await mkItem({name:"The Harbinger's Key"},b.token);   // a forged key made by someone else
  const forged=await call('POST',`/items/${box.id}/use`,{},b.token);assert.equal(forged.status,409);
  await call('POST',`/items/${(await call('GET','/items/me',undefined,b.token)).items.find(i=>i.name==="The Harbinger's Key").id}/delete`,{},b.token);
  assert.equal((await call('POST',`/items/${key.id}/give`,{to:'Kael'},a.token)).status,200);
  const opened=await call('POST',`/items/${box.id}/use`,{},b.token);assert.equal(opened.status,200);
  assert.deepEqual(opened.gained,['Magic crystal']);assert.equal(opened.consumed,true);assert.equal(opened.keyUsed,"the harbinger's  key");
  assert.deepEqual(opened.items.map(i=>i.name),['Magic crystal']);
});

test('opening needs room, and deleting a container deletes what is inside',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  const mkItem=async f=>{const r=await call('POST','/items',{icon:'game:20001',description:'',...f},a.token);assert.equal(r.status,201);return r.items.find(i=>i.id===r.id)};
  const box=await mkItem({name:'Chest',useText:'Open.',useLabel:'Open'});
  for(const n of ['A','B','C','D'])await call('POST',`/items/${box.id}/seal`,{itemId:(await mkItem({name:n})).id},a.token);
  assert.equal((await call('GET','/items/me',undefined,a.token)).items.length,2);   // chest + the fourth item, which was refused
  assert.equal((await call('POST',`/items/${box.id}/delete`,{},a.token)).status,200);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM items WHERE name IN (?,?,?)').get('A','B','C').n,0);
  const c2=await mkItem({name:'Chest2',useText:'Open.',useLabel:'Open'});
  await call('POST',`/items/${c2.id}/seal`,{itemId:(await mkItem({name:'X'})).id},a.token);
  for(let i=0;i<8;i++)await mkItem({name:'F'+i});
  const full=await call('POST',`/items/${c2.id}/use`,{},a.token);assert.equal(full.status,409);assert.match(full.error,/room/);
});

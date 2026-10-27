import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of ['0001_init.sql','0002_scenes.sql','0003_items.sql','0004_stashes.sql','0005_signs.sql','0006_item_requirements.sql','0007_bank.sql','0008_statuses.sql','0009_recipes.sql','0010_diagnosis.sql','0011_quests.sql','0012_quest_claims.sql','0013_quest_starts.sql','0014_quest_fights.sql','0015_gold_spots.sql'])sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpass');return {status:r.status,...await r.json()}};
const spot={name:'Old well',zone:'Mist',territory:339,map:72,x:10.5,y:2,z:-30.25,mapX:11.2,mapY:9.8};
const cookie={name:'Burnt cookie',icon:'game:20001',description:'x',useLabel:'Eat',useText:'Ash.',consumable:true};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r}

test('make a stash, everyone sees it, private ones only the owner',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  assert.equal((await call('GET','/stashes')).status,401);
  const made=await call('POST','/stashes',spot,a.token);assert.equal(made.status,201);assert.equal(made.stash.mine,true);assert.equal(made.stash.capacity,20);
  const priv=await call('POST','/stashes',{...spot,name:'Secret',isPrivate:true},a.token);assert.equal(priv.status,201);
  const seenByB=(await call('GET','/stashes',undefined,b.token)).stashes;
  assert.deepEqual(seenByB.map(s=>s.name),['Old well']);assert.equal(seenByB[0].mine,false);assert.equal(seenByB[0].ownerName,'Mira');assert.equal(seenByB[0].territory,339);
  assert.equal((await call('GET',`/stashes/${priv.stash.id}`,undefined,b.token)).status,404);
  assert.equal((await call('GET',`/stashes/${priv.stash.id}`,undefined,a.token)).status,200);
});

test('bad positions are refused and each member gets three stashes',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  assert.equal((await call('POST','/stashes',{...spot,x:'far'},a.token)).status,400);
  assert.equal((await call('POST','/stashes',{...spot,territory:-1},a.token)).status,400);
  assert.equal((await call('POST','/stashes',{...spot,name:''},a.token)).status,400);
  for(let i=0;i<3;i++)assert.equal((await call('POST','/stashes',{...spot,name:'S'+i},a.token)).status,201);
  assert.equal((await call('POST','/stashes',spot,a.token)).status,409);
});

test('put and take items, with limits on both sides',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  const st=(await call('POST','/stashes',spot,a.token)).stash;
  const item=(await call('POST','/items',cookie,a.token)).items[0];
  const put=await call('POST',`/stashes/${st.id}/put`,{itemId:item.id},b.token);assert.equal(put.status,404);
  const ok=await call('POST',`/stashes/${st.id}/put`,{itemId:item.id},a.token);assert.equal(ok.status,200);
  assert.equal(ok.items.length,0);assert.equal(ok.stashItems.length,1);assert.equal(ok.stash.count,1);
  const taken=await call('POST',`/stashes/${st.id}/take`,{itemId:item.id},b.token);assert.equal(taken.status,200);
  assert.equal(taken.items.length,1);assert.equal(taken.stashItems.length,0);
  assert.equal(taken.items[0].canEdit,false);
  for(let i=0;i<10;i++)await call('POST','/items/admin/grant',{...cookie,name:'G'+i,to:'Mira',adminPassword:'dmpass'});
  const inv=(await call('GET','/items/me',undefined,a.token)).items;assert.equal(inv.length,10);
  assert.equal((await call('POST',`/stashes/${st.id}/put`,{itemId:inv[0].id},a.token)).status,200);
  assert.equal((await call('POST',`/stashes/${st.id}/take`,{itemId:inv[0].id},b.token)).status,200);
  assert.equal((await call('POST',`/stashes/${st.id}/take`,{itemId:'nothing'},a.token)).status,404);
});

test('a stash holds twenty, and a full inventory cannot take more',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  const st=(await call('POST','/stashes',spot,a.token)).stash;
  for(let round=0;round<2;round++){for(let i=0;i<10;i++)await call('POST','/items',{...cookie,name:`C${round}${i}`},a.token);
    for(const it of (await call('GET','/items/me',undefined,a.token)).items)assert.equal((await call('POST',`/stashes/${st.id}/put`,{itemId:it.id},a.token)).status,200)}
  await call('POST','/items',cookie,a.token);
  const extra=(await call('GET','/items/me',undefined,a.token)).items[0];
  const full=await call('POST',`/stashes/${st.id}/put`,{itemId:extra.id},a.token);assert.equal(full.status,409);assert.match(full.error,/full/);
  for(let i=0;i<10;i++)await call('POST','/items/admin/grant',{...cookie,name:'B'+i,to:'Kael',adminPassword:'dmpass'});
  const inside=(await call('GET',`/stashes/${st.id}`,undefined,b.token)).stashItems[0];
  assert.equal((await call('POST',`/stashes/${st.id}/take`,{itemId:inside.id},b.token)).status,409);
});

test('the owner can rename, hide, move and delete (empty only); others cannot',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  const st=(await call('POST','/stashes',spot,a.token)).stash;
  assert.equal((await call('POST',`/stashes/${st.id}/update`,{name:'Hack'},b.token)).status,403);
  const up=await call('POST',`/stashes/${st.id}/update`,{name:'Deep well',isPrivate:true},a.token);assert.equal(up.stash.name,'Deep well');assert.equal(up.stash.isPrivate,true);
  assert.equal((await call('GET','/stashes',undefined,b.token)).stashes.length,0);
  const moved=await call('POST',`/stashes/${st.id}/update`,{...spot,x:99,territory:340,zone:'Lavender Beds'},a.token);assert.equal(moved.stash.x,99);assert.equal(moved.stash.territory,340);
  const item=(await call('POST','/items',cookie,a.token)).items[0];
  await call('POST',`/stashes/${st.id}/put`,{itemId:item.id},a.token);
  assert.equal((await call('POST',`/stashes/${st.id}/delete`,{},a.token)).status,409);
  await call('POST',`/stashes/${st.id}/take`,{itemId:item.id},a.token);
  assert.equal((await call('POST',`/stashes/${st.id}/delete`,{},b.token)).status,404);
  assert.equal((await call('POST',`/stashes/${st.id}/delete`,{},a.token)).status,200);
});

test('Advocates see stashes, can delete them, and removing a member clears their stashes',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  const s1=(await call('POST','/stashes',spot,a.token)).stash,s2=(await call('POST','/stashes',{...spot,name:'Other'},b.token)).stash;
  const it=(await call('POST','/items',cookie,a.token)).items[0];await call('POST',`/stashes/${s1.id}/put`,{itemId:it.id},a.token);
  const list=await call('POST','/items/admin/list',{adminPassword:'dmpass'});
  assert.equal(list.stashes.length,2);assert.equal(list.items[0].owner,'Stash: Old well');
  assert.equal((await call('POST','/items/admin/delete-stash',{adminPassword:'fcpass',stashId:s1.id})).status,403);
  assert.equal((await call('POST','/items/admin/delete-stash',{adminPassword:'dmpass',stashId:s2.id})).status,200);
  assert.equal((await call('POST','/items/admin/remove-member',{adminPassword:'dmpass',name:'Mira'})).status,200);
  const after=await call('POST','/items/admin/list',{adminPassword:'dmpass'});assert.equal(after.stashes.length,0);assert.equal(after.items.length,0);
});

test('gold can be put in and taken out of a stash, and a stash with gold cannot be deleted',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const reg=async n=>{const r=await call('POST','/items/register',{name:n,memberPassword:'fcpass'});return r.token};
  const a=await reg('Mira'),b=await reg('Kael');
  await call('POST','/bank/admin/mint',{bankPassword:'bankpass',to:'Mira',amount:100});
  const spot={territory:339,map:72,x:1,y:2,z:3,mapX:5,mapY:6,zone:'Mist'};
  const made=await call('POST','/stashes',{...spot,name:'Box'},a);const id=made.stash.id;
  assert.equal(made.stash.gold,0);
  assert.equal((await call('POST',`/stashes/${id}/put-gold`,{amount:500},a)).status,409);
  assert.equal((await call('POST',`/stashes/${id}/put-gold`,{amount:0},a)).status,400);
  let r=await call('POST',`/stashes/${id}/put-gold`,{amount:70},a);assert.equal(r.stash.gold,70);assert.equal((await call('GET','/bank/me',undefined,a)).gold,30);
  assert.equal((await call('POST',`/stashes/${id}/delete`,{},a)).status,409);
  r=await call('POST',`/stashes/${id}/take-gold`,{amount:20},b);assert.equal(r.stash.gold,50);assert.equal((await call('GET','/bank/me',undefined,b)).gold,20);   // anyone who can open it
  assert.equal((await call('POST',`/stashes/${id}/take-gold`,{amount:99},b)).status,409);
  assert.equal((await call('POST',`/stashes/${id}/update`,{isPrivate:true},a)).status,200);
  assert.equal((await call('POST',`/stashes/${id}/take-gold`,{amount:5},b)).status,404);           // private stays private
  assert.equal((await call('POST','/items/admin/delete-stash',{adminPassword:'dmpass',stashId:id})).status,200);
  assert.equal((await call('GET','/bank/me',undefined,a)).gold,80);                                  // the rest went back to the owner
});

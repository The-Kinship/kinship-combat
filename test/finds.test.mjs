import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('migrations/'+f,'utf8'));
  const wrap=s=>({bind:(...a)=>({run:async()=>{const r=s.run(...a);return {meta:{changes:Number(r.changes)}}},first:async()=>s.get(...a)??null,all:async()=>({results:s.all(...a)})}),run:async()=>{const r=s.run();return {meta:{changes:Number(r.changes)}}},first:async()=>s.get()??null,all:async()=>({results:s.all()})});
  return {sqlite,prepare:q=>wrap(sqlite.prepare(q))}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpass',{scenePassword:'scenepass'});return {status:r.status,...await r.json()}};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r}
const spot={zone:'Forest',territory:339,map:12,room:'',x:10,y:0,z:10,mapX:10,mapY:10};
const here={at:{territory:339,room:'',x:10.5,y:0,z:10}}, far={at:{territory:339,room:'',x:200,y:0,z:10}};
const q=(x,y)=>`?t=339&r=&x=${x}&y=0&z=${y}`;

test('a world item hands out copies of an item, by mode: once, timer, always',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Mira'),b=await join(call,'Kael');
  const herb=await call('POST','/items',{name:'Frost herb',icon:'game:20001',description:'Cold and bright.'},a.token);
  const itemId=herb.items[0].id;
  const make=(extra)=>call('POST','/finds',{...spot,itemId,label:'A pretty frost herb',text:'It glitters.',mode:'once',...extra},a.token);
  assert.equal((await call('POST','/finds',{...spot,itemId:'nope',label:'x',mode:'once'},a.token)).status,404);
  assert.equal((await make({mode:'sometimes'})).status,400);
  assert.equal((await make({mode:'timer',minutes:0})).status,400);
  const once=await make();assert.equal(once.status,201);assert.equal(once.find.itemName,'Frost herb');
  // only close, and only when ready, and the item's name is not given away
  assert.equal((await call('GET','/finds'+q(500,500),undefined,b.token)).finds.length,0);
  const seen=(await call('GET','/finds'+q(10,10),undefined,b.token)).finds;assert.equal(seen.length,1);assert.equal(seen[0].label,'A pretty frost herb');assert.equal(seen[0].itemName,undefined);
  assert.equal((await call('POST',`/finds/${once.find.id}/pickup`,far,b.token)).status,403);
  const got=await call('POST',`/finds/${once.find.id}/pickup`,here,b.token);assert.equal(got.status,200);assert.equal(got.picked,'Frost herb');
  assert.equal(got.items.some(i=>i.name==='Frost herb'),true);
  assert.equal((await call('POST',`/finds/${once.find.id}/pickup`,here,a.token)).status,409);                         // once: gone
  assert.equal((await call('GET','/finds'+q(10,10),undefined,b.token)).finds.length,0);
  assert.equal((await call('GET','/finds'+q(10,10),undefined,a.token)).finds[0].state,'gone');                        // the owner still sees it
  assert.equal((await call('POST',`/finds/${once.find.id}/reset`,{},b.token)).status,403);
  assert.equal((await call('POST',`/finds/${once.find.id}/reset`,{},a.token)).status,200);
  assert.equal((await call('POST',`/finds/${once.find.id}/pickup`,here,a.token)).status,200);                         // back after a reset
  // timer
  const timer=(await make({mode:'timer',minutes:20})).find;
  assert.equal((await call('POST',`/finds/${timer.id}/pickup`,here,b.token)).status,200);
  assert.equal((await call('POST',`/finds/${timer.id}/pickup`,here,a.token)).status,409);                             // waiting
  const mineNow=(await call('GET','/finds'+q(10,10),undefined,a.token)).finds.find(f=>f.id===timer.id);assert.equal(mineNow.state,'waiting');assert.ok(mineNow.secondsLeft>1100&&mineNow.secondsLeft<=1200);
  db.sqlite.exec("UPDATE finds SET available_at = '2000-01-01T00:00:00.000Z'");                                         // the wait is over
  assert.equal((await call('POST',`/finds/${timer.id}/pickup`,here,a.token)).status,200);
  // always
  const always=(await make({mode:'always'})).find;
  for(let i=0;i<3;i++) assert.equal((await call('POST',`/finds/${always.id}/pickup`,here,b.token)).status,200);
  assert.equal((await call('GET','/finds'+q(10,10),undefined,b.token)).finds.some(f=>f.id===always.id),true);
  // deleting
  assert.equal((await call('POST',`/finds/${always.id}/delete`,{},b.token)).status,403);
  assert.equal((await call('POST',`/finds/${always.id}/delete`,{},a.token)).status,200);
  assert.equal((await call('POST',`/finds/${always.id}/pickup`,here,b.token)).status,404);
});

test('a copy keeps the recipe, and a full inventory does not use up the find',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Mira'),b=await join(call,'Kael');
  const herb=await call('POST','/items',{name:'Frost herb',icon:'game:20001',description:'x',reagents:[],with:['Sun herb'],result:{name:'Antidote',icon:'game:20002',description:'Cures it.'}},a.token);
  const id=herb.items.find(i=>i.name==='Frost herb').id;
  const f=(await call('POST','/finds',{...spot,itemId:id,label:'A herb',mode:'once'},a.token)).find;
  for(let i=0;i<10;i++) await call('POST','/items',{name:'Filler '+i,icon:'game:20001',description:'x'},b.token);   // Kael's inventory is full
  assert.equal((await call('POST',`/finds/${f.id}/pickup`,here,b.token)).status,409);
  assert.equal(db.sqlite.prepare("SELECT taken FROM finds WHERE id=?").get(f.id).taken,0);                          // not used up
  db.sqlite.prepare("DELETE FROM items WHERE name LIKE 'Filler%'").run();
  assert.equal((await call('POST',`/finds/${f.id}/pickup`,here,b.token)).status,200);
  const copy=db.sqlite.prepare("SELECT recipe, creator_id FROM items WHERE owner_id=? AND name='Frost herb'").get(b.memberId);
  assert.match(copy.recipe,/Antidote/);
  assert.equal(copy.recipe,db.sqlite.prepare("SELECT recipe FROM items WHERE id=?").get(id).recipe);
  assert.equal(copy.creator_id,a.memberId);
  // removing the member who placed it removes their world items
  await call('POST','/items/admin/remove-member',{adminPassword:'dmpass',name:'Mira'});
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM finds").get().n,0);
});

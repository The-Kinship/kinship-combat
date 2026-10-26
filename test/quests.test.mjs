import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpw');return {status:r.status,...await r.json()}};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r}
const st={name:'Feeling cheerful',icon:'game:10001',description:'A spring in your step.',minutes:0,isDebuff:false};
const gift={name:'Silver locket',icon:'game:20001',description:'Cold to the touch.'};
const quest={title:'The Lost Locket',intro:'Someone misses a keepsake.',steps:[
  {type:'talk',npc:'Old Maren',text:'Please find my locket.',hint:'She sits by the docks.'},
  {type:'receive',npc:'Old Maren',text:'Take this, it was his.',gift},
  {type:'give',npc:'Captain Voss',item:'Silver locket',text:'Ah, the locket. Thank you.'}]};

test('an Advocate writes a quest, a player walks it step by step, items move, and it finishes',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  const admin=(p,d)=>call('POST','/quests/admin/'+p,{adminPassword:'dmpass',...d});
  assert.equal((await call('POST','/quests/admin/list',{adminPassword:'nope'})).status,403);
  assert.equal((await admin('save',{...quest,steps:[]})).status,400);
  assert.equal((await admin('save',{...quest,steps:[{type:'dance',npc:'X',text:'y'}]})).status,400);
  const saved=await admin('save',quest);assert.equal(saved.status,201);const id=saved.id;
  assert.equal((await admin('assign',{questId:id,to:'Mira'})).status,201);
  const mine=(await call('GET','/quests/mine',undefined,a.token)).quests;
  assert.equal(mine.length,1);assert.equal(mine[0].current.npc,'Old Maren');assert.equal(mine[0].current.hint,'She sits by the docks.');assert.equal(mine[0].total,3);
  assert.equal((await call('GET','/quests/mine',undefined,b.token)).quests.length,0);
  assert.equal(JSON.stringify(mine).includes('Take this'),false);          // later dialogue is not revealed
  let r=await call('POST','/quests/talk',{npc:'Captain Voss'},a.token);assert.equal(r.results.length,0);   // wrong person
  r=await call('POST','/quests/talk',{npc:'old  maren'},a.token);assert.equal(r.results[0].ok,true);assert.equal(r.results[0].text,'Please find my locket.');
  r=await call('POST','/quests/talk',{npc:'Old Maren'},a.token);assert.equal(r.results[0].gained[0],'Silver locket');assert.equal(r.items.length,1);assert.equal(r.items[0].name,'Silver locket');
  r=await call('POST','/quests/talk',{npc:'Old Maren'},a.token);assert.equal(r.results.length,0);   // no repeat
  assert.equal((await call('POST','/quests/talk',{npc:'Captain Voss'},b.token)).results.length,0);
  r=await call('POST','/quests/talk',{npc:'Captain Voss'},a.token);assert.equal(r.results[0].ok,true);assert.equal(r.results[0].finished,true);assert.equal(r.items.length,0);
  const done=(await call('GET','/quests/mine',undefined,a.token)).quests[0];assert.equal(done.done,true);assert.equal(done.current,null);
  assert.equal((await call('POST','/quests/talk',{npc:'Captain Voss'},a.token)).results.length,0);
});

test('giving needs a real Advocate-made item, a full bag stops a gift without losing the step, edits and removals tidy up',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  const admin=(p,d)=>call('POST','/quests/admin/'+p,{adminPassword:'dmpass',...d});
  const id=(await admin('save',{title:'Fake it',steps:[{type:'give',npc:'Voss',item:'Silver locket',text:'Thanks.'},{type:'receive',npc:'Voss',text:'Here.',gift}]})).id;
  await admin('assign',{questId:id,to:'Mira'});
  await call('POST','/items',{name:'Silver locket',icon:'game:20001'},a.token);           // a player-made fake
  let r=await call('POST','/quests/talk',{npc:'Voss'},a.token);assert.equal(r.results[0].ok,false);
  assert.equal((await call('GET','/quests/mine',undefined,a.token)).quests[0].step,0);
  await admin('grant-check',{});                                                              // unknown admin route is a 404
  await call('POST','/items/admin/grant',{adminPassword:'dmpass',to:'Mira',name:'Silver locket',icon:'game:20001'});
  r=await call('POST','/quests/talk',{npc:'Voss'},a.token);assert.equal(r.results[0].ok,true);
  const items=(await call('GET','/items/me',undefined,a.token)).items;
  for(let i=items.length;i<10;i++)await call('POST','/items',{name:'Junk'+i,icon:'game:20001'},a.token);
  r=await call('POST','/quests/talk',{npc:'Voss'},a.token);assert.equal(r.results[0].ok,false);assert.match(r.results[0].text,/full/);
  assert.equal((await call('GET','/quests/mine',undefined,a.token)).quests[0].step,1);   // still on the gift step
  const list=await admin('list',{});assert.equal(list.quests[0].players[0].name,'Mira');
  await admin('save',{questId:id,title:'Fake it',steps:[quest.steps[0]]});                 // shortened: Mira is now past the end
  assert.equal((await call('GET','/quests/mine',undefined,a.token)).quests[0].done,true);
  assert.equal((await admin('unassign',{questId:id,to:'Mira'})).status,200);
  assert.equal((await call('GET','/quests/mine',undefined,a.token)).quests.length,0);
  await admin('assign',{questId:id,to:'Mira'});
  assert.equal((await admin('delete',{questId:id})).status,200);
  assert.equal((await call('GET','/quests/mine',undefined,a.token)).quests.length,0);
  assert.equal((await admin('assign',{questId:id,to:'Mira'})).status,404);
});

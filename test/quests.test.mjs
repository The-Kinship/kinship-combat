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

const spot={zone:'Mist',territory:339,map:72,x:10,y:2,z:-5,mapX:12.5,mapY:9.5};
test('look, listen and search steps happen at a spot, and a first-come find goes to one player only',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael'),c=await join(call,'Rune');
  const admin=(p,d)=>call('POST','/quests/admin/'+p,{adminPassword:'dmpass',...d});
  assert.equal((await admin('save',{title:'X',steps:[{type:'look',text:'You see.'}]})).status,400);               // needs a place
  assert.equal((await admin('save',{title:'X',steps:[{type:'look',text:'You see.',place:{...spot,x:'far'}}]})).status,400);
  const id=(await admin('save',{title:'Keys',steps:[
    {type:'look',text:'Scratches mark the old gate.',hint:'By the gate',place:spot},
    {type:'listen',text:'A faint voice sings.',place:spot},
    {type:'search',text:'Under a stone you find a key.',place:spot,once:true,gift:{name:'Rusty key',icon:'game:20001'}},
    {type:'talk',npc:'Old Maren',text:'Well done.'}]})).id;
  for(const n of ['Mira','Kael','Rune'])await admin('assign',{questId:id,to:n});
  const cur=(await call('GET','/quests/mine',undefined,a.token)).quests[0].current;assert.equal(cur.type,'look');assert.equal(cur.place.territory,339);
  const act=(tok,type,territory=339)=>call('POST','/quests/act',{type,territory},tok);
  assert.equal((await act(a.token,'dance')).status,400);
  assert.equal((await act(a.token,'look',1)).results.length,0);                 // wrong zone
  assert.equal((await act(a.token,'listen')).results.length,0);                 // wrong action for this step
  assert.equal((await act(a.token,'look')).results[0].text,'Scratches mark the old gate.');
  assert.equal((await call('POST','/quests/talk',{npc:'Old Maren'},a.token)).results.length,0);   // spot steps can't be talked through
  for(const tok of [b.token,c.token]){await act(tok,'look');await act(tok,'listen')}
  await act(a.token,'listen');
  let r=await act(a.token,'search');assert.equal(r.results[0].gained[0],'Rusty key');assert.equal(r.items.length,1);
  r=await act(b.token,'search');assert.equal(r.results[0].ok,false);assert.match(r.results[0].text,/first/);assert.equal(r.items.length,0);
  assert.equal((await call('GET','/quests/mine',undefined,b.token)).quests[0].step,2);          // loser stays put
  const list=await admin('list',{});assert.equal(list.quests[0].claims[0].name,'Mira');
  await admin('reset-claims',{questId:id});
  r=await act(b.token,'search');assert.equal(r.results[0].gained[0],'Rusty key');
  assert.equal((await call('POST','/quests/talk',{npc:'Old Maren'},a.token)).results[0].finished,true);
});

test('a step can need a status, use it up, and give one; a full status list stops it without losing the step',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  const admin=(p,d)=>call('POST','/quests/admin/'+p,{adminPassword:'dmpass',...d});
  const blessed={name:'Blessed',icon:'game:10205',description:'A warm glow.',minutes:20};
  assert.equal((await admin('save',{title:'X',steps:[{type:'talk',npc:'P',text:'t',grants:{...blessed,icon:'nope'}}]})).status,400);
  assert.equal((await admin('save',{title:'X',steps:[{type:'talk',npc:'P',text:'t',grants:{...blessed,minutes:-5}}]})).status,400);
  const id=(await admin('save',{title:'Blessing',steps:[
    {type:'talk',npc:'Priest',text:'Kneel. You are blessed.',grants:blessed},
    {type:'talk',npc:'Guard',text:'Pass, blessed one.',needs:'Blessed',needText:'The guard sneers at you.',takesNeeded:true},
    {type:'talk',npc:'Priest',text:'Done.'}]})).id;
  await admin('assign',{questId:id,to:'Mira'});
  const talk=n=>call('POST','/quests/talk',{npc:n},a.token);
  assert.equal((await call('GET','/quests/mine',undefined,a.token)).quests[0].current.needs,undefined);
  for(let i=0;i<5;i++)await call('POST','/statuses/self',{name:'S'+i,icon:'game:10205',description:''},a.token);
  await call('POST','/statuses/self',{name:'S5',icon:'game:10205',description:''},a.token);                    // now at the limit of six
  let r=await talk('Priest');assert.equal(r.results[0].ok,false);assert.match(r.results[0].text,/6 statuses/);
  assert.equal((await call('GET','/quests/mine',undefined,a.token)).quests[0].step,0);
  const mine=(await call('GET','/statuses',undefined,a.token)).statuses.find(s=>s.name==='S5');await call('POST',`/statuses/${mine.id}/remove`,{},a.token);
  r=await talk('Priest');assert.equal(r.results[0].ok,true);assert.equal(r.results[0].statusGained,'Blessed');
  const have=(await call('GET','/statuses',undefined,a.token)).statuses.find(s=>s.name==='Blessed');assert.ok(have.secondsLeft>1100&&have.secondsLeft<=1200);
  db.sqlite.prepare("UPDATE statuses SET expires_at = ? WHERE name = 'Blessed'").run(new Date(Date.now()-1000).toISOString());   // it ran out
  r=await talk('Guard');assert.equal(r.results[0].ok,false);assert.equal(r.results[0].text,'The guard sneers at you.');
  assert.equal((await call('GET','/quests/mine',undefined,a.token)).quests[0].step,1);
  db.sqlite.prepare("DELETE FROM statuses WHERE name = 'Blessed'").run();
  await call('POST','/statuses/self',blessed,a.token);
  r=await talk('Guard');assert.equal(r.results[0].ok,true);
  assert.equal((await call('GET','/statuses',undefined,a.token)).statuses.some(s=>s.name==='Blessed'),false);   // used up
});

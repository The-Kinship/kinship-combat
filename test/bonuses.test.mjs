import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpw');return {status:r.status,...await r.json()}};
const join=async(call,name)=>call('POST','/items/register',{name,memberPassword:'fcpass'});
const admin=(call,p,d)=>call('POST','/statuses/admin/'+p,{adminPassword:'dmpass',...d});

test('only Advocate statuses carry roll bonuses; self-made and player-item statuses never do',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Sesen');
  assert.equal((await admin(call,'add',{to:'Sesen',name:'Blessed',icon:'game:10001',atkBonus:2,healBonus:-1})).status,201);
  assert.equal((await admin(call,'add',{to:'Sesen',name:'Wild',icon:'game:10001',atkBonus:9})).status,400);
  let list=(await call('GET','/statuses',undefined,a.token)).statuses;
  assert.deepEqual([list[0].atkBonus,list[0].healBonus],[2,-1]);
  // a status you give yourself ignores any bonus you send
  await call('POST','/statuses/self',{name:'Sleepy',icon:'game:10001',atkBonus:5,healBonus:5},a.token);
  list=(await call('GET','/statuses',undefined,a.token)).statuses;
  const sleepy=list.find(s=>s.name==='Sleepy');assert.deepEqual([sleepy.atkBonus,sleepy.healBonus,sleepy.self],[0,0,true]);
  // a player-made item cannot carry a bonus; an Advocate's can
  const mine=await call('POST','/items',{name:'Elixir',icon:'game:20001',useLabel:'Drink',useText:'Tingly.',stName:'Buzzed',stIcon:'game:10001',stAtk:3,stHeal:3,quantity:1},a.token);
  assert.equal(mine.status,201,JSON.stringify(mine));
  const made=(await call('GET','/items/me',undefined,a.token)).items.find(i=>i.name==='Elixir');assert.deepEqual([made.stAtk,made.stHeal],[0,0]);
  const g=await call('POST','/items/admin/grant',{adminPassword:'dmpass',to:'Sesen',name:'Hero draught',icon:'game:20001',useLabel:'Drink',useText:'Strong!',consumable:true,stName:'Mighty',stIcon:'game:10001',stAtk:3,stHeal:1});
  assert.equal(g.status,201,JSON.stringify(g));
  const draught=(await call('GET','/items/me',undefined,a.token)).items.find(i=>i.name==='Hero draught');
  assert.equal((await call('POST',`/items/${draught.id}/use`,{},a.token)).status,200);
  list=(await call('GET','/statuses',undefined,a.token)).statuses;
  const mighty=list.find(s=>s.name==='Mighty');assert.deepEqual([mighty.atkBonus,mighty.healBonus],[3,1]);
});

test('quest fights add attack bonuses and say so in the log',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Sesen');
  await admin(call,'add',{to:'Sesen',name:'Blessed',icon:'game:10001',atkBonus:5});
  const q=await call('POST','/quests/admin/save',{adminPassword:'dmpass',title:'Duel',steps:[{type:'fight',npc:'Guard',text:'t',fight:{npcHp:500,npcDie:2,playerHp:900,playerDie:2,playerBonus:0}}]});
  await call('POST','/quests/admin/assign',{adminPassword:'dmpass',questId:q.id,to:'Sesen'});
  await call('POST','/quests/fight/start',{npc:'Guard'},a.token);
  const r=await call('POST','/quests/fight/attack',{questId:q.id},a.token);
  assert.equal(r.fight.npcHp>=500-7,true,JSON.stringify(r));   // a d2 plus 5 hits for 6 or 7
  assert.equal(r.fight.npcHp<=494,true);
  assert.match(JSON.stringify(r.fight.log),/\+5 Blessed/);
});

test('an encounter roll adds the roller\'s own statuses, attack and heal separately, and only for their own character',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Sesen');
  await admin(call,'add',{to:'Sesen',name:'Blessed',icon:'game:10001',atkBonus:5,healBonus:-1});
  const dm=await call('POST','/rooms',{name:'Mira',encounter:'Test',createPassword:'dmpass'}),code=dm.room.code;
  const pl=await call('POST',`/rooms/${code}/join`,{name:'Ren'});
  let room=pl.room;
  const act=async(type,payload,tok,extra={})=>{const r=await call('POST',`/rooms/${code}/actions`,{type,payload,revision:room.revision,actionId:crypto.randomUUID(),...extra},tok);if(r.room)room=r.room;return r};
  const view=async()=>{room=(await call('GET',`/rooms/${code}`,undefined,dm.token)).room};
  for(const [i,c] of [{name:'Hero',type:'Player',hp:5,max:500,ownerId:pl.memberId},{name:'Rat',type:'NPC',hp:500,max:500}].entries()){const r=await act('participant',{...c,number:i+1,details:'',loot:''},dm.token);assert.equal(r.status,200,JSON.stringify(r));await view();}
  assert.equal((await act('settings',{name:'T',mode:'manual',notes:'',location:'',kind:'classic'},dm.token)).status,200);
  assert.equal((await act('start',{},dm.token)).status,200);await view();
  const hero=room.people.find(p=>p.name==='Hero'),rat=room.people.find(p=>p.name==='Rat');
  const bad=await act('roll',{kind:'attack',targetId:rat.id,sides:4},pl.token,{itemsToken:'not-a-token'});
  assert.equal(bad.status,200);                                          // an unknown token just means no bonus
  assert.equal(bad.room.lastRoll.bonus,0);
  await act('next',{},pl.token);await view();                            // back to the hero (the rat has a turn)
  await act('next',{},dm.token);await view();
  const ok=await act('roll',{kind:'attack',targetId:rat.id,sides:4},pl.token,{itemsToken:a.token});
  assert.equal(ok.status,200,JSON.stringify(ok));
  assert.equal(ok.room.lastRoll.bonus,5);
  assert.deepEqual(ok.room.lastRoll.mods.map(m=>m.label),['Blessed']);
  assert.equal(ok.room.lastRoll.total>=6,true);
});

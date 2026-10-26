import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpw');return {status:r.status,...await r.json()}};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r}
const st={name:'Feeling cheerful',icon:'game:10001',description:'A spring in your step.',minutes:0,isDebuff:false};

test('add a status to yourself, everyone can see it, only you or its giver can remove it',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  assert.equal((await call('GET','/statuses')).status,401);
  assert.equal((await call('POST','/statuses/self',st,a.token)).status,201);
  const seen=(await call('GET','/statuses',undefined,b.token)).statuses;
  assert.equal(seen.length,1);assert.equal(seen[0].memberName,'Mira');assert.equal(seen[0].mine,false);assert.equal(seen[0].canRemove,false);assert.equal(seen[0].secondsLeft,null);
  assert.equal((await call('POST',`/statuses/${seen[0].id}/remove`,{},b.token)).status,403);
  assert.equal((await call('POST',`/statuses/${seen[0].id}/remove`,{},a.token)).status,200);
  assert.equal((await call('GET','/statuses',undefined,b.token)).statuses.length,0);
});

test('same name replaces, six at most, bad input refused, timers expire',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  assert.equal((await call('POST','/statuses/self',{...st,name:''},a.token)).status,400);
  assert.equal((await call('POST','/statuses/self',{...st,icon:'nope'},a.token)).status,400);
  assert.equal((await call('POST','/statuses/self',{...st,minutes:-1},a.token)).status,400);
  assert.equal((await call('POST','/statuses/self',{...st,minutes:99999999},a.token)).status,400);
  await call('POST','/statuses/self',st,a.token);await call('POST','/statuses/self',{...st,description:'Still cheerful.'},a.token);
  assert.equal((await call('GET','/statuses',undefined,a.token)).statuses.length,1);
  for(let i=0;i<5;i++)assert.equal((await call('POST','/statuses/self',{...st,name:'S'+i},a.token)).status,201);
  const seventh=await call('POST','/statuses/self',{...st,name:'Seventh'},a.token);assert.equal(seventh.status,409);assert.match(seventh.error,/6 statuses/);
  db.sqlite.prepare("UPDATE statuses SET expires_at = ? WHERE name = 'S0'").run(new Date(Date.now()-1000).toISOString());
  assert.equal((await call('GET','/statuses',undefined,a.token)).statuses.length,5);
  assert.equal((await call('POST','/statuses/self',{...st,name:'Seventh',minutes:30},a.token)).status,201);   // an expired one no longer counts
  const timed=(await call('GET','/statuses',undefined,a.token)).statuses.find(s=>s.name==='Seventh');assert.ok(timed.secondsLeft>1700&&timed.secondsLeft<=1800);
});

test('the strange cookie poisons you, the antidote cures it, and a cure with nothing to cure is not wasted',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira'),b=await join(call,'Kael');
  const mkItem=async(f,tok=a.token)=>{const r=await call('POST','/items',{icon:'game:20001',description:'',...f},tok);assert.equal(r.status,201);return r.items.find(i=>i.id===r.id)};
  assert.equal((await call('POST','/items',{name:'X',icon:'game:20001',stName:'Poison'},a.token)).status,400);   // needs an action
  const cookie=await mkItem({name:'Strange smelling cookie',useLabel:'Eat',useText:'It tastes... wrong.',consumable:true,stName:'Chocolate poison',stDesc:'Your stomach churns.',stDebuff:true,stMinutes:0});
  const antidote=await mkItem({name:'Antidote',useLabel:'Drink',useText:'You feel better.',consumable:true,cures:'chocolate poison'});
  assert.equal(cookie.stName,'Chocolate poison');assert.equal(cookie.stDebuff,true);
  await call('POST',`/items/${cookie.id}/give`,{to:'Kael'},a.token);await call('POST',`/items/${antidote.id}/give`,{to:'Kael'},a.token);
  const ca=(await call('GET','/items/me',undefined,b.token)).items;assert.equal(ca[0].stName,undefined);   // the effect is a surprise for the eater
  const cure1=await call('POST',`/items/${antidote.id}/use`,{},b.token);assert.equal(cure1.status,409);assert.match(cure1.error,/no chocolate poison to cure/i);
  assert.equal((await call('GET','/items/me',undefined,b.token)).items.length,2);   // not used up
  const eat=await call('POST',`/items/${cookie.id}/use`,{},b.token);assert.equal(eat.status,200);assert.equal(eat.statusGained,'Chocolate poison');
  const s=(await call('GET','/statuses',undefined,a.token)).statuses;assert.equal(s.length,1);assert.equal(s[0].memberName,'Kael');assert.equal(s[0].isDebuff,true);assert.equal(s[0].icon,'game:20001');
  assert.equal(s[0].canRemove,true);   // the cookie's maker can lift it
  const cure=await call('POST',`/items/${antidote.id}/use`,{},b.token);assert.equal(cure.status,200);assert.equal(cure.statusCured,'Chocolate poison');
  assert.equal((await call('GET','/statuses',undefined,a.token)).statuses.length,0);
  assert.equal(cure.items.length,0);
});

test('a full set of statuses blocks a status item without using it up; Advocates can add and remove',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  const item=(await call('POST','/items',{name:'Curse',icon:'game:20001',useLabel:'Touch',useText:'Cold.',consumable:true,stName:'Cursed',stDebuff:true},a.token)).items[0];
  for(let i=0;i<6;i++)await call('POST','/statuses/self',{...st,name:'S'+i},a.token);
  const blocked=await call('POST',`/items/${item.id}/use`,{},a.token);assert.equal(blocked.status,409);
  assert.equal((await call('GET','/items/me',undefined,a.token)).items.length,1);
  assert.equal((await call('POST','/statuses/admin/add',{adminPassword:'nope',to:'Mira',...st,name:'Blessed'})).status,403);
  const list=(await call('GET','/statuses',undefined,a.token)).statuses;
  assert.equal((await call('POST','/statuses/admin/remove',{adminPassword:'dmpass',statusId:list[0].id})).status,200);
  assert.equal((await call('POST','/statuses/admin/add',{adminPassword:'dmpass',to:'mira',...st,name:'Blessed'})).status,201);
  const after=(await call('GET','/statuses',undefined,a.token)).statuses;assert.equal(after.length,6);assert.equal(after.find(s=>s.name==='Blessed').canRemove,true);   // the holder can always remove
  assert.equal((await call('POST','/items/admin/remove-member',{adminPassword:'dmpass',name:'Mira'})).status,200);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM statuses').get().n,0);
});

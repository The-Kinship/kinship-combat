import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpw');return {status:r.status,...await r.json()}};
const join=async(call,name)=>call('POST','/items/register',{name,memberPassword:'fcpass'});
const blessed={name:'Blessed',icon:'game:10001',description:'Favoured.',minutes:0,isDebuff:false};

test('an NPC says different things by roster gender and by status, and the first match wins',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Sesen'),b=await join(call,'Kael'),c=await join(call,'Vex');
  const admin=(p,d)=>call('POST','/quests/admin/'+p,{adminPassword:'dmpass',...d});
  const quest={title:'Greetings',steps:[
    {type:'talk',npc:'Maren',text:'Hello.',grants:blessed,variants:[{gender:'female',text:'Good day, miss.'},{gender:'Male',text:'Good day, sir.'}]},
    {type:'talk',npc:'Maren',text:'You look ordinary.',variants:[{status:'Blessed',gender:'male',text:'You glow, sir.'},{status:'Blessed',text:'You glow.'}]}]};
  const saved=await admin('save',quest);assert.equal(saved.status,201);
  for(const who of ['Sesen','Kael','Vex'])await admin('assign',{questId:saved.id,to:who});
  const say=async(tok,gender)=>(await call('POST','/quests/talk',{npc:'Maren',gender},tok)).results[0].text;
  assert.equal(await say(a.token,'Female'),'Good day, miss.');   // case does not matter
  assert.equal(await say(b.token,'male'),'Good day, sir.');
  assert.equal(await say(c.token,'nonbinary'),'Hello.');           // no matching version: the normal text
  // the blessing was given by step one, so step two sees it
  assert.equal(await say(a.token,'female'),'You glow.');
  assert.equal(await say(b.token,'male'),'You glow, sir.');         // status and gender both match, listed first
});

test('the text is picked before the step changes anything, and variants are checked when saved',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Sesen');
  const admin=(p,d)=>call('POST','/quests/admin/'+p,{adminPassword:'dmpass',...d});
  const saved=await admin('save',{title:'Once',steps:[{type:'talk',npc:'Maren',text:'Plain.',grants:blessed,variants:[{status:'Blessed',text:'Already blessed.'}]}]});
  await admin('assign',{questId:saved.id,to:'Sesen'});
  assert.equal((await call('POST','/quests/talk',{npc:'Maren'},a.token)).results[0].text,'Plain.');   // the blessing this step grants does not count for itself
  const bad=s=>admin('save',{title:'Bad',steps:[{type:'talk',npc:'M',text:'x',variants:s}]});
  assert.equal((await bad([{text:'no condition'}])).status,400);
  assert.equal((await bad([{gender:'male'}])).status,400);
  assert.equal((await bad(Array.from({length:7},(_,i)=>({gender:'g'+i,text:'t'})))).status,400);
  assert.equal((await bad('nope')).status,400);
  const list=(await call('POST','/quests/admin/list',{adminPassword:'dmpass'})).quests.find(q=>q.title==='Once');
  assert.equal(list.steps[0].variants[0].status,'Blessed');   // the editor gets them back
});

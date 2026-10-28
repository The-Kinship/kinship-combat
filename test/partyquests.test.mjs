import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpw');return {status:r.status,...await r.json()}};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r}
const gift={name:'Silver locket',icon:'game:20001',description:'Cold to the touch.'};
const quest={title:'The Lever',intro:'Pull it.',steps:[
  {type:'talk',npc:'Old Maren',text:'Find the lever.',hint:'Down the hall.'},
  {type:'receive',npc:'Old Maren',text:'Take this.',gift},
  {type:'talk',npc:'Captain Voss',text:'Done.'}]};

test('party members move together: one completes a step and mates on the same step follow, with the reward and a notice',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Mira'),b=await join(call,'Kael'),c=await join(call,'Ash'),d=await join(call,'Lone');
  const admin=(p,x)=>call('POST','/quests/admin/'+p,{adminPassword:'dmpass',...x});
  const id=(await admin('save',quest)).id;
  for(const n of ['Mira','Kael','Ash','Lone'])await admin('assign',{questId:id,to:n});
  const sc=await call('POST','/scenes',{name:'Mira',title:'Party',createPassword:'dmpass'});assert.equal(sc.status,201);
  const jb=await call('POST',`/scenes/${sc.code}/join`,{name:'Kael'});
  const jc=await call('POST',`/scenes/${sc.code}/join`,{name:'Ash'});
  assert.equal((await call('POST','/quests/party/link',{code:sc.code,sceneToken:sc.token},a.token)).status,200);
  assert.equal((await call('POST','/quests/party/link',{code:sc.code,sceneToken:jb.token},b.token)).status,200);
  assert.equal((await call('POST','/quests/party/link',{code:sc.code,sceneToken:'0'.repeat(64)},c.token)).status,401);   // wrong proof
  assert.equal((await call('POST','/quests/party/link',{code:sc.code,sceneToken:jc.token},c.token)).status,200);
  // Ash falls a step behind on purpose: she does the first step alone first? no, she is on step 0 like the others, so move her ahead by hand
  await call('POST','/quests/party/unlink',{},c.token);
  let r=await call('POST','/quests/talk',{npc:'Old Maren'},c.token);assert.equal(r.results[0].ok,true);   // Ash is now on step 1, unlinked
  await call('POST','/quests/party/link',{code:sc.code,sceneToken:jc.token},c.token);
  r=await call('POST','/quests/talk',{npc:'Old Maren'},a.token);assert.equal(r.results[0].ok,true);
  const bm=await call('GET','/quests/mine',undefined,b.token);
  assert.equal(bm.quests[0].step,1);assert.equal(bm.shared.length,1);assert.equal(bm.shared[0].by,'Mira');assert.equal(bm.shared[0].text,'Find the lever.');
  assert.equal((await call('GET','/quests/mine',undefined,b.token)).shared.length,0);   // told once
  assert.equal((await call('GET','/quests/mine',undefined,c.token)).quests[0].step,1);   // Ash was on a different step: left alone
  assert.equal((await call('GET','/quests/mine',undefined,c.token)).shared.length,0);
  assert.equal((await call('GET','/quests/mine',undefined,d.token)).quests[0].step,0);   // not in the party: left alone
  // the receive step gives everyone on it a copy of the gift
  r=await call('POST','/quests/talk',{npc:'Old Maren'},b.token);assert.equal(r.results[0].gained[0],'Silver locket');
  const am=await call('GET','/quests/mine',undefined,a.token);assert.equal(am.quests[0].step,2);assert.equal(am.shared[0].gained[0],'Silver locket');
  assert.equal((await call('GET','/items/me',undefined,a.token)).items.length,1);
  assert.equal((await call('GET','/items/me',undefined,c.token)).items.length,1);   // Ash was on the receive step too
  // leaving the party stops the sharing
  await call('POST',`/scenes/${sc.code}/leave`,{},jb.token);
  r=await call('POST','/quests/talk',{npc:'Captain Voss'},a.token);assert.equal(r.results[0].finished,true);
  assert.equal((await call('GET','/quests/mine',undefined,b.token)).quests[0].step,2);
  const cm=await call('GET','/quests/mine',undefined,c.token);assert.equal(cm.quests[0].done,true);assert.equal(cm.shared.at(-1).finished,true);   // Ash was still in the party, so she finished too
});

test('closing a party stops sharing and clears the links the next time a step is shared',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await join(call,'Mira'),b=await join(call,'Kael');
  const admin=(p,x)=>call('POST','/quests/admin/'+p,{adminPassword:'dmpass',...x});
  const id=(await admin('save',quest)).id;await admin('assign',{questId:id,to:'Mira'});await admin('assign',{questId:id,to:'Kael'});
  const sc=await call('POST','/scenes',{name:'Mira',title:'P'}),jb=await call('POST',`/scenes/${sc.code}/join`,{name:'Kael'});
  await call('POST','/quests/party/link',{code:sc.code,sceneToken:sc.token},a.token);await call('POST','/quests/party/link',{code:sc.code,sceneToken:jb.token},b.token);
  await call('POST',`/scenes/${sc.code}/close`,{},sc.token);
  await call('POST','/quests/talk',{npc:'Old Maren'},a.token);
  assert.equal((await call('GET','/quests/mine',undefined,b.token)).quests[0].step,0);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM party_links').get().n,0);
});

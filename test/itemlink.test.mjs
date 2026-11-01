import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpass');return {status:r.status,...await r.json()}};
const joinm=(call,name)=>call('POST','/items/register',{name,memberPassword:'fcpass'});
const dossier={name:'Kin dossier',icon:'game:20001',description:'Fill this in.',useLabel:'Read',useText:'Open the link to complete your file.',link:'https://the-kinship.github.io/kinship/apply.html'};

test('only SMs can put a website link on an item, and everyone who holds it sees the link',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await joinm(call,'Mira'),b=await joinm(call,'Kael');
  assert.equal((await call('POST','/items',dossier,a.token)).status,403);
  assert.equal((await call('POST','/items',{...dossier,name:'Plain note',link:''},a.token)).status,201);
  db.sqlite.exec("UPDATE members SET tags = 'SM' WHERE name = 'Mira'");
  for(const bad of ['http://x.com/a','javascript:alert(1)','https://no spaces.com','https://localhost','https://u:p@x.com/','ftp://x.com']){db.sqlite.exec('DELETE FROM rate_limits');assert.equal((await call('POST','/items',{...dossier,link:bad},a.token)).status,400,bad)}
  const made=await call('POST','/items',dossier,a.token);assert.equal(made.status,201);
  const mine=(await call('GET','/items/me',undefined,a.token)).items.find(i=>i.name==='Kin dossier');
  assert.equal(mine.link,dossier.link);
  // editing can change or clear it
  assert.equal((await call('POST',`/items/${mine.id}/update`,{...dossier,link:'https://example.org/form'},a.token)).status,200);
  const again=(await call('GET','/items/me',undefined,a.token)).items.find(i=>i.name==='Kin dossier');assert.equal(again.link,'https://example.org/form');dossier.link='https://example.org/form';
  const gv=await call('POST',`/items/${mine.id}/give`,{to:'Kael'},a.token);assert.equal(gv.status,200,JSON.stringify(gv));
  const theirs=(await call('GET','/items/me',undefined,b.token)).items.find(i=>i.name==='Kin dossier');
  assert.equal(theirs.link,dossier.link);assert.equal(theirs.canEdit,false);
});

test('an Advocate gift can carry a link, and the Iron Pack tag replaces Vanguard',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const b=await joinm(call,'Kael');
  const g=await call('POST','/items/admin/grant',{...dossier,adminPassword:'dmpass',to:'Kael'});assert.equal(g.status,201);
  assert.equal((await call('GET','/items/me',undefined,b.token)).items[0].link,dossier.link);
  const tags=await call('POST','/items/admin/registered',{adminPassword:'dmpass'});
  assert.ok(tags.tagChoices.includes('Iron Pack'));assert.ok(!tags.tagChoices.includes('Vanguard'));
  db.sqlite.exec("UPDATE members SET tags = 'Onyx,Vanguard,Kin' WHERE name = 'Kael'");
  db.sqlite.exec(fs.readFileSync(new URL('../migrations/0037_iron_pack_tag.sql',import.meta.url),'utf8'));
  assert.equal(db.sqlite.prepare("SELECT tags FROM members WHERE name = 'Kael'").get().tags,'Onyx,Iron Pack,Kin');
});

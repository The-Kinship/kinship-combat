import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpw');return {status:r.status,...await r.json()}};
async function join(call,name){const r=await call('POST','/items/register',{name,memberPassword:'fcpass'});assert.equal(r.status,201);return r}
test('editing an item saves, including gear and status settings',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);const a=await join(call,'Mira');
  const body={name:'Glowing crystal',icon:'game:20001',description:'It hums.',flavor:'Warm.',useText:'You feel angry.',stName:'Anger',stDesc:'Short tempered.',stIcon:'game:10205'};
  assert.equal((await call('POST','/items',body,a.token)).status,201);
  const first=(await call('GET','/items/me',undefined,a.token)).items.find(i=>i.name==='Glowing crystal');
  const up=await call('POST',`/items/${first.id}/update`,{...body,description:'It hums louder.'},a.token);
  assert.equal(up.status,200);
  const after=(await call('GET','/items/me',undefined,a.token)).items.find(i=>i.name==='Glowing crystal');
  assert.equal(after.description,'It hums louder.');assert.equal(after.stName,'Anger');
});

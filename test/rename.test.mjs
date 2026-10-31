import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handle } from '../src/api.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync(new URL('../migrations/',import.meta.url)).sort())sqlite.exec(fs.readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));return {sqlite,prepare(sql){const st=sqlite.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async all(){return {results:st.all(...a)}},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const mk=db=>async(method,path,data,token)=>{const r=await handle(new Request('https://kinship.test/api'+path,{method,headers:{...(data===undefined?{}:{'Content-Type':'application/json',Origin:'https://kinship.test'}),...(token?{Authorization:'Bearer '+token}:{})},body:data===undefined?undefined:JSON.stringify(data)}),db,'dmpass','fcpass','bankpw');return {status:r.status,...await r.json()}};
const joinm=async(call,name)=>call('POST','/items/register',{name,memberPassword:'fcpass'});
test('a member can change their registered name, keeping everything, but not take another name',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const call=mk(db);
  const a=await joinm(call,'Sesen'),b=await joinm(call,'Kael');
  assert.equal((await call('POST','/items',{name:'Rock',icon:'game:20001'},a.token)).status,201);
  assert.equal((await call('POST','/items/rename',{name:'Sesen Silverborne'})).status,401);
  assert.equal((await call('POST','/items/rename',{name:'S'},a.token)).status,400);
  assert.equal((await call('POST','/items/rename',{name:'kael'},a.token)).status,409);
  assert.equal((await call('POST','/items/rename',{name:'Sesen'},a.token)).status,400);
  const r=await call('POST','/items/rename',{name:'Sesen Silverborne'},a.token);
  assert.equal(r.status,200);assert.equal(r.name,'Sesen Silverborne');
  assert.equal((await call('GET','/items/me',undefined,a.token)).items.length,1);
  assert.equal((await call('POST','/items/rename',{name:'Sesen'},b.token)).status,200);
  const rec=await call('POST','/items/recover',{recoveryCode:a.recoveryCode});
  assert.deepEqual(rec.characters,['Sesen Silverborne']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from '../src/worker.js';
function d1(){const s=new DatabaseSync(':memory:');s.exec(fs.readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8'));return {prepare(sql){const st=s.prepare(sql);let a=[];return {bind(...v){a=v;return this},async first(){return st.get(...a)||null},async run(){return {meta:{changes:Number(st.run(...a).changes)}}}}}}}
const env={DB:d1(),ASSETS:{fetch:async r=>new Response('asset:'+new URL(r.url).pathname)}};
test('root redirects to the table page, keeping ?room=',async()=>{const r=await worker.fetch(new Request('https://x.example/?room=ABC'),env);assert.equal(r.status,302);assert.equal(r.headers.get('location'),'https://x.example/table/index.html?room=ABC')});
test('static files go to assets',async()=>{const r=await worker.fetch(new Request('https://x.example/table/app.js'),env);assert.equal(await r.text(),'asset:/table/app.js')});
test('/api/health works against the database',async()=>{const r=await worker.fetch(new Request('https://x.example/api/health'),env);assert.equal(r.status,200);assert.equal((await r.json()).service,'Kinship Combat')});
test('create room through the worker',async()=>{const r=await worker.fetch(new Request('https://x.example/api/rooms',{method:'POST',headers:{'content-type':'application/json',origin:'https://x.example'},body:JSON.stringify({name:'DM',encounter:'Test'})}),env);assert.equal(r.status,201);assert.match((await r.json()).room.code,/^[A-F0-9]{18}$/)});

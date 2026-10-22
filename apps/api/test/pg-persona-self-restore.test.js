'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { PostgresStore } = require('../src/persistence/postgres-store');
const { createApp } = require('../src/app');
const databaseUrl = process.env.QIYU_PG_TEST_DATABASE_URL;
const options = { skip: !databaseUrl && '需要独立 QIYU_PG_TEST_DATABASE_URL', timeout: 30000 };

async function fixture(t) {
  const target = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname.endsWith('_test'));
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  t.after(() => pool.end());
  const alice = randomUUID(), bob = randomUUID();
  await pool.query("INSERT INTO accounts(account_id,age_status) VALUES($1,'AGE_PASS'),($2,'AGE_PASS')", [alice,bob]);
  await pool.query('INSERT INTO account_interaction_controls(account_id) VALUES($1),($2)', [alice,bob]);
  await pool.query("INSERT INTO required_notices(notice_id,account_id,type,notice_version,state,displayed_at) VALUES($1,$2,'AI_IDENTITY','synthetic','DISPLAYED',CURRENT_TIMESTAMP),($3,$4,'AI_IDENTITY','synthetic','DISPLAYED',CURRENT_TIMESTAMP)", [randomUUID(),alice,randomUUID(),bob]);
  const auth = { resolveAccessToken: async token => ({ 'synthetic-alice': alice, 'synthetic-bob': bob })[token] };
  async function server() {
    const app = createApp({ store: new PostgresStore({ pool }), trialAuthEnabled: true, trialAuth: auth, summaryEnabled: false });
    await new Promise(resolve => app.listen(0,'127.0.0.1',resolve));
    t.after(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve); }));
    return `http://127.0.0.1:${app.address().port}/api/v1`;
  }
  let origin = await server();
  async function request(route, body, { token='synthetic-alice', key=randomUUID(), method=body===undefined?'GET':'POST' }={}) {
    const r = await fetch(origin+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':key},body:body===undefined?undefined:JSON.stringify(body)});
    return { status:r.status, body:await r.json() };
  }
  const created = await request('/characters',{name:'Synthetic restore',persona:{personality:'Quiet',gender:'male'}});
  assert.equal(created.status,201);
  const id = created.body.character.character_id;
  return { pool,alice,bob,id,request,restart:async()=>{origin=await server();} };
}

test('PG restore: edit, fresh server read, restore and durable idempotent replay retain snapshots and metadata', options, async t => {
  const { pool,id,request,restart } = await fixture(t);
  const edited = await request(`/characters/${id}/persona-versions`,{expected_version:1,persona:{personality:'Lively',gender:'female'},note:'self edit'});
  assert.equal(edited.status,201);
  await restart();
  let current = (await request(`/characters/${id}`)).body.character;
  assert.deepEqual(current.persona_history.map(v=>v.state),['RETIRED','STABLE']);
  const body={expected_version:current.version,confirm:true,reason:'Prefer original'};
  const restored=await request(`/characters/${id}/persona-versions/1/restore`,body,{key:'durable-restore'});
  assert.equal(restored.status,201);
  await restart();
  current=(await request(`/characters/${id}`)).body.character;
  assert.equal(current.version,restored.body.character.version);
  assert.equal(current.active_persona_version,3);
  assert.equal(current.persona.personality,'Quiet');
  assert.deepEqual(current.persona_history.map(v=>v.state),['RETIRED','RETIRED','STABLE']);
  assert.equal(current.persona_history[2].restored_from_version,1);
  assert.equal(current.persona_history[2].note,'回退至 v1：Prefer original');
  const replay=await request(`/characters/${id}/persona-versions/1/restore`,body,{key:'durable-restore'});
  assert.deepEqual(replay,restored);
  const rows=(await pool.query('SELECT version,persona_json,restored_from_version FROM persona_versions WHERE character_id=$1 ORDER BY version',[id])).rows;
  assert.equal(rows.length,3);
  assert.equal(rows[0].persona_json.personality,'Quiet');
  assert.equal(rows[1].persona_json.personality,'Lively');
  assert.equal(Number(rows[2].restored_from_version),1);
});

test('PG restore: draft version gaps do not corrupt optimistic versions; concurrent different requests have one winner', options, async t => {
  const { id,request,restart }=await fixture(t);
  await request(`/characters/${id}/persona-versions`,{expected_version:1,persona:{personality:'Lively'},note:'edit'});
  const draft=await request(`/characters/${id}/persona-versions`,{expected_version:2,persona:{personality:'Unreleased'},release_mode:'draft',note:'draft'});
  assert.equal(draft.status,201);
  await restart();
  let current=(await request(`/characters/${id}`)).body.character;
  assert.equal(current.version,2,'history-only draft must not bump the character row');
  assert.equal((await request(`/characters/${id}/persona-versions/3/restore`,{expected_version:2,confirm:true,reason:'reject draft'})).status,409);
  const results=await Promise.all(['one','two'].map(reason=>request(`/characters/${id}/persona-versions/1/restore`,{expected_version:2,confirm:true,reason})));
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  const winner=results.find(r=>r.status===201);
  await restart();
  current=(await request(`/characters/${id}`)).body.character;
  assert.equal(current.version,3);
  assert.equal(current.active_persona_version,4);
  assert.equal(winner.body.character.version,current.version);
  assert.equal(current.persona_history.length,4);
  assert.equal(current.persona_history.find(v=>v.version===3).state,'DRAFT');
  assert.equal(current.persona_history.find(v=>v.version===4).restored_from_version,1);
});

test('PG restore: real RLS and request validation reject foreign owners and client-injected snapshots', options, async t => {
  const { pool,alice,bob,id,request }=await fixture(t);
  await request(`/characters/${id}/persona-versions`,{expected_version:1,persona:{personality:'Lively'},note:'edit'});
  const route=`/characters/${id}/persona-versions/1/restore`,body={expected_version:2,confirm:true,reason:'restore'};
  assert.equal((await request(route,body,{token:'synthetic-bob'})).status,404);
  assert.equal((await request(route,{...body,persona:{personality:'Injected'}})).status,400);
  assert.equal((await request(route,{...body,confirm:false})).status,400);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');await client.query('SET LOCAL ROLE qiyu_app');
    await client.query("SELECT set_config('app.account_id',$1,true)",[bob]);
    assert.equal((await client.query('SELECT version FROM persona_versions WHERE character_id=$1',[id])).rowCount,0);
    await client.query('ROLLBACK');
  }finally{client.release();}
  assert.equal((await request(`/characters/${id}`)).body.character.version,2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM persona_versions WHERE account_id=$1',[alice])).rows[0].n,2);
});

test('PG restore migration: legacy stable history is repaired safely, reruns retain metadata and constraints reject invalid targets', options, async t => {
  const { pool,id,request,bob }=await fixture(t);
  await request(`/characters/${id}/persona-versions`,{expected_version:1,persona:{personality:'Lively'},note:'edit'});
  await pool.query("UPDATE persona_versions SET state='STABLE' WHERE character_id=$1 AND version=1",[id]);
  const migration=readFileSync(path.resolve(__dirname,'../../../infra/postgres/migrations/069_persona_self_restore_persistence.sql'),'utf8');
  await pool.query(migration);
  await pool.query(migration);
  assert.deepEqual((await pool.query('SELECT state FROM persona_versions WHERE character_id=$1 ORDER BY version',[id])).rows.map(v=>v.state),['RETIRED','STABLE']);
  await assert.rejects(pool.query('UPDATE persona_versions SET restored_from_version=version WHERE character_id=$1 AND version=2',[id]),{code:'23514'});
  const other=randomUUID();
  await pool.query("INSERT INTO characters(character_id,account_id,display_name) VALUES($1,$2,'Other')",[other,bob]);
  await assert.rejects(pool.query("INSERT INTO persona_versions(character_id,account_id,version,persona_json,restored_from_version) SELECT character_id,account_id,2,'{}'::jsonb,1 FROM characters WHERE character_id=$1",[other]),{code:'23503'});
});

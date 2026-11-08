'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enqueueAutomaticMemory, evaluateCandidates, runAutomaticMemoryJob } = require('../src/domain/automatic-memory-v2');

function proposal(quote, topic, category = 'preference') {
  return { quote, topic, category, subject: 'self', assertion: 'explicit' };
}

test('one message can supply two grounded memories with separate expiration rules', () => {
  const result = evaluateCandidates('我喜欢清淡饮食，我最近在准备考试。', [
    proposal('我喜欢清淡饮食', '饮食'),
    proposal('我最近在准备考试', '考试', 'recent')
  ]);
  assert.deepEqual(result.map(({ quote, recent }) => [quote, recent]), [
    ['我喜欢清淡饮食', false], ['我最近在准备考试', true]
  ]);
});

test('a standalone literal preference does not inherit a separate personal disclosure', () => {
  const preference = '我喜欢摄影';
  const disclosure = '我最近在服用控制血压的药物';
  const [ordinary, sensitive] = evaluateCandidates(`${preference}，${disclosure}。`, [
    proposal(preference, '摄影', 'interest'),
    proposal(disclosure, '药物', 'sensitive')
  ]);
  assert.equal(ordinary.needsConfirmation, false);
  assert.equal(sensitive.needsConfirmation, true);
  const income = '我的月收入是五千元';
  const separated = evaluateCandidates(`${preference}；${income}。`, [
    proposal(preference, '摄影', 'interest'), proposal(income, '月收入', 'background')
  ]);
  assert.deepEqual(separated.map(({ needsConfirmation }) => needsConfirmation), [false, true]);

  const dependent = '我喜欢这个';
  const [unclear] = evaluateCandidates(`${disclosure}，${dependent}。`, [proposal(dependent, '这个')]);
  assert.equal(unclear.needsConfirmation, true);

  const qualifier = '属于失眠治疗的一部分';
  const [qualified] = evaluateCandidates(`${preference}，${qualifier}。`, [proposal(preference, '摄影')]);
  assert.equal(qualified.needsConfirmation, true);
});

test('model output cannot clip a negation, invent a quote or turn a third party into the user', () => {
  assert.deepEqual(evaluateCandidates('我不喜欢喝茶。', [proposal('喜欢喝茶', '茶')]), []);
  assert.deepEqual(evaluateCandidates('张三喜欢喝茶。', [proposal('张三喜欢喝茶', '茶')]), []);
  assert.deepEqual(evaluateCandidates('我朋友说，我喜欢喝茶。', [proposal('我喜欢喝茶', '茶')]), []);
  assert.deepEqual(evaluateCandidates('我喜欢喝茶，我的验证码是123456。', [proposal('我喜欢喝茶', '茶')]), []);
  assert.equal(evaluateCandidates('我最近失眠。', [proposal('我最近失眠', '失眠')])[0].needsConfirmation, true);
});

test('precise addresses require confirmation even when the model calls them ordinary background', () => {
  const address = '我暂住在海棠路二十八号二单元';
  const [sensitive] = evaluateCandidates(address, [proposal(address, '海棠路', 'background')]);
  assert.equal(sensitive.needsConfirmation, true);
  const district = '我住在滨江区';
  assert.equal(evaluateCandidates(district, [proposal(district, '滨江区', 'background')])[0].needsConfirmation, false);
});

test('a rejected literal meaning stays rejected when the model quotes only the preceding clause', () => {
  const sarcastic = '我最喜欢周末被叫起来开会了';
  assert.deepEqual(evaluateCandidates(`${sarcastic}，才怪。`, [proposal(sarcastic, '开会')]), []);
  const hypothetical = '我肯定会起得更早';
  assert.deepEqual(evaluateCandidates(`要是我喜欢冬泳，${hypothetical}。`, [
    proposal(hypothetical, '起得更早', 'goal')
  ]), []);
  const denial = '我没说过我喜欢喝气泡水';
  assert.deepEqual(evaluateCandidates(`${denial}。`, [proposal(denial, '气泡水')]), []);
  const role = '我在游戏里扮作爱唱山歌的村长';
  assert.deepEqual(evaluateCandidates(role, [proposal(role, '山歌')]), []);
});

test('long-term reply preferences using 答复 keep the canonical style key', () => {
  const quote = '以后请把答复写得详细些';
  const [fact] = evaluateCandidates(`${quote}。`, [proposal(quote, '详细', 'communication')]);
  assert.equal(fact.key, 'communication.response_style');
  assert.equal(fact.value, 'detailed');
});

test('standing communication requests survive paraphrase without saving a one-turn instruction', () => {
  const classify = (quote, topic) => evaluateCandidates(quote, [proposal(quote, topic, 'communication')]);
  const [style] = classify('往后请回复得直接些', '直接');
  assert.equal(style?.key, 'communication.response_style');
  assert.equal(style.value, 'direct');
  assert.equal(classify('此后和我聊天时请尽量用普通话', '普通话').length, 1);
  assert.equal(classify('今后的回复请先给结论', '结论').length, 1);
  assert.deepEqual(classify('请把这一段回复写短些', '回复'), []);
});

test('a short answer only becomes a drink preference after a matching question in the previous turn', () => {
  const input = [proposal('咖啡', '咖啡')];
  const previous = { actor: 'ASSISTANT', message_id: 'q', text: '你喜欢喝什么？' };
  assert.deepEqual(evaluateCandidates('咖啡', input), []);
  const [fact] = evaluateCandidates('咖啡', input, { previous });
  assert.equal(fact.key, 'user.preference.drink:coffee');
  assert.equal(fact.contextId, 'q');
  assert.deepEqual(evaluateCandidates('咖啡', input, { previous: { ...previous, text: '你刚才喝了什么？' } }), []);
  assert.equal(evaluateCandidates('咖啡', input, { previous: { ...previous, text: '您更喜欢哪种饮品？' } })[0]?.key,
    'user.preference.drink:coffee');
});

test('a short hobby answer needs an explicit preference question rather than a past activity question', () => {
  const input = [proposal('陶艺', '陶艺', 'interest')];
  const previous = { actor: 'ASSISTANT', message_id: 'q', text: '你平时喜欢做什么？' };
  assert.deepEqual(evaluateCandidates('陶艺', input), []);
  const [fact] = evaluateCandidates('陶艺', input, { previous });
  assert.equal(fact.key, 'v2:preference:陶艺');
  assert.equal(fact.displayText, '喜欢陶艺');
  assert.equal(fact.contextId, 'q');
  assert.deepEqual(evaluateCandidates('陶艺', input, { previous: { ...previous, text: '你昨天做了什么？' } }), []);
  assert.equal(evaluateCandidates('陶艺', input, { previous: { ...previous, text: '您平时有什么爱好？' } })[0]?.key, 'v2:preference:陶艺');
  const punctuated = [proposal('陶艺。', '陶艺', 'interest')];
  assert.equal(evaluateCandidates('陶艺。', punctuated, { previous })[0]?.contextId, 'q');
  assert.deepEqual(evaluateCandidates('陶艺。', punctuated, { previous: { ...previous, text: '你昨天做了什么？' } }), []);
  assert.deepEqual(evaluateCandidates('陶艺？', [proposal('陶艺？', '陶艺', 'interest')], { previous }), []);
  const hobby = '练习花体字';
  const activity = [proposal(hobby + '。', '花体字', 'interest')];
  const contextual = evaluateCandidates(hobby + '。', activity, { previous });
  assert.equal(contextual[0]?.key, 'v2:preference:练习花体字');
  assert.equal(contextual[0]?.contextId, 'q');
  assert.deepEqual(evaluateCandidates(hobby + '。', activity, { previous: { ...previous, text: '你上周做了什么？' } }), []);
  assert.deepEqual(evaluateCandidates('练习那个。', [proposal('练习那个', '那个', 'interest')], { previous }), []);
});

test('explicit calendar dates expire at local midnight and impossible dates are discarded', () => {
  const text = '我计划2028年2月29日参加考试';
  const [fact] = evaluateCandidates(text, [proposal(text, '考试', 'recent')], { utcOffsetMinutes: 480 });
  assert.equal(fact.expiresAt, '2028-02-29T16:00:00.000Z');
  const invalid = '我计划2027-02-29参加考试';
  assert.deepEqual(evaluateCandidates(invalid, [proposal(invalid, '考试', 'recent')]), []);
});

test('Chinese numeral dates use the explicit year and ambiguous calendar dates need confirmation', () => {
  const evaluate = (quote) => evaluateCandidates(quote, [proposal(quote, '考试', 'recent')], { utcOffsetMinutes: 480 });
  assert.equal(evaluate('我计划二〇二八年二月二十九日参加考试')[0]?.expiresAt, '2028-02-29T16:00:00.000Z');
  assert.equal(evaluate('我预约了２０２８年２月２９号的考试')[0]?.expiresAt, '2028-02-29T16:00:00.000Z');
  assert.deepEqual(evaluate('我计划二零二七年二月二十九日参加考试'), []);
  assert.deepEqual(evaluate('我计划二月三十日参加考试'), []);
  assert.deepEqual(evaluate('我计划二〇二八年二月二十八日至二月二十九日参加考试'), []);
  for (const quote of ['我计划二月二十九日参加考试', '我计划农历二〇二八年二月二十九日参加考试', '我计划农历正月初一参加考试']) {
    const [fact] = evaluate(quote);
    assert.equal(fact?.needsConfirmation, true);
    assert.equal(fact.expiresAt, undefined);
  }
});

test('alternate drink wording keeps the same key when the extractor labels it an interest', () => {
  const text = '我爱热美式咖啡';
  const [fact] = evaluateCandidates(text, [proposal(text, '热美式咖啡', 'interest')]);
  assert.equal(fact.key, 'user.preference.drink:hot_americano');
  assert.equal(fact.value, 'like');
});

test('activity paraphrases share a preference key without conflating different activities', () => {
  const evaluate = (text, topic) => evaluateCandidates(text, [proposal(text, topic, 'interest')])[0];
  assert.equal(evaluate('我很爱听爵士乐', '爵士乐').key, evaluate('我偏爱爵士乐', '爵士乐').key);
  assert.equal(evaluate('我喜欢陶艺', '陶艺').key, evaluate('我爱做陶艺', '陶艺').key);
  assert.equal(evaluate('现在我不喜欢做陶艺', '陶艺').value, 'dislike');
  assert.equal(evaluate('现在我不喜欢做陶艺', '陶艺').revisable, true);
  assert.notEqual(evaluate('我喜欢看鱼', '鱼').key, evaluate('我喜欢吃鱼', '鱼').key);
  assert.notEqual(evaluate('我周末常去攀岩', '攀岩').key, evaluate('我喜欢攀岩', '攀岩').key);
});

test('food and drink paraphrases preserve qualifiers and action boundaries', () => {
  const evaluate = (text, topic) => evaluateCandidates(text, [proposal(text, topic)])[0];
  const yogurt = evaluate('我偏爱无糖酸奶', '无糖酸奶');
  assert.equal(evaluate('我挺喜欢吃无糖酸奶', '无糖酸奶').key, yogurt.key);
  assert.ok(yogurt.relatedKeys.includes('v2:preference:吃无糖酸奶'));
  assert.equal(evaluate('现在我不喜欢吃无糖酸奶', '无糖酸奶').revisable, true);
  assert.notEqual(evaluate('我喜欢酸奶', '酸奶').key, yogurt.key);
  assert.notEqual(evaluate('我喜欢做无糖酸奶', '无糖酸奶').key, yogurt.key);
  assert.notEqual(evaluate('我喜欢鱼', '鱼').key, evaluate('我喜欢吃鱼', '鱼').key);
  assert.equal(evaluate('我喜欢喝豆浆', '豆浆').key, evaluate('我最爱豆浆', '豆浆').key);
  assert.notEqual(evaluate('我喜欢喝冰豆浆', '冰豆浆').key, evaluate('我喜欢豆浆', '豆浆').key);
});

function jobFixture(mode) {
  const job = { account_id: 'a', message_id: 'm', preference_version: 1, revocation_epoch: 1, attempts: 1, mode };
  const account = { account_status: 'OPEN', user_pause_state: 'ACTIVE', automatic_memory_enabled: true, automatic_memory_preference_version: 1, revocation_epoch: 1 };
  const completions = [];
  const scoped = {
    account: () => account,
    messages: new Map([['m', { message_id: 'm', actor: 'USER', conversation_id: 'c', text: '我喜欢清淡饮食' }]]),
    conversations: new Map([['c', { account_id: 'a', status: 'ACTIVE', character_id: 'character' }]]),
    assets: new Map(),
    candidates: new Map(),
    assetEmbeddingJobs: new Map(),
    next: () => 'new-id',
    client: { async query(sql, args) {
      if (sql.includes('RETURNING')) return { rows: [job] };
      if (sql.includes('SELECT 1')) return { rowCount: 1 };
      if (args[2]) completions.push(args[2]);
      return { rowCount: 1 };
    } }
  };
  const store = { async withAccountTransaction(_id, action) { return action(scoped); } };
  return { store, scoped, account, completions };
}

test('active jobs publish a source-linked memory and previously queued shadow jobs only observe', async () => {
  for (const queuedMode of ['active', 'shadow']) {
    const { store, scoped } = jobFixture(queuedMode);
    const result = await runAutomaticMemoryJob({ store, accountId: 'a', mode: 'active', async extract() {
      return { candidates: [proposal('我喜欢清淡饮食', '饮食')], modelVersion: 'test-model' };
    } });
    assert.equal(result, 'COMPLETED');
    assert.equal(scoped.assets.size, queuedMode === 'active' ? 1 : 0);
    if (queuedMode === 'active') {
      assert.equal(scoped.assets.get('new-id').origin, 'AUTOMATIC');
      assert.equal(scoped.assets.get('new-id').automatic_source_message_id, 'm');
    }
  }
});

test('an opt-out while extraction is running prevents publishing the result', async () => {
  const { store, scoped, account, completions } = jobFixture('active');
  const result = await runAutomaticMemoryJob({ store, accountId: 'a', mode: 'active', async extract() {
    account.automatic_memory_enabled = false;
    account.automatic_memory_preference_version += 1;
    return { candidates: [proposal('我喜欢清淡饮食', '饮食')] };
  } });
  assert.equal(result, 'CANCELLED');
  assert.deepEqual(completions, ['CANCELLED']);
  assert.equal(scoped.assets.size, 0);
});

test('a paraphrased change to a legacy confirmed preference is sent for confirmation', async () => {
  const { store, scoped } = jobFixture('active');
  const text = '现在我不喜欢做陶艺';
  scoped.messages.get('m').text = text;
  scoped.assets.set('legacy', {
    asset_id: 'legacy', account_id: 'a', character_id: 'character', state: 'ACTIVE',
    origin: 'USER_CONFIRMED', display_text: '我喜欢陶艺', value: { fact_key: 'user.preference:陶艺', fact_value: 'like' }
  });
  const outcome = await runAutomaticMemoryJob({ store, accountId: 'a', mode: 'active', async extract() {
    return { candidates: [proposal(text, '陶艺', 'interest')] };
  } });
  assert.equal(outcome, 'COMPLETED');
  assert.equal(scoped.assets.size, 1);
  assert.equal(scoped.assets.get('legacy').state, 'ACTIVE');
  assert.equal(scoped.candidates.get('new-id').state, 'CANDIDATE');
});

test('a concurrent message does not invalidate an independent fact, but revoked context does', async () => {
  for (const revoke of [false, true]) {
    const { store, scoped } = jobFixture('active');
    scoped.messages.get('m').created_at = new Date('2026-11-07T10:00:00.300Z');
    const prior = { message_id: 'q', actor: 'ASSISTANT', conversation_id: 'c', text: '聊聊饮食吧', created_at: new Date('2026-11-07T10:00:00.100Z') };
    scoped.messages.set(prior.message_id, prior);
    const state = await runAutomaticMemoryJob({ store, accountId: 'a', mode: 'active', async extract(_text, context) {
      assert.equal(context.length, 1);
      if (revoke) scoped.messages.delete(prior.message_id);
      else scoped.messages.set('later', { ...prior, message_id: 'later', text: '你平时喜欢做什么？', created_at: new Date('2026-11-07T10:00:00.200Z') });
      return { candidates: [proposal('我喜欢清淡饮食', '饮食')] };
    } });
    assert.equal(state, revoke ? 'CANCELLED' : 'COMPLETED');
    assert.equal(scoped.assets.size, revoke ? 0 : 1);
  }
});

test('a rollback of the rollout scope stops excluded accounts before a provider call', async (t) => {
  const { store, scoped, account, completions } = jobFixture('active');
  const mode = process.env.QIYU_AUTOMATIC_MEMORY_V2;
  const accounts = process.env.QIYU_AUTOMATIC_MEMORY_V2_ACCOUNTS;
  t.after(() => {
    if (mode === undefined) delete process.env.QIYU_AUTOMATIC_MEMORY_V2;
    else process.env.QIYU_AUTOMATIC_MEMORY_V2 = mode;
    if (accounts === undefined) delete process.env.QIYU_AUTOMATIC_MEMORY_V2_ACCOUNTS;
    else process.env.QIYU_AUTOMATIC_MEMORY_V2_ACCOUNTS = accounts;
  });
  process.env.QIYU_AUTOMATIC_MEMORY_V2 = 'active';
  process.env.QIYU_AUTOMATIC_MEMORY_V2_ACCOUNTS = 'b';
  scoped.automaticMemoryJobs = [];
  enqueueAutomaticMemory(scoped, { ...account, account_id: 'a' }, scoped.messages.get('m'));
  assert.equal(scoped.automaticMemoryJobs.length, 0);
  let calls = 0;
  await runAutomaticMemoryJob({ store, accountId: 'a', mode: 'active', async extract() { calls += 1; } });
  assert.equal(calls, 0);
  assert.deepEqual(completions, ['CANCELLED']);
});

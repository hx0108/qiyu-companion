const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const webRoot = path.resolve(__dirname, '../../web');
const source = fs.readFileSync(path.join(webRoot, 'character-appearance.js'), 'utf8');
const appearance = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('形象目录新增三男三女，每张图片均有独立文件', async () => {
  const { CHARACTER_PORTRAITS } = await appearance;
  assert.equal(CHARACTER_PORTRAITS.filter((p) => p.group === '男性').length, 3);
  assert.equal(CHARACTER_PORTRAITS.filter((p) => p.group === '女性').length, 3);
  for (const portrait of CHARACTER_PORTRAITS.filter((p) => p.id !== 'original')) {
    const bytes = fs.readFileSync(path.join(webRoot, portrait.src));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
});

test('选择按角色保存，刷新可恢复且不会串角色', async () => {
  const { loadPortraitId, savePortraitId } = await appearance;
  const data = new Map();
  const storage = { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value) };
  assert.equal(savePortraitId('role-a', 'female-02', storage), true);
  assert.equal(loadPortraitId('role-a', storage), 'female-02');
  assert.equal(loadPortraitId('role-b', storage), 'original');
  assert.equal(savePortraitId('role-a', '../../unknown', storage), false);
  assert.equal(loadPortraitId('role-a', storage), 'female-02');
});

test('未知或存储不可用时回到经典形象，写入失败显式返回失败', async () => {
  const { loadPortraitId, savePortraitId } = await appearance;
  assert.equal(loadPortraitId('role-a', { getItem: () => 'unknown' }), 'original');
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(loadPortraitId('role-a', blocked), 'original');
  assert.equal(savePortraitId('role-a', 'male-01', blocked), false);
});

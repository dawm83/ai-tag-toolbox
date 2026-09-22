'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssistant } = require('../src/modules/assistant');
const { createImages } = require('../src/modules/images');
const { createStorage } = require('../src/modules/storage');

function fixture(t, model, gateway) {
  const storage = createStorage(), images = createImages({ storage });
  const image = images.add({ filename: 'source.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AQID' });
  const requests = [];
  const app = createAssistant({ storage, images, primaryApi: { model, base: 'https://fixture.test/v1' }, primaryGateway: { complete: async (messages, config) => {
    requests.push(structuredClone(messages));
    return gateway ? gateway(messages, config, requests.length) : { text: '已查看' };
  } } });
  t.after(() => app.destroy());
  return { app, storage, image, requests };
}
const pictures = messages => messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url') : []);

test('a visual primary receives authorized image content without persisting image payloads in the conversation', async t => {
  const f = fixture(t, 'fixture-vision');
  const result = await f.app.run({ text: '描述图片', imageIds: [f.image.id] });
  assert.equal(result.ok, true);
  assert.equal(pictures(f.requests[0])[0]?.image_url.url, 'data:image/png;base64,AQID');
  assert.doesNotMatch(f.app.exportSessions(), /base64|AQID/);
});

test('a known text-only primary receives an honest visual capability note and image IDs without pixels', async t => {
  const f = fixture(t, 'deepseek-chat');
  await f.app.run({ text: '分析图片', imageIds: [f.image.id] });
  assert.equal(pictures(f.requests[0]).length, 0);
  assert.match(f.requests[0][0].content, /不能直接看图/);
  assert.match(JSON.stringify(f.requests[0]), new RegExp(f.image.id));
});

test('explicit unsupported image response retries as text once and remembers the provider capability', async t => {
  const f = fixture(t, 'custom-model', (_m, _c, n) => {
    if (n === 1) throw new Error('HTTP 400: model does not support image input');
    return { text: '需要视觉子代理' };
  });
  assert.equal((await f.app.run({ text: '分析图片', imageIds: [f.image.id] })).ok, true);
  assert.equal(pictures(f.requests[0]).length, 1);
  assert.equal(pictures(f.requests[1]).length, 0);
  await f.app.run({ text: '再看这张图', imageIds: [f.image.id] });
  assert.equal(pictures(f.requests[2]).length, 0);
});

test('ordinary provider failure is not retried as a text-only image success', async t => {
  const f = fixture(t, 'fixture-vision', () => { throw new Error('HTTP 503 unavailable'); });
  assert.equal((await f.app.run({ text: '分析图片', imageIds: [f.image.id] })).ok, false);
  assert.equal(f.requests.length, 1);
});

test('revisiting an authorized image through the view tool supplies pixels only to the next model request', async t => {
  const f = fixture(t, 'fixture-vision', (_m, _c, n) => n === 2 ? { toolCalls: [{ id: 'view', name: 'conversation_viewImages', arguments: { imageIds: [f.image.id] } }] } : { text: '已查看' });
  await f.app.run({ text: '这张图', imageIds: [f.image.id] });
  const result = await f.app.run('再核对一下姿势');
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(pictures(f.requests.at(-1)).length, 1);
  assert.doesNotMatch(f.app.exportSessions(), /base64|AQID/);
  f.app.newSession();
  const denied = await f.app.primaryTools.call('conversation.viewImages', { imageIds: [f.image.id] }, { sessionId: f.app.currentSession().id });
  assert.equal(denied.ok, false);
});

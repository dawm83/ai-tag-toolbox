'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createComfy } = require('../src/modules/comfy');

async function serverFixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('ComfyUI connects and transfers images without renderer fetch or CORS headers', async t => {
  const calls = [];
  const pixels = Buffer.from([137, 80, 78, 71, 0, 255, 4]);
  let upload;
  let submitted;
  const base = await serverFixture(t, async (req, res) => {
    calls.push(req.url);
    assert.equal(req.headers.origin, undefined);
    assert.notEqual(req.headers['sec-fetch-site'], 'cross-site');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/system_stats') return res.end(JSON.stringify({ system: { comfyui_version: 'fixture' }, devices: [] }));
    if (req.url === '/queue') return res.end('{"queue_running":[],"queue_pending":[]}');
    if (req.url === '/upload/image') {
      upload = await new Request(base + req.url, { method: req.method, headers: req.headers, body }).formData();
      return res.end('{"name":"source.png","type":"input","subfolder":""}');
    }
    if (req.url === '/prompt') { submitted = JSON.parse(body); return res.end('{"prompt_id":"fixture-job"}'); }
    if (req.url.startsWith('/view?')) { res.setHeader('Content-Type', 'image/png'); return res.end(pixels); }
    res.writeHead(404).end();
  });
  const browserFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Browser CORS blocked this request'); };
  t.after(() => { globalThis.fetch = browserFetch; });
  const comfy = createComfy({ base });
  const status = await comfy.status();
  assert.equal(status.connected, true, status.error);
  assert.equal(status.version, 'fixture');
  assert.equal(calls.filter(url => url === '/system_stats').length, 1);
  await comfy.uploadImage({ bytes: pixels, filename: 'source.png', type: 'image/png' });
  assert.equal(upload.get('type'), 'input');
  assert.deepEqual(Buffer.from(await upload.get('image').arrayBuffer()), pixels);
  await comfy.submitPrompt({ '1': { class_type: 'SaveImage', inputs: {} } });
  assert.equal(submitted.prompt['1'].class_type, 'SaveImage');
  const image = await comfy.fetchImage({ filename: 'out.png', type: 'output' });
  assert.equal(image.dataUrl, `data:image/png;base64,${pixels.toString('base64')}`);
});

test('diagnostics keep HTTP failures and reject a non-Comfy service', async t => {
  let mode = 'forbidden';
  const base = await serverFixture(t, (_req, res) => {
    if (mode === 'forbidden') return res.writeHead(403).end('denied');
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true}');
  });
  const comfy = createComfy({ base });
  let result = await comfy.status();
  assert.equal(result.connected, false);
  assert.match(result.error, /403/);
  assert.equal(result.errorCode, 'COMFY_HTTP_ERROR');
  mode = 'other-service';
  result = await comfy.status();
  assert.equal(result.connected, false);
  assert.equal(result.errorCode, 'COMFY_INVALID_RESPONSE');
});

test('an aborted ComfyUI request releases the pending connection', async t => {
  let received;
  const started = new Promise(resolve => { received = resolve; });
  const base = await serverFixture(t, () => received());
  const controller = new AbortController();
  const comfy = createComfy({ base });
  const pending = comfy.objectInfo(true, controller.signal);
  const rejected = assert.rejects(pending, /cancel fixture/);
  await started;
  controller.abort(new Error('cancel fixture'));
  await rejected;
});

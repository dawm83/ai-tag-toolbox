'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCallMonitor } = require('../src/modules/call-monitor');
const { createAssistant } = require('../src/modules/assistant');
const { createAiClient } = require('../src/modules/ai-client');
const { createAgentRuntime } = require('../src/modules/agent-runtime');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const promptSource = { composePrimary: () => 'PRIMARY SYSTEM', composeGenerate: () => 'GENERATOR SYSTEM', get: () => 'FIXED PROMPT' };

test('call summary drops full payloads before disk write without changing provider input', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-call-monitor-'));
  try {
    const filePath = path.join(dir, 'calls.json');
    const monitor = createCallMonitor({ filePath, getSecrets: () => ['test-private-key'] });
    const input = { messages: [{ content: 'keep blue hair; test-private-key; data:image/png;base64,AQ==' }, { content: JSON.stringify({ apiKey: 'nested-private-key', path: 'C:\\private\\photo.png', tag: 'blue hair' }) }], image: new Uint8Array([1, 2]), prompt_tokens: 42, apiKey: 'private-key' };
    monitor.begin({ requestId: 'root', rootRequestId: 'root', parentRequestId: 'parent', sessionId: 'session', messageId: 'message', jobId: 'job', kind: 'primary', input });
    monitor.event('root', { type: 'round.start', body: 'large event payload' });
    monitor.finish('root', { status: 'completed', usage: { total_tokens: 42 }, usageScope: 'root-total-at-completion', output: { text: 'returned test-private-key', absolute: '/Users/private/photo.png' } });
    await monitor.flush();
    const saved = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(saved, /test-private-key|nested-private-key|private-key|data:image|base64|AQ==|photo\.png/);
    assert.doesNotMatch(saved, /blue hair|large event payload/);
    const row = monitor.list()[0];
    assert.deepEqual(Object.keys(row).sort(), ['requestId', 'rootRequestId', 'parentRequestId', 'sessionId', 'messageId', 'jobId', 'kind', 'tool', 'model', 'status', 'startedAt', 'endedAt', 'durationMs', 'apiCalls', 'usage', 'usageScope', 'httpStatus', 'error'].sort());
    assert.equal(row.usage.total_tokens, 42);
    assert.equal(row.rootRequestId, 'root');
    assert.equal(row.parentRequestId, 'parent');
    assert.equal(row.sessionId, 'session');
    assert.equal(row.messageId, 'message');
    assert.equal(row.jobId, 'job');
    assert.equal(row.durationMs, row.endedAt - row.startedAt);
    assert.equal(input.apiKey, 'private-key');
    assert.match(input.messages[0].content, /test-private-key/);
    const restored = createCallMonitor({ filePath });
    assert.deepEqual(restored.list(), monitor.list());
    restored.clear(); await restored.flush();
    assert.deepEqual(createCallMonitor({ filePath }).list(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real assistant connects primary rounds and fixed-subagent output under one root request', async () => {
  let round = 0;
  const requests = [];
  const app = createAssistant({ promptSource,
    primaryApi: { base: 'https://example.test/v1', model: 'test-model', key: 'test-secret-key' },
    primaryGateway: { complete: async messages => {
      requests.push(structuredClone(messages));
      if (messages[0]?.content === 'FIXED PROMPT') return { text: 'blue hair', usage: { total_tokens: 6 } };
      return ++round === 1
        ? { toolCalls: [{ id: 'translation-call', name: 'translation_translate', arguments: { text: '蓝发', direction: 'zh-en', source: 'ai' } }], usage: { total_tokens: 3 } }
        : { text: '完成', usage: { total_tokens: 4 } };
    } }
  });
  const result = await app.run({ text: '翻译蓝发', requestId: 'trace-root' });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const rows = app.listCallRecords();
  const primary = rows.find(row => row.kind === 'primary');
  assert.equal(primary.apiCalls, 2);
  assert.equal(primary.model, 'test-model');
  assert.equal(requests[0].at(-1).content, '翻译蓝发');
  assert(requests.at(-1).some(row => row.role === 'tool'));
  const child = rows.find(row => row.kind === 'subagent:translation');
  const tool = rows.find(row => row.kind === 'tool:translation.translate');
  assert.equal(child.parentRequestId, tool.requestId);
  assert.equal(child.rootRequestId, primary.requestId);
  assert.equal(child.apiCalls, 1);
  assert.equal(tool.tool, 'translation.translate');
  assert.equal(requests[1][0].content, 'FIXED PROMPT');
  assert.equal(JSON.parse(result.data.transcript.find(row => row.role === 'tool').content).text, 'blue hair');
  assert.equal(primary.usage.total_tokens, result.usage.total_tokens);
  assert.equal(primary.usageScope, 'root-total-at-completion');
  assert.equal(result.usage.total_tokens, 13);
  assert.deepEqual(result.usage.byKind, { primary: 7, translation: 6 });
  assert.doesNotMatch(JSON.stringify(rows), /test-secret-key|FIXED PROMPT|blue hair/);
  app.destroy();
});

test('malformed Tag replies retain parser failure and token usage in the summary', async () => {
  const app = createAssistant({ promptSource, primaryApi: { model: 'test' }, visionGateway: { complete: async () => ({ text: 'not JSON at all', usage: { total_tokens: 9 } }) } });
  const result = await app.runtime.runSubAgent('generateTags', { input: { requirements: 'girl' } });
  assert.equal(result.error.code, 'OUTPUT_INVALID');
  assert.equal(result.usage.total_tokens, 9);
  assert.deepEqual(result.usage.byKind, { generateTags: 9 });
  const row = app.listCallRecords()[0];
  assert.equal(row.status, 'error');
  assert.equal(row.apiCalls, 1);
  assert.equal(row.error.code, 'OUTPUT_INVALID');
  assert.equal(row.usage.total_tokens, 9);
  assert.equal(row.exchanges, undefined);
  app.destroy();
});

test('running calls time out without late replies overwriting the monitor', async () => {
  let reply;
  const monitor = createCallMonitor();
  const client = createAiClient({ model: 'test' }, { complete: () => new Promise(resolve => { reply = resolve; }) }, monitor);
  const runtime = createAgentRuntime({ monitor, primaryClient: client });
  const promise = runtime.runPrimary({ requestId: 'timeout', input: { text: 'hello' }, timeoutMs: 30 });
  await wait(2);
  assert.equal(monitor.list()[0].status, 'running');
  assert.equal(monitor.list()[0].apiCalls, 1);
  const result = await promise;
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(monitor.list()[0].status, 'timeout');
  const snapshot = JSON.stringify(monitor.list());
  reply({ text: 'late' }); await wait(2);
  assert.equal(JSON.stringify(monitor.list()), snapshot);
  monitor.clear();
  assert.deepEqual(monitor.list(), []);
});

test('record count and byte limits are enforced without copying large payloads', () => {
  const monitor = createCallMonitor({ maxRecords: 2, maxBytes: 16000, maxRecordBytes: 6000 });
  for (let n = 0; n < 5; n++) {
    monitor.begin({ requestId: String(n), kind: 'tool:test', input: { long: 'a'.repeat(20000) } });
    monitor.finish(String(n), { status: 'completed', output: {} });
  }
  const rows = monitor.list();
  assert.equal(rows.length, 2);
  assert(rows.every(row => row.input === undefined && row.output === undefined));
  assert(Buffer.byteLength(JSON.stringify(rows)) < 16000);
  rows[0].status = 'tampered';
  assert.equal(monitor.list()[0].status, 'completed');
});

test('oversized diagnostics preserve the terminal error before bulky output', () => {
  const monitor = createCallMonitor({ maxRecordBytes: 4096, maxBytes: 8192 });
  monitor.begin({ requestId: 'terminal-error', kind: 'subagent:evaluateImages', input: { prompt: 'x'.repeat(12000) } });
  monitor.finish('terminal-error', {
    status: 'error',
    output: { raw: 'y'.repeat(20000) },
    error: { code: 'OUTPUT_INVALID', message: '最终评估 JSON 连续两次无效' },
    usage: { total_tokens: 123 }
  });
  const row = monitor.list()[0];
  assert.equal(row.status, 'error');
  assert.equal(row.error.code, 'OUTPUT_INVALID');
  assert.match(row.error.message, /连续两次无效/);
  assert.equal(row.usage.total_tokens, 123);
  assert.equal(row.input, undefined);
  assert.equal(row.output, undefined);
});

test('HTTP call summary preserves usage and status while streaming output reaches the caller', async () => {
  const http = require('node:http');
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ body: JSON.parse(body), authorization: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'blue ' } }] }) + '\n\n' +
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hair' }, finish_reason: 'stop' }], usage: { total_tokens: 8 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const monitor = createCallMonitor();
    const client = createAiClient({ base: `http://127.0.0.1:${server.address().port}`, model: 'local-fixture', key: 'fixture-key' }, null, monitor);
    const runtime = createAgentRuntime({ primaryClient: client, monitor });
    const result = await runtime.runPrimary({ requestId: 'stream', input: { text: 'hair color' } });
    assert.equal(result.data.text, 'blue hair');
    const row = monitor.list()[0];
    assert.equal(received[0].body.messages.at(-1).content, 'hair color');
    assert.equal(received[0].body.model, 'local-fixture');
    assert.equal(received[0].authorization, 'Bearer fixture-key');
    assert.equal(row.apiCalls, 1);
    assert.equal(row.model, 'local-fixture');
    assert.equal(row.usage.total_tokens, 8);
    assert.equal(row.httpStatus, 200);
    assert.equal(row.status, 'completed');
    assert.doesNotMatch(JSON.stringify(row), /Bearer|fixture-key|hair color|blue hair/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('AI translation and image-description summaries identify their calls without copying image pixels', async () => {
  const { createVisionService } = require('../src/modules/vision-service');
  const { createFixedSubagents } = require('../src/modules/fixed-subagents');
  const monitor = createCallMonitor();
  const requests = [];
  const client = createAiClient({ model: 'test-vision' }, { complete: async messages => { requests.push(structuredClone(messages)); return { text: 'blue hair' }; } }, monitor);
  const vision = createVisionService({ images: { get: () => ({ id: 'img', dataUrl: 'data:image/png;base64,AQ==' }) }, visionAI: client, getPrompt: () => 'VISION SYSTEM' });
  const subagents = createFixedSubagents({ ai: client, visionAI: client, vision, prompts: { get: () => 'TRANSLATION SYSTEM' } });
  const runtime = createAgentRuntime({ monitor, subagents });
  const translated = await runtime.runSubAgent('translation', { input: { text: '蓝发', source: 'ai' } });
  assert.equal(translated.ok, true);
  const described = await runtime.runSubAgent('vision', { input: { imageId: 'img', mode: 'ai' } });
  assert.equal(described.ok, true, JSON.stringify(described.error));
  const [translation, image] = monitor.list();
  assert.equal(translation.apiCalls, 1);
  assert.equal(image.apiCalls, 1);
  assert.equal(translation.model, 'test-vision');
  assert.equal(image.kind, 'subagent:vision');
  assert.equal(requests[0][0].content, 'TRANSLATION SYSTEM');
  assert.equal(requests[1][0].content, 'VISION SYSTEM');
  assert.equal(requests[1][1].content[1].image_url.url, 'data:image/png;base64,AQ==');
  assert.doesNotMatch(JSON.stringify(monitor.list()), /AQ==|base64/);
});

test('aggregates multiple API exchanges as direct usage and does not accept unknown usage payloads', () => {
  const monitor = createCallMonitor();
  const requestId = monitor.begin({ requestId: 'multi', kind: 'primary' });
  monitor.run(requestId, () => {
    const first = monitor.beginExchange({ body: { model: 'test-model' } });
    monitor.endExchange(first, { ok: true, usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }, httpStatus: 200 });
    const second = monitor.beginExchange({ body: { model: 'test-model' } });
    monitor.endExchange(second, { ok: true, usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }, httpStatus: 200 });
  });
  monitor.finish(requestId, { status: 'completed', usage: { unknownToken: 'do not persist' } });
  const row = monitor.list()[0];
  assert.equal(row.apiCalls, 2);
  assert.deepEqual(row.usage, { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 });
  assert.equal(row.usageScope, 'direct-api');
  assert.equal(row.httpStatus, 200);
});

test('event updates never schedule a diagnostic file write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-call-summary-events-'));
  try {
    const filePath = path.join(dir, 'summary.json');
    const monitor = createCallMonitor({ filePath });
    const requestId = monitor.begin({ requestId: 'event-only', kind: 'primary' });
    monitor.event(requestId, { type: 'round.start', prompt: 'large details' });
    await wait(300);
    assert.equal(fs.existsSync(filePath), false);
    monitor.finish(requestId, { status: 'completed' });
    await monitor.flush();
    assert.equal(fs.existsSync(filePath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

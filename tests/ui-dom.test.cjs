'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, 'src', name), 'utf8');

function boot(options = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'src/index.html'), 'utf8'), {
    url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only'
  });
  const { window } = dom;
  const downloadBlobs = [];
  window.URL.createObjectURL = blob => { downloadBlobs.push(blob); return 'blob:ui-test'; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function click() {};
  window.navigator.clipboard = { writeText: async () => {} };
  window.prompt = () => '新名称';
  window.confirm = () => true;

  const session = { id: 's1', title: '测试会话', messages: options.initialMessages ? structuredClone(options.initialMessages) : [] };
  const images = new Map([['img-1', { id: 'img-1', dataUrl: 'data:image/png;base64,AA==' }], ['img-2', { id: 'img-2', dataUrl: 'data:image/png;base64,AQ==' }]]);
  const gallery = [{ imageId: 'img-1', filename: 'one.png', dataUrl: 'data:image/png;base64,AA==' }];
  let runCount = 0;
  let conversationItems = options.conversationItems ? options.conversationItems.slice() : [];
  const repository = {
    listGallery: () => ({ items: gallery.slice() }),
    get: id => images.get(id),
    getOriginalBytes: async () => new Uint8Array([1, 2]),
    referenceCount: () => ({ total: 0, conversations: 0, messages: 0 }),
    removeFromGallery: id => { const index = gallery.findIndex(item => item.imageId === id); if (index >= 0) gallery.splice(index, 1); },
    renameGalleryImage: (id, name) => { const item = gallery.find(row => row.imageId === id); if (item) item.displayName = name; },
    attachToConversation: () => ({ refId: 'r1' }),
    listConversation: () => ({ items: conversationItems.slice() }),
    clearConversationImages: sessionId => { options.clearConversationImages?.(sessionId); conversationItems = []; return { removed: 1, deletedImages: 1 }; }
  };
  let settings = { base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key: '', comfyBase: 'http://127.0.0.1:8188', comfyOn: true, comfyW: 768, comfyH: 1024, comfySteps: 25, comfyCfg: 7, batchCount: 1, maxComfyCalls: 3, generationAutoRun: true, imagesPerRound: 1, maxAutoRounds: 3 };
  let cancelCount = 0;
  const continuationCalls = [];
  const assistant = {
    sessions: () => [session], currentSession: () => session, newSession: () => session,
    getSettings: () => settings,
    setSettings: patch => { settings = { ...settings, ...patch }; if (patch.batchCount !== undefined) settings.imagesPerRound = patch.batchCount; if (patch.imagesPerRound !== undefined) settings.batchCount = patch.imagesPerRound; if (patch.maxComfyCalls !== undefined) settings.maxAutoRounds = patch.maxComfyCalls; if (patch.maxAutoRounds !== undefined) settings.maxComfyCalls = patch.maxAutoRounds; return settings; }, listModels: async () => ({ ok: true, models: ['gpt-4o-mini'] }), listVisionModels: async () => ({ ok: true, models: ['gpt-4o-mini'] }),
    getCapabilities: () => ({ comfy: options.comfyCapabilities || { enabled: true, connected: true, workflowReady: true, render: true }, vision: { local: false, ai: false } }),
    refreshCapabilities: async () => assistant.getCapabilities(),
    calls: { refreshCapabilities: async () => ({ comfy: { enabled: false, connected: false }, vision: { local: false, ai: false } }) },
    run: async input => {
      runCount += 1;
      session.messages.push({ id: `m${runCount}`, role: 'user', text: input.text, imageIds: input.imageIds || [], status: 'done' });
      const result = options.runResult || { ok: true, text: '完成', requestId: input.requestId };
      if (options.runResult) session.messages.push({ id: `a${runCount}`, role: 'assistant', text: result.text, status: 'error' });
      return result;
    },
    cancel: () => { cancelCount += 1; return true; },
    chooseCandidate: (messageId, candidateId, source = 'user') => {
      const message = session.messages.find(item => item.id === messageId);
      if (!message?.result?.candidates?.some(candidate => candidate.id === candidateId)) return null;
      message.result.candidates = message.result.candidates.map(candidate => ({ ...candidate, selected: candidate.id === candidateId, selectionSource: candidate.id === candidateId ? source : '' }));
      const candidate = message.result.candidates.find(item => item.id === candidateId);
      Object.assign(message.result, { selectedCandidateId: candidateId, selectedImageId: candidate.imageId, finalCandidateId: candidateId, finalImageId: candidate.imageId, finalPrompt: candidate.prompt, finalNegative: candidate.negative || '' });
      return structuredClone(message.result);
    },
    selectGenerationFinal: async (messageId, candidateId) => assistant.chooseCandidate(messageId, candidateId, 'user'),
    continueGeneration: async (messageId, candidateId, feedback) => { continuationCalls.push({ messageId, candidateId, feedback }); return { ok: true }; },
    selectGenerationCharacter: options.selectGenerationCharacter,
    clearConversationImages: sessionId => repository.clearConversationImages?.(sessionId),
    deleteSession: (sessionId, value) => { options.deleteSession?.(sessionId, value); return true; },
    imageRepository: repository
  };
  const callRecords = options.callRecords ? options.callRecords.slice() : [];
  assistant.listCallRecords = () => callRecords.slice();
  assistant.clearCallRecords = () => { callRecords.length = 0; };
  const promptKeys = ['primary', 'generateTags', 'artistQuality', 'vision', 'candidateEvaluation', 'translation'];
  const promptSet = { id: 'prompt-set-default', name: '默认提示词', items: { primary: 'prompt text', generateTags: 'prompt text', artistQuality: 'prompt text', vision: 'prompt text', candidateEvaluation: 'evaluation prompt', translation: 'prompt text' } };
  const extension = { id: 'ext-1', name: '扩展 1', text: 'ext text', enabled: true, activation: { mode: 'always', keywords: [] } };
  const prompts = {
    get: () => 'prompt text', getEffective: () => 'prompt text', set: () => 'prompt text', getDefault: () => 'default',
    item: key => ({ key, text: 'prompt text', defaultText: 'default', enabled: true, builtin: true }),
    items: () => promptKeys.map(key => ({ key, text: 'prompt text', defaultText: 'default', enabled: true, builtin: true })),
    keys: () => promptKeys.slice(),
    reset: () => ({}), resetItem: () => ({}),
    sets: () => [promptSet], activeSetId: () => promptSet.id, activeSet: () => promptSet,
    createSet: () => ({ id: 'prompt-set-2', name: '提示词组 2', items: {} }), deleteSet: () => true, renameSet: () => ({ name: '提示词组 2' }), setActive: () => true, resetSet: () => ({}),
    extensions: () => [extension], createExtension: () => ({ id: 'ext-2', name: '扩展 2', text: '', enabled: true, activation: { mode: 'always', keywords: [] } }),
    updateExtension: () => ({}), deleteExtension: () => true, matchExtensions: () => [],
    composePrimary: () => 'composed primary', composeGenerate: () => 'composed generate', composeEvaluation: () => 'evaluation prompt',
    snapshot: () => ({ version: 3, sets: [promptSet], activeSetId: promptSet.id, activeSet: promptSet, items: {}, extensions: [extension], defaults: {}, metadata: {} }),
    exportBundle: () => ({ format: 'ai-tag-prompts', version: 3, sets: [promptSet], extensions: [extension] }),
    importBundle: () => ({ sets: [promptSet], extensions: [extension] }),
    exportExtensions: () => ({ format: 'ai-tag-prompt-extensions', version: 1, extensions: [extension] }), importExtensions: () => ({ ok: true, count: 1 })
  };
  const tags = options.tags || {
    stateSnapshot: () => ({ categories: [], categoryCounts: {}, selected: [], category: 'all', revision: 0 }), selected: () => [], page: () => ({ items: [], total: 0 }),
    restore: () => {}, setSearchPrecision: () => {}, setAdult: () => {}, setQuery: () => {}, size: () => 0, customTags: () => [], subcategories: () => [], getCategories: () => []
  };
  let comfyProfile = options.comfyProfile ? structuredClone(options.comfyProfile) : null;
  const comfy = { setBase: () => {}, setWorkflow: () => {}, check: async () => false };
  if (comfyProfile) comfy.profiles = {
    active: () => structuredClone(comfyProfile), list: () => [structuredClone(comfyProfile)],
    save: value => { comfyProfile = structuredClone(value); return structuredClone(comfyProfile); },
    setActive: () => structuredClone(comfyProfile), remove: () => false
  };
  const modules = { catalog: options.catalog, formatTagOutput: options.formatTagOutput, assistant, favorites: options.favorites, joinFavoriteBlocks: options.joinFavoriteBlocks, characters: options.characters, runtime: { ...options.runtime }, prompts, tags, images: { get: id => images.get(id), preview: id => images.get(id) }, imageRepository: repository, preferences: options.preferences || { get: (_k, fallback) => fallback, set: () => {} }, translation: options.translation || { findReferences: () => [] }, comfy, locales: options.locales || { 'zh-CN': {} }, version: '1.4.34' };

  for (const file of ['views/tag-location-view.js', 'views/tag-editor-view.js', 'views/settings-view.js', 'views/comfy-view.js', 'views/prompt-view.js', 'views/agent-status-view.js', 'views/call-monitor-view.js', 'modules/translation-alignment.js', 'views/translation-view.js', 'views/favorites-view.js', 'app-view.js']) window.eval(source(file));
  if (options.favoritesView) window.AppViews.favorites = { createFavoritesView: () => options.favoritesView };
  const view = window.AppView.create(modules, window.document);
  options.beforeStart?.(window);
  view.start();
  return { dom, window, view, assistant, repository, gallery, downloadBlobs, continuationCalls, getRunCount: () => runCount, getCancelCount: () => cancelCount, getComfyProfile: () => comfyProfile && structuredClone(comfyProfile) };
}

test('startup inserts the initial Tag cards once instead of rebuilding them for locale setup', t => {
  let observer;
  const app = boot({ tags: {
    stateSnapshot: () => ({ categories: [], categoryCounts: { all: 1 }, selected: [], category: 'all', revision: 0 }),
    selected: () => [], getCategories: () => [], subcategories: () => [], size: () => 1,
    page: () => ({ items: [{ id: 'blue_hair', en: 'blue hair', zh: '蓝发', category: 'hair' }], total: 1 })
  }, beforeStart: window => { observer = new window.MutationObserver(() => {}); observer.observe(window.document.querySelector('#chips'), { childList: true }); } });
  t.after(() => { observer.disconnect(); app.dom.window.close(); });
  const inserted = observer.takeRecords().flatMap(row => [...row.addedNodes]).reduce((sum, row) => sum + (row.querySelectorAll?.('.chip').length || 0), 0);
  assert.equal(inserted, 1);
  assert.equal(app.window.document.querySelector('#chips .zh').textContent, '蓝发');
});

test('the first render applies the saved language and later language changes still refresh cards', t => {
  const app = boot({
    preferences: { get: (key, fallback) => key === 'app.locale' ? 'en-US' : fallback, set: () => {} },
    locales: { 'en-US': require('../locales/en-US.json'), 'zh-CN': require('../locales/zh-CN.json') },
    tags: { stateSnapshot: () => ({ categories: [], categoryCounts: {}, selected: [], category: 'all', revision: 0 }), selected: () => [], getCategories: () => [], subcategories: () => [], size: () => 1, page: () => ({ items: [{ id: 'blue_hair', en: 'blue hair', zh: '蓝发' }], total: 1 }) }
  });
  t.after(() => app.dom.window.close());
  assert.equal(app.window.document.documentElement.lang, 'en-US');
  assert.equal(app.window.document.querySelector('#chips .cp').textContent, 'Copy only');
  app.window.document.querySelector('#localeBtn').click();
  app.window.document.querySelector('[data-locale="zh-CN"]').click();
  assert.equal(app.window.document.querySelector('#chips .cp').textContent, '仅复制');
});

test('full DOM startup renders extracted views and conversation click uses assistant runtime', async () => {
  const app = boot();
  assert.ok(app.window.document.querySelector('#talkConv'));
  assert.ok(app.window.document.querySelector('#mainPromptSetCard'));
  assert.ok(app.window.document.querySelector('#extensionPromptsCard'));
  assert.equal(app.window.document.querySelectorAll('#extList .ext-row').length, 1);
  assert.equal(app.window.document.querySelector('#promptSetSel')?.options?.length, 1);
  assert.ok(app.window.document.querySelector('#psCandidateEvaluation'));
  assert.equal(app.window.document.querySelector('#psCandidateEvaluation').value, 'prompt text');
  app.window.document.querySelector('#talkIn').value = '生成一张图';
  app.window.document.querySelector('#talkSendBtn').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(app.getRunCount(), 1);
  assert.match(app.window.document.querySelector('#talkConv').textContent, /生成一张图/);
  app.dom.window.close();
});

test('AI translation button re-enables after empty input and stays usable when translation page reopens', t => {
  const app = boot();
  t.after(() => app.dom.window.close());
  const doc = app.window.document;
  const input = doc.querySelector('#translateInput');
  const button = doc.querySelector('#translateAi');
  app.view.route('translation');
  input.value = ' ';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  assert.equal(button.disabled, true);
  input.value = 'blue hair';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  assert.equal(button.disabled, false, 'typing non-empty input must recover the button');
  doc.querySelector('#translateClear').click();
  assert.equal(button.disabled, true, 'empty input must disable AI translation');
  assert.match(doc.querySelector('#translateInputCount').textContent, /^0 /);
  input.value = 'blue hair';
  app.view.route('tags');
  app.view.route('translation');
  assert.equal(button.disabled, false, 'reopening translation must resync the button state');
});

test('AI translation renders optional alignment segments and highlights linked source units', async t => {
  const app = boot({ runtime: {
    runSubAgent: async () => ({ ok: true, data: { text: 'She has blue hair.', alignment: { sourceUnits: [{ id: 's1', text: '蓝发' }, { id: 's2', text: '她' }], targetSegments: [{ text: 'She ', sourceIds: ['s2'] }, { text: 'has ', sourceIds: [] }, { text: 'blue hair', sourceIds: ['s1'] }, { text: '.', sourceIds: [] }] } } })
  } });
  t.after(() => app.dom.window.close());
  const doc = app.window.document;
  app.view.route('translation');
  doc.querySelector('#translateInput').value = '蓝发，她';
  doc.querySelector('#translateInput').dispatchEvent(new app.window.Event('input', { bubbles: true }));
  doc.querySelector('#translateAi').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const aligned = doc.querySelector('#translateAlignedOutput');
  assert.equal(aligned.hidden, false);
  assert.equal(aligned.querySelectorAll('.translation-alignment-segment').length, 4);
  assert.equal(doc.querySelectorAll('.translation-alignment-token').length, 2);
  aligned.querySelector('[data-source-ids="s1"]').dispatchEvent(new app.window.MouseEvent('mouseenter', { bubbles: true }));
  assert.equal(doc.querySelector('.translation-alignment-token[data-source-id="s1"]').classList.contains('active'), true);
  assert.equal(aligned.querySelector('[data-source-ids="s1"]').classList.contains('active'), true);
  aligned.querySelector('[data-source-ids="s1"]').click();
  assert.equal(doc.querySelector('.translation-alignment-token[data-source-id="s1"]').classList.contains('pinned'), true);
});

test('AI translation falls back to plain output when alignment is missing', async t => {
  const app = boot({ runtime: { runSubAgent: async () => ({ ok: true, data: { text: 'blue hair' } }) } });
  t.after(() => app.dom.window.close());
  const doc = app.window.document;
  app.view.route('translation');
  doc.querySelector('#translateInput').value = '蓝发';
  doc.querySelector('#translateInput').dispatchEvent(new app.window.Event('input', { bubbles: true }));
  doc.querySelector('#translateAi').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(doc.querySelector('#translateAlignedOutput').hidden, true);
  assert.equal(doc.querySelector('#translateOutput').value, 'blue hair');
});

test('AI response with omitted commas reaches the page and highlights source and translated selections', async t => {
  const { createAgentRuntime } = require('../src/modules/agent-runtime');
  const { createFixedSubagents } = require('../src/modules/fixed-subagents');
  let calls = 0;
  const runtime = createAgentRuntime({ subagents: createFixedSubagents({ ai: { complete: async () => {
    calls++;
    return { text: JSON.stringify({ text: '蓝发，红眼，蓝发', targetSegments: [
      { text: '蓝发', sourceIds: ['s1'] }, { text: '红眼', sourceIds: ['s2'] }, { text: '蓝发', sourceIds: ['s3'] }
    ] }) };
  } } }) });
  const app = boot({ runtime: { runSubAgent: runtime.runSubAgent, cancel: runtime.cancel } });
  t.after(() => app.dom.window.close());
  const doc = app.window.document, input = doc.querySelector('#translateInput');
  app.view.route('translation');
  input.value = 'blue_hair, red_eyes, blue_hair';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  doc.querySelector('#translateAi').click();
  await new Promise(resolve => setImmediate(resolve));
  const mirror = doc.querySelector('#translateSourceMirror'), aligned = doc.querySelector('#translateAlignedOutput');
  assert.equal(aligned.hidden, false, 'valid word links survive missing comma segments');
  assert.equal(aligned.textContent, '蓝发，红眼，蓝发');
  input.focus(); input.setSelectionRange(21, input.value.length);
  input.dispatchEvent(new app.window.Event('select'));
  assert.deepEqual([...aligned.querySelectorAll('.active')].map(node => node.dataset.sourceIds), ['s3']);
  aligned.focus();
  const range = doc.createRange(); range.selectNodeContents(aligned.querySelector('[data-source-ids="s2"]'));
  app.window.getSelection().removeAllRanges(); app.window.getSelection().addRange(range);
  doc.dispatchEvent(new app.window.Event('selectionchange'));
  assert.deepEqual([...mirror.querySelectorAll('.active')].map(node => node.dataset.sourceId), ['s2']);
  let copied;
  app.window.navigator.clipboard.writeText = async value => { copied = value; };
  doc.querySelector('#translateCopy').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(copied, '蓝发，红眼，蓝发');
  assert.equal(calls, 1, 'separator recovery must not request another AI translation');
});

test('translation target hover keeps only the directly linked source units', async t => {
  const app = boot({ runtime: {
    runSubAgent: async () => ({ ok: true, data: { text: 'long blue hair', alignment: { sourceUnits: [{ id: 's1', text: 'blue' }, { id: 's2', text: 'long' }, { id: 's3', text: 'hair' }], targetSegments: [
      { text: 'long', sourceIds: ['s2'] }, { text: ' ', sourceIds: [] },
      { text: 'blue', sourceIds: ['s1'] }, { text: ' ', sourceIds: [] },
      { text: 'hair', sourceIds: ['s1', 's2', 's3'] }
    ] } } })
  } });
  t.after(() => app.dom.window.close());
  const doc = app.window.document;
  app.view.route('translation');
  doc.querySelector('#translateInput').value = 'blue, long, hair';
  doc.querySelector('#translateInput').dispatchEvent(new app.window.Event('input', { bubbles: true }));
  doc.querySelector('#translateAi').click();
  await new Promise(resolve => setImmediate(resolve));
  const blue = doc.querySelector('[data-source-ids="s1"]');
  blue.dispatchEvent(new app.window.MouseEvent('mouseenter', { bubbles: true }));
  assert.deepEqual([...doc.querySelectorAll('.translation-alignment-token.active')].map(node => node.dataset.sourceId), ['s1']);
  blue.dispatchEvent(new app.window.MouseEvent('mouseleave'));
  const input = doc.querySelector('#translateInput');
  input.focus(); input.setSelectionRange(0, 4);
  input.dispatchEvent(new app.window.Event('select'));
  assert.deepEqual([...doc.querySelectorAll('.translation-alignment-token.active')].map(node => node.dataset.sourceId), ['s1']);
  assert.deepEqual([...doc.querySelectorAll('.translation-alignment-segment.active')].map(node => node.textContent), ['blue', 'hair']);
});

test('direction changes refresh matched references after starting local translation', async t => {
  let referenceCalls = 0;
  const app = boot({
    translation: { findReferences: () => { referenceCalls += 1; return []; } },
    runtime: { runSubAgent: async () => ({ ok: true, data: { text: 'translation' } }) }
  });
  t.after(() => app.dom.window.close());
  const doc = app.window.document, input = doc.querySelector('#translateInput'), direction = doc.querySelector('#translateDirection');
  app.view.route('translation');
  input.value = 'blue_hair';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 130));
  const before = referenceCalls;
  direction.value = 'en-zh';
  direction.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(referenceCalls > before, true);
});

test('alignment follows source and target text selections, keeps whitespace and copies only plain translated text', async t => {
  const translated = '长发\n蓝发；蓝发。';
  const app = boot({ runtime: { runSubAgent: async (_name, request) => {
    assert.equal(request.input.includeAlignment, true);
    assert.equal(request.input.text, '  blue_hair, long_hair, blue_hair\n');
    return { ok: true, data: { text: translated, alignment: { targetSegments: [
      { text: '长发', sourceIds: ['s2'] }, { text: '\n', sourceIds: [] },
      { text: '蓝发', sourceIds: ['s1'] }, { text: '；', sourceIds: [] },
      { text: '蓝发', sourceIds: ['s3'] }, { text: '。', sourceIds: [] }
    ] } } };
  } } });
  t.after(() => app.dom.window.close());
  const doc = app.window.document, input = doc.querySelector('#translateInput');
  let copied;
  app.window.navigator.clipboard.writeText = async value => { copied = value; };
  app.view.route('translation');
  input.value = '  blue_hair, long_hair, blue_hair\n';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  doc.querySelector('#translateAi').click();
  await new Promise(resolve => setImmediate(resolve));
  const mirror = doc.querySelector('#translateSourceMirror'), aligned = doc.querySelector('#translateAlignedOutput');
  assert.equal(mirror.textContent.replace(/\u200b$/, ''), input.value);
  assert.equal(aligned.textContent, translated);
  input.focus(); input.setSelectionRange(2, 22);
  input.dispatchEvent(new app.window.Event('select'));
  assert.deepEqual([...aligned.querySelectorAll('.active')].map(node => node.textContent), ['长发', '蓝发']);
  const target = aligned.querySelector('[data-source-ids="s3"]');
  const range = doc.createRange(); range.selectNodeContents(target);
  app.window.getSelection().removeAllRanges(); app.window.getSelection().addRange(range);
  doc.dispatchEvent(new app.window.Event('selectionchange'));
  assert.deepEqual([...mirror.querySelectorAll('.active')].map(node => node.dataset.sourceId), ['s3']);
  doc.querySelector('#translateCopy').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(copied, translated);
  aligned.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.querySelectorAll('.translation-alignment-token.active').length, 0);
});

test('alignment never executes model markup and is retired on edits or direction changes', async t => {
  const app = boot({ runtime: { runSubAgent: async () => ({ ok: true, data: { text: '<img src=x onerror=alert(1)>', alignment: { targetSegments: [{ text: '<img src=x onerror=alert(1)>', sourceIds: ['s1'] }] } } }) } });
  t.after(() => app.dom.window.close());
  const doc = app.window.document, input = doc.querySelector('#translateInput');
  app.view.route('translation'); input.value = '蓝发';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true })); doc.querySelector('#translateAi').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.querySelector('#translateAlignedOutput img'), null);
  assert.equal(doc.querySelector('#translateAlignedOutput').textContent, '<img src=x onerror=alert(1)>');
  input.value = '红眼'; input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  assert.equal(doc.querySelector('#translateAlignedOutput').hidden, true);
  assert.equal(doc.querySelector('#translateSourceMirror').hidden, true);
  assert.equal(doc.querySelectorAll('.translation-alignment-token').length, 0);
  doc.querySelector('#translateAi').click(); await new Promise(resolve => setImmediate(resolve));
  doc.querySelector('#translateDirection').dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(doc.querySelector('#translateAlignedOutput').hidden, true);
});

function translationHarness(t) {
  const requests = [], cancellations = [];
  const app = boot({ runtime: {
    runSubAgent: (name, request) => new Promise((resolve, reject) => requests.push({ name, ...request, resolve, reject })),
    cancel: requestId => { cancellations.push(requestId); return true; }
  } });
  t.after(() => app.dom.window.close());
  const doc = app.window.document;
  const input = doc.querySelector('#translateInput');
  const button = doc.querySelector('#translateAi');
  const output = doc.querySelector('#translateOutput');
  app.view.route('translation');
  const type = value => { input.value = value; input.dispatchEvent(new app.window.Event('input', { bubbles: true })); };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { ...app, doc, input, button, output, type, requests, cancellations, settle };
}

test('AI translation blocks duplicate clicks while running and releases after API errors, exceptions and success', async t => {
  const app = translationHarness(t);
  app.type('blue hair');
  for (const outcome of ['error', 'exception', 'success']) {
    const before = app.requests.length;
    app.button.click(); app.button.click();
    assert.equal(app.requests.length, before + 1);
    const request = app.requests.at(-1);
    assert.equal(request.name, 'translation');
    assert.equal(request.input.source, 'ai');
    assert.equal(app.button.disabled, true);
    assert.equal(app.button.classList.contains('is-loading'), true);
    assert.equal(app.button.getAttribute('aria-busy'), 'true');
    assert.equal(app.button.querySelector('.translate-loading-spinner') !== null, true);
    assert.match(app.button.textContent, /翻译中/);
    if (outcome === 'exception') request.reject(new Error('断线'));
    else request.resolve(outcome === 'error' ? { ok: false, error: { code: 'TIMEOUT', message: '超时' } } : { ok: true, data: { text: '蓝发' } });
    await app.settle();
    assert.equal(app.button.disabled, false);
    assert.equal(app.button.classList.contains('is-loading'), false);
    assert.equal(app.button.getAttribute('aria-busy'), 'false');
    assert.equal(app.button.querySelector('.translate-loading-spinner'), null);
    assert.match(app.button.textContent, /AI 翻译/);
    assert.equal(app.output.value, outcome === 'success' ? '蓝发' : outcome === 'error' ? '超时' : '断线');
  }
});

test('leaving translation cancels pending work and reopening allows a fresh AI request', async t => {
  const app = translationHarness(t);
  app.type('blue hair'); app.button.click();
  const previous = app.requests[0];
  app.view.route('tags'); app.view.route('translation');
  assert.deepEqual(app.cancellations, [previous.requestId]);
  assert.equal(app.input.value, 'blue hair');
  assert.equal(app.button.disabled, false);
  app.button.click();
  const current = app.requests[1];
  previous.resolve({ ok: true, data: { text: '离开前的结果' } });
  await app.settle();
  assert.equal(app.button.disabled, true);
  assert.equal(app.output.value, '');
  current.resolve({ ok: true, data: { text: '蓝发' } });
  await app.settle();
  assert.equal(app.button.disabled, false);
  assert.equal(app.output.value, '蓝发');
});

test('editing or clearing translation retires the old AI request without letting its completion unlock or overwrite a new one', async t => {
  const app = translationHarness(t);
  app.type('blue hair'); app.button.click();
  const first = app.requests[0];
  app.type('red eyes');
  assert.equal(app.button.disabled, false);
  assert.deepEqual(app.cancellations, [first.requestId]);
  app.button.click();
  const second = app.requests[1];
  first.resolve({ ok: true, data: { text: '旧的蓝发结果' } });
  await app.settle();
  assert.equal(app.button.disabled, true, 'old completion cannot unlock the active AI request');
  assert.notEqual(app.output.value, '旧的蓝发结果');
  second.resolve({ ok: true, data: { text: '红眼' } });
  await app.settle();
  assert.equal(app.button.disabled, false);
  assert.equal(app.output.value, '红眼');
  app.button.click();
  const third = app.requests[2];
  app.doc.querySelector('#translateClear').click();
  third.resolve({ ok: true, data: { text: '清空前的结果' } });
  await app.settle();
  assert.equal(app.output.value, '');
  assert.equal(app.button.disabled, true);
  assert.equal(app.doc.querySelector('#translateThinking'), null);
});

test('changing translation direction cancels AI and local completion cannot replace a newer explicit AI translation', async t => {
  const app = translationHarness(t);
  app.type('blue hair'); app.button.click();
  const first = app.requests[0];
  const direction = app.doc.querySelector('#translateDirection');
  direction.value = 'en-zh';
  direction.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  const local = app.requests[1];
  assert.equal(local.input.source, 'local');
  assert.equal(local.input.direction, 'en-zh');
  assert.equal(app.cancellations[0], first.requestId);
  assert.equal(app.button.disabled, false, 'local translation must not block AI');
  app.button.click();
  const latest = app.requests[2];
  assert.equal(latest.input.direction, 'en-zh');
  latest.resolve({ ok: true, data: { text: '蓝发（AI）' } });
  await app.settle();
  local.resolve({ ok: true, data: { text: '旧本地结果' } });
  first.resolve({ ok: true, data: { text: '旧方向结果' } });
  await app.settle();
  assert.equal(app.output.value, '蓝发（AI）');
  assert.equal(app.button.disabled, false);
  assert.equal(app.doc.querySelector('#translateThinking'), null, 'translation must not show a thinking panel');
});

test('gallery card rename updates the repository', () => {
  const app = boot();
  app.view.route('gallery');
  const card = app.window.document.querySelector('.gallery-card');
  assert.ok(card);
  card.querySelector('[data-action="rename"]').click();
  assert.equal(app.gallery[0].displayName, '新名称');
  app.dom.window.close();
});

test('ComfyUI gets a dedicated AI tab and the conversation debug button opens it', () => {
  const app = boot();
  app.view.route('ai');
  app.view.showAi('comfy');
  assert.equal(app.window.document.querySelector('#tabComfy')?.style.display, '');
  assert.equal(app.window.document.querySelector('#tabApi')?.style.display, 'none');
  assert.equal(app.window.document.querySelector('#tabApi #comfyBase'), null);
  assert.equal(app.window.document.querySelector('#tabApi #comfyWf'), null);
  const workflow = app.window.document.querySelector('#comfyWf');
  workflow.value = '{"3":{"class_type":"KSampler"}}';
  workflow.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  app.window.document.querySelector('#comfySeed').value = '1234';
  app.window.document.querySelector('#comfySeed').dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(app.assistant.getSettings().comfySeed, 1234);
  app.view.showAi('api');
  app.window.document.querySelector('#aiClearCfg').click();
  assert.equal(app.assistant.getSettings().comfyWorkflow, '{"3":{"class_type":"KSampler"}}');
  app.view.showAi('comfy');
  assert.equal(app.window.document.querySelector('#comfyWf').value, '{"3":{"class_type":"KSampler"}}');
  app.window.document.querySelector('#talkComfyDebug').click();
  assert.equal(app.window.document.querySelector('#tabComfy')?.style.display, '');
  const batch = app.window.document.querySelector('#batchCount');
  const maxCalls = app.window.document.querySelector('#maxComfyCalls');
  batch.value = '7'; batch.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  maxCalls.value = '6'; maxCalls.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  app.view.showAi('talk');
  assert.equal(app.window.document.querySelector('#imagesPerRound').value, '7');
  assert.equal(app.window.document.querySelector('#maxAutoRounds').value, '6');
  app.window.document.querySelector('#imagesPerRound').value = '5';
  app.window.document.querySelector('#imagesPerRound').dispatchEvent(new app.window.Event('change', { bubbles: true }));
  app.window.document.querySelector('#maxAutoRounds').value = '4';
  app.window.document.querySelector('#maxAutoRounds').dispatchEvent(new app.window.Event('change', { bubbles: true }));
  app.view.showAi('comfy');
  assert.equal(app.window.document.querySelector('#batchCount').value, '5');
  assert.equal(app.window.document.querySelector('#maxComfyCalls').value, '4');
  app.dom.window.close();
});

test('API edits and test requests preserve zero temperatures', async t => {
  const app = boot(); t.after(() => app.dom.window.close());
  const doc = app.window.document;
  app.assistant.setSettings({ temperature: 0, visionTemperature: 0 });
  doc.querySelector('#aiStrict').dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(app.assistant.getSettings().temperature, 0);
  assert.equal(app.assistant.getSettings().visionTemperature, 0);
  const configs = [];
  app.assistant.testConnection = async config => { configs.push(config); return { ok: true }; };
  doc.querySelector('#aiTest').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(configs.length);
  assert.ok(configs.every(config => config.temperature === 0));
});

test('favorites route preserves draft on rejected leave and includes favorite snapshots in the bottom bar', async t => {
  let allowed = false;
  let snapshots = [{ entryId: 'f1', kind: 'bundle', title: 'light', rawText: ' soft lighting, (blue hair:1.2) ' }];
  const favorites = { selected: () => snapshots, setSelected: () => { snapshots = []; }, clearSelected: () => { snapshots = []; }, search: () => ({ items: [] }), subscribe: () => () => {} };
  const app = boot({ favorites, favoritesView: { bind() {}, enter() {}, render() {}, leave: async () => allowed } });
  t.after(() => app.dom.window.close());
  const doc = app.window.document;
  doc.querySelector('#favBtn').click();
  assert.equal(doc.querySelector('#favoritesView').hidden, false);
  assert.ok(doc.querySelector('[data-remove-favorite="f1"]'));
  await app.view.route('tags');
  assert.equal(doc.querySelector('#favoritesView').hidden, false);
  allowed = true;
  await app.view.route('tags');
  assert.equal(doc.querySelector('#favoritesView').hidden, true);
  doc.querySelector('[data-remove-favorite="f1"]').click();
  assert.equal(snapshots.length, 0);
});

test('real canonical favorites keeps exact bundle content and live selection while preserving Comfy settings', async t => {
  const { createHarness } = require('./fixtures/tag-library.cjs');
  const { createFavorites, createTags } = require('../src/modules');
  const { formatTagOutput } = require('../src/modules/tag-library');
  const h = createHarness(); await h.ready;
  const favorites = createFavorites({ library: h.library }), tags = createTags({ library: h.library });
  const catalog = { ...h.library, execute: (command, options) => h.library.execute(structuredClone(command), structuredClone(options)) };
  const app = boot({ catalog, favorites, tags, formatTagOutput });
  t.after(() => { app.view.dispose(); favorites.dispose(); tags.dispose(); app.dom.window.close(); });
  const doc = app.window.document, settle = () => new Promise(resolve => setImmediate(resolve)), copied = [];
  app.window.navigator.clipboard.writeText = async value => copied.push(value);
  await app.view.route('favorites');
  const original = ' soft lighting, (blue_hair:1.2),\\\\(detail\\\\) \\n';
  await app.view.views.favorites.openCreate({ kind: 'bundle', rawText: original, seriesId: 'home', sectionId: 'daily' });
  doc.querySelector('[data-tag-save]').click(); await settle();
  const entry = favorites.list().items[0]; assert.equal(entry.rawText, original);
  doc.querySelector(`[data-favorite-select="${entry.id}"]`).click(); await settle();
  assert.equal(doc.querySelector('#preview').textContent, original); assert.equal(copied.at(-1), original);
  await favorites.saveEntry({ id: entry.id, rawText: 'new value' });
  assert.equal(doc.querySelector('#preview').textContent, 'new value');
  doc.querySelector('#copyAll').click(); await settle(); assert.equal(copied.at(-1), 'new value');
  assert.equal(app.assistant.getSettings().comfyW, 768);
  doc.querySelector('[data-selection-key]').click(); await settle(); assert.equal(h.library.selected().length, 0);
  assert.equal(favorites.list().total, 1); assert.equal(await favorites.flush(), true);
});

test('global favorite results and English favorites labels use the real page and store', async t => {
  const { createUnifiedFixture, addFavoriteLocation } = require('./fixtures/unified-modules.cjs');
  const { favorites } = await createUnifiedFixture();
  const { seriesId, sectionId } = await addFavoriteLocation(favorites, 'Lighting', 'Main');
  await favorites.saveEntry({ seriesId, sectionId, kind: 'bundle', title: 'Light group', rawText: 'soft lighting' });
  await favorites.saveEntry({ seriesId, sectionId, rawText: 'private lighting', globalSearchable: false });
  const tags = { stateSnapshot: () => ({ categories: [], categoryCounts: {}, selected: [], query: 'lighting', adult: false }), selected: () => [], page: () => ({ items: [], total: 0 }), restore() {}, subcategories: () => [] };
  const locales = { 'en-US': require('../locales/en-US.json') };
  const app = boot({ favorites, tags, locales });
  t.after(() => { app.view.views.favorites.destroy(); app.dom.window.close(); });
  assert.equal(app.window.document.querySelectorAll('#favoriteSearchResults .favorite-global-item').length, 1);
  const doc = app.window.document;
  const result = doc.querySelector('#favoriteSearchResults .chip');
  result.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  doc.querySelector('[data-remove-favorite]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.querySelector('#favoriteSearchResults .chip').getAttribute('aria-pressed'), 'false');
  doc.querySelector('#favoriteSearchResults .chip').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(favorites.selected().length, 1);
  doc.querySelector('#clearSel').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.querySelector('#favoriteSearchResults .chip').getAttribute('aria-pressed'), 'false');
  app.window.document.querySelector('#localeBtn').click();
  app.window.document.querySelector('[data-locale="en-US"]').click();
  await app.view.route('favorites');
  assert.ok(app.window.document.querySelector('[data-favorite-section-tab]'));
});

test('gallery name copying and bulk actions share one selection state', async t => {
  const app = boot(); t.after(() => app.dom.window.close());
  const doc = app.window.document;
  app.view.route('gallery');
  doc.querySelector('.gallery-name').click();
  assert.equal(doc.querySelector('.gallery-card').classList.contains('is-selected'), false);
  assert.equal(doc.querySelector('#galleryDownload').disabled, true);
  doc.querySelector('.gallery-thumb').click();
  assert.equal(doc.querySelector('.gallery-card').classList.contains('is-selected'), true);
  doc.querySelector('#galleryDownload').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(app.downloadBlobs.length, 1);
  const attached = [];
  app.repository.attachToConversation = (sessionId, imageId) => { attached.push([sessionId, imageId]); return { refId: 'r1' }; };
  doc.querySelector('#gallerySend').click();
  assert.deepEqual(attached, [['s1', 'img-1']]);
  assert.equal(doc.querySelector('#gallerySend').disabled, true);
});

test('gallery cards support keyboard selection without losing focus', t => {
  const app = boot(); t.after(() => app.dom.window.close());
  const doc = app.window.document;
  app.view.route('gallery');
  const card = doc.querySelector('.gallery-card');
  assert.equal(card.tabIndex, 0);
  card.focus();
  card.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.equal(doc.querySelector('.gallery-card').getAttribute('aria-pressed'), 'true');
  assert.equal(doc.activeElement, doc.querySelector('.gallery-card'));
  doc.activeElement.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(doc.querySelector('.gallery-card').getAttribute('aria-pressed'), 'false');
  assert.equal(doc.querySelector('#galleryDownload').disabled, true);
});

for (const entry of ['#talkClearBtn', '#mgrClear']) test(`${entry} confirms message clearing and retains conversation images`, t => {
  const app = boot({
    initialMessages: [{ id: 'm1', role: 'user', text: 'keep until confirmed', imageIds: ['img-1'], status: 'done' }],
    conversationItems: [{ refId: 'r1', imageId: 'img-1', sessionId: 's1', slotNo: 1 }]
  });
  t.after(() => app.dom.window.close());
  const doc = app.window.document;
  let calls = 0;
  app.assistant.clearSession = id => {
    assert.equal(id, 's1'); calls += 1; app.assistant.currentSession().messages = [];
  };
  app.view.route('ai');
  if (entry === '#mgrClear') app.view.showAi('mgr');
  doc.querySelector(entry).click();
  assert.equal(calls, 0);
  assert.equal(doc.querySelector('#cfmModal').classList.contains('show'), true);
  assert.match(doc.querySelector('#cfmText').textContent, /1/);
  doc.querySelector('#cfmNo').click();
  assert.equal(app.assistant.currentSession().messages.length, 1);
  doc.querySelector(entry).click(); doc.querySelector('#cfmYes').click();
  assert.equal(calls, 1);
  assert.equal(app.assistant.currentSession().messages.length, 0);
  assert.equal(app.repository.listConversation('s1').items.length, 1);
  assert.equal(doc.querySelectorAll('#talkImageRepository .conversation-image-card').length, 1);
});

test('one AI connection click sends exactly one request', async t => {
  const app = boot(); t.after(() => app.dom.window.close());
  let calls = 0;
  app.assistant.testConnection = async () => { calls += 1; return { ok: true }; };
  app.window.document.querySelector('#aiTest').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1);
});

test('API address changes have one settings writer', async t => {
  const app = boot(); t.after(() => app.dom.window.close());
  await new Promise(resolve => setTimeout(resolve, 0));
  const patches = [];
  const save = app.assistant.setSettings;
  app.assistant.setSettings = patch => { patches.push(patch); return save(patch); };
  const input = app.window.document.querySelector('#aiBase');
  input.value = 'https://example.test/v1';
  input.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(patches.length, 1);
  assert.equal(app.assistant.getSettings().base, input.value);
});

test('generation controls cannot save an unfinished custom API model', t => {
  const app = boot(); t.after(() => app.dom.window.close());
  const doc = app.window.document;
  doc.querySelector('#aiModel').value = '__custom__';
  doc.querySelector('#aiModelCustom').value = 'unfinished-model';
  const rounds = doc.querySelector('#imagesPerRound');
  rounds.value = '4'; rounds.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(app.assistant.getSettings().model, 'gpt-4o-mini');
  assert.equal(app.assistant.getSettings().imagesPerRound, 4);
});

test('blank Comfy numbers retain saved values while explicit zero and empty seed remain distinct', t => {
  const app = boot(); t.after(() => app.dom.window.close());
  const doc = app.window.document;
  app.view.route('ai'); app.view.showAi('comfy');
  doc.querySelector('#comfyCfg').value = '';
  doc.querySelector('#comfyW').value = '';
  doc.querySelector('#comfySeed').value = '';
  let patch = app.view.views.comfy.collect();
  assert.equal(patch.comfyCfg, 7);
  assert.equal(patch.comfyW, 768);
  assert.equal(patch.comfySeed, undefined);
  doc.querySelector('#comfyCfg').value = '0';
  doc.querySelector('#comfySeed').value = '0';
  patch = app.view.views.comfy.collect();
  assert.equal(patch.comfyCfg, 0);
  assert.equal(patch.comfySeed, 0);
  app.assistant.setSettings({ comfyCfg: 0 });
  doc.querySelector('#comfyCfg').value = '';
  assert.equal(app.view.views.comfy.collect().comfyCfg, 0);
});

test('ComfyUI workflow action buttons have localized labels', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(root, 'locales', 'zh-CN.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(root, 'locales', 'en-US.json'), 'utf8'));
  assert.match(zh.ui.settings.workflowClear, /清空/);
  assert.match(zh.ui.settings.comfyRestoreDefault, /默认/);
  assert.match(en.ui.settings.workflowClear, /Clear/i);
  assert.match(en.ui.settings.comfyRestoreDefault, /default/i);
});

test('ComfyUI profile exposes explicit capabilities and reference bindings', () => {
  const app = boot({ comfyProfile: {
    id: 'profile-reference', name: '参考图工作流', workflow: {}, updatedAt: 1,
    capabilities: { txt2img: true, img2img: true, controlImage: false, mask: false },
    overrides: { positive: true, negative: true }, bindings: { sourceImage: null, denoise: null, controlStrength: null },
    analysis: {
      level: 'advanced', nodeCount: 12, samplerCandidates: [{ nodeId: '3', title: 'KSampler', classType: 'KSampler' }],
      sourceImageCandidates: [{ nodeId: '10', input: 'image', title: 'Load Image', classType: 'LoadImage' }],
      referenceFieldCandidates: { denoise: [{ nodeId: '3', input: 'denoise', title: 'KSampler', classType: 'KSampler' }], controlStrength: [] }
    }
  } });
  app.view.route('ai'); app.view.showAi('comfy'); app.view.views.comfy.render();
  assert.equal(app.window.document.querySelector('[data-capability="img2img"]').checked, true);
  const source = app.window.document.querySelector('[data-binding="sourceImage"]');
  assert.equal(source.options.length, 2);
  source.value = '10::image';
  source.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.deepEqual(app.getComfyProfile().bindings.sourceImage, { nodeId: '10', input: 'image' });
  assert.equal(app.view.views.comfy.snapshot().comfyBase, 'http://127.0.0.1:8188');
  app.dom.window.close();
});

test('conversation generation controls persist batch and auto/manual mode', async () => {
  const app = boot();
  app.view.route('ai'); app.view.showAi('talk');
  await new Promise(resolve => setTimeout(resolve, 0));
  const master = app.window.document.querySelector('#talkComfyOn');
  const batch = app.window.document.querySelector('#imagesPerRound');
  const rounds = app.window.document.querySelector('#maxAutoRounds');
  const autoRun = app.window.document.querySelector('#generationAutoRun');
  const gear = app.window.document.querySelector('#talkComfyDebug');
  assert.equal(master.checked, true);
  assert.equal(batch.value, '1');
  assert.equal(rounds.value, '3');
  assert.equal(batch.options.length, 10);
  assert.equal(batch.options[9].value, '10');
  assert.equal(rounds.options.length, 10);
  assert.equal(rounds.options[9].value, '10');
  assert.equal(app.window.document.querySelector('#batchCount').max, '10');
  assert.equal(app.window.document.querySelector('#maxComfyCalls').max, '10');
  assert.match(app.window.document.querySelector('#maxAutoRounds').getAttribute('aria-label'), /ComfyUI|调用|迭代/);
  assert.equal(autoRun.checked, true);
  assert.match(gear.textContent, /⚙/);
  batch.value = '4'; batch.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  autoRun.checked = false; autoRun.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(rounds.disabled, true);
  assert.equal(app.assistant.getSettings().imagesPerRound, 4);
  assert.equal(app.assistant.getSettings().generationAutoRun, false);
  master.checked = false; master.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(batch.disabled, true);
  assert.equal(autoRun.disabled, true);
  const beforeStop = app.getCancelCount();
  app.window.document.querySelector('#talkStopBtn').click();
  assert(app.getCancelCount() > beforeStop);
  app.dom.window.close();
});

test('candidate comparison shows scores and issues and accepts a manual final choice', () => {
  const candidates = [
    { id: 'candidate-1', iteration: 1, imageId: 'img-1', prompt: '1girl, blue hair', negative: 'lowres', evaluation: { status: 'reviewed', score: 76, summary: '构图需要调整', issues: [{ severity: 'major', observed: '视角偏正面', suggestedChange: '加强侧身' }] } },
    { id: 'candidate-2', iteration: 2, imageId: 'img-2', prompt: '1girl, blue hair, from side', negative: 'lowres', selected: true, evaluation: { status: 'reviewed', score: 94, summary: '符合要求', issues: [], recommended: true } }
  ];
  const app = boot({ initialMessages: [{ id: 'a1', role: 'assistant', text: '', imageIds: ['img-1', 'img-2'], status: 'done', result: { status: 'completed', selectedCandidateId: 'candidate-2', selectedImageId: 'img-2', prompt: candidates[1].prompt, negative: 'lowres', candidates } }] });
  app.view.route('ai'); app.view.showAi('talk'); app.view.renderTalk();
  const cards = app.window.document.querySelectorAll('.draw-candidate');
  assert.equal(app.window.document.querySelectorAll('.draw-round').length, 1);
  assert.equal(app.window.document.querySelector('.draw-round-track').children.length, 2);
  assert.equal(cards.length, 2);
  assert.match(cards[1].querySelector('.draw-candidate-score').textContent, /94/);
  assert.match(cards[0].querySelector('.draw-candidate-issues').textContent, /视角偏正面/);
  assert.equal(cards[1].classList.contains('selected'), true);
  assert.match(app.window.document.querySelector('.genout').textContent, /from side/);
  assert.equal(cards[0].querySelectorAll('.draw-candidate-actions > .cico').length, 1, 'only continue may remain outside Tag details');
  assert.equal(cards[0].querySelectorAll('.draw-candidate-tag-copy').length, 1);
  cards[0].querySelector('.draw-candidate-choose').click();
  return new Promise(resolve => setTimeout(resolve, 0)).then(() => {
    assert.equal(app.assistant.currentSession().messages[0].result.selectedCandidateId, 'candidate-1');
    app.dom.window.close();
  });
});

test('manual candidate feedback continues only the selected image', async () => {
  const candidate = { id: 'candidate-1', iteration: 1, roundId: 'round-1', roundIndex: 1, imageId: 'img-1', prompt: '1girl', negative: '', evaluation: { status: 'reviewed', score: 70, summary: '需要调整', issues: [] } };
  const app = boot({ initialMessages: [{ id: 'a1', role: 'assistant', text: '', imageIds: ['img-1'], status: 'done', result: { status: 'awaiting_feedback', jobId: 'job-1', candidates: [candidate], rounds: [{ roundId: 'round-1', candidateIds: ['candidate-1'], recommendedCandidateId: 'candidate-1' }] } }] });
  app.view.route('ai'); app.view.showAi('talk'); app.view.renderTalk();
  const feedback = app.window.document.querySelector('.draw-candidate-feedback');
  const button = app.window.document.querySelector('.draw-candidate-continue');
  assert.ok(feedback);
  assert.equal(feedback.closest('.draw-candidate-feedback-shell') !== null, true);
  assert.match(app.window.document.querySelector('.draw-candidate-feedback-title').textContent, /修改意见/);
  assert.equal(feedback.closest('.draw-candidate-tags'), null);
  assert.equal(button.hidden, false);
  feedback.value = '保留人物，增强低视角';
  button.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(app.continuationCalls[0], { messageId: 'a1', candidateId: 'candidate-1', feedback: '保留人物，增强低视角' });
  app.dom.window.close();
});

test('primary model image capability can be selected explicitly', t => {
  const app = boot(); t.after(() => app.dom.window.close());
  const select = app.window.document.querySelector('#primaryVisionMode');
  assert(select);
  assert.deepEqual([...select.options].map(option => option.value), ['auto', 'supported', 'unsupported']);
  select.value = 'supported';
  select.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.equal(app.assistant.getSettings().primaryVisionMode, 'supported');
});

test('candidate feedback remains separate from Tags and identifies its target', () => {
  const candidate = { id: 'candidate-1', iteration: 1, roundId: 'round-1', roundIndex: 1, imageId: 'img-1', prompt: '1girl', negative: '', evaluation: { status: 'pending' } };
  const app = boot({ initialMessages: [{ id: 'a1', role: 'assistant', text: '', status: 'done', result: { status: 'awaiting_feedback', jobId: 'job-1', candidates: [candidate] } }] });
  app.view.route('ai'); app.view.showAi('talk'); app.view.renderTalk();
  const shell = app.window.document.querySelector('.draw-candidate-feedback-shell');
  assert(shell);
  assert.match(shell.textContent, /第 1 次渲染/);
  assert.match(shell.querySelector('textarea').placeholder, /输入本轮修改/);
  assert.equal(shell.querySelector('textarea').getAttribute('aria-label'), '对第 1 次渲染的修改意见');
  assert.equal(shell.previousElementSibling.classList.contains('draw-candidate-tags'), true);
  app.dom.window.close();
});

test('decision-required candidates show an explicit AI decision status', () => {
  const candidate = { id: 'candidate-1', iteration: 1, roundId: 'round-1', roundIndex: 1, imageId: 'img-1', prompt: '1girl', negative: '', evaluation: { status: 'pending' } };
  const app = boot({ initialMessages: [{ id: 'a1', role: 'assistant', text: '', status: 'streaming', result: { status: 'awaiting_feedback', decisionRequired: true, jobId: 'job-1', candidates: [candidate] } }] });
  app.view.route('ai'); app.view.showAi('talk'); app.view.renderTalk();
  assert.match(app.window.document.querySelector('.draw-candidate-decision').textContent, /主 AI 正在判断|主 AI 判断/);
  assert.equal(app.window.document.querySelector('.draw-candidate-feedback-shell').hidden, true);
  app.dom.window.close();
});

test('selecting a gallery card updates only selection state without rereading the gallery', t => {
  const app = boot();
  app.view.route('gallery');
  let listCalls = 0;
  const listGallery = app.repository.listGallery;
  app.repository.listGallery = (...args) => { listCalls += 1; return listGallery(...args); };
  const card = app.window.document.querySelector('.gallery-card');
  const before = app.window.document.querySelector('.gallery-card');
  listCalls = 0;
  card.click();
  assert.equal(listCalls, 0);
  assert.equal(app.window.document.querySelector('.gallery-card'), before);
  assert.equal(card.getAttribute('aria-pressed'), 'true');
  app.dom.window.close();
});

test('completed candidate continue button resumes the original job directly', async () => {
  const candidate = { id: 'candidate-1', iteration: 1, roundId: 'round-1', roundIndex: 1, imageId: 'img-1', prompt: '1girl, sitting', negative: '', evaluation: { status: 'reviewed', score: 70, summary: '姿势需要调整', issues: [{ observed: '姿势不对', suggestedChange: '改成 standing' }] } };
  const app = boot({ initialMessages: [{ id: 'a1', role: 'assistant', text: '', status: 'done', result: { status: 'completed', jobId: 'job-1', candidates: [candidate] } }] });
  app.view.route('ai'); app.view.showAi('talk'); app.view.renderTalk();
  const feedback = app.window.document.querySelector('.draw-candidate-feedback');
  assert.equal(feedback.hidden, false);
  app.window.document.querySelector('.draw-candidate-continue').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(app.continuationCalls[0].messageId, 'a1');
  assert.equal(app.continuationCalls[0].candidateId, 'candidate-1');
  assert.match(app.continuationCalls[0].feedback, /主 AI|primary/i);
  app.dom.window.close();
});

test('candidate rounds render as separate horizontal comparison tracks', () => {
  const candidates = [
    { id: 'candidate-1', iteration: 1, roundIndex: 1, imageId: 'img-1', prompt: 'first', evaluation: { status: 'reviewed', score: 70 } },
    { id: 'candidate-2', iteration: 2, roundIndex: 1, imageId: 'img-2', prompt: 'second', evaluation: { status: 'reviewed', score: 75 } },
    { id: 'candidate-3', iteration: 3, roundIndex: 2, imageId: 'img-3', prompt: 'third', evaluation: { status: 'reviewed', score: 80 } },
    { id: 'candidate-4', iteration: 4, roundIndex: 2, imageId: 'img-4', prompt: 'fourth', evaluation: { status: 'reviewed', score: 85 } }
  ];
  const app = boot({ initialMessages: [{ id: 'a1', role: 'assistant', text: '', imageIds: candidates.map(row => row.imageId), status: 'done', result: { status: 'completed', candidates } }] });
  app.view.route('ai'); app.view.showAi('talk');
  const rounds = [...app.window.document.querySelectorAll('.draw-round')];
  assert.equal(rounds.length, 2);
  assert.deepEqual(rounds.map(round => round.querySelectorAll('.draw-round-track > .draw-candidate').length), [2, 2]);
  assert.deepEqual(rounds.map(round => round.querySelector('.draw-round-heading').textContent), ['第 1 轮', '第 2 轮']);
  app.dom.window.close();
});

test('automatic running candidates hide continuation but keep final selection', () => {
  const candidate = { id: 'candidate-1', iteration: 1, roundId: 'round-1', roundIndex: 1, imageId: 'img-1', prompt: '1girl', evaluation: { status: 'reviewed', score: 70, summary: 'reviewed' } };
  const app = boot({ initialMessages: [{ id: 'a1', role: 'assistant', text: '', imageIds: ['img-1'], status: 'streaming', result: { status: 'rendering', jobId: 'job-1', candidates: [candidate], rounds: [] } }] });
  app.view.route('ai'); app.view.showAi('talk'); app.view.renderTalk();
  assert.equal(app.window.document.querySelector('.draw-candidate-continue')?.hidden, true);
  assert.equal(app.window.document.querySelector('.draw-candidate-choose')?.disabled, false);
  app.dom.window.close();
});

test('generation delivery badges expose limits, approximation and residual issues', () => {
  const issue = { expected: '原图构图', observed: '视角仍有偏差', severity: 'hard', suggestedChange: '改成低视角' };
  const candidate = { id: 'candidate-1', iteration: 1, imageId: 'img-1', prompt: '1girl, church', negative: 'lowres', selected: true, evaluation: { status: 'reviewed', score: 78, verdict: 'revise', hardErrors: [issue], issues: [], summary: '尚未完全匹配' } };
  const app = boot({ initialMessages: [{ id: 'a1', role: 'assistant', text: '', imageIds: ['img-1'], status: 'done', result: { status: 'completed', outcome: 'best_available', recreationMode: 'text_approximation', aspectRatioMode: 'workflow_fixed', selectedCandidateId: candidate.id, residualIssues: [issue], candidates: [candidate] } }] });
  app.view.route('ai'); app.view.showAi('talk');
  const delivery = app.window.document.querySelector('.generation-delivery');
  assert(delivery);
  assert.equal(delivery.dataset.outcome, 'best_available');
  assert.match(delivery.textContent, /达到上限后的最佳候选/);
  assert.match(delivery.textContent, /文本近似复刻/);
  assert.match(delivery.textContent, /工作流固定尺寸/);
  assert.match(delivery.textContent, /视角仍有偏差/);
  app.dom.window.close();
});

test('agent-controlled task timeline is open and shows structured comparison details', () => {
  const candidate = { id: 'candidate-1', iteration: 1, roundIndex: 1, imageId: 'img-1', prompt: '1girl, standing', evaluation: { status: 'pending' } };
  const events = [
    { type: 'source.local_hint', summary: '本地识图返回 12 个初始 Tag', details: { tags: ['1girl', 'standing'] } },
    { type: 'baseline.prompt', summary: '首轮使用初始 Tag 出图', details: { tagCount: 12 } },
    { type: 'candidate.comparing', candidateId: 'candidate-1', summary: '正在对照原图和候选图' },
    { type: 'candidate.diff', candidateId: 'candidate-1', summary: '发现 2 项差异', details: { changes: ['改为三人', '保留背景'] } }
  ];
  const app = boot({ initialMessages: [{ id: 'a1', role: 'assistant', text: '', status: 'done', events, activity: events, result: { status: 'awaiting_feedback', agentControlled: true, decisionRequired: true, jobId: 'job-1', candidates: [candidate] } }] });
  app.view.route('ai'); app.view.showAi('talk'); app.view.renderTalk();
  const timeline = app.window.document.querySelector('.draw-activity');
  assert(timeline);
  assert.equal(timeline.open, true);
  assert.match(timeline.textContent, /本地识图返回 12 个初始 Tag/);
  assert.match(timeline.textContent, /正在对照原图和候选图/);
  assert.match(timeline.textContent, /改为三人/);
  app.dom.window.close();
});

test('needs-input generation result is shown as an actionable conversation notice', () => {
  const app = boot({ initialMessages: [{ id: 'a1', role: 'assistant', text: '请选择参考图', imageIds: [], status: 'done', result: { status: 'needs_input', jobId: 'job-1', needsInput: { kind: 'source_image', message: '请选择当前会话中的参考原图' }, candidates: [] } }] });
  app.view.route('ai'); app.view.showAi('talk'); app.view.renderTalk();
  assert.match(app.window.document.querySelector('.generation-needs-input').textContent, /参考原图/);
  app.dom.window.close();
});

test('character question shows names, works and tags, submits one choice and recovers from a failed resume', async () => {
  let release;
  const choices = [];
  const app = boot({ initialMessages: [{ id: 'a1', role: 'assistant', text: '', status: 'done', result: { status: 'needs_input', jobId: 'job-1', needsInput: { kind: 'character', query: '天子', message: '请选择角色', options: [{ id: 'hinanawi_tenshi', name: '比那名居天子', series: 'touhou', trigger: 'hinanawi_tenshi' }, { id: 'tenshi-2', name: '天子', series: '其他作品' }] } } }], selectGenerationCharacter: (...args) => { choices.push(args.slice(0, 2)); return new Promise(resolve => { release = resolve; }); } });
  app.view.route('ai'); app.view.showAi('talk');
  try {
    const doc = app.window.document;
    const buttons = [...doc.querySelectorAll('.generation-character-choice')];
    assert.equal(buttons.length, 2);
    assert.match(buttons[0].textContent, /比那名居天子/);
    assert.match(buttons[0].textContent, /touhou/);
    assert.match(buttons[0].textContent, /hinanawi_tenshi/);
    buttons[0].click(); buttons[1].click();
    assert.deepEqual(choices, [['a1', 'hinanawi_tenshi']]);
    release({ ok: false, error: { code: 'JOB_NOT_FOUND', message: '任务不可用' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(doc.querySelector('#talkSendBtn').disabled, false);
    assert.equal(doc.querySelector('.generation-character-choice').disabled, false);
    assert.equal(app.getRunCount(), 0);
  } finally { app.dom.window.close(); }
});

test('empty character choices can be searched locally and selected without sending another chat', async () => {
  const searches = [];
  const choices = [];
  const app = boot({ initialMessages: [{ id: 'a1', role: 'assistant', text: '', status: 'done', result: { status: 'needs_input', jobId: 'job-1', needsInput: { kind: 'character', query: 'touhou', message: '请选择角色', options: [] } } }], characters: { page: async value => { searches.push(value); return { items: [{ id: 'hinanawi_tenshi', nameZh: '比那名居天子', seriesName: 'touhou', trigger: 'hinanawi_tenshi' }] }; } }, selectGenerationCharacter: async (...args) => { choices.push(args.slice(0, 2)); return { ok: true }; } });
  app.view.route('ai'); app.view.showAi('talk');
  try {
    const doc = app.window.document;
    const input = doc.querySelector('.generation-character-search');
    assert.ok(input);
    input.value = '比那名居天子';
    doc.querySelector('.generation-character-search-button').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(searches[0].query, '比那名居天子');
    assert.match(doc.querySelector('.generation-character-choice').textContent, /比那名居天子/);
    doc.querySelector('.generation-character-choice').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(choices, [['a1', 'hinanawi_tenshi']]);
    assert.equal(app.getRunCount(), 0);
  } finally { app.dom.window.close(); }
});

test('original-character button bypasses an empty library and recovers after a failed resume', async () => {
  let release;
  const choices = [];
  const app = boot({ initialMessages: [{ id: 'a1', role: 'assistant', text: '', status: 'done', result: { status: 'needs_input', jobId: 'job-oc', needsInput: { kind: 'character', query: '小星', options: [] } } }], selectGenerationCharacter: (messageId, characterId, options) => { choices.push({ messageId, characterId, original: options.original }); return new Promise(resolve => { release = resolve; }); } });
  app.view.route('ai'); app.view.showAi('talk');
  try {
    const doc = app.window.document;
    const button = doc.querySelector('.generation-character-original');
    assert(button, '原创人物即使无匹配候选也必须能够继续');
    assert.match(button.textContent, /原创.*继续/);
    button.click(); button.click();
    assert.deepEqual(choices, [{ messageId: 'a1', characterId: '', original: true }]);
    assert.equal(button.disabled, true);
    release({ ok: false, error: { code: 'JOB_NOT_FOUND', message: '任务不可用' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(doc.querySelector('.generation-character-original').disabled, false);
    assert.equal(doc.querySelector('#talkSendBtn').disabled, false);
    assert.equal(app.getRunCount(), 0);
  } finally { app.dom.window.close(); }
});

test('conversation image clear button confirms and clears only current conversation images', () => {
  let clearedSession = '';
  const app = boot({ conversationItems: [{ refId: 'r1', imageId: 'img-1', slotNo: 1, source: 'upload', sent: true }], clearConversationImages: sessionId => { clearedSession = sessionId; } });
  const button = app.window.document.querySelector('#talkClearImagesBtn');
  assert.ok(button);
  button.click();
  assert.equal(app.window.document.querySelector('#cfmModal').classList.contains('show'), true);
  app.window.document.querySelector('#cfmYes').click();
  assert.equal(clearedSession, 's1');
  assert.match(app.window.document.querySelector('#talkImageRepository').textContent, /No conversation images|没有对话图片/);
  app.dom.window.close();
});

test('deleting a conversation defaults to removing images unless gallery retention is checked', () => {
  let deleted;
  const app = boot({ deleteSession: (sessionId, value) => { deleted = { sessionId, value }; } });
  app.window.document.querySelector('#talkManage').click();
  app.window.document.querySelector('#mgrChatList .del, #mgrGenList .del')?.click();
  assert.equal(app.window.document.querySelector('#cfmRetainImages').checked, false);
  app.window.document.querySelector('#cfmYes').click();
  assert.equal(deleted.sessionId, 's1');
  assert.equal(deleted.value.retainImages, false);
  app.dom.window.close();
});

test('call monitor renders compact summaries and never exposes request or response payloads', async () => {
  const app = boot({ callRecords: [{
    requestId: 'primary-1', rootRequestId: 'primary-1', parentRequestId: '', sessionId: 'session-1',
    messageId: 'message-1', jobId: 'job-1', kind: 'primary', tool: 'primary', status: 'completed',
    startedAt: 1, endedAt: 125, durationMs: 124, model: 'test-model', apiCalls: 1,
    httpStatus: 200, usage: { total_tokens: 4 }, usageScope: 'root-total-at-completion', error: null
  }, {
    requestId: 'tool-2', rootRequestId: 'primary-2', parentRequestId: 'primary-2', sessionId: 'session-2',
    messageId: '', jobId: '', kind: 'tool:tags.search', tool: 'tags.search', status: 'error',
    startedAt: 3, endedAt: 305, durationMs: 302, model: 'tag-tool', apiCalls: 0,
    httpStatus: null, usage: { total_tokens: 0 }, usageScope: 'call', error: { code: 'TAG_LOOKUP', message: '查询失败' }
  }] });
  app.window.document.querySelector('#openCallMonitor').click();
  const modal = app.window.document.querySelector('#callMonitorModal');
  assert.equal(modal.parentElement, app.window.document.body);
  assert.equal(modal.classList.contains('show'), true);
  assert.equal(modal.getAttribute('aria-hidden'), 'false');
  assert.match(app.window.document.querySelector('#callMonitorList').textContent, /primary-1/);
  assert.match(app.window.document.querySelector('#callMonitorList').textContent, /124 ms/);
  assert.match(app.window.document.querySelector('#callMonitorList').textContent, /Token 4/);
  assert.match(app.window.document.querySelector('#callMonitorList').textContent, /test-model/);
  assert.match(app.window.document.querySelector('#callMonitorList').textContent, /message-1/);
  assert.match(app.window.document.querySelector('#callMonitorList').textContent, /job-1/);
  assert.doesNotMatch(app.window.document.querySelector('#callMonitorList').textContent, /实际请求|原始返回|调用输入|处理后的输出|系统提示词|messages|blue hair|REDACTED/);
  const filter = app.window.document.querySelector('#callMonitorFilter');
  filter.value = 'primary-2';
  filter.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  assert.match(app.window.document.querySelector('#callMonitorList').textContent, /tags.search/);
  assert.match(app.window.document.querySelector('#callMonitorList').textContent, /失败/);
  assert.match(app.window.document.querySelector('#callMonitorList').textContent, /TAG_LOOKUP：查询失败/);
  const exported = app.view.views.callMonitor.exportJson();
  assert.equal(exported.format, 'ai-tag-call-monitor');
  assert.equal(exported.version, 2);
  assert.equal(exported.records.length, 1);
  assert.equal(exported.records[0].requestId, 'tool-2');
  app.window.document.querySelector('#callMonitorExport').click();
  const exportedText = await new Promise(resolve => {
    const reader = new app.window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(app.downloadBlobs.at(-1));
  });
  assert.equal(JSON.parse(exportedText).records[0].requestId, 'tool-2');
  assert.equal(app.window.document.querySelector('#callMonitorModal').classList.contains('show'), true);
  app.window.document.querySelector('#callMonitorClear').click();
  assert.equal(app.assistant.listCallRecords().length, 2);
  app.window.document.querySelector('#cfmYes').click();
  assert.equal(app.assistant.listCallRecords().length, 0);
  app.window.document.querySelector('#callMonitorClose').click();
  assert.equal(modal.getAttribute('aria-hidden'), 'true');
  app.dom.window.close();
});

test('failed replies keep progress in messages without copying it into the ComfyUI toolbar', async () => {
  const progress = '【进度 步骤1/5】正在处理：确认当前会话中的图片引用，查询角色。'.repeat(20);
  const app = boot({ runResult: { ok: false, text: progress, error: { code: 'OUTPUT_INVALID', message: 'Tag 子代理返回格式无效' } } });
  try {
    const doc = app.window.document;
    doc.querySelector('#talkIn').value = '继续任务';
    doc.querySelector('#talkSendBtn').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(doc.querySelector('#talkStatus').textContent, '输出格式无效');
    assert.doesNotMatch(doc.querySelector('.tk-statusline').textContent, /进度|步骤1/);
    assert.match(doc.querySelector('#talkConv').textContent, /进度 步骤1/);
    assert.equal(doc.querySelector('#talkComfyDebug').textContent, '⚙');
  } finally { app.dom.window.close(); }
});


test('Tags-only messages render one text code block with a copy-all action', async t => {
  const app = boot({ initialMessages: [{ id: 'tags-result', role: 'assistant', text: 'Tag 已生成。', status: 'done', result: { outputType: 'tags', status: 'completed', prompt: '1girl, blue hair', negative: 'lowres', positiveTags: ['1girl','blue hair'], negativeTags: ['lowres'] } }] });
  t.after(() => app.dom.window.close());
  app.assistant.setSettings({ generateNegativeTags: true });
  let copied;
  app.window.navigator.clipboard.writeText = async value => { copied = value; };
  app.view.route('ai'); app.view.showAi('talk');
  const doc = app.window.document;
  const result = doc.querySelector('.generation-tags-result');
  assert(result);
  assert.equal(result.querySelectorAll('.codeblock').length, 1);
  assert.equal(result.querySelectorAll('.chip').length, 0);
  assert.equal(result.querySelector('.codelang').textContent, 'text');
  assert.match(result.querySelector('.codepre').textContent, /1girl, blue hair/);
  assert.match(result.querySelector('.codepre').textContent, /Negative prompt:\nlowres/);
  result.querySelector('.codebtn').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(copied, '1girl, blue hair\n\nNegative prompt:\nlowres');
});

test('conversation timeline explains the routed task, a blocked tool and the answer phase', t => {
  const app = boot({ initialMessages: [{ id: 'routed', role: 'assistant', text: 'blue hair', status: 'done', activity: [
    { type: 'task.routed', intent: 'search_tags' },
    { type: 'tool.blocked', name: 'generation.execute', error: { message: '本轮只查标签' } },
    { type: 'task.answering', intent: 'search_tags' }
  ] }] });
  t.after(() => app.dom.window.close());
  app.view.route('ai'); app.view.showAi('talk');
  const content = app.window.document.querySelector('.draw-activity').textContent;
  assert.match(content, /搜索 Tag/);
  assert.match(content, /已跳过.*generation\.execute.*本轮只查标签/);
  assert.match(content, /整理答复/);
});

test('disconnected drawing controls stay off and automatic iteration is hidden', async t => {
  const app = boot({ comfyCapabilities: { enabled: true, connected: false, workflowReady: true, render: false, error: 'offline' } });
  t.after(() => app.dom.window.close());
  app.view.route('ai'); app.view.showAi('talk');
  await new Promise(resolve => setTimeout(resolve, 0));
  const doc = app.window.document;
  assert.equal(doc.querySelector('#talkComfyOn').checked, false);
  assert.equal(doc.querySelector('#talkComfyOn').disabled, true);
  assert.equal(doc.querySelector('#generationAutoRun').closest('label').hidden, true);
  assert.match(doc.querySelector('#comfyStatus').textContent, /仅生成 Tag/);
});


test('paused ComfyUI task resumes directly from its notice without sending another AI prompt', async t => {
  const app = boot({ initialMessages: [{ id: 'paused-image', role: 'assistant', text: '', status: 'done', result: { jobId: 'job-pending', outputType: 'images', status: 'needs_input', prompt: 'portrait', positiveTags: ['portrait'], pendingRender: { promptId: 'accepted' }, needsInput: { kind: 'connection', message: '连接中断' } } }] });
  t.after(() => app.dom.window.close());
  const calls = [];
  app.assistant.continueGeneration = async (...args) => { calls.push(args); return { ok: true, data: { status: 'awaiting_feedback' } }; };
  app.view.route('ai'); app.view.showAi('talk');
  const button = app.window.document.querySelector('.generation-resume-connection');
  assert(button, 'a paused request must have a direct recovery action');
  button.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'paused-image');
  assert.equal(calls[0][3].resumeOnly, true);
  assert.equal(app.getRunCount(), 0);
});

test('primary-selected unscored candidates are not displayed as accepted or zero hard errors', t => {
  const candidate = { id: 'candidate-1', imageId: 'img-1', prompt: 'standing', selected: true, evaluation: { status: 'pending' } };
  const app = boot({ initialMessages: [{ id: 'a1', role: 'assistant', text: '', status: 'done', result: { status: 'completed', outcome: 'primary_selected', selectedCandidateId: 'candidate-1', candidates: [candidate] } }] });
  t.after(() => app.dom.window.close());
  app.view.route('ai'); app.view.showAi('talk');
  const delivery = app.window.document.querySelector('.generation-delivery');
  assert.match(delivery.textContent, /主 AI 选择/);
  assert.match(delivery.textContent, /未进行辅助评分/);
  assert.doesNotMatch(delivery.textContent, /硬错误 0|达到上限|已达到验收/);
});

for (const negativeEnabled of [false, true]) test(`final copy is positive Tags only and the prompt panel has no empty duplicate (negative=${negativeEnabled})`, async t => {
  const prompt = '1girl, (blue_hair:1.2), standing';
  const candidate = { id: 'candidate-1', imageId: 'img-1', prompt, negative: 'lowres', selected: true };
  const app = boot({ initialMessages: [{ id: 'copy-final', role: 'assistant', status: 'done', text: '', result: { jobId: 'job-1', status: 'completed', prompt, negative: 'lowres', selectedCandidateId: candidate.id, candidates: [candidate] } }] });
  t.after(() => app.dom.window.close());
  app.assistant.setSettings({ generateNegativeTags: negativeEnabled });
  let copied;
  app.window.navigator.clipboard.writeText = async value => { copied = value; };
  app.view.route('ai'); app.view.showAi('talk');
  const row = app.window.document.querySelector('[data-message-id="copy-final"]');
  row.querySelector('.draw-final-copy').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(copied, prompt);
  assert.equal(row.querySelectorAll('.genout').length, 1);
  assert.equal(row.querySelector('.draw-final-prompt pre').textContent, prompt);
  assert.equal(row.querySelector('.draw-final-legacy'), null);
  if (!negativeEnabled) {
    assert.doesNotMatch(row.textContent, /lowres|负面提示词|负向 Tag/);
    assert.equal(row.querySelector('.draw-candidate-tag-section.negative'), null);
  }
});

test('drawing shows the task introduction, primary evaluation and a separate next step instead of hiding public text', t => {
  const primaryReview = { summary: '人数正确，姿势尚需调整。', issues: [{ expected: '站立', observed: '坐姿', suggestedChange: '移除坐姿，改为站立' }], nextAction: 'revise', nextStep: '我会再画一张，修正姿势。' };
  const events = [{ type: 'assistant.message', phase: 'start', summary: '我会复刻参考图，先用本地 Tag 生成一张基线图。' }, { type: 'assistant.message', phase: 'final', summary: '本轮先请你查看姿势的差异。' }];
  const app = boot({ initialMessages: [{ id: 'visible-feedback', role: 'assistant', status: 'done', text: '本轮先请你查看姿势的差异。', reasoning: 'INTERNAL_NOTE', events, result: { status: 'awaiting_feedback', jobId: 'j1', candidates: [{ id: 'candidate-1', imageId: 'img-1', prompt: 'standing', primaryReview }] } }] });
  t.after(() => app.dom.window.close());
  app.view.route('ai'); app.view.showAi('talk');
  const row = app.window.document.querySelector('[data-message-id="visible-feedback"]');
  assert.match(row.querySelector('.body').textContent, /我会复刻参考图/);
  const card = row.querySelector('.draw-candidate');
  const review = card.querySelector('.draw-primary-review');
  assert(review);
  assert.match(review.textContent, /人数正确|坐姿/);
  assert.match(review.textContent, /移除坐姿，改为站立/);
  assert.equal(review.closest('details'), null);
  const next = card.querySelector('.draw-candidate-next-step');
  assert.equal(next.textContent, primaryReview.nextStep);
  assert.equal(next.closest('.draw-primary-review'), null);
  assert.match(row.querySelector('.generation-public-replies').textContent, /本轮先请你/);
  assert.doesNotMatch(row.querySelector('.generation-public-replies').textContent, /INTERNAL_NOTE/);
});

test('public narration does not hide a later failed request or leave feedback hidden after the primary stops', t => {
  const app = boot({ initialMessages: [{ id: 'error-after-plan', role: 'assistant', status: 'error', text: '读取图片失败', events: [{ type: 'assistant.message', phase: 'start', summary: '我会先比较图片。' }], result: { status: 'awaiting_feedback', decisionRequired: true, jobId: 'j1', error: { message: '图片读取失败，请重试' }, candidates: [{ id: 'candidate-1', imageId: 'img-1', prompt: 'portrait' }] } }] });
  t.after(() => app.dom.window.close());
  app.view.route('ai'); app.view.showAi('talk');
  const row = app.window.document.querySelector('[data-message-id="error-after-plan"]');
  assert.match(row.textContent, /图片读取失败，请重试/);
  assert.equal(row.querySelector('.draw-candidate-decision'), null);
  assert.equal(row.querySelector('.draw-candidate-feedback-shell').hidden, false);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrimaryTools } = require('../src/modules/primary-tools');
const { createPrimaryAgent } = require('../src/modules/primary-agent');

test('favorite query contract augments the runtime prompt without changing user prompt storage', () => {
  const stored = 'My original instructions';
  const agent = createPrimaryAgent({ prompts: { get: () => stored }, favoritesEnabled: true });
  const prompt = agent.getPrompt();
  assert.ok(prompt.startsWith(stored));
  assert.match(prompt, /favorites/);
  assert.match(prompt, /contentOmitted/);
  assert.match(prompt, /用户收藏/);
  assert.equal(stored, 'My original instructions');
});

test('Tag queries return distinct favorite groups without notes or changing dictionary results', async () => {
  const calls = [];
  const tools = createPrimaryTools({
    tags: { search: () => [{ en: 'soft lighting', zh: '柔光' }] },
    favorites: { search: (query, options) => {
      calls.push({ query, options });
      return { items: [{ entryId: 'e1', kind: 'bundle', title: 'soft portrait', rawText: ' soft lighting, (blue hair:1.2) ', note: 'private note', seriesName: 'light', memberCount: 2 }] };
    } }
  });
  const result = await tools.call('tags.search', { query: 'soft', includeAdult: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.items[0].en, 'soft lighting');
  assert.equal(result.data.favorites[0].rawText, ' soft lighting, (blue hair:1.2) ');
  assert.equal(result.data.favorites[0].kind, 'bundle');
  assert.equal('note' in result.data.favorites[0], false);
  assert.equal(calls[0].options.scope, 'global');
  assert.equal(calls[0].options.includeAdult, false);
});

test('oversized groups are explicitly omitted rather than returned as a truncated prompt', async () => {
  const tools = createPrimaryTools({
    tags: { search: () => [] },
    favorites: { search: () => ({ items: [
      { entryId: 'huge', kind: 'bundle', title: 'long', rawText: 'x'.repeat(16001) },
      { entryId: 'small', kind: 'tag', title: 'small', rawText: 'blue hair' }
    ] }) }
  });
  const result = await tools.call('tags.search', { query: 'hair' });
  assert.equal(result.ok, true);
  assert.equal(result.data.favorites[0].contentOmitted, true);
  assert.equal(result.data.favorites[0].rawText, undefined);
  assert.equal(result.data.favorites[1].rawText, 'blue hair');
});

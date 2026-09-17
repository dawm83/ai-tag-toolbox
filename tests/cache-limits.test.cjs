'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTranslation } = require('../src/modules/translation');
const { createTags } = require('../src/modules/tags');
const { createImages } = require('../src/modules/images');

test('local translations retain recent results and evict old queries after 256 entries', () => {
  let calls = 0;
  const translation = createTranslation({ runner: value => { calls += 1; return { text: value.toUpperCase() }; } });
  translation.translateLocal('alpha', 'en-zh');
  translation.translateLocal('beta', 'en-zh');
  for (let index = 0; index < 254; index += 1) translation.translateLocal(`entry${index}`, 'en-zh');
  assert.equal(translation.translateLocal('alpha', 'en-zh').cached, true);
  translation.translateLocal('overflow', 'en-zh');
  const before = calls;
  assert.equal(translation.translateLocal('alpha', 'en-zh').cached, true);
  assert.equal(calls, before);
  assert.equal(translation.translateLocal('beta', 'en-zh').text, 'BETA');
  assert.equal(calls, before + 1);
  translation.translateLocal('alpha', 'en-zh', { force: true });
  assert.equal(calls, before + 2);
});

test('tag search caches recent sorting work without retaining every old query', t => {
  const tags = createTags({ sources: { tags: ['alpha one', 'alpha two', 'beta one', 'beta two'].map(en => ({ en, category: 'other' })) } });
  const compare = String.prototype.localeCompare;
  let comparisons = 0;
  t.mock.method(String.prototype, 'localeCompare', function (...args) { comparisons += 1; return compare.apply(this, args); });
  const alpha = tags.search('alpha');
  const beta = tags.search('beta');
  assert.equal(alpha.length, 2);
  assert.equal(beta.length, 2);
  for (let index = 0; index < 254; index += 1) tags.search(`missing${index}`);
  tags.search('alpha');
  tags.search('overflow');
  comparisons = 0;
  assert.deepEqual(tags.search('alpha'), alpha);
  assert.equal(comparisons, 0);
  assert.deepEqual(tags.search('beta'), beta);
  assert.ok(comparisons > 0, 'an evicted query must recompute its sorted results');
});

test('image analysis retains four recent variants per image and respects invalidation', async () => {
  let calls = 0;
  const images = createImages({ analyzer: async () => { calls += 1; return { tags: ['sample'] }; } });
  const first = images.add({ id: 'first', bytes: Buffer.from([1]) });
  const second = images.add({ id: 'second', bytes: Buffer.from([2]) });
  await images.analyze(second.id, { threshold: 0.1 });
  for (const threshold of [0.1, 0.2, 0.3, 0.4]) await images.analyze(first.id, { threshold });
  await images.analyze(first.id, { threshold: 0.1 });
  await images.analyze(first.id, { threshold: 0.5 });
  const before = calls;
  await images.analyze(first.id, { threshold: 0.1 });
  await images.analyze(second.id, { threshold: 0.1 });
  assert.equal(calls, before);
  await images.analyze(first.id, { threshold: 0.2 });
  assert.equal(calls, before + 1);
  await images.analyze(first.id, { threshold: 0.2, force: true });
  assert.equal(calls, before + 2);
  images.update(first.id, { displayName: 'updated' });
  await images.analyze(first.id, { threshold: 0.2 });
  assert.equal(calls, before + 3);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createBrief,
  addItems,
  mergeBrief,
  briefForAgent,
  migrateBrief
} = require('../src/modules/task-brief');

test('creates a bounded task brief with a current prompt mirror', () => {
  const brief = createBrief({
    mode: 'create',
    userRequest: '画一个角色',
    currentPrompt: { positiveTags: ['1girl'], negativeTags: ['lowres'], iteration: 2 }
  });
  assert.equal(brief.version, 1);
  assert.deepEqual(brief.goal, { mode: 'create', userRequest: '画一个角色' });
  assert.deepEqual(brief.currentPrompt, { positiveTags: ['1girl'], negativeTags: ['lowres'], iteration: 2 });
  assert.deepEqual(brief.items, []);
});

test('source boundaries normalize or reject directives instead of trusting model labels', () => {
  const brief = createBrief({ mode: 'create', userRequest: '画角色' });
  const library = addItems(brief, [{
    scope: 'character.1.outfit', value: 'default uniform', directive: 'must_include', authority: 'hard'
  }], { source: 'character_library' });
  assert.equal(library.items[0].source, 'character_library');
  assert.equal(library.items[0].directive, 'reference_only');
  assert.equal(library.items[0].authority, 'low');
  assert.throws(() => addItems(brief, [{
    scope: 'scene', value: 'remove the background', directive: 'remove'
  }], { source: 'vision' }), /directive/i);
  assert.throws(() => addItems(brief, [{ scope: 'scene', value: 'x' }], { source: 'unknown' }), /source/i);
});

test('user feedback removes lower-priority references while user requirements remain included', () => {
  let brief = createBrief({ mode: 'recreate', userRequest: '保留构图，换成紧身衣' });
  brief = addItems(brief, [{
    scope: 'character.1.identity', value: 'character_tag', directive: 'must_include'
  }], { source: 'user' });
  brief = addItems(brief, [{
    scope: 'character.1.outfit', value: 'default socks', directive: 'reference_only'
  }], { source: 'character_library' });
  brief = addItems(brief, [{
    scope: 'character.1.outfit', value: 'tight suit', directive: 'must_include'
  }], { source: 'user' });
  brief = addItems(brief, [{
    scope: 'character.1.outfit', value: 'default socks', directive: 'remove'
  }], { source: 'user_feedback' });
  brief = addItems(brief, [{
    scope: 'composition.pose', value: 'three-quarter view', directive: 'observation'
  }], { source: 'vision' });

  const merged = mergeBrief(brief);
  assert.deepEqual(merged.include, ['character_tag', 'tight suit']);
  assert.deepEqual(merged.observe, ['three-quarter view']);
  assert.deepEqual(merged.excluded, ['default socks']);
  assert.equal(merged.include.includes('default socks'), false);
});

test('briefForAgent exposes effective instructions without turning references into drawing requirements', () => {
  let brief = createBrief({ mode: 'create', userRequest: '画角色' });
  brief = addItems(brief, [{ scope: 'character.1.identity', value: 'character_tag', directive: 'must_include' }], { source: 'user' });
  brief = addItems(brief, [{ scope: 'character.1.outfit', value: 'default uniform', directive: 'reference_only' }], { source: 'character_library' });
  const input = briefForAgent(brief);
  assert.deepEqual(input.effective.include, ['character_tag']);
  assert.deepEqual(input.effective.observe, ['default uniform']);
  assert.equal(input.items[1].source, 'character_library');
});

test('legacy generation state migrates to one stable brief and migration is idempotent', () => {
  const legacy = {
    mode: 'recreate',
    originalRequirements: '保留姿势并修改服装',
    positiveTags: ['character_tag', 'sitting'],
    negativeTags: ['lowres'],
    visualBlueprint: { pose: ['sitting'], scene: ['room'] },
    characterReferences: [{ id: 'character-1', identityTags: ['character_tag'], generalTags: ['default uniform'], specificTags: [] }]
  };
  const first = migrateBrief(legacy);
  const second = migrateBrief({ ...legacy, brief: first });
  assert.deepEqual(second, first);
  assert.equal(first.goal.mode, 'recreate');
  assert.equal(first.items.some(item => item.source === 'vision' && item.value === 'sitting'), true);
  assert.equal(first.items.some(item => item.source === 'character_library' && item.directive === 'reference_only'), true);
  assert.deepEqual(first.currentPrompt, { positiveTags: ['character_tag', 'sitting'], negativeTags: ['lowres'], iteration: 0 });
});

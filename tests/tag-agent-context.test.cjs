'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixedSubagents } = require('../src/modules/fixed-subagents');
const { applyPromptPatch } = require('../src/modules/prompt-patch');

test('compile forwards requirements and optional image but not the upstream blueprint or character dossier', async () => {
  let messages;
  const agent = createFixedSubagents({ prompts: { generateTags: '编译规则' }, resolveImage: async () => ({ dataUrl: 'data:image/png;base64,AQ==' }), visionAI: { complete: async rows => { messages = rows; return { positiveTags: ['2girls', 'garden'] }; } } });
  const result = await agent.generateTags.run({ requirements: '两个角色站在花园', imageId: 'source', description: 'OBSOLETE_BLUEPRINT', characterReferences: [{ id: 'a', name: 'A', identityTags: ['alice'], generalTags: ['DEFAULT_CLOTHES'], specificTags: [] }] });
  assert.equal(messages.length, 2);
  assert.match(messages[1].content[0].text, /两个角色站在花园/);
  assert.doesNotMatch(JSON.stringify(messages), /OBSOLETE_BLUEPRINT|DEFAULT_CLOTHES|characterReferences|角色身份资料/);
  assert.equal(messages[1].content[1].type, 'image_url');
  assert.deepEqual(result.data.positiveTags, ['2girls', 'garden']);
});

test('revision sees the exact previous Tags and current correction without old opinions or history', async () => {
  let messages;
  const agent = createFixedSubagents({ visionAI: { complete: async rows => { messages = rows; return { add: ['standing'], remove: ['sitting'], preserve: [] }; } } });
  const previous = { positiveTags: ['alice', 'sitting', 'garden'], negativeTags: [] };
  const result = await agent.generateTags.run({ operation: 'revise', requirements: '只改姿势', ...previous, evaluation: { userFeedback: '改为站立', score: 12, summary: 'OLD_SUMMARY', feedbackHistory: ['OLD_FEEDBACK'], issues: [{ suggestedChange: 'UNRELATED_CHANGE' }] }, description: 'OLD_BLUEPRINT' });
  const content = messages[1].content[0].text;
  assert.match(content, /alice, sitting, garden/);
  assert.match(content, /改为站立/);
  assert.doesNotMatch(content, /OLD_|UNRELATED_CHANGE|score|feedbackHistory/);
  assert.deepEqual(applyPromptPatch(previous, result.data).positiveTags, ['alice', 'garden', 'standing']);
});

test('structured current changes reach the reviser without truncating a long previous Tag baseline', async () => {
  let content;
  const tags = Array.from({ length: 200 }, (_, i) => `tag${i}`);
  const agent = createFixedSubagents({ visionAI: { complete: async rows => { content = rows[1].content[0].text; return { add: ['standing'], remove: [], preserve: [] }; } } });
  await agent.generateTags.run({ operation: 'revise', requirements: '改姿势', positiveTags: tags, changes: ['站立，保留其他内容'] });
  assert.match(content, /站立，保留其他内容/);
  assert.match(content, /tag199/);
});

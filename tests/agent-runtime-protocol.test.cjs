'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAgentRuntime } = require('../src/modules/agent-runtime');

const querySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { query: { type: 'string', minLength: 1 } },
  required: ['query']
};

function protocolTools(callHandler) {
  const names = ['tags.search', 'characters.search'];
  const entries = new Map(names.map(name => [name, {
    name,
    description: name,
    parameters: querySchema
  }]));
  return {
    resolve(name) { return entries.get(name) || null; },
    openAiTools() {
      return names.map(name => ({
        type: 'function',
        function: { name: name.replace('.', '_'), description: name, parameters: querySchema }
      }));
    },
    call: callHandler
  };
}

test('executes every valid tool call returned in one assistant response', async () => {
  const calls = [];
  let rounds = 0;
  const primaryClient = {
    complete: async () => {
      rounds += 1;
      return rounds === 1
        ? { toolCalls: [
          { id: 'tag-call', name: 'tags_search', arguments: { query: 'blue hair' } },
          { id: 'character-call', name: 'characters_search', arguments: { query: 'Alice' } }
        ] }
        : { text: 'done' };
    }
  };
  const tools = protocolTools(async name => {
    calls.push(name);
    return { ok: true, data: { items: [] } };
  });
  const runtime = createAgentRuntime({ primaryClient, tools, getSettings: () => ({ limits: {} }) });

  const result = await runtime.runPrimary({ input: { text: 'find references' } });

  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(calls, ['tags.search', 'characters.search']);
  assert.equal(result.data.toolCalls.length, 2);
  assert.equal(result.data.transcript.filter(row => row.role === 'tool').length, 2);
});

test('returns a failed tool result to the primary model for recovery', async () => {
  const requests = [];
  let rounds = 0;
  const primaryClient = {
    complete: async messages => {
      requests.push(messages);
      rounds += 1;
      return rounds === 1
        ? { toolCalls: [{ id: 'tag-call', name: 'tags_search', arguments: { query: 'blue hair' } }] }
        : { text: 'I recovered after the search failed.' };
    }
  };
  const tools = protocolTools(async () => ({
    ok: false,
    error: { code: 'TEMP_FAIL', message: 'temporary', retryable: true }
  }));
  const runtime = createAgentRuntime({ primaryClient, tools, getSettings: () => ({ limits: {} }) });

  const result = await runtime.runPrimary({ input: { text: 'search' } });

  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(requests.length, 2);
  assert.match(requests[1].find(row => row.role === 'tool').content, /TEMP_FAIL/);
  assert.equal(result.data.toolCalls[0].ok, false);
  assert.equal(result.data.toolCalls[0].error.code, 'TEMP_FAIL');
});

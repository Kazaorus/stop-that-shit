'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { defaultContract, parseContractPrompt } = require('../src/contracts.cjs');

test('explicit review directive enables guard by default', () => {
  const result = parseContractPrompt('$stop-that-shit review -- inspect the diff', defaultContract());
  assert.equal(result.contract.mode, 'review');
  assert.equal(result.contract.level, 'guard');
  assert.equal(result.contract.hashPolicy, 'deny');
});

test('hash policy defaults to deny and accepts an explicit override', () => {
  assert.equal(defaultContract().hashPolicy, 'deny');
  const result = parseContractPrompt('$stop-that-shit change hash=allow -- add the required release checksum');
  assert.equal(result.contract.hashPolicy, 'allow');
});

test('hash ask policy requires a separate approval decision', () => {
  const result = parseContractPrompt('$stop-that-shit change hash=ask -- implement the feature');
  assert.equal(result.contract.hashPolicy, 'ask');
});

test('optional lock fields parse from the directive head', () => {
  const result = parseContractPrompt('$stop-that-shit lock change files=src/config.cjs|test/** deps=allow -- implement it');
  assert.deepEqual(result.contract.allowedPaths, ['src/config.cjs', 'test/**']);
  assert.equal(result.contract.dependencyPolicy, 'allow');
});

test('files values preserve path casing while directive keywords stay case-insensitive', () => {
  const result = parseContractPrompt('$stop-that-shit LOCK CHANGE FILES=/Workspace/example/Config.toml|src/Config.cjs -- update config');
  assert.equal(result.contract.mode, 'change');
  assert.equal(result.contract.level, 'lock');
  assert.deepEqual(result.contract.allowedPaths, ['/Workspace/example/Config.toml', 'src/Config.cjs']);
});

test('Windows drive paths do not terminate the directive head', () => {
  const result = parseContractPrompt('$stop-that-shit lock change files=C:/Workspace/Config.toml: update config');
  assert.equal(result.contract.mode, 'change');
  assert.equal(result.contract.level, 'lock');
  assert.deepEqual(result.contract.allowedPaths, ['C:/Workspace/Config.toml']);
});

test('an explicit empty files value creates an empty file boundary', () => {
  const empty = parseContractPrompt('$stop-that-shit lock change files= -- update nothing');
  const omitted = parseContractPrompt('$stop-that-shit lock change -- update files');

  assert.deepEqual(empty.contract.allowedPaths, []);
  assert.equal(omitted.contract.allowedPaths, null);
});

test('agent limits default to the maximum safe integer', () => {
  const contract = defaultContract();
  assert.equal(contract.totalAgentBudget, Number.MAX_SAFE_INTEGER);
  assert.equal(contract.concurrentAgentBudget, Number.MAX_SAFE_INTEGER);
  assert.equal('agentBudget' in contract, false);
  assert.equal('agentsUsed' in contract, false);
});

test('total and concurrent agent limits are parsed independently', () => {
  const result = parseContractPrompt('$stop-that-shit lock change total-agents=3 concurrent-agents=2 -- implement it');
  assert.equal(result.contract.mode, 'change');
  assert.equal(result.contract.level, 'lock');
  assert.equal(result.contract.totalAgentBudget, 3);
  assert.equal(result.contract.concurrentAgentBudget, 2);
  assert.equal(result.error, null);
  assert.equal(result.warning, null);
});

test('zero is accepted for both agent limits', () => {
  const result = parseContractPrompt('$stop-that-shit change total-agents=0 concurrent-agents=0 -- implement it');
  assert.equal(result.contract.totalAgentBudget, 0);
  assert.equal(result.contract.concurrentAgentBudget, 0);
  assert.equal(result.error, null);
});

test('invalid agent limits return a structured error without changing the contract', () => {
  const previous = {
    ...defaultContract(),
    mode: 'change',
    level: 'guard',
    totalAgentBudget: 4,
    concurrentAgentBudget: 3
  };
  for (const token of ['total-agents=-1', 'total-agents=1.5', 'concurrent-agents=NaN', `concurrent-agents=${Number.MAX_SAFE_INTEGER + 1}`]) {
    const result = parseContractPrompt(`$stop-that-shit change ${token} -- implement it`, previous);
    assert.equal(result.error.code, 'INVALID_AGENT_LIMIT');
    assert.equal(result.error.token, token);
    assert.equal(result.changed, false);
    assert.deepEqual(result.contract, previous);
  }
});

test('legacy agents directive maps to total with a deprecation warning', () => {
  const result = parseContractPrompt('$stop-that-shit change agents=9 -- implement it');
  assert.equal(result.contract.totalAgentBudget, 9);
  assert.equal(result.contract.concurrentAgentBudget, Number.MAX_SAFE_INTEGER);
  assert.equal(result.error, null);
  assert.equal(result.warning.code, 'DEPRECATED_AGENT_DIRECTIVE');
  assert.equal(result.warning.token, 'agents=9');
  assert.equal(result.changed, true);
});

test('conflicting legacy and canonical total limits reject without partial updates', () => {
  const previous = {
    ...defaultContract(),
    mode: 'review',
    level: 'guard',
    totalAgentBudget: 4,
    concurrentAgentBudget: 3
  };
  const result = parseContractPrompt('$stop-that-shit change total-agents=9 agents=1 -- implement it', previous);
  assert.equal(result.error.code, 'CONFLICTING_AGENT_LIMITS');
  assert.equal(result.error.token, 'agents=1');
  assert.equal(result.changed, false);
  assert.deepEqual(result.contract, previous);
});

test('matching legacy and canonical total limits are accepted with a warning', () => {
  const result = parseContractPrompt('$stop-that-shit change total-agents=9 agents=9 -- implement it');
  assert.equal(result.contract.totalAgentBudget, 9);
  assert.equal(result.error, null);
  assert.equal(result.warning.code, 'DEPRECATED_AGENT_DIRECTIVE');
});

test('a long path does not truncate a later agent limit', () => {
  const longPath = `src/${'nested/'.repeat(20)}file.cjs`;
  const result = parseContractPrompt(`$stop-that-shit change files=${longPath} total-agents=7 -- implement it`);
  assert.equal(result.contract.totalAgentBudget, 7);
  assert.deepEqual(result.contract.allowedPaths, [longPath]);
});

test('implicit invocation stays watch-only until mode is confirmed', () => {
  const result = parseContractPrompt('Please avoid overengineering this task.');
  assert.equal(result.contract.mode, 'unconfirmed');
  assert.equal(result.contract.level, 'watch');
});

test('explicit fix request updates a prior review contract', () => {
  const prior = { ...defaultContract(), mode: 'review', level: 'guard' };
  const result = parseContractPrompt('Fix the P1 finding now. Do not change the others.', prior);
  assert.equal(result.contract.mode, 'change');
});

test('negative review language wins over the word fix', () => {
  const prior = { ...defaultContract(), mode: 'change', level: 'guard' };
  const result = parseContractPrompt("Review only. Don't fix anything.", prior);
  assert.equal(result.contract.mode, 'review');
});

test('off remains off before a mode is confirmed', () => {
  const result = parseContractPrompt('$stop-that-shit off');
  assert.equal(result.contract.level, 'off');
});

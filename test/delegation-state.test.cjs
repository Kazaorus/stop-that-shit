'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  activeDelegationCount,
  bindSubagent,
  clearDelegations,
  releaseReservation,
  releaseSubagent,
  reserveDelegation
} = require('../src/delegation-state.cjs');
const { readState, statePath } = require('../src/state.cjs');

function emptyDelegation() {
  return { totalAgentsUsed: 0, reservations: {}, agentIdsSeen: [] };
}

test('reservation increases total usage and active count by the requested batch size', () => {
  const next = reserveDelegation(emptyDelegation(), 'reservation-1', 'action-1', 2);
  assert.equal(next.totalAgentsUsed, 2);
  assert.deepEqual(next.reservations['reservation-1'], {
    actionId: 'action-1',
    pendingCount: 2,
    agentIds: []
  });
  assert.equal(activeDelegationCount(next), 2);
});

test('an agent binds once and duplicate starts do not increase activity', () => {
  const reserved = reserveDelegation(emptyDelegation(), 'reservation-1', 'action-1', 2);
  const bound = bindSubagent(reserved, 'agent-1', 'reservation-1');
  const duplicate = bindSubagent(bound, 'agent-1', 'reservation-1');
  assert.deepEqual(bound.reservations['reservation-1'], {
    actionId: 'action-1',
    pendingCount: 1,
    agentIds: ['agent-1']
  });
  assert.deepEqual(duplicate, bound);
  assert.equal(activeDelegationCount(duplicate), 2);
});

test('stopping an unknown or already stopped agent is idempotent', () => {
  const reserved = reserveDelegation(emptyDelegation(), 'reservation-1', 'action-1', 1);
  const bound = bindSubagent(reserved, 'agent-1', 'reservation-1');
  const stopped = releaseSubagent(bound, 'agent-1');
  assert.equal(activeDelegationCount(stopped), 0);
  assert.deepEqual(releaseSubagent(stopped, 'agent-1'), stopped);
  assert.deepEqual(releaseSubagent(stopped, 'unknown'), stopped);
});

test('late duplicate starts do not bind a later reservation', () => {
  let state = reserveDelegation(emptyDelegation(), 'reservation-1', 'action-1', 1);
  state = bindSubagent(state, 'agent-1', 'reservation-1');
  state = releaseSubagent(state, 'agent-1');
  state = reserveDelegation(state, 'reservation-2', 'action-2', 1);
  const duplicate = bindSubagent(state, 'agent-1', 'reservation-2');

  assert.deepEqual(duplicate, state);
  assert.equal(activeDelegationCount(duplicate), 1);
  assert.equal(duplicate.reservations['reservation-2'].pendingCount, 1);
});

test('late duplicate starts remain idempotent after action.after removed the reservation', () => {
  let state = reserveDelegation(emptyDelegation(), 'reservation-1', 'action-1', 1);
  state = bindSubagent(state, 'agent-1', 'reservation-1');
  state = releaseReservation(state, 'reservation-1');
  state = reserveDelegation(state, 'reservation-2', 'action-2', 1);

  const duplicate = bindSubagent(state, 'agent-1', 'reservation-2');
  assert.deepEqual(duplicate, state);
  assert.equal(duplicate.reservations['reservation-2'].pendingCount, 1);
});

test('after releases all remaining activity for one reservation without refunding total usage', () => {
  let state = reserveDelegation(emptyDelegation(), 'reservation-1', 'action-1', 2);
  state = bindSubagent(state, 'agent-1', 'reservation-1');
  state = reserveDelegation(state, 'reservation-2', 'action-2', 1);
  const released = releaseReservation(state, 'reservation-1');
  assert.equal(released.totalAgentsUsed, 3);
  assert.equal(activeDelegationCount(released), 1);
  assert.equal(released.reservations['reservation-1'], undefined);
});

test('session end clears reservations but preserves total usage', () => {
  const state = reserveDelegation(emptyDelegation(), 'reservation-1', 'action-1', 2);
  const cleared = clearDelegations(state);
  assert.equal(cleared.totalAgentsUsed, 2);
  assert.deepEqual(cleared.reservations, {});
  assert.equal(activeDelegationCount(cleared), 0);
});

test('readState migrates legacy agent usage to schema 2', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-state-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = statePath('legacy-session', dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    contract: {
      mode: 'change',
      level: 'guard',
      agentBudget: 8,
      agentsUsed: 5,
      hashPolicy: 'allow',
      allowedPaths: ['src/**'],
      dependencyPolicy: 'deny',
      source: 'directive'
    },
    lastPromptContext: 'legacy context'
  }));

  const state = readState('legacy-session', dataDir);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.contract.mode, 'change');
  assert.equal(state.contract.hashPolicy, 'allow');
  assert.deepEqual(state.contract.allowedPaths, ['src/**']);
  assert.equal(state.contract.totalAgentBudget, Number.MAX_SAFE_INTEGER);
  assert.equal(state.contract.concurrentAgentBudget, Number.MAX_SAFE_INTEGER);
  assert.equal('agentBudget' in state.contract, false);
  assert.equal('agentsUsed' in state.contract, false);
  assert.equal(state.delegation.totalAgentsUsed, 5);
  assert.deepEqual(state.delegation.reservations, {});
  assert.deepEqual(state.delegation.agentIdsSeen, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).delegation.agentIdsSeen, []);
  assert.equal(state.directiveError, null);
  assert.equal(state.lastPromptContext, 'legacy context');
});

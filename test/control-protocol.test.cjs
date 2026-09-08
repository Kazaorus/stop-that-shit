'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fromControlResult, handleCodexHook, toControlEvent } = require('../src/adapters/codex-hooks.cjs');
const { assertControlEvent, PROTOCOL_VERSION } = require('../src/control-protocol.cjs');
const { handleControlEvent } = require('../src/controller.cjs');
const { detectDependencyIntent } = require('../src/adapters/codex-tool-classifier.cjs');
const { readRuntime } = require('../src/runtime-audit.cjs');
const { readState } = require('../src/state.cjs');

function dataDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-protocol-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('Codex Adapter maps Hook JSON to ControlEvent v1', () => {
  const event = toControlEvent({
    session_id: 'session-1',
    turn_id: 'turn-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_use_id: 'call-1',
    tool_input: { command: 'patch' },
    model: 'gpt-example'
  });
  assert.equal(event.protocolVersion, PROTOCOL_VERSION);
  assert.equal(event.kind, 'action.before');
  assert.equal(event.action.mutability, 'write');
  assert.equal(event.action.hashIntent, false);
  assert.equal(event.host.model, 'gpt-example');
  assertControlEvent(event);
});

test('Codex Adapter maps lifecycle Hook fields to ControlEvent v1', () => {
  const after = toControlEvent({
    session_id: 'lifecycle-session',
    hook_event_name: 'PostToolUse',
    tool_use_id: 'call-1',
    tool_name: 'Agent',
    tool_input: { prompt: 'inspect' }
  });
  assert.equal(after.kind, 'action.after');
  assert.deepEqual(after.action, { id: 'call-1' });

  const start = toControlEvent({
    session_id: 'lifecycle-session',
    hook_event_name: 'SubagentStart',
    agent_id: 'agent-1',
    reservation_id: 'reservation:call-1'
  });
  assert.equal(start.kind, 'subagent.start');
  assert.equal(start.agentId, 'agent-1');
  assert.equal(start.reservationId, 'reservation:call-1');

  const stop = toControlEvent({
    session_id: 'lifecycle-session',
    hook_event_name: 'SubagentStop',
    agent_id: 'agent-1'
  });
  assert.equal(stop.kind, 'subagent.stop');
  assert.equal(stop.agentId, 'agent-1');

  const end = toControlEvent({
    session_id: 'lifecycle-session',
    hook_event_name: 'SessionEnd',
    reason: 'other'
  });
  assert.equal(end.kind, 'session.end');
  for (const hookEventName of ['PostToolUse', 'SubagentStop', 'SessionEnd']) {
    assert.equal(fromControlResult(hookEventName, { kind: 'context', text: 'observer context' }), null);
  }
});

test('Codex prompt hooks block legacy directives instead of dropping the error', (t) => {
  const directory = dataDir(t);
  handleCodexHook({
    session_id: 'invalid-directive',
    hook_event_name: 'UserPromptSubmit',
    prompt: '$stop-that-shit change total-agents=4 -- bounded delegation'
  }, { dataDir: directory });
  const output = handleCodexHook({
    session_id: 'invalid-directive',
    hook_event_name: 'UserPromptSubmit',
    prompt: '$stop-that-shit change agents=1 -- legacy syntax'
  }, { dataDir: directory });
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /agents=N directive was removed/);
  assert.deepEqual(fromControlResult('UserPromptSubmit', {
    kind: 'prompt-error',
    message: 'invalid prompt'
  }), { decision: 'block', reason: 'invalid prompt' });
});

test('Codex Adapter marks only high-confidence hashing actions', () => {
  const hashPatch = toControlEvent({
    session_id: 'session-1', hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    tool_input: { patch: "*** Begin Patch\n+const digest = createHash('sha256').update(data).digest('hex');\n*** End Patch" }
  });
  const prosePatch = toControlEvent({
    session_id: 'session-1', hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    tool_input: { patch: '*** Begin Patch\n+Document the hash policy without adding code.\n*** End Patch' }
  });
  assert.equal(hashPatch.action.hashIntent, true);
  assert.equal(prosePatch.action.hashIntent, false);
});

test('Codex Adapter extracts a patch path without guessing its semantics', () => {
  const event = toControlEvent({
    session_id: 'session-1', hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    tool_input: {
      patch: "*** Begin Patch\n*** Add File: src/legacy-adapter.cjs\n+function migrateLegacyConfig(value) { return value; }\n*** End Patch"
    }
  });
  assert.deepEqual(event.action.affectedPaths, ['src/legacy-adapter.cjs']);
  assert.equal(event.action.dependencyIntent, false);
});

test('dependency intent is scoped to added lines in manifest sections', () => {
  const unrelated = `*** Begin Patch
*** Update File: package.json
@@
-  "description": "old"
+  "description": "new"
*** Update File: src/report.cjs
@@
+const dependencies = { status: 'reported' };
*** End Patch`;
  assert.equal(detectDependencyIntent('apply_patch', { patch: unrelated }), false);

  const dependency = `*** Begin Patch
*** Update File: package.json
@@
+  "dependencies": { "example": "^1.0.0" }
*** End Patch`;
  assert.equal(detectDependencyIntent('apply_patch', { patch: dependency }), true);
});

test('Codex Adapter normalizes an absolute patch path relative to hook cwd', () => {
  const cwd = process.platform === 'win32' ? 'D:\\fixture' : '/fixture';
  const absolute = process.platform === 'win32' ? 'D:\\fixture\\src\\config.cjs' : '/fixture/src/config.cjs';
  const event = toControlEvent({
    session_id: 'session-1', hook_event_name: 'PreToolUse', cwd, tool_name: 'apply_patch',
    tool_input: { patch: `*** Begin Patch\n*** Update File: ${absolute}\n@@\n-old\n+new\n*** End Patch` }
  });
  assert.deepEqual(event.action.affectedPaths, ['src/config.cjs']);
  assert.equal(event.action.cwd, cwd);
});

test('controller decisions do not depend on model metadata', (t) => {
  const firstDir = dataDir(t);
  const secondDir = dataDir(t);
  const promptEvent = {
    protocolVersion: 1,
    kind: 'prompt.submit',
    sessionId: 'session-1',
    turnId: 'turn-1',
    prompt: '$stop-that-shit review -- inspect only'
  };
  handleControlEvent({ ...promptEvent, host: { family: 'codex', model: 'gpt-a' } }, { dataDir: firstDir });
  handleControlEvent({ ...promptEvent, host: { family: 'future-host', model: 'model-b' } }, { dataDir: secondDir });

  const action = {
    protocolVersion: 1,
    kind: 'action.before',
    sessionId: 'session-1',
    turnId: 'turn-1',
    action: { name: 'write-file', input: { path: 'x' }, mutability: 'write' }
  };
  const first = handleControlEvent({ ...action, host: { family: 'codex', model: 'gpt-a' } }, { dataDir: firstDir });
  const second = handleControlEvent({ ...action, host: { family: 'future-host', model: 'model-b' } }, { dataDir: secondDir });
  assert.deepEqual(first.decision, second.decision);
  assert.equal(first.kind, second.kind);
  assert.match(first.eventId, /^evt_/);
  assert.match(second.eventId, /^evt_/);
  assert.notEqual(first.eventId, second.eventId);
  assert.equal(first.message.replace(first.eventId, '<event>'), second.message.replace(second.eventId, '<event>'));
  assert.equal(first.kind, 'deny');
  assert.equal(readRuntime({ sessionId: 'session-1' }, { dataDir: firstDir }).events[0].decision.responseOutcome, 'permission_deny_returned');
  assert.equal(readRuntime({ sessionId: 'session-1' }, { dataDir: secondDir }).events[0].decision.responseOutcome, 'permission_deny_returned');
});

test('protocol rejects unknown versions and kinds', () => {
  assert.throws(() => assertControlEvent({ protocolVersion: 2, kind: 'prompt.submit', sessionId: 's', prompt: '' }), /protocolVersion/);
  assert.throws(() => assertControlEvent({ protocolVersion: 1, kind: 'model.changed', sessionId: 's' }), /kind/);
});

test('protocol accepts only non-negative integer delegation counts', () => {
  const event = {
    protocolVersion: 1,
    kind: 'action.before',
    sessionId: 'session-1',
    action: { name: 'delegate_task', input: {}, mutability: 'delegate' }
  };
  assert.doesNotThrow(() => assertControlEvent(event));
  assert.doesNotThrow(() => assertControlEvent({
    ...event,
    action: { ...event.action, delegationCount: 0 }
  }));
  assert.doesNotThrow(() => assertControlEvent({
    ...event,
    action: { ...event.action, delegationCount: 2 }
  }));
  for (const delegationCount of [-1, 1.5, '2']) {
    assert.throws(() => assertControlEvent({
      ...event,
      action: { ...event.action, delegationCount }
    }), /delegationCount/);
  }
});

test('protocol accepts lifecycle events and action identifiers', () => {
  assert.doesNotThrow(() => assertControlEvent({
    protocolVersion: 1,
    kind: 'action.after',
    sessionId: 'session-1',
    action: { id: 'call-1' }
  }));
  assert.doesNotThrow(() => assertControlEvent({
    protocolVersion: 1,
    kind: 'subagent.start',
    sessionId: 'session-1',
    agentId: 'agent-1',
    reservationId: 'reservation-1'
  }));
  assert.doesNotThrow(() => assertControlEvent({
    protocolVersion: 1,
    kind: 'subagent.stop',
    sessionId: 'session-1',
    agentId: 'agent-1'
  }));
  assert.doesNotThrow(() => assertControlEvent({
    protocolVersion: 1,
    kind: 'session.end',
    sessionId: 'session-1'
  }));
});

test('controller applies total and concurrent limits atomically', (t) => {
  const directory = dataDir(t);
  const base = { protocolVersion: 1, sessionId: 'ledger-session' };
  handleControlEvent({
    ...base,
    kind: 'prompt.submit',
    prompt: '$stop-that-shit change total-agents=3 concurrent-agents=2 -- delegate'
  }, { dataDir: directory });

  const first = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-1', name: 'delegate_task', mutability: 'delegate', delegationCount: 2 }
  }, { dataDir: directory });
  assert.equal(first.kind, 'none');
  assert.equal(readState('ledger-session', directory).delegation.totalAgentsUsed, 2);
  assert.equal(readState('ledger-session', directory).delegation.reservations['reservation:call-1'].pendingCount, 2);

  const concurrentDenied = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-2', name: 'delegate_task', mutability: 'delegate', delegationCount: 1 }
  }, { dataDir: directory });
  assert.equal(concurrentDenied.decision.reasonCode, 'CONCURRENT_AGENT_LIMIT');
  assert.equal(readState('ledger-session', directory).delegation.totalAgentsUsed, 2);

  handleControlEvent({ ...base, kind: 'action.after', action: { id: 'call-1' } }, { dataDir: directory });
  const lastUnit = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-3', name: 'delegate_task', mutability: 'delegate', delegationCount: 1 }
  }, { dataDir: directory });
  assert.equal(lastUnit.kind, 'none');

  const totalDenied = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-4', name: 'delegate_task', mutability: 'delegate', delegationCount: 1 }
  }, { dataDir: directory });
  assert.equal(totalDenied.decision.reasonCode, 'TOTAL_AGENT_LIMIT');
  assert.equal(readState('ledger-session', directory).delegation.totalAgentsUsed, 3);
});

test('subagent start and stop events are idempotent and action.after releases pending work', (t) => {
  const directory = dataDir(t);
  const base = { protocolVersion: 1, sessionId: 'lifecycle-session' };
  handleControlEvent({ ...base, kind: 'prompt.submit', prompt: '$stop-that-shit change concurrent-agents=2 -- delegate' }, { dataDir: directory });
  handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-1', name: 'delegate_task', mutability: 'delegate', delegationCount: 2 }
  }, { dataDir: directory });

  handleControlEvent({ ...base, kind: 'subagent.start', agentId: 'agent-1', reservationId: 'reservation:call-1' }, { dataDir: directory });
  handleControlEvent({ ...base, kind: 'subagent.start', agentId: 'agent-1', reservationId: 'reservation:call-1' }, { dataDir: directory });
  assert.equal(readState('lifecycle-session', directory).delegation.reservations['reservation:call-1'].pendingCount, 1);
  handleControlEvent({ ...base, kind: 'subagent.stop', agentId: 'agent-1' }, { dataDir: directory });
  handleControlEvent({ ...base, kind: 'subagent.stop', agentId: 'agent-1' }, { dataDir: directory });
  assert.equal(readState('lifecycle-session', directory).delegation.reservations['reservation:call-1'].pendingCount, 1);
  handleControlEvent({ ...base, kind: 'action.after', action: { id: 'call-1' } }, { dataDir: directory });
  handleControlEvent({ ...base, kind: 'action.after', action: { id: 'call-1' } }, { dataDir: directory });
  assert.equal(readState('lifecycle-session', directory).delegation.totalAgentsUsed, 2);
  assert.equal(Object.keys(readState('lifecycle-session', directory).delegation.reservations).length, 0);

  handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-2', name: 'delegate_task', mutability: 'delegate', delegationCount: 1 }
  }, { dataDir: directory });
  handleControlEvent({ ...base, kind: 'subagent.start', agentId: 'agent-1' }, { dataDir: directory });
  handleControlEvent({ ...base, kind: 'subagent.stop', agentId: 'agent-1' }, { dataDir: directory });
  assert.equal(readState('lifecycle-session', directory).delegation.reservations['reservation:call-2'].pendingCount, 1);
  handleControlEvent({ ...base, kind: 'action.after', action: { id: 'call-2' } }, { dataDir: directory });
});

test('legacy directive records an error and blocks later delegation until corrected', (t) => {
  const directory = dataDir(t);
  const base = { protocolVersion: 1, sessionId: 'directive-session' };
  handleControlEvent({ ...base, kind: 'prompt.submit', prompt: '$stop-that-shit change total-agents=4 -- delegate' }, { dataDir: directory });
  const invalid = handleControlEvent({ ...base, kind: 'prompt.submit', prompt: '$stop-that-shit change agents=1 -- delegate' }, { dataDir: directory });
  assert.equal(invalid.kind, 'prompt-error');
  assert.equal(readState('directive-session', directory).contract.totalAgentBudget, 4);
  assert.equal(readState('directive-session', directory).directiveError.code, 'LEGACY_AGENT_DIRECTIVE');

  const denied = handleControlEvent({
    ...base,
    kind: 'action.before',
    action: { id: 'call-1', name: 'delegate_task', mutability: 'delegate', delegationCount: 1 }
  }, { dataDir: directory });
  assert.equal(denied.decision.reasonCode, 'INVALID_DIRECTIVE');

  handleControlEvent({ ...base, kind: 'prompt.submit', prompt: '$stop-that-shit change total-agents=4 -- corrected' }, { dataDir: directory });
  assert.equal(readState('directive-session', directory).directiveError, null);
});

test('Codex Adapter renders a normalized deny result back to PreToolUse JSON', () => {
  const output = fromControlResult('PreToolUse', {
    kind: 'deny',
    message: 'Stop That Shit [I/MODE_FORBIDS_MUTATION]: blocked'
  });
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /MODE_FORBIDS_MUTATION/);
});

test('controller implementation contains no Codex Hook event names', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.cjs'), 'utf8');
  assert.doesNotMatch(source, /PreToolUse|PostToolUse|UserPromptSubmit|SubagentStart|hook_event_name/);
});

'use strict';

const { PROTOCOL_VERSION } = require('../control-protocol.cjs');
const { handleControlEvent } = require('../controller.cjs');
const {
  classifyHermesTool,
  countHermesDelegation,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths
} = require('./hermes-tool-classifier.cjs');

const EVENT_KIND = {
  pre_llm_call: 'prompt.submit',
  pre_tool_call: 'action.before',
  post_tool_call: 'action.after',
  subagent_start: 'subagent.start',
  subagent_stop: 'subagent.stop',
  on_session_end: 'session.end'
};

function toControlEvent(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = EVENT_KIND[input.hook_event_name];
  if (!kind) return null;

  const extra = input.extra && typeof input.extra === 'object' ? input.extra : {};
  const event = {
    protocolVersion: PROTOCOL_VERSION,
    kind,
    sessionId: String(input.session_id || extra.parent_session_id || ''),
    turnId: extra.turn_id || extra.parent_turn_id || input.turn_id || null,
    host: {
      family: 'hermes-agent',
      model: input.model || extra.model || null,
      permissionMode: null,
      agentId: null,
      agentType: null
    }
  };

  if (kind === 'prompt.submit') {
    event.prompt = String(extra.user_message || '');
  }

  if (kind === 'action.before') {
    event.action = {
      id: input.tool_call_id || extra.tool_call_id || null,
      name: String(input.tool_name || 'unknown'),
      input: input.tool_input,
      mutability: classifyHermesTool(input.tool_name, input.tool_input),
      delegationCount: countHermesDelegation(input.tool_name, input.tool_input),
      hashIntent: detectHashIntent(input.tool_name, input.tool_input),
      dependencyIntent: detectDependencyIntent(input.tool_name, input.tool_input),
      affectedPaths: extractAffectedPaths(input.tool_name, input.tool_input, input.cwd),
      cwd: input.cwd,
      unboundedDelegation: false
    };
  }

  if (kind === 'action.after') {
    const actionId = input.tool_call_id || extra.tool_call_id || null;
    if (!actionId) return null;
    event.action = { id: String(actionId) };
  }

  if (kind === 'subagent.start' || kind === 'subagent.stop') {
    const agentId = extra.child_session_id
      || input.child_session_id
      || extra.child_subagent_id
      || input.child_subagent_id
      || null;
    if (agentId) event.agentId = String(agentId);
    const reservationId = extra.reservation_id || extra.reservationId || null;
    if (reservationId) event.reservationId = String(reservationId);
  }

  return event;
}

function fromControlResult(result, kind) {
  if (!result || result.kind === 'none') return null;
  if (result.kind === 'context') {
    if (['subagent.start', 'subagent.stop', 'session.end'].includes(kind)) return null;
    return { context: result.text };
  }
  if (result.kind === 'deny') return { action: 'block', message: result.message };
  return null;
}

function handleHermesHook(input, options = {}) {
  const event = toControlEvent(input);
  if (!event) return null;
  return fromControlResult(handleControlEvent(event, options), event.kind);
}

module.exports = {
  fromControlResult,
  handleHermesHook,
  toControlEvent
};

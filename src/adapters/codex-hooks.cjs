'use strict';

const { PROTOCOL_VERSION } = require('../control-protocol.cjs');
const { handleControlEvent } = require('../controller.cjs');
const { classifyCodexTool, detectDependencyIntent, detectHashIntent, extractAffectedPaths } = require('./codex-tool-classifier.cjs');

const EVENT_KIND = {
  SessionStart: 'session.start',
  UserPromptSubmit: 'prompt.submit',
  PreToolUse: 'action.before',
  PostToolUse: 'action.after',
  SubagentStart: 'subagent.start',
  SubagentStop: 'subagent.stop',
  SessionEnd: 'session.end'
};

function toControlEvent(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = EVENT_KIND[input.hook_event_name];
  if (!kind) return null;

  const event = {
    protocolVersion: PROTOCOL_VERSION,
    kind,
    sessionId: String(input.session_id || ''),
    turnId: input.turn_id || null,
    host: {
      family: 'codex',
      model: input.model || null,
      permissionMode: input.permission_mode || null
    }
  };

  if (kind === 'prompt.submit') event.prompt = String(input.prompt || '');
  if (kind === 'action.after') {
    event.action = {
      id: input.tool_use_id || input.tool_call_id || null
    };
  }
  if (kind === 'action.before') {
    event.action = {
      id: input.tool_use_id || null,
      name: String(input.tool_name || 'unknown'),
      input: input.tool_input,
      mutability: classifyCodexTool(input.tool_name, input.tool_input),
      hashIntent: detectHashIntent(input.tool_name, input.tool_input),
      dependencyIntent: detectDependencyIntent(input.tool_name, input.tool_input),
      affectedPaths: extractAffectedPaths(input.tool_name, input.tool_input, input.cwd),
      cwd: input.cwd
    };
  }
  if (kind === 'subagent.start' || kind === 'subagent.stop') {
    event.agentId = input.agent_id || input.agentId || null;
    const reservationId = input.reservation_id || input.reservationId;
    if (reservationId) event.reservationId = reservationId;
  }
  return event;
}

function contextOutput(hookEventName, text) {
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: text
    }
  };
}

function fromControlResult(hookEventName, result) {
  if (!result || result.kind === 'none') {
    return null;
  }
  if (result.kind === 'prompt-error') {
    return {
      decision: 'block',
      reason: result.message
    };
  }
  if (result.kind === 'context') {
    if (['PostToolUse', 'SubagentStop', 'SessionEnd'].includes(hookEventName)) return null;
    return contextOutput(hookEventName, result.text);
  }
  if (result.kind === 'deny') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: result.message
      }
    };
  }
  return null;
}

function handleCodexHook(input, options = {}) {
  const event = toControlEvent(input);
  if (!event) return null;
  const result = handleControlEvent(event, options);
  return fromControlResult(input.hook_event_name, result);
}

module.exports = {
  fromControlResult,
  handleCodexHook,
  toControlEvent
};

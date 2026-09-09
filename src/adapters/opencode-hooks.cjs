'use strict';

const { PROTOCOL_VERSION } = require('../control-protocol.cjs');
const { handleControlEvent } = require('../controller.cjs');
const {
  classifyOpenCodeTool,
  detectDependencyIntent,
  detectHashIntent,
  extractAffectedPaths
} = require('./opencode-tool-classifier.cjs');
const { optionalIdentifier, readAsyncLaunched } = require('./lifecycle-fields.cjs');

function promptText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part && part.type === 'text' && !part.synthetic && !part.ignored)
    .map((part) => String(part.text || ''))
    .filter(Boolean)
    .join('\n');
}

function hostMetadata(input) {
  const model = input && input.model;
  return {
    family: 'opencode',
    agent: input && input.agent || null,
    model: model && model.providerID && model.modelID ? `${model.providerID}/${model.modelID}` : null,
    messageId: input && input.messageID || null
  };
}

function toPromptEvent(input, output, context = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'prompt.submit',
    sessionId: String(context.controlSessionID || input && input.sessionID || ''),
    prompt: promptText(output && output.parts),
    host: hostMetadata(input)
  };
}

function toActionEvent(input, output, context = {}) {
  const toolName = String(input && input.tool || 'unknown');
  const args = output && output.args;
  const mutability = classifyOpenCodeTool(toolName, args);
  const actionId = optionalIdentifier(input && input.callID, input && input.callId);
  if (mutability === 'delegate' && !actionId) return null;
  const action = {
    id: actionId,
    name: toolName,
    input: args,
    mutability,
    affectedPaths: extractAffectedPaths(toolName, args, context.directory),
    cwd: context.directory,
    dependencyIntent: detectDependencyIntent(toolName, args),
    hashIntent: detectHashIntent(toolName, args)
  };
  const asyncLaunched = readAsyncLaunched(input, args);
  if (mutability === 'delegate' && asyncLaunched !== null) action.asyncLaunched = asyncLaunched;
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'action.before',
    sessionId: String(context.controlSessionID || input && input.sessionID || ''),
    host: hostMetadata(input),
    action
  };
}

function toActionAfterEvent(input, context = {}) {
  const actionId = optionalIdentifier(input && input.callID, input && input.callId);
  if (!actionId) return null;
  const action = { id: actionId };
  const asyncLaunched = readAsyncLaunched(input, input && input.args)
    ?? (input && input.tool === 'task' ? false : null);
  if (asyncLaunched !== null) action.asyncLaunched = asyncLaunched;
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'action.after',
    sessionId: String(context.controlSessionID || input && input.sessionID || ''),
    host: hostMetadata(input),
    action
  };
}

function toSubagentStartEvent(input, context = {}) {
  const agentId = optionalIdentifier(input && (input.agentId || input.agent_id || input.childSessionID || input.childSessionId || input.id));
  const reservationId = optionalIdentifier(input && (input.reservationId || input.reservation_id || input.callID || input.callId));
  if (!agentId) return null;
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'subagent.start',
    sessionId: String(context.controlSessionID || input && input.sessionID || ''),
    host: hostMetadata(input),
    agentId,
    ...(reservationId ? { reservationId } : {})
  };
}

function toSubagentStopEvent(input, context = {}) {
  const agentId = optionalIdentifier(input && (input.agentId || input.agent_id || input.childSessionID || input.childSessionId || input.id));
  if (!agentId) return null;
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'subagent.stop',
    sessionId: String(context.controlSessionID || input && input.sessionID || ''),
    host: hostMetadata(input),
    agentId
  };
}

function toSessionEndEvent(input, context = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'session.end',
    sessionId: String(context.controlSessionID || input && input.sessionID || ''),
    host: hostMetadata(input)
  };
}

function controllerOptions(options) {
  return { ...options, denialResponseOutcome: 'execution_denial_returned' };
}

function handleOpenCodeMessage(input, output, context = {}, options = {}) {
  return handleControlEvent(toPromptEvent(input, output, context), controllerOptions(options));
}

function handleOpenCodeTool(input, output, context = {}, options = {}) {
  const event = toActionEvent(input, output, context);
  return event ? handleControlEvent(event, controllerOptions(options)) : { kind: 'none' };
}

function handleOpenCodeToolAfter(input, output, context = {}, options = {}) {
  const event = toActionAfterEvent(input, context);
  return event ? handleControlEvent(event, controllerOptions(options)) : { kind: 'none' };
}

function handleOpenCodeSessionEnd(input, context = {}, options = {}) {
  return handleControlEvent(toSessionEndEvent(input, context), controllerOptions(options));
}

module.exports = {
  handleOpenCodeMessage,
  handleOpenCodeSessionEnd,
  handleOpenCodeTool,
  handleOpenCodeToolAfter,
  promptText,
  toActionAfterEvent,
  toActionEvent,
  toSubagentStartEvent,
  toSubagentStopEvent,
  toSessionEndEvent,
  toPromptEvent
};

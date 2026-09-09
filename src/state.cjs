'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultContract } = require('./contracts.cjs');

function dataRoot(override) {
  return override || process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'stop-that-shit-dev');
}

function sessionKey(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId || 'unknown')).digest('hex').slice(0, 24);
}

function statePath(sessionId, override) {
  return path.join(dataRoot(override), 'sessions', `${sessionKey(sessionId)}.json`);
}

function freshState() {
  return {
    schemaVersion: 2,
    contract: defaultContract(),
    delegation: {
      totalAgentsUsed: 0,
      reservations: {},
      agentIdsSeen: [],
      stoppedAgentIds: [],
      acceptedActions: {}
    },
    directiveWarning: null,
    directiveError: null,
    lastPromptContext: null
  };
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeDelegation(value, legacyUsed) {
  const source = value && typeof value === 'object' ? value : {};
  const reservations = {};
  if (source.reservations && typeof source.reservations === 'object') {
    for (const [reservationId, reservation] of Object.entries(source.reservations)) {
      if (!reservation || typeof reservation !== 'object') continue;
      reservations[reservationId] = {
        actionId: typeof reservation.actionId === 'string' ? reservation.actionId : '',
        asyncLaunched: typeof reservation.asyncLaunched === 'boolean' ? reservation.asyncLaunched : null,
        pendingCount: safeCount(reservation.pendingCount),
        agentIds: Array.isArray(reservation.agentIds)
          ? [...new Set(reservation.agentIds.filter((agentId) => typeof agentId === 'string' && agentId))]
          : []
      };
    }
  }
  const acceptedActions = source.acceptedActions && typeof source.acceptedActions === 'object'
    ? Object.fromEntries(Object.entries(source.acceptedActions)
      .filter(([actionId, count]) => typeof actionId === 'string' && actionId
        && Number.isSafeInteger(count) && count >= 0))
    : {};
  for (const reservation of Object.values(reservations)) {
    if (!reservation.actionId || Object.prototype.hasOwnProperty.call(acceptedActions, reservation.actionId)) continue;
    acceptedActions[reservation.actionId] = reservation.pendingCount + reservation.agentIds.length;
  }
  const hasNewTotal = Number.isSafeInteger(source.totalAgentsUsed) && source.totalAgentsUsed >= 0;
  return {
    totalAgentsUsed: hasNewTotal ? source.totalAgentsUsed : safeCount(legacyUsed),
    reservations,
    agentIdsSeen: Array.isArray(source.agentIdsSeen)
      ? [...new Set(source.agentIdsSeen.filter((agentId) => typeof agentId === 'string' && agentId))]
      : [],
    stoppedAgentIds: Array.isArray(source.stoppedAgentIds)
      ? [...new Set(source.stoppedAgentIds.filter((agentId) => typeof agentId === 'string' && agentId))]
      : [],
    acceptedActions
  };
}

function normalizeState(parsed) {
  const fresh = freshState();
  const legacyContract = parsed.contract && typeof parsed.contract === 'object' ? parsed.contract : {};
  const contract = { ...fresh.contract, ...legacyContract };
  const legacyBudget = Number.isSafeInteger(legacyContract.agentBudget) && legacyContract.agentBudget >= 0
    ? legacyContract.agentBudget
    : null;
  if (!Object.prototype.hasOwnProperty.call(legacyContract, 'totalAgentBudget') && legacyBudget !== null) {
    contract.totalAgentBudget = legacyBudget;
  }
  delete contract.agentBudget;
  delete contract.agentsUsed;
  if (!Number.isSafeInteger(contract.totalAgentBudget) || contract.totalAgentBudget < 0) {
    contract.totalAgentBudget = fresh.contract.totalAgentBudget;
  }
  if (!Number.isSafeInteger(contract.concurrentAgentBudget) || contract.concurrentAgentBudget < 0) {
    contract.concurrentAgentBudget = fresh.contract.concurrentAgentBudget;
  }
  return {
    schemaVersion: 2,
    contract,
    delegation: normalizeDelegation(parsed.delegation, legacyContract.agentsUsed),
    directiveWarning: parsed.directiveWarning && typeof parsed.directiveWarning === 'object' ? parsed.directiveWarning : null,
    directiveError: parsed.directiveError && typeof parsed.directiveError === 'object' ? parsed.directiveError : null,
    lastPromptContext: parsed.lastPromptContext ?? null
  };
}

function readState(sessionId, override) {
  const file = statePath(sessionId, override);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const normalized = normalizeState(parsed);
    const hasDelegation = Object.prototype.hasOwnProperty.call(parsed, 'delegation');
    const hasDirectiveWarning = Object.prototype.hasOwnProperty.call(parsed, 'directiveWarning');
    const hasDirectiveError = Object.prototype.hasOwnProperty.call(parsed, 'directiveError');
    const hasPromptContext = Object.prototype.hasOwnProperty.call(parsed, 'lastPromptContext');
    const hasAgentIdsSeen = parsed.delegation
      && typeof parsed.delegation === 'object'
      && Object.prototype.hasOwnProperty.call(parsed.delegation, 'agentIdsSeen');
    const hasStoppedAgentIds = parsed.delegation
      && typeof parsed.delegation === 'object'
      && Object.prototype.hasOwnProperty.call(parsed.delegation, 'stoppedAgentIds');
    const hasAcceptedActions = parsed.delegation
      && typeof parsed.delegation === 'object'
      && Object.prototype.hasOwnProperty.call(parsed.delegation, 'acceptedActions');
    if (parsed.schemaVersion !== 2 || !hasDelegation || !hasDirectiveWarning || !hasDirectiveError || !hasPromptContext || !hasAgentIdsSeen || !hasStoppedAgentIds || !hasAcceptedActions) {
      writeState(sessionId, normalized, override);
    }
    return normalized;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.name === 'SyntaxError')) return freshState();
    throw error;
  }
}

function writeState(sessionId, state, override) {
  const file = statePath(sessionId, override);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    fs.copyFileSync(temporary, file);
    fs.unlinkSync(temporary);
  }
}


function lockPath(sessionId, override) {
  return `${statePath(sessionId, override)}.lock`;
}

function sleepSync(milliseconds) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, milliseconds);
}

function acquireSessionLock(sessionId, override, options = {}) {
  const file = lockPath(sessionId, override);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : 10000;
  const started = Date.now();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  while (true) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      const token = `${process.pid}:${crypto.randomUUID()}`;
      fs.writeFileSync(fd, `${token} ${Date.now()}\n`, 'utf8');
      return () => {
        try { fs.closeSync(fd); } catch {}
        try {
          const owner = fs.readFileSync(file, 'utf8').trim().split(/\s+/, 1)[0];
          if (owner === token) fs.unlinkSync(file);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(file);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(file);
          continue;
        }
      } catch (statError) {
        if (statError && statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - started >= timeoutMs) {
        const timeout = new Error(`Timed out waiting for Stop That Shit session lock: ${sessionKey(sessionId)}`);
        timeout.code = 'STS_LOCK_TIMEOUT';
        throw timeout;
      }
      sleepSync(10);
    }
  }
}

function withSessionLock(sessionId, override, fn, options) {
  const release = acquireSessionLock(sessionId, override, options);
  try {
    return fn();
  } finally {
    release();
  }
}

module.exports = {
  acquireSessionLock,
  dataRoot,
  freshState,
  readState,
  sessionKey,
  statePath,
  withSessionLock,
  writeState
};

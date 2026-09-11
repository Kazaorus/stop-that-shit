'use strict';

function reservationsOf(state) {
  return state && state.reservations && typeof state.reservations === 'object'
    ? state.reservations
    : {};
}

function seenAgentIds(state) {
  return Array.isArray(state && state.agentIdsSeen) ? state.agentIdsSeen : [];
}

function stoppedAgentIds(state) {
  return Array.isArray(state && state.stoppedAgentIds) ? state.stoppedAgentIds : [];
}

function acceptedActions(state) {
  return state && state.acceptedActions && typeof state.acceptedActions === 'object'
    ? state.acceptedActions
    : {};
}

function acceptedActionCount(state, actionId) {
  if (typeof actionId !== 'string' || !actionId) return null;
  const count = acceptedActions(state)[actionId];
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function activeDelegationCount(state) {
  return Object.values(reservationsOf(state)).reduce((total, reservation) => {
    const pendingCount = Number.isSafeInteger(reservation && reservation.pendingCount) && reservation.pendingCount >= 0
      ? reservation.pendingCount
      : 0;
    const agentCount = Array.isArray(reservation && reservation.agentIds)
      ? reservation.agentIds.length
      : 0;
    return total + pendingCount + agentCount;
  }, 0);
}

function reserveDelegation(state, reservationId, actionId, count) {
  if (typeof reservationId !== 'string' || !reservationId) throw new TypeError('reservationId must be a non-empty string.');
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('reservation count must be a non-negative safe integer.');
  const reservations = reservationsOf(state);
  if (reservations[reservationId]) return state;
  const normalizedActionId = String(actionId || '');
  const priorCount = acceptedActionCount(state, normalizedActionId);
  if (priorCount !== null) return state;
  const accepted = { ...acceptedActions(state) };
  if (normalizedActionId) accepted[normalizedActionId] = count;
  return {
    ...state,
    acceptedActions: accepted,
    reservations: {
      ...reservations,
      [reservationId]: {
        actionId: normalizedActionId,
        asyncLaunched: null,
        pendingCount: count,
        agentIds: []
      }
    }
  };
}

function markReservationAsync(state, reservationId, asyncLaunched) {
  if (!reservationsOf(state)[reservationId] || typeof asyncLaunched !== 'boolean') return state;
  const reservation = reservationsOf(state)[reservationId];
  if (reservation.asyncLaunched === true || reservation.asyncLaunched === asyncLaunched) return state;
  return {
    ...state,
    reservations: {
      ...reservationsOf(state),
      [reservationId]: { ...reservation, asyncLaunched }
    }
  };
}

function bindSubagent(state, agentId, reservationId) {
  if (typeof agentId !== 'string' || !agentId) return state;
  if (seenAgentIds(state).includes(agentId)) return state;
  const reservations = reservationsOf(state);
  const reservation = reservations[reservationId];
  if (stoppedAgentIds(state).includes(agentId)) {
    if (!reservation || !Number.isInteger(reservation.pendingCount) || reservation.pendingCount <= 0) return state;
    const nextReservations = { ...reservations };
    if (reservation.pendingCount === 1 && (!Array.isArray(reservation.agentIds) || reservation.agentIds.length === 0)) {
      delete nextReservations[reservationId];
    } else {
      nextReservations[reservationId] = { ...reservation, pendingCount: reservation.pendingCount - 1 };
    }
    return {
      ...state,
      agentIdsSeen: [...new Set([...seenAgentIds(state), agentId])],
      reservations: nextReservations
    };
  }
  if (Object.values(reservations).some((reservation) => Array.isArray(reservation.agentIds) && reservation.agentIds.includes(agentId))) {
    return state;
  }
  if (!reservation || !Number.isInteger(reservation.pendingCount) || reservation.pendingCount <= 0) return state;
  return {
    ...state,
    agentIdsSeen: [...new Set([...seenAgentIds(state), agentId])],
    reservations: {
      ...reservations,
      [reservationId]: {
        ...reservation,
        pendingCount: reservation.pendingCount - 1,
        agentIds: [...(Array.isArray(reservation.agentIds) ? reservation.agentIds : []), agentId]
      }
    }
  };
}

function releaseSubagent(state, agentId) {
  if (typeof agentId !== 'string' || !agentId) return state;
  const stopped = stoppedAgentIds(state);
  const reservations = reservationsOf(state);
  for (const [reservationId, reservation] of Object.entries(reservations)) {
    const agentIds = Array.isArray(reservation.agentIds) ? reservation.agentIds : [];
    if (!agentIds.includes(agentId)) continue;
    const remainingAgents = agentIds.filter((value) => value !== agentId);
    const nextReservations = { ...reservations };
    if (reservation.pendingCount === 0 && remainingAgents.length === 0) {
      delete nextReservations[reservationId];
    } else {
      nextReservations[reservationId] = { ...reservation, agentIds: remainingAgents };
    }
    return {
      ...state,
      stoppedAgentIds: [...new Set([...stopped, agentId])],
      reservations: nextReservations
    };
  }
  if (stopped.includes(agentId)) return state;
  return { ...state, stoppedAgentIds: [...stopped, agentId] };
}

function releaseReservation(state, reservationId) {
  if (typeof reservationId !== 'string' || !reservationId || !reservationsOf(state)[reservationId]) return state;
  const reservations = { ...reservationsOf(state) };
  delete reservations[reservationId];
  return { ...state, reservations };
}

function clearDelegations(state) {
  return { ...state, reservations: {} };
}

function reservationForAction(state, actionId) {
  if (typeof actionId !== 'string' || !actionId) return null;
  for (const [reservationId, reservation] of Object.entries(reservationsOf(state))) {
    if (reservation && reservation.actionId === actionId) return reservationId;
  }
  return null;
}

module.exports = {
  acceptedActionCount,
  activeDelegationCount,
  bindSubagent,
  clearDelegations,
  markReservationAsync,
  releaseReservation,
  releaseSubagent,
  reserveDelegation,
  reservationForAction
};

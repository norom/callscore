/**
 * The match in progress, and how to step back through it.
 *
 * In d10 undo was "drop the last point", which is exact when every change is
 * one point. A spoken score can be two points, or a rebuilt game, so undo here
 * puts back the point list as it was before the last change instead. History
 * is kept in memory only: after a restart there is nothing to step back to,
 * and undo falls back to dropping a point.
 */

export const HISTORY_LIMIT = 50;

export function createSession({ points, firstServer }) {
  return { points, firstServer, history: [] };
}

const samePoints = (a, b) => a === b || (a.length === b.length && a.every((team, i) => team === b[i]));

export function commit(session, points) {
  if (samePoints(session.points, points)) return session;

  return {
    ...session,
    points,
    history: [...session.history, session.points].slice(-HISTORY_LIMIT),
  };
}

export function undo(session) {
  if (session.history.length > 0) {
    return {
      ...session,
      points: session.history[session.history.length - 1],
      history: session.history.slice(0, -1),
    };
  }

  if (session.points.length === 0) return session;
  return { ...session, points: session.points.slice(0, -1) };
}

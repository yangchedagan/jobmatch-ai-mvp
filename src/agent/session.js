const sessions = new Map();
const SESSION_TTL_MS = Number(process.env.AGENT_SESSION_TTL_MS || 30 * 60 * 1000);
const HISTORY_LIMIT = 16;

export function getOrCreateAgentSession(sessionId) {
  cleanupAgentSessions();
  const id = sessionId && sessions.has(sessionId) ? sessionId : createSessionId();
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      created_at: Date.now(),
      updated_at: Date.now(),
      history: [],
      resumeId: null,
      lastJobIds: [],
      lastJobId: null,
      lastReportSummary: null,
    });
  }
  const session = sessions.get(id);
  session.updated_at = Date.now();
  return session;
}

export function appendHistory(session, role, content) {
  session.history.push({ role, content: String(content || "").slice(0, 4000) });
  if (session.history.length > HISTORY_LIMIT) session.history.splice(0, session.history.length - HISTORY_LIMIT);
  session.updated_at = Date.now();
}

export function cleanupAgentSessions(now = Date.now()) {
  for (const [id, session] of sessions.entries()) {
    if (now - session.updated_at > SESSION_TTL_MS) sessions.delete(id);
  }
}

export function agentSessionCount() {
  cleanupAgentSessions();
  return sessions.size;
}

function createSessionId() {
  return `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

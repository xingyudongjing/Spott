"use client";

import { useEffect, useState } from "react";

import {
  bootstrapSession,
  logoutCurrentSession,
  readSession,
  refreshCurrentSession,
  subscribeSessionChanges,
  type WebSession,
} from "../../lib/client-api";

export function SessionCoordinationProbe() {
  const [session, setSession] = useState<WebSession | null>(null);
  const [result, setResult] = useState("idle");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let active = true;
    const synchronize = () => {
      if (active) setSession(readSession());
    };
    const unsubscribe = subscribeSessionChanges(synchronize);
    void bootstrapSession().then((value) => {
      if (active) setSession(value);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function coordinateRefresh() {
    setRunning(true);
    setResult("running");
    try {
      const refreshed = await refreshCurrentSession();
      setSession(readSession());
      setResult(refreshed ? "refreshed" : "unavailable");
    } catch {
      setSession(readSession());
      setResult("failed");
    } finally {
      setRunning(false);
    }
  }

  async function coordinateLogout(scope: "current" | "all") {
    setRunning(true);
    setResult(scope === "all" ? "logging-out-all" : "logging-out");
    try {
      const completed = await logoutCurrentSession(scope);
      setSession(readSession());
      setResult(completed ? "logged-out" : "logout-unconfirmed");
    } catch {
      setSession(readSession());
      setResult("failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <main>
      <h1>Session coordination probe</h1>
      <dl>
        <div>
          <dt>State</dt>
          <dd data-testid="session-coordination-state">
            {session ? "authenticated" : "anonymous"}
          </dd>
        </div>
        <div>
          <dt>Generation</dt>
          <dd data-testid="session-coordination-generation">
            {session?.refreshGeneration ?? "-"}
          </dd>
        </div>
        <div>
          <dt>User</dt>
          <dd data-testid="session-coordination-user">{session?.user.id ?? "-"}</dd>
        </div>
        <div>
          <dt>Result</dt>
          <dd data-testid="session-coordination-result">{result}</dd>
        </div>
      </dl>
      <button type="button" disabled={running || !session} onClick={() => void coordinateRefresh()}>
        {running ? "Coordinating…" : "Coordinate refresh"}
      </button>
      <button type="button" disabled={!session} onClick={() => void coordinateLogout("current")}>
        Log out current session
      </button>
      <button type="button" disabled={!session} onClick={() => void coordinateLogout("all")}>
        Log out every session
      </button>
    </main>
  );
}

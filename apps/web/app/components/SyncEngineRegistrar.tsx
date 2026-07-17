"use client";

import { useEffect } from "react";

import { readSession, subscribeSessionChanges } from "../lib/client-api";
import { getSyncEngine } from "../lib/sync-engine";

/**
 * Boots the shared {@link SyncEngine} for the signed-in session so cross-device
 * writes become visible without a manual refresh (dev doc §6). The engine opens
 * a realtime wake-up channel in the foreground and degrades to short polling,
 * consuming `/sync/pull` and `/sync/push`. It only runs while a session exists
 * and tears down on sign-out or account switch.
 */
export function SyncEngineRegistrar() {
  useEffect(() => {
    const engine = getSyncEngine();

    const sync = () => {
      if (readSession()) engine.start();
      else engine.stop();
    };

    sync();
    const unsubscribe = subscribeSessionChanges(sync);
    return () => {
      unsubscribe();
      engine.stop();
    };
  }, []);

  return null;
}

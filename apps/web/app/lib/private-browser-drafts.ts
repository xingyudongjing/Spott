"use client";

import { clearAllComposerDrafts } from "../create/event-composer-draft";
import { clearAllGroupTransferCaches } from "./group-transfer-cache";
import { clearAllRegistrationDrafts } from "./registration-draft";

function browserStorage(kind: "localStorage" | "sessionStorage"): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window[kind];
  } catch {
    return null;
  }
}

export function clearPrivateBrowserDrafts(): void {
  const sessionStorage = browserStorage("sessionStorage");
  if (sessionStorage) clearAllRegistrationDrafts(sessionStorage);

  const localStorage = browserStorage("localStorage");
  if (!localStorage) return;
  clearAllComposerDrafts(localStorage);
  clearAllGroupTransferCaches(localStorage);
}

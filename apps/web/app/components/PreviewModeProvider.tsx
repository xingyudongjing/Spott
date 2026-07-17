"use client";

import { createContext, useContext } from "react";

import type { PreviewMode } from "../lib/preview-mode";

const PreviewModeContext = createContext<PreviewMode>("standard");

export function PreviewModeProvider({
  children,
  initialMode,
}: {
  children: React.ReactNode;
  initialMode: PreviewMode;
}) {
  return (
    <PreviewModeContext.Provider value={initialMode}>
      {children}
    </PreviewModeContext.Provider>
  );
}

export function usePreviewMode(): PreviewMode {
  return useContext(PreviewModeContext);
}

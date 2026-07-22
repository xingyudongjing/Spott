import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import "../../app/globals.css";
import { AppDialogProvider } from "../../app/components/AppDialog";
import { I18nProvider } from "../../app/components/I18nProvider";
import { PreviewModeProvider } from "../../app/components/PreviewModeProvider";
import type { Locale } from "../../app/i18n/messages";
import { StudioEventsClient } from "../../app/studio/events/StudioEventsClient";
import { hostStudioCaptureItems } from "./fixture";

const locale = captureLocale(new URLSearchParams(window.location.search).get("locale"));

function CaptureSurface() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!cancelled) setReady(true);
      }));
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <div data-host-studio-capture-ready={ready ? "true" : "false"}>
      <I18nProvider initialLocale={locale}>
        <PreviewModeProvider initialMode="read-only">
          <AppDialogProvider>
            <StudioEventsClient initialItems={hostStudioCaptureItems(locale)} />
          </AppDialogProvider>
        </PreviewModeProvider>
      </I18nProvider>
    </div>
  );
}

const captureWindow = window as typeof window & { __spottHostStudioCaptureRoot__?: Root };
const captureRoot = captureWindow.__spottHostStudioCaptureRoot__ ?? createRoot(document.getElementById("root")!);
captureWindow.__spottHostStudioCaptureRoot__ = captureRoot;
captureRoot.render(
  <StrictMode>
    <CaptureSurface />
  </StrictMode>,
);

function captureLocale(value: string | null): Locale {
  return value === "ja" || value === "en" ? value : "zh-Hans";
}

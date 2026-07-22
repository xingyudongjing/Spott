import { StrictMode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import "../../app/globals.css";
import { DiscoveryShell } from "../../app/components/discovery/DiscoveryShell";
import { EventDetailView } from "../../app/components/event/EventDetail";
import { I18nProvider } from "../../app/components/I18nProvider";
import { PreviewModeProvider } from "../../app/components/PreviewModeProvider";
import { SiteHeader } from "../../app/components/SiteHeader";
import { EventActions } from "../../app/e/[slug]/EventActions";
import { GroupsDirectory } from "../../app/groups/GroupsDirectory";
import type { Locale } from "../../app/i18n/messages";
import {
  marketingCaptureFixture,
  type MarketingCaptureSurface,
} from "./fixture";

const params = new URLSearchParams(window.location.search);
const locale = captureLocale(params.get("locale"));
const surface = captureSurface(params.get("surface"));

function CaptureSurface() {
  const [ready, setReady] = useState(false);
  const fixture = marketingCaptureFixture(locale);
  const expectedHeading = surface === "discover"
    ? fixture.copy.discoverHeading
    : surface === "event-detail"
      ? fixture.copy.eventTitle
      : fixture.copy.groupsHeading;

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
    <I18nProvider initialLocale={locale}>
      <PreviewModeProvider initialMode="standard">
        <div
          data-capture-locale={locale}
          data-capture-surface={surface}
          data-expected-heading={expectedHeading}
          data-forbidden-fixture-text={JSON.stringify(fixture.forbiddenFixtureText)}
          data-marketing-product-capture-ready={ready ? "true" : "false"}
        >
          <SiteHeader />
          <div id="spott-main-content">
            {surface === "discover" ? (
              <main>
                <DiscoveryShell
                  initialError={null}
                  initialFeed={fixture.discoveryFeed}
                  initialPage={null}
                  initialQuery={{}}
                />
              </main>
            ) : null}
            {surface === "event-detail" ? (
              <EventDetailView
                actions={<EventActions event={fixture.detail} session={null} />}
                event={fixture.detail}
                locale={locale}
              />
            ) : null}
            {surface === "groups" ? (
              <main><GroupsDirectory initialItems={fixture.groups} /></main>
            ) : null}
          </div>
        </div>
      </PreviewModeProvider>
    </I18nProvider>
  );
}

const captureWindow = window as typeof window & { __spottMarketingProductCaptureRoot__?: Root };
const captureRoot = captureWindow.__spottMarketingProductCaptureRoot__ ?? createRoot(document.getElementById("root")!);
captureWindow.__spottMarketingProductCaptureRoot__ = captureRoot;
captureRoot.render(<StrictMode><CaptureSurface /></StrictMode>);

function captureLocale(value: string | null): Locale {
  return value === "ja" || value === "en" ? value : "zh-Hans";
}

function captureSurface(value: string | null): MarketingCaptureSurface {
  if (value === "event-detail" || value === "groups") return value;
  return "discover";
}

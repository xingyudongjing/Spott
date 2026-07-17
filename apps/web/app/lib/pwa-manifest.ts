import type { MetadataRoute } from "next";

import { formatMessage, type Locale } from "../i18n/messages";
import { tokyoPath } from "./city-locale";

export function buildManifest(locale: Locale): MetadataRoute.Manifest {
  return {
    id: "/",
    name: formatMessage(locale, "pwa.name"),
    short_name: "Spott",
    description: formatMessage(locale, "pwa.description"),
    start_url: `${tokyoPath(locale)}?source=pwa`,
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#F7F5F0",
    theme_color: "#F7F5F0",
    lang: locale,
    categories: ["social", "lifestyle", "events"],
    icons: [
      { src: "/spott-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/spott-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/spott-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/spott-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
    shortcuts: [
      { name: formatMessage(locale, "pwa.discover"), short_name: formatMessage(locale, "pwa.discover"), url: tokyoPath(locale), icons: [{ src: "/spott-icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: formatMessage(locale, "pwa.myEvents"), short_name: formatMessage(locale, "pwa.myEvents"), url: "/me/events", icons: [{ src: "/spott-icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: formatMessage(locale, "pwa.create"), short_name: formatMessage(locale, "pwa.create"), url: "/create", icons: [{ src: "/spott-icon-192.png", sizes: "192x192", type: "image/png" }] },
    ],
  };
}

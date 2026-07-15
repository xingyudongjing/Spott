import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/discover",
    name: "Spott · Local events in Japan",
    short_name: "Spott",
    description: "Discover, join, and host real local events across Japan.",
    start_url: "/discover?source=pwa",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#F7F6F2",
    theme_color: "#F7F6F2",
    lang: "zh-Hans",
    categories: ["social", "lifestyle", "events"],
    icons: [{ src: "/spott-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
    shortcuts: [
      { name: "Discover", short_name: "Discover", url: "/discover", icons: [{ src: "/spott-icon.svg", sizes: "any", type: "image/svg+xml" }] },
      { name: "My events", short_name: "My events", url: "/me/events", icons: [{ src: "/spott-icon.svg", sizes: "any", type: "image/svg+xml" }] },
      { name: "Create event", short_name: "Create", url: "/create", icons: [{ src: "/spott-icon.svg", sizes: "any", type: "image/svg+xml" }] },
    ],
  };
}

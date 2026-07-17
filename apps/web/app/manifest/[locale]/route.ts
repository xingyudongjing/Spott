import { isLocale } from "../../i18n/messages";
import { buildManifest } from "../../lib/pwa-manifest";

export async function GET(_request: Request, context: { params: Promise<{ locale: string }> }) {
  const raw = decodeURIComponent((await context.params).locale).replace(/\.webmanifest$/, "");
  if (!isLocale(raw)) return new Response("Not found", { status: 404 });

  return Response.json(buildManifest(raw), {
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Content-Language": raw,
    },
  });
}

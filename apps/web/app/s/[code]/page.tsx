import { notFound, redirect } from "next/navigation";

const apiBase =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:4100/v1" : "https://api.spott.jp/v1");

interface ShareResolution {
  resourceType: "event" | "group" | "profile";
  resourceId: string;
  canonicalPath: string;
  sessionId: string;
}

export default async function ShareLinkPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  let resolved: ShareResolution;
  try {
    const response = await fetch(`${apiBase}/shares/${encodeURIComponent(code)}`, {
      cache: "no-store",
      headers: { "X-Spott-Anonymous-Id": crypto.randomUUID() },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) notFound();
    resolved = (await response.json()) as ShareResolution;
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    notFound();
  }

  if (!/^\/(e|g|u)\/[A-Za-z0-9_-]+$/.test(resolved.canonicalPath)) notFound();
  redirect(resolved.canonicalPath);
}

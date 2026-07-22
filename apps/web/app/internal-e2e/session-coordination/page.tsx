import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SessionCoordinationProbe } from "./SessionCoordinationProbe";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function SessionCoordinationPage() {
  if (process.env.SPOTT_E2E_SESSION_COORDINATION !== "1") notFound();
  return <SessionCoordinationProbe />;
}

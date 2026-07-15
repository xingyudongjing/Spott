import type { Metadata } from "next";
import { OpsConsole, type OpsSection } from "../../components/OpsConsole";

export const metadata: Metadata = { title: "运营工作台" };

const sections = new Set<OpsSection>([
  "overview",
  "users",
  "organizers",
  "events",
  "groups",
  "moderation",
  "points",
  "config",
  "analytics",
  "audit",
  "exports",
]);

export default async function OpsPage({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  const value = (await params).section?.[0] ?? "overview";
  const section = sections.has(value as OpsSection) ? (value as OpsSection) : "overview";
  return <OpsConsole section={section} />;
}

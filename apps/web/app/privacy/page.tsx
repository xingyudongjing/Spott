import type { Metadata } from "next";

import { LegalDocument } from "../components/legal/LegalDocument";
import { legalDocument } from "../components/legal/legal-content";
import { serverLocale } from "../i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await serverLocale();
  const document = legalDocument(locale, "privacy");
  return {
    title: document.title,
    description: document.metaDescription,
    alternates: { canonical: "/privacy" },
    openGraph: {
      title: `${document.title} · Spott`,
      description: document.metaDescription,
      url: "/privacy",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: `${document.title} · Spott`,
      description: document.metaDescription,
    },
  };
}

export default async function PrivacyPage() {
  const locale = await serverLocale();
  return <LegalDocument document={legalDocument(locale, "privacy")} locale={locale} />;
}

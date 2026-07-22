import type { Metadata } from "next";

import { formatMessage, type Locale } from "../../i18n/messages";
import { configuredCanonicalOrigin } from "../../lib/canonical-origin";
import { marketingPaths } from "./marketing-copy";

const openGraphLocales: Record<Locale, string> = {
  "zh-Hans": "zh_CN",
  ja: "ja_JP",
  en: "en_US",
};

function canonicalURLs(origin: string) {
  return {
    "zh-Hans": new URL(marketingPaths["zh-Hans"], origin).toString(),
    ja: new URL(marketingPaths.ja, origin).toString(),
    en: new URL(marketingPaths.en, origin).toString(),
  };
}

type MarketingMetadataOptions = {
  readonly hasQuery?: boolean;
};

type MarketingSearchParams = Promise<Record<string, string | string[] | undefined>>;

export function marketingMetadata(
  locale: Locale,
  { hasQuery = false }: MarketingMetadataOptions = {},
): Metadata {
  const origin = configuredCanonicalOrigin(process.env);
  const urls = canonicalURLs(origin);
  const title = formatMessage(locale, "marketing.metadata.title");
  const description = formatMessage(locale, "marketing.metadata.description");
  const imageAlt = formatMessage(locale, "marketing.metadata.imageAlt");
  const previewImage = {
    url: `/marketing/product/web-discover-${locale}-desktop.png`,
    width: 1440,
    height: 900,
    alt: imageAlt,
    type: "image/png",
  } as const;
  const alternateLocale = Object.entries(openGraphLocales)
    .filter(([candidate]) => candidate !== locale)
    .map(([, value]) => value);

  return {
    metadataBase: new URL(origin),
    title: { absolute: title },
    description,
    applicationName: "Spott",
    manifest: null,
    alternates: {
      canonical: urls[locale],
      languages: {
        "zh-Hans": urls["zh-Hans"],
        ja: urls.ja,
        en: urls.en,
        "x-default": urls["zh-Hans"],
      },
    },
    openGraph: {
      title,
      description,
      siteName: "Spott",
      type: "website",
      url: urls[locale],
      locale: openGraphLocales[locale],
      alternateLocale,
      images: [previewImage],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [previewImage.url],
    },
    robots: { index: !hasQuery, follow: !hasQuery },
  };
}

export async function marketingMetadataForSearchParams(
  locale: Locale,
  searchParams: MarketingSearchParams,
): Promise<Metadata> {
  const raw = await searchParams;
  return marketingMetadata(locale, { hasQuery: Object.keys(raw).length > 0 });
}

export function marketingStructuredData(locale: Locale): string {
  const origin = configuredCanonicalOrigin(process.env);
  const urls = canonicalURLs(origin);
  const organizationID = new URL("/#organization", origin).toString();
  const websiteID = new URL("/#website", origin).toString();

  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": organizationID,
        name: "Spott",
        url: new URL("/", origin).toString(),
        logo: new URL("/spott-icon-512.png", origin).toString(),
      },
      {
        "@type": "WebSite",
        "@id": websiteID,
        name: "Spott",
        url: urls[locale],
        description: formatMessage(locale, "marketing.metadata.description"),
        inLanguage: locale,
        publisher: { "@id": organizationID },
      },
    ],
  }).replaceAll("<", "\\u003c");
}

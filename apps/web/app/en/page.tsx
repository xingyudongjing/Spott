import type { Metadata } from "next";

import { MarketingHome } from "../components/marketing/MarketingHome";
import { marketingMetadataForSearchParams } from "../components/marketing/MarketingMetadata";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export function generateMetadata({ searchParams }: { readonly searchParams: SearchParams }): Promise<Metadata> {
  return marketingMetadataForSearchParams("en", searchParams);
}

export default function EnglishMarketingHome() {
  return <MarketingHome locale="en" />;
}

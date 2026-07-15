import { DiscoverExperience } from "../../components/DiscoverExperience";
import { Footer } from "../../components/Footer";
import { getEvents } from "../../lib/api";

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  return <main><DiscoverExperience initialEvents={await getEvents()} initialCategory={(await params).slug} /><Footer /></main>;
}

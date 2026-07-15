import { DiscoverExperience } from "./components/DiscoverExperience";
import { Footer } from "./components/Footer";
import { getEvents } from "./lib/api";

export default async function Home() {
  const events = await getEvents();
  return (
    <main>
      <DiscoverExperience initialEvents={events} />
      <Footer />
    </main>
  );
}

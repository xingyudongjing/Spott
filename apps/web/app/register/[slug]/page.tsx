import { notFound } from "next/navigation";
import { EventAPIError } from "../../lib/events-api";
import { fetchEventForRequest } from "../../lib/events-server";
import { RegistrationFlow } from "./RegistrationFlow";

export default async function RegisterPage({ params }: { params: Promise<{ slug: string }> }) {
  try {
    return <RegistrationFlow event={await fetchEventForRequest((await params).slug)} />;
  } catch (error) {
    if (error instanceof EventAPIError && error.status === 404) notFound();
    throw error;
  }
}

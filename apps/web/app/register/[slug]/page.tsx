import { notFound } from "next/navigation";
import { getEvent } from "../../lib/api";
import { RegistrationFlow } from "./RegistrationFlow";

export default async function RegisterPage({ params }: { params: Promise<{ slug: string }> }) {
  const event = await getEvent((await params).slug);
  if (!event) notFound();
  return <RegistrationFlow event={event} />;
}

import { HostFeedback } from "./HostFeedback";

export default async function HostFeedbackPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <HostFeedback eventId={id} />;
}

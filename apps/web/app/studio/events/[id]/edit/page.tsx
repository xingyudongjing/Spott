import { EventComposer } from "../../../../create/EventComposer";

export default async function StudioEventEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EventComposer editEventId={id} />;
}

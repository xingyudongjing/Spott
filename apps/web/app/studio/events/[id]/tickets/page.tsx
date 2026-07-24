import { TicketTypeManager } from "./TicketTypeManager";

export default async function StudioTicketTypesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TicketTypeManager eventId={id} />;
}

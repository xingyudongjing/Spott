import { AnnouncementComposer } from "./AnnouncementComposer";

export default async function StudioAnnouncementsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AnnouncementComposer eventId={id} />;
}

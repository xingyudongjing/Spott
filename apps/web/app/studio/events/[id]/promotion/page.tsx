import { PromotionManager } from "./PromotionManager";

export default async function StudioPromotionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PromotionManager eventId={id} />;
}

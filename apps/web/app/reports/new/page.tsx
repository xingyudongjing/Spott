import { ReportForm } from "./ReportForm";

export default async function ReportPage({ searchParams }: { searchParams: Promise<{ targetType?: string; targetId?: string }> }) {
  const { targetType, targetId } = await searchParams;
  return <ReportForm initialTargetType={targetType} initialTargetId={targetId} />;
}

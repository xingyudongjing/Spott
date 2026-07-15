import { GroupExperience } from "./GroupExperience";

export default async function GroupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <GroupExperience slug={slug} />;
}

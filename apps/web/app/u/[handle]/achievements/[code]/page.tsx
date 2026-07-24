import { AchievementLanding } from "./AchievementLanding";

export default async function AchievementLandingPage({
  params,
}: {
  params: Promise<{ handle: string; code: string }>;
}) {
  const { handle, code } = await params;
  return <AchievementLanding handle={handle} code={code} />;
}

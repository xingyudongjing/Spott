import { PhoneVerificationFlow } from "./PhoneVerificationFlow";

export default async function PhoneVerificationPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const { returnTo } = await searchParams;
  return <PhoneVerificationFlow returnTo={returnTo} />;
}

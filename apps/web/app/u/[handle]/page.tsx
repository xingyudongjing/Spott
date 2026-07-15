import { HostProfile } from "./HostProfile";

export default async function ProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  return <HostProfile handle={(await params).handle} />;
}

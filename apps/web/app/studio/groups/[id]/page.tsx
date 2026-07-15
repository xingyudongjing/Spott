import { GroupManager } from "./GroupManager";

export default async function GroupManagementPage({ params }: { params: Promise<{ id: string }> }) {
  return <GroupManager groupId={(await params).id} />;
}

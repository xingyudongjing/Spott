import { AttendeeManager } from "./AttendeeManager";

export default async function AttendeesPage({ params }: { params: Promise<{ id: string }> }) {
  return <AttendeeManager eventId={(await params).id} />;
}

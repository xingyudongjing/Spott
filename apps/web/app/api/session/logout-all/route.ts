import { handleSessionLogout } from '../../../lib/session-logout';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function POST(request: Request): Promise<Response> {
  return handleSessionLogout(request, 'all');
}

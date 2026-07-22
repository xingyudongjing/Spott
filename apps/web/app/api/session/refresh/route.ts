import { handleSessionRefresh } from '../../../lib/session-refresh';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function POST(request: Request): Promise<Response> {
  return handleSessionRefresh(request);
}

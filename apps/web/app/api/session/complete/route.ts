import { handleSessionComplete } from '../../../lib/session-complete';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function POST(request: Request): Promise<Response> {
  return handleSessionComplete(request);
}

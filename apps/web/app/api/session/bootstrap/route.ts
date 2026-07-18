import { handleSessionBootstrap } from '../../../lib/session-bootstrap';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function GET(request: Request): Promise<Response> {
  return handleSessionBootstrap(request);
}

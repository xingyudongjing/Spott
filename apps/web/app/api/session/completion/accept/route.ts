import { handleSessionCompletionDisposition } from '../../../../lib/session-completion-disposition';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function POST(request: Request): Promise<Response> {
  return handleSessionCompletionDisposition(request, 'accept');
}

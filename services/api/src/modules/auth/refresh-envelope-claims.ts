import { z } from 'zod';

export const webRefreshEnvelopeDBClaimsSchema = z
  .object({
    sessionId: z.string().uuid(),
    familyId: z.string().uuid(),
    generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    transportClass: z.literal('web_bff'),
    persistentBindingId: z.string().uuid(),
    persistentBindingGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type WebRefreshEnvelopeDBClaims = z.infer<typeof webRefreshEnvelopeDBClaimsSchema>;

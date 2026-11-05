import type { z } from 'zod';
import type { browserChallengeSchema } from '@sazuz/core/browser';
export type BrowserChallenge = z.infer<typeof browserChallengeSchema>;

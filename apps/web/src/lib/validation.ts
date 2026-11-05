import { z } from 'zod';

// Configure before schema imports: Zod's optional JIT probe violates a strict browser CSP.
z.config({ jitless: true });

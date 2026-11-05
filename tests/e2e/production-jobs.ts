import { expect, type APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import { knowledgeJobSchema } from '@sazuz/core/memory';

/** Keep each model fixture alive until the real worker finishes its queued extraction. */
export async function waitForProductionExtractions(request: APIRequestContext, runIds: string[]) {
  await expect
    .poll(
      async () => {
        const response = await request.get('/api/memory/jobs');
        expect(response.status()).toBe(200);
        const jobs = z.array(knowledgeJobSchema).parse(await response.json());
        return runIds.map(
          (id) => jobs.find((job) => job.kind === 'extract' && job.runId === id)?.status,
        );
      },
      { timeout: 30000, intervals: [500, 1000] },
    )
    .toEqual(runIds.map(() => 'completed'));
}

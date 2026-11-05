import { z } from 'zod';
import {
  proposalDecisionSchema,
  proposalQuerySchema,
  skillProposalSchema,
} from '@sazuz/core/proposals';
import { decideSkillProposal, listSkillProposals } from '@sazuz/skills';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { workPath } from './phase-three-shared.js';

export function registerSkillProposals(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
) {
  app.get(
    '/api/skills/proposals',
    {
      schema: {
        querystring: proposalQuerySchema,
        response: { 200: z.array(skillProposalSchema).max(50) },
      },
    },
    async (request) =>
      listSkillProposals(
        runtime.database,
        (await runtime.admin(request)).user.id,
        request.query.projectId,
      ),
  );
  app.post(
    '/api/skills/proposals/:id/decision',
    {
      schema: {
        params: workPath,
        body: proposalDecisionSchema,
        response: { 200: skillProposalSchema },
      },
    },
    async (request) =>
      decideSkillProposal(
        runtime.database,
        (await runtime.admin(request)).user.id,
        request.params.id,
        request.body,
      ),
  );
}

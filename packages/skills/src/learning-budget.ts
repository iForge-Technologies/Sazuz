import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
import {
  costLedger,
  getControl,
  remainingSpend,
  workKey,
  type Database,
  type Transaction,
} from '@sazuz/db';
import { LearningError } from '@sazuz/core/learning';
import type { SettingsDocument } from '@sazuz/config/settings';
import type { ModelRouter } from '@sazuz/llm';
import { renderToolOutput } from '@sazuz/tools';
import { safeSkillText } from './loader.js';

export interface LearningBudgetOptions {
  database: Database;
  receiptId: string;
  projectId?: string;
  projectCap?: number | null;
  agentId: string;
  privateOnly: boolean;
  getSettings: () => SettingsDocument;
  router: Pick<ModelRouter, 'generateObject'>;
  maxUsd: number;
  maxCalls: number;
  maxOutputTokens: number;
  timeoutMs: number;
  onCost(tx: Transaction, amount: number): Promise<void>;
}
export async function withLearningBudget<T>(
  options: LearningBudgetOptions,
  consume: (
    generate: <V>(input: {
      role: 'planner' | 'executor' | 'fast';
      system: string;
      data: unknown;
      schema: z.ZodType<V>;
      privateOnly?: boolean;
    }) => Promise<V>,
  ) => Promise<T>,
) {
  const db = options.database;
  const lease = await db.pool.connect();
  let locked = false;
  const timeoutMs = Math.min(
    options.timeoutMs,
    options.getSettings().budgets.value.maxWallTimeSeconds * 1000,
  );
  const deadline = Date.now() + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const lockDeadline = Date.now() + 5000;
    while (!locked) {
      locked =
        (await lease.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(72839102) AS locked'))
          .rows[0]?.locked ?? false;
      if (!locked) {
        if (Date.now() >= lockDeadline) throw new LearningError('LEARNING_LIMIT');
        await delay(50, undefined, { signal });
      }
    }
    const settings = options.getSettings();
    const budget = Math.min(
      options.maxUsd,
      settings.budgets.value.perRunUsd,
      await remainingSpend(
        db,
        settings.budgets.value,
        options.projectId,
        options.projectCap ?? undefined,
      ),
    );
    let spent = 0,
      calls = 0;
    const generate = async <V>(input: {
      role: 'planner' | 'executor' | 'fast';
      system: string;
      data: unknown;
      schema: z.ZodType<V>;
      privateOnly?: boolean;
    }): Promise<V> => {
      const current = options.getSettings().budgets.value;
      const callBudget = Math.min(
        budget - spent,
        current.perRunUsd - spent,
        await remainingSpend(db, current, options.projectId, options.projectCap ?? undefined),
      );
      if (
        ++calls > Math.min(options.maxCalls, settings.budgets.value.maxSteps, current.maxSteps) ||
        Date.now() >= deadline ||
        spent > budget ||
        callBudget < 0 ||
        (await getControl(db)).paused
      )
        throw new LearningError('LEARNING_LIMIT');
      safeSkillText(JSON.stringify(input.data));
      if (JSON.stringify(input.data).length > 90000) throw new LearningError('LEARNING_LIMIT');
      const before = spent;
      const result = await options.router.generateObject(
        {
          role: input.role,
          tools: [],
          privateOnly: options.privateOnly || input.privateOnly === true,
          remainingBudgetUsd: Math.max(0, callBudget),
          maxOutputTokens: options.maxOutputTokens,
          signal,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: renderToolOutput({ output: input.data, untrusted: true }) },
          ],
          onUsage: async (usage) => {
            spent += usage.costUsd;
            await db.orm.transaction(async (tx) => {
              await tx.insert(costLedger).values({
                id: workKey('cost'),
                runId: options.receiptId,
                projectId: options.projectId ?? null,
                agentId: options.agentId,
                providerId: usage.providerId,
                modelId: usage.modelId,
                inputTokens: usage.usage.inputTokens,
                outputTokens: usage.usage.outputTokens,
                cachedInputTokens: usage.usage.cachedInputTokens,
                costUsd: usage.costUsd,
                estimated: usage.costEstimated,
                latencyMs: usage.latencyMs,
                status: usage.status,
              });
              await options.onCost(tx, usage.costUsd);
            });
          },
        },
        input.schema,
        { maxAttempts: 1 },
      );
      if (spent > budget + 1e-9 || spent - before > callBudget + 1e-9 || Date.now() >= deadline)
        throw new LearningError('LEARNING_LIMIT');
      const object = input.schema.parse(result.object);
      safeSkillText(JSON.stringify(object));
      return object;
    };
    return await consume(generate);
  } finally {
    let reusable = false;
    try {
      if (locked) await lease.query('SELECT pg_advisory_unlock(72839102)');
      reusable = true;
    } finally {
      lease.release(!reusable);
    }
  }
}

import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createMission,
  getMission,
  runs,
  taskAttempts,
  toolCalls,
  workflowNodeRuns,
} from '@sazuz/db';
import { workflowDefinitionSchema } from '@sazuz/core/workflows';
import { saveWorkflow, reviewWorkflow, runWorkflow } from '../../packages/workflows/src/index.js';
import { graphPlanSchema } from '@sazuz/core/graphs';
import { createDurableExecutor } from '../../packages/runtime/src/durable.js';
import { createFixtureRouter, createFixtureTools } from './phase-three-runtime-worker.js';
import { phaseFourFixture } from './phase-four-fixture.js';
import { registerPhaseSix } from '../../apps/server/src/phase-six.js';

describe.each(['graph', 'workflow'])('Durable %s process recovery', (kind) => {
  it('kills a real worker after a child side effect and resumes the same task attempt without a second effect', async () => {
    const fixture = await phaseFourFixture(registerPhaseSix, { maxConnections: 24 });
    const children = new Set<ChildProcess>(),
      held = new Set<ServerResponse>();
    const effects = new Map<string, { value: string; count: number }>();
    let reads = 0;
    const server = createServer((request, response) => {
      void (async () => {
        const key = decodeURIComponent((request.url ?? '').slice('/effects/'.length));
        if (request.method === 'GET') {
          reads++;
          const effect = effects.get(key);
          response
            .writeHead(effect ? 200 : 404, { 'content-type': 'application/json' })
            .end(JSON.stringify(effect ? { written: true, value: effect.value } : {}));
          return;
        }
        const parts: Buffer[] = [];
        for await (const part of request)
          parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array));
        const body = z
          .object({ value: z.string() })
          .parse(JSON.parse(Buffer.concat(parts).toString('utf8')));
        effects.set(key, { value: body.value, count: (effects.get(key)?.count ?? 0) + 1 });
        held.add(response);
        response.on('close', () => held.delete(response));
      })().catch(() => response.writeHead(500).end());
    });
    async function stop(child: ChildProcess) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      children.delete(child);
    }
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture address unavailable.');
      const origin = `http://127.0.0.1:${address.port}`;
      async function start() {
        const child = fork(
          fileURLToPath(new URL('./phase-three-runtime-worker.ts', import.meta.url)),
          [],
          {
            cwd: fileURLToPath(new URL('../../', import.meta.url)),
            execArgv: ['--import', 'tsx'],
            windowsHide: true,
            env: {
              ...process.env,
              SAZUZ_PHASE3_RUNTIME_WORKER: '1',
              SAZUZ_PHASE3_FIXTURE_ORIGIN: origin,
              SAZUZ_PHASE3_DATA_DIR: fixture.directory,
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          },
        );
        children.add(child);
        let ready = false;
        child.stdout?.resume();
        child.stderr?.resume();
        child.on('message', (input: unknown) => {
          if (z.object({ kind: z.literal('ready') }).safeParse(input).success) ready = true;
        });
        await vi.waitFor(
          () => {
            expect(child.exitCode).toBeNull();
            expect(ready).toBe(true);
          },
          { timeout: 30000, interval: 40 },
        );
        return child;
      }
      async function workflowTask() {
        const saved = await saveWorkflow(fixture.db, fixture.userId, null, {
          projectId: fixture.projectId,
          expectedVersion: 0,
          definition: workflowDefinitionSchema.parse({
            name: 'Recover a workflow effect',
            nodes: [
              {
                id: 'start',
                label: 'Start',
                position: { x: 0, y: 0 },
                action: { kind: 'trigger', trigger: { kind: 'manual' } },
              },
              {
                id: 'write',
                label: 'Write once',
                position: { x: 250, y: 0 },
                input: '{"value":"durable fixture effect"}',
                action: { kind: 'tool', agent: 'writer', tool: 'files.fixture_write' },
                retry: { attempts: 3, delaySeconds: 0, timeoutSeconds: 180 },
              },
            ],
            edges: [{ from: 'start', to: 'write' }],
          }),
        });
        await reviewWorkflow(
          fixture.db,
          fixture.userId,
          saved.id,
          { expectedVersion: 1, revision: 1, enabled: false },
          fixture.runtime.settings,
        );
        const created = await runWorkflow(
          fixture.db,
          fixture.userId,
          saved.id,
          { requestId: randomUUID(), revision: 1 },
          fixture.runtime.settings,
        );
        return { id: created.missionId, run: { id: created.id } };
      }
      const mission =
        kind === 'workflow'
          ? await workflowTask()
          : await createMission(
              fixture.db,
              fixture.userId,
              {
                projectId: fixture.projectId,
                goal: 'Write one recoverable artifact through a specialist',
                requestId: randomUUID(),
              },
              { maxSteps: 20, maxCostUsd: 1, maxWallTimeSeconds: 180 },
            );
      const plan = graphPlanSchema.parse({
        mode: 'single',
        tasks: [
          {
            id: 'artifact',
            agent: 'writer',
            goal: 'Write the artifact once',
            inputs: {},
            depends_on: [],
            acceptance: ['A confirmed write'],
            budget: { usd: 0.2, steps: 8 },
          },
        ],
        user_checkpoints: [],
        deliverable: 'Report the confirmed artifact',
      });
      const coordinator = createDurableExecutor({
        database: fixture.db,
        workerId: 'graph-setup',
        dataDir: fixture.directory,
        getSettings: () => fixture.runtime.settings,
        tools: createFixtureTools({ fixtureOrigin: origin }),
        router: () => createFixtureRouter({ plan }),
      });
      await coordinator.execute(mission.run.id);
      const first = await start();
      await vi.waitFor(
        () => expect([...effects.values()].map((effect) => effect.count)).toEqual([1]),
        { timeout: 15000, interval: 40 },
      );
      const [childRun] = await fixture.db.orm
        .select()
        .from(runs)
        .where(eq(runs.parentRunId, mission.run.id));
      const [intent] = await fixture.db.orm
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.runId, childRun!.id));
      expect(intent?.status).toBe('intent');
      await stop(first);
      const replacement = await start();
      await vi.waitFor(
        async () =>
          expect(
            (await getMission(fixture.db, fixture.userId, mission.id))?.mission.run.status,
          ).toBe('completed'),
        { timeout: 15000, interval: 80 },
      );
      await stop(replacement);
      expect([...effects.values()].map((effect) => effect.count)).toEqual([1]);
      expect(reads).toBe(1);
      if (kind === 'graph') {
        expect(
          await fixture.db.orm
            .select()
            .from(taskAttempts)
            .where(eq(taskAttempts.runId, childRun!.id)),
        ).toHaveLength(1);
        expect((await getMission(fixture.db, fixture.userId, mission.id))?.graph?.revision).toBe(1);
      } else {
        expect(
          await fixture.db.orm
            .select()
            .from(workflowNodeRuns)
            .where(eq(workflowNodeRuns.runId, childRun!.id)),
        ).toHaveLength(1);
      }
      expect(
        (await fixture.db.orm.select().from(toolCalls).where(eq(toolCalls.id, intent!.id)))[0]
          ?.status,
      ).toBe('done');
    } finally {
      for (const child of children) await stop(child);
      for (const response of held) response.destroy();
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await fixture.close();
    }
  }, 90000);
});

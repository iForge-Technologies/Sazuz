import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { readInfraConfig, readOperatorKey } from '@sazuz/config';
import { workId } from '@sazuz/core/work';
import {
  evalModeSchema,
  evalPresetSchema,
  evalReportSchema,
  evalRunSchema,
} from '@sazuz/core/evals';
import {
  createFixturePlan,
  evalRecordSchema,
  fixturePlanSchema,
  renderEvalHtml,
  runFixturePlan,
  selectSuites,
  type EvalPersistence,
} from '@sazuz/evals';

const usage =
  'Usage: sazuz eval run --suite all|name[,name] --preset balanced,budget [--mode fixture|configured] [--project ID] [--judge] [--output DIRECTORY] | sazuz eval resume DIRECTORY';
export function parseEvalArgs(args: string[]) {
  if (args[0] === 'resume' && args.length === 2 && args[1]) return { resume: resolve(args[1]) };
  if (args[0] !== 'run') throw new Error(usage);
  const values: Record<string, string> = {};
  for (let index = 1; index < args.length; index++) {
    const key = args[index];
    if (
      !key ||
      !['--suite', '--preset', '--mode', '--project', '--output', '--judge'].includes(key) ||
      Object.hasOwn(values, key)
    )
      throw new Error(usage);
    if (key === '--judge') {
      values[key] = 'true';
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(usage);
    values[key] = value;
  }
  const mode = evalModeSchema.safeParse(values['--mode'] ?? 'fixture');
  const presets = z
    .array(evalPresetSchema)
    .min(1)
    .max(4)
    .refine((items) => new Set(items).size === items.length)
    .safeParse((values['--preset'] ?? 'balanced').split(','));
  const projectId = values['--project'];
  if (
    !mode.success ||
    !presets.success ||
    (values['--judge'] && mode.data !== 'configured') ||
    (mode.data === 'configured' && !workId.safeParse(projectId).success)
  )
    throw new Error(usage);
  return {
    mode: mode.data,
    presets: presets.data,
    suites: (values['--suite'] ?? 'all').split(','),
    projectId,
    judge: values['--judge'] === 'true',
    output: values['--output'],
  };
}
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
async function readJson(path: string, maxBytes: number): Promise<unknown> {
  if ((await stat(path)).size > maxBytes)
    throw new Error('The saved evaluation exceeds its size limit.');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}
function diskPersistence(directory: string, id: string): EvalPersistence {
  const path = join(directory, `${workId.parse(id)}.json`);
  return {
    async load() {
      try {
        return evalRecordSchema.parse(await readJson(path, 4_000_000));
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async save(checkpoint, journal) {
      await atomicJson(path, evalRecordSchema.parse({ checkpoint, journal }));
    },
  };
}
async function writeReport(directory: string, report: z.infer<typeof evalReportSchema>) {
  await atomicJson(join(directory, 'report.json'), report);
  const temporary = join(directory, `report.${randomUUID()}.tmp`);
  await writeFile(temporary, renderEvalHtml(report), { flag: 'wx', mode: 0o600 });
  await rename(temporary, join(directory, 'report.html'));
}
export async function runEvalCli(args: string[], output: (message: string) => void) {
  const input = parseEvalArgs(args);
  if ('resume' in input || input.mode === 'fixture') {
    const plan =
      'resume' in input
        ? fixturePlanSchema.parse(await readJson(join(input.resume, 'plan.json'), 1_200_000))
        : createFixturePlan(selectSuites(input.suites), input.presets);
    const directory =
      'resume' in input ? input.resume : resolve(input.output ?? join('eval-reports', plan.id));
    if (!('resume' in input))
      await mkdir(directory, { recursive: false, mode: 0o700 }).catch(async (error: unknown) => {
        if (!missing(error)) throw error;
        await mkdir(resolve(directory, '..'), { recursive: true, mode: 0o700 });
        await mkdir(directory, { mode: 0o700 });
      });
    const lockPath = join(directory, 'execution.lock');
    let lock;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch {
      throw new Error(
        'This report directory is in use. After confirming its previous process stopped, remove execution.lock before resuming.',
      );
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, runId: plan.id }));
      if (!('resume' in input)) await atomicJson(join(directory, 'plan.json'), plan);
      const report = await runFixturePlan(plan, (id) => diskPersistence(directory, id));
      await writeReport(directory, report);
      output(
        `Fixture evaluation ${report.id}: ${report.passedCases}/${report.totalCases} passed; $0. No model calls or live tools.`,
      );
      output(`HTML report: ${join(directory, 'report.html')}`);
      if (report.passedCases !== report.totalCases)
        throw new Error('Evaluation criteria failed or remain unverified. See the report.');
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
    return;
  }
  const config = readInfraConfig();
  const base = new URL('/api/operator/evals', config.serverUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
    throw new Error('Configured evaluations require the local installed Sazuz server.');
  const operatorKey = await readOperatorKey(config.dataDir);
  const requestId = randomUUID();
  const request = async (id?: string) => {
    const response = await fetch(id ? new URL(`${base.pathname}/${id}`, base) : base, {
      method: id ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${operatorKey}`, 'content-type': 'application/json' },
      ...(!id
        ? {
            body: JSON.stringify({
              requestId,
              projectId: input.projectId,
              suites: input.suites,
              presets: input.presets,
              mode: 'configured',
              judge: input.judge,
            }),
          }
        : {}),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(
        'The local evaluation request failed. Check setup, project access, settings and server status.',
      );
    return (await response.json()) as unknown;
  };
  const started = evalRunSchema.parse(await request());
  output(
    `Configured evaluation queued: ${started.id}. Inference uses stored model, privacy and budget settings.`,
  );
  const directory = resolve(input.output ?? join('eval-reports', started.id));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 660_000;
  while (Date.now() < deadline) {
    const report = evalReportSchema.parse(await request(started.id));
    if (!['queued', 'running'].includes(report.status)) {
      await writeReport(directory, report);
      output(
        `${report.passedCases}/${report.totalCases} passed; $${report.costUsd.toFixed(6)} including $${report.judgeCostUsd.toFixed(6)} judge cost. HTML report: ${join(directory, 'report.html')}`,
      );
      if (report.status !== 'completed' || report.passedCases !== report.totalCases)
        throw new Error(
          'Evaluation stopped or criteria failed. Review the retained report before starting another paid evaluation.',
        );
      return;
    }
    await delay(1000);
  }
  throw new Error(
    `Evaluation ${started.id} remains queued or running. Inspect it in Evals; this command will not create another request.`,
  );
}

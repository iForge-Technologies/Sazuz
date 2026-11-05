import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evalReportSchema } from '@sazuz/core/evals';
import { parseEvalArgs, runEvalCli } from './eval.js';

describe('evaluation CLI', () => {
  let directory: string | undefined;
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (
      directory &&
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
      directory.includes('sazuz-eval-cli-')
    )
      await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });
  it('runs and resumes a durable two-preset three-suite report without a server, environment or credentials', async () => {
    directory = await mkdtemp(join(tmpdir(), 'sazuz-eval-cli-'));
    const destination = join(directory, 'report');
    const network = vi.fn(() => Promise.reject(new Error('Fixture CLI must stay offline.')));
    vi.stubGlobal('fetch', network);
    const output = vi.fn();
    await runEvalCli(
      ['run', '--suite', 'all', '--preset', 'balanced,budget', '--output', destination],
      output,
    );
    const first = evalReportSchema.parse(
      JSON.parse(await readFile(join(destination, 'report.json'), 'utf8')),
    );
    expect(first).toMatchObject({ totalCases: 12, passedCases: 12, mode: 'fixture', costUsd: 0 });
    await runEvalCli(['resume', destination], output);
    const second = evalReportSchema.parse(
      JSON.parse(await readFile(join(destination, 'report.json'), 'utf8')),
    );
    expect(second.results).toEqual(first.results);
    expect(second.id).toBe(first.id);
    expect(network).not.toHaveBeenCalled();
    expect(await readFile(join(destination, 'report.html'), 'utf8')).toContain(
      'Deterministic fixture mode',
    );
  });
  it('rejects unknown/duplicate flags, credential arguments and configured calls without a project', () => {
    for (const args of [
      ['run', '--secret', 'bad'],
      ['run', '--mode', 'configured'],
      ['run', '--judge'],
      ['run', '--suite', 'all', '--suite', 'research'],
      ['run', '--preset', 'budget,budget'],
      ['run', '--preset', 'unknown'],
    ])
      expect(() => parseEvalArgs(args)).toThrow('Usage');
    expect(parseEvalArgs(['run', '--suite', 'research', '--preset', 'budget'])).toMatchObject({
      suites: ['research'],
      presets: ['budget'],
      mode: 'fixture',
    });
  });
});

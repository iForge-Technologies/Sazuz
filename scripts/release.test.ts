import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  assembleImages,
  publishImages,
  releaseImages,
  retainImages,
  type ReleaseCommand,
} from './release.js';
import { releaseSchema } from '@sazuz/core/operations';

const context = {
  revision: 'a'.repeat(40),
  repository: 'Example/Sazuz',
  version: '1.0.0',
  runId: '123',
};
const roots: string[] = [];
const id = (i: number) => 'sha256:' + String(i + 1).repeat(64);
async function fixture(architecture: 'amd64' | 'arm64' = 'amd64') {
  const directory = await mkdtemp(join(tmpdir(), 'sazuz-release-'));
  roots.push(directory);
  const calls: { program: string; args: string[] }[] = [];
  const run: ReleaseCommand = async (program, args) => {
    calls.push({ program, args });
    if (args[0] === 'image' && args[1] === 'save') {
      await writeFile(args[3]!, 'retained image bytes');
      return '';
    }
    if (args.includes('{{json .RepoDigests}}')) {
      const tag = args.at(-1)!;
      return JSON.stringify([
        `${tag.slice(0, tag.lastIndexOf(':'))}@${id(architecture === 'amd64' ? 0 : 1)}`,
      ]);
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      const target = args.at(-1)!;
      return JSON.stringify({
        Id: target.startsWith('sha256:')
          ? target
          : id(releaseImages.findIndex((image) => image.tag === target)),
        Architecture: architecture,
        Os: 'linux',
      });
    }
    return '';
  };
  await retainImages(directory, architecture, context.revision, run);
  return { directory, calls, run };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    if (resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('sazuz-release-'))
      await rm(root, { recursive: true, force: true });
});
describe('tested image release artifacts', () => {
  it('retains image IDs and publishes those exact images without rebuilding', async () => {
    const f = await fixture();
    const save = f.calls.find((call) => call.args[1] === 'save')!;
    expect(save.args.slice(4)).toEqual(releaseImages.map((_, i) => id(i)));
    const published = await publishImages(f.directory, 'amd64', context, f.run);
    expect(published.images).toHaveLength(6);
    expect(f.calls.filter((call) => call.args[1] === 'tag').map((call) => call.args[2])).toEqual(
      releaseImages.map((_, i) => id(i)),
    );
    expect(f.calls.some((call) => call.args.includes('build'))).toBe(false);
    expect(published.images.every((image) => image.image.includes('@sha256:'))).toBe(true);
  });
  it.each(['archive', 'revision', 'architecture'] as const)(
    'rejects a changed %s before any Docker load or publication',
    async (change) => {
      const f = await fixture();
      f.calls.length = 0;
      if (change === 'archive') await writeFile(join(f.directory, 'images.tar'), 'different bytes');
      await expect(
        publishImages(
          f.directory,
          change === 'architecture' ? 'arm64' : 'amd64',
          change === 'revision' ? { ...context, revision: 'b'.repeat(40) } : context,
          f.run,
        ),
      ).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    },
  );
  it('validates all loaded identities before the first push', async () => {
    const f = await fixture();
    f.calls.length = 0;
    const run: ReleaseCommand = (program, args) =>
      args.at(-1) === id(5)
        ? Promise.resolve(JSON.stringify({ Id: id(0), Architecture: 'amd64', Os: 'linux' }))
        : f.run(program, args);
    await expect(publishImages(f.directory, 'amd64', context, run)).rejects.toThrow();
    expect(f.calls.some((call) => call.args[1] === 'push')).toBe(false);
  });
  it('assembles six exact two-platform indices and a fully pinned deployment bundle', async () => {
    const amd = await fixture('amd64'),
      arm = await fixture('arm64');
    const a = await publishImages(amd.directory, 'amd64', context, amd.run),
      b = await publishImages(arm.directory, 'arm64', context, arm.run);
    await writeFile(join(amd.directory, 'published-arm64.json'), JSON.stringify(b));
    const calls: string[][] = [];
    const run: ReleaseCommand = (_program, args) => {
      calls.push(args);
      if (args.includes('--raw'))
        return Promise.resolve(
          JSON.stringify({
            manifests: [
              { digest: id(0), platform: { os: 'linux', architecture: 'amd64' } },
              { digest: id(1), platform: { os: 'linux', architecture: 'arm64' } },
            ],
          }),
        );
      if (args.includes('--format')) return Promise.resolve(JSON.stringify({ digest: id(2) }));
      return Promise.resolve('');
    };
    const result = await assembleImages(amd.directory, context, 'Reviewed release notes.', run);
    expect(releaseSchema.parse(result.release).image).toContain('@sha256:');
    const compose = z
      .object({ services: z.record(z.string(), z.object({ image: z.string() })) })
      .parse(parse(await readFile(join(result.assets, 'compose.release.yaml'), 'utf8')));
    expect(Object.keys(compose.services)).toHaveLength(12);
    expect(Object.values(compose.services).every((value) => value.image.includes('@sha256:'))).toBe(
      true,
    );
    const creates = calls.filter((args) => args.includes('create'));
    expect(creates).toHaveLength(6);
    expect(creates[0]!.slice(-2)).toEqual([a.images[0]!.image, b.images[0]!.image]);
    const bad = { ...b, context: { ...context, runId: '124' } };
    await writeFile(join(amd.directory, 'published-arm64.json'), JSON.stringify(bad));
    calls.length = 0;
    await expect(
      assembleImages(amd.directory, context, 'Reviewed release notes.', run),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it('requires the reusable native architecture checks before explicit publication', async () => {
    const yaml = z.object({ jobs: z.record(z.string(), z.unknown()) });
    const ci = yaml.parse(parse(await readFile(resolve('.github/workflows/checks.yml'), 'utf8')));
    const image = z
      .object({
        needs: z.literal('quality'),
        'runs-on': z.string(),
        strategy: z.object({
          matrix: z.object({
            include: z.array(z.object({ arch: z.string(), runner: z.string() })),
          }),
        }),
      })
      .parse(ci.jobs.image);
    expect(image.strategy.matrix.include).toEqual([
      { arch: 'amd64', runner: 'ubuntu-24.04' },
      { arch: 'arm64', runner: 'ubuntu-24.04-arm' },
    ]);
    const release = z
      .object({
        on: z.object({ workflow_dispatch: z.unknown() }),
        jobs: z.record(z.string(), z.unknown()),
      })
      .parse(parse(await readFile(resolve('.github/workflows/release.yml'), 'utf8')));
    expect(
      z
        .object({ needs: z.literal('checks'), environment: z.literal('release') })
        .parse(release.jobs.publish),
    ).toBeTruthy();
  });
});

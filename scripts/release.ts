import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { releaseSchema, releaseImageSchema } from '@sazuz/core/operations';

export const releaseImages = [
  {
    name: 'app',
    tag: 'sazuz/app:phase5',
    services: [
      'bootstrap',
      'migrate',
      'server',
      'worker',
      'web',
      'egress-proxy',
      'docker-socket-proxy',
    ],
  },
  { name: 'browser', tag: 'sazuz/browser:phase5', services: ['browser'] },
  { name: 'sandbox-python', tag: 'sazuz/sandbox-python:phase5', services: ['sandbox-python'] },
  { name: 'sandbox-node', tag: 'sazuz/sandbox-node:phase5', services: ['sandbox-node'] },
  { name: 'whisper', tag: 'sazuz/whisper:phase11', services: ['whisper'] },
  { name: 'piper', tag: 'sazuz/piper:phase11', services: ['piper'] },
] as const;
const names = z.enum(['app', 'browser', 'sandbox-python', 'sandbox-node', 'whisper', 'piper']);
const architectureSchema = z.enum(['amd64', 'arm64']);
type Architecture = z.infer<typeof architectureSchema>;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const versionSchema = releaseSchema.shape.version;
export const releaseContextSchema = z.strictObject({
  revision: revisionSchema,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  version: versionSchema,
  runId: z.string().regex(/^[1-9][0-9]{0,19}$/),
});
type ReleaseContext = z.infer<typeof releaseContextSchema>;
const inventorySchema = z
  .strictObject({
    format: z.literal(1),
    revision: revisionSchema,
    architecture: architectureSchema,
    archive: z.literal('images.tar'),
    sha256: sha,
    images: z.array(z.strictObject({ name: names, id: digest })).length(6),
  })
  .refine((value) => new Set(value.images.map((image) => image.name)).size === 6);
const publishedSchema = z
  .strictObject({
    format: z.literal(1),
    context: releaseContextSchema,
    architecture: architectureSchema,
    images: z.array(z.strictObject({ name: names, image: releaseImageSchema })).length(6),
  })
  .refine((value) => new Set(value.images.map((image) => image.name)).size === 6);
export type ReleaseCommand = (program: 'docker' | 'git' | 'tar', args: string[]) => Promise<string>;

const execute: ReleaseCommand = (program, args) =>
  new Promise((accept, reject) => {
    const child = spawn(program, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let text = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > 2_000_000) child.kill();
    });
    child.once('error', () => reject(new Error(`Could not start ${program}.`)));
    child.once('close', (code) =>
      code === 0 && text.length <= 2_000_000
        ? accept(text.trim())
        : reject(new Error(`${program} release command failed.`)),
    );
  });
export async function fileChecksum(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path))
    hash.update(z.instanceof(Uint8Array).parse(chunk));
  return hash.digest('hex');
}
const imageMetadataSchema = z.object({
  Id: digest,
  Architecture: architectureSchema,
  Os: z.literal('linux'),
});
const repositoryFor = (context: ReleaseContext, role: string) =>
  `ghcr.io/${context.repository.toLowerCase()}${role === 'app' ? '' : `-${role}`}`;
const publicationTag = (context: ReleaseContext) =>
  `${context.version}-${context.revision.slice(0, 12)}-${context.runId}`;

/** Called only after this architecture's full container and browser checks pass. */
export async function retainImages(
  directory: string,
  architecture: Architecture,
  revision: string,
  run: ReleaseCommand = execute,
) {
  architectureSchema.parse(architecture);
  revisionSchema.parse(revision);
  await mkdir(directory, { recursive: true });
  const images = [];
  for (const image of releaseImages) {
    const metadata = imageMetadataSchema.parse(
      JSON.parse(await run('docker', ['image', 'inspect', '--format', '{{json .}}', image.tag])),
    );
    if (metadata.Architecture !== architecture)
      throw new Error('The tested image has the wrong architecture.');
    images.push({ name: image.name, id: metadata.Id });
  }
  const archive = join(directory, 'images.tar');
  // Save the exact inspected IDs. A later tag change cannot replace the tested images.
  await run('docker', ['image', 'save', '--output', archive, ...images.map((image) => image.id)]);
  const inventory = inventorySchema.parse({
    format: 1,
    revision,
    architecture,
    archive: 'images.tar',
    sha256: await fileChecksum(archive),
    images,
  });
  await writeFile(join(directory, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
  return inventory;
}

export async function publishImages(
  directory: string,
  architecture: Architecture,
  rawContext: ReleaseContext,
  run: ReleaseCommand = execute,
) {
  const context = releaseContextSchema.parse(rawContext);
  const inventory = inventorySchema.parse(
    JSON.parse(await readFile(join(directory, 'inventory.json'), 'utf8')),
  );
  if (
    inventory.architecture !== architecture ||
    inventory.revision !== context.revision ||
    inventory.sha256 !== (await fileChecksum(join(directory, inventory.archive)))
  )
    throw new Error(
      'Retained image source, architecture or archive checksum differs. Nothing was published.',
    );
  await run('docker', ['image', 'load', '--input', join(directory, inventory.archive)]);
  // Verify every image before publishing any image. Loading alone is not proof of identity.
  for (const image of inventory.images) {
    const metadata = imageMetadataSchema.parse(
      JSON.parse(await run('docker', ['image', 'inspect', '--format', '{{json .}}', image.id])),
    );
    if (metadata.Id !== image.id || metadata.Architecture !== architecture)
      throw new Error('A retained image no longer matches the tested inventory.');
  }
  const images = [];
  for (const image of inventory.images) {
    const repository = repositoryFor(context, image.name);
    const tag = `${repository}:${publicationTag(context)}-${architecture}`;
    await run('docker', ['image', 'tag', image.id, tag]);
    await run('docker', ['image', 'push', tag]);
    const found = z
      .array(z.string())
      .parse(
        JSON.parse(
          await run('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', tag]),
        ),
      );
    const pinned = found.find((value) => value.startsWith(repository + '@'));
    images.push({ name: image.name, image: releaseImageSchema.parse(pinned) });
  }
  const published = publishedSchema.parse({ format: 1, context, architecture, images });
  await writeFile(
    join(directory, `published-${architecture}.json`),
    JSON.stringify(published, null, 2) + '\n',
  );
  return published;
}

export async function assembleImages(
  directory: string,
  rawContext: ReleaseContext,
  notes: string,
  run: ReleaseCommand = execute,
) {
  const context = releaseContextSchema.parse(rawContext);
  const architectures = await Promise.all(
    ['amd64', 'arm64'].map(async (architecture) => {
      const value = publishedSchema.parse(
        JSON.parse(await readFile(join(directory, `published-${architecture}.json`), 'utf8')),
      );
      if (
        value.architecture !== architecture ||
        JSON.stringify(value.context) !== JSON.stringify(context)
      )
        throw new Error('Both native architectures must come from this same checked release run.');
      return value;
    }),
  );
  for (const architecture of architectures)
    for (const image of architecture.images)
      if (!image.image.startsWith(repositoryFor(context, image.name) + '@'))
        throw new Error('The retained image belongs to a different release repository.');
  const images: { name: z.infer<typeof names>; image: string; sources: string[] }[] = [];
  for (const image of releaseImages) {
    const sources = architectures.map(
      (value) => value.images.find((entry) => entry.name === image.name)!.image,
    );
    if (sources.some((source) => !source.startsWith(repositoryFor(context, image.name) + '@')))
      throw new Error('The retained image belongs to a different release repository.');
    const tag = `${repositoryFor(context, image.name)}:${publicationTag(context)}`;
    await run('docker', ['buildx', 'imagetools', 'create', '--tag', tag, ...sources]);
    const index = z
      .object({
        manifests: z
          .array(
            z.object({
              digest,
              platform: z.object({ architecture: architectureSchema, os: z.literal('linux') }),
            }),
          )
          .length(2),
      })
      .parse(JSON.parse(await run('docker', ['buildx', 'imagetools', 'inspect', '--raw', tag])));
    for (const [i, source] of sources.entries())
      if (
        !index.manifests.some(
          (entry) =>
            entry.digest === source.split('@')[1] &&
            entry.platform.architecture === architectures[i]!.architecture,
        )
      )
        throw new Error('The published index does not contain the exact tested platform digests.');
    const metadata = z
      .object({ digest })
      .parse(
        JSON.parse(
          await run('docker', [
            'buildx',
            'imagetools',
            'inspect',
            '--format',
            '{{json .Manifest}}',
            tag,
          ]),
        ),
      );
    images.push({
      name: image.name,
      image: releaseImageSchema.parse(`${repositoryFor(context, image.name)}@${metadata.digest}`),
      sources,
    });
  }
  const release = releaseSchema.parse({
    format: 1,
    version: context.version,
    image: images.find((image) => image.name === 'app')!.image,
    notes,
  });
  const compose =
    'services:\n' +
    releaseImages
      .flatMap((image) =>
        image.services.map(
          (service) =>
            `  ${service}:\n    image: ${images.find((entry) => entry.name === image.name)!.image}\n`,
        ),
      )
      .join('');
  const assets = join(directory, 'assets');
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, 'release.json'), JSON.stringify(release, null, 2) + '\n');
  await writeFile(
    join(assets, 'images.json'),
    JSON.stringify({ format: 1, context, images }, null, 2) + '\n',
  );
  await writeFile(join(assets, 'compose.release.yaml'), compose);
  await writeFile(join(assets, 'RELEASE-NOTES.md'), notes + '\n');
  return { release, assets };
}

async function bundleRelease(directory: string, context: ReleaseContext, assets: string) {
  const stage = await mkdtemp(join(directory, 'bundle-'));
  try {
    const source = join(stage, 'sazuz');
    await mkdir(source);
    await execute('git', [
      'archive',
      '--format=tar',
      '--output',
      join(stage, 'source.tar'),
      context.revision,
    ]);
    await execute('tar', ['-xf', join(stage, 'source.tar'), '-C', source]);
    await copyFile(
      join(assets, 'compose.release.yaml'),
      join(source, 'deploy/compose.release.yaml'),
    );
    await copyFile(join(assets, 'release.json'), join(source, 'release.json'));
    const archive = `sazuz-${context.version}.tar.gz`;
    const docs = `sazuz-${context.version}-docs.tar.gz`;
    await execute('tar', ['-czf', join(assets, archive), '-C', stage, 'sazuz']);
    await execute('tar', ['-czf', join(assets, docs), '-C', resolve('dist'), 'docs-site']);
    const files = [
      'release.json',
      'images.json',
      'compose.release.yaml',
      'RELEASE-NOTES.md',
      archive,
      docs,
    ];
    const checksums = [];
    for (const file of files) checksums.push(`${await fileChecksum(join(assets, file))}  ${file}`);
    await writeFile(join(assets, 'SHA256SUMS'), checksums.join('\n') + '\n');
  } finally {
    // Only the newly allocated staging directory under this release output is removed.
    if (resolve(stage).startsWith(resolve(directory) + sep) && stage.includes('bundle-'))
      await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const action = z.enum(['retain', 'publish', 'assemble']).parse(process.argv[2]);
    const directory = resolve('.verification/release');
    const revision = revisionSchema.parse(process.env.GITHUB_SHA);
    if (action === 'retain') {
      const architecture = architectureSchema.parse(process.argv[3]);
      await retainImages(join(directory, architecture), architecture, revision);
    } else {
      const context = releaseContextSchema.parse({
        revision,
        repository: process.env.GITHUB_REPOSITORY,
        version: process.env.RELEASE_VERSION,
        runId: process.env.GITHUB_RUN_ID,
      });
      const notes = releaseSchema.shape.notes.parse(
        await readFile(resolve('docs/releases', `${context.version}.md`), 'utf8'),
      );
      if (action === 'publish') {
        const architecture = architectureSchema.parse(process.argv[3]);
        await publishImages(join(directory, architecture), architecture, context);
      } else {
        const result = await assembleImages(directory, context, notes);
        await bundleRelease(directory, context, result.assets);
      }
    }
    process.stdout.write(`Release ${action} completed.\n`);
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : 'Release command failed.') + '\n',
    );
    process.exitCode = 1;
  }
}

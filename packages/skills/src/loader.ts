import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, stringify } from 'yaml';
import { skillManifestSchema, type SkillManifest } from '@sazuz/core/skills';
import { secretRedactor } from '@sazuz/vault';
import { SkillError } from './errors.js';

export function safeSkillText(text: string) {
  if (secretRedactor.redactText(text) !== text) throw new SkillError('SKILL_SECRET');
  return text;
}
export function parseSkill(markdown: string) {
  if (markdown.length > 24000 || Buffer.byteLength(markdown) > 72000)
    throw new SkillError('SKILL_INVALID');
  safeSkillText(markdown);
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]+?)\n---\n([\s\S]+)$/.exec(normalized);
  if (!match || match[1]!.length > 10000 || !match[2]!.trim())
    throw new SkillError('SKILL_INVALID');
  try {
    const document = parseDocument(match[1]!, { uniqueKeys: true, strict: true, schema: 'core' });
    if (document.errors.length || document.warnings.length) throw new SkillError('SKILL_INVALID');
    // Alias expansion, custom tags and implicit code evaluation are never enabled.
    const metadata: unknown = document.toJS({ maxAliasCount: 0 });
    const manifest = skillManifestSchema.parse(metadata);
    return {
      manifest,
      markdown: normalized,
      body: match[2]!,
      sha256: createHash('sha256').update(normalized).digest('hex'),
    };
  } catch (error) {
    if (error instanceof SkillError) throw error;
    throw new SkillError('SKILL_INVALID');
  }
}
export function formatSkill(manifest: SkillManifest, body: string) {
  return parseSkill(
    `---\n${stringify(skillManifestSchema.parse(manifest)).trimEnd()}\n---\n${body.trim()}\n`,
  );
}
export const builtinSkillNames = [
  'morning-brief',
  'inbox-assistant',
  'meeting-prep',
  'uptime-watch',
  'knowledge-qa',
] as const;
export async function readBuiltinSkills(
  directory = fileURLToPath(new URL('../../../skills/', import.meta.url)),
) {
  return Promise.all(
    builtinSkillNames.map(async (name, index) => {
      const document = parseSkill(await readFile(resolve(directory, name, 'SKILL.md'), 'utf8'));
      if (document.manifest.name !== name) throw new SkillError('SKILL_INVALID');
      return { ...document, id: `skl_${String(index + 1).padStart(26, '0')}` };
    }),
  );
}

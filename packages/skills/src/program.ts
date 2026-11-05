import { learnedInputsSchema } from '@sazuz/core/learning-replay';
export { learnedInputsSchema } from '@sazuz/core/learning-replay';
import type { z } from 'zod';
import {
  learnedProgramSchema,
  type learningInputSchema,
  type learningLabelsSchema,
  LearningError,
  type LearnedAction,
  type LearnedProgram,
  type RecordingEvent,
} from '@sazuz/core/learning';
import { valueHash } from '@sazuz/db';
import { formatSkill, safeSkillText } from './loader.js';
import type { SkillManifest } from '@sazuz/core/skills';

export function checkedProgram(input: unknown): LearnedProgram {
  const parsed = learnedProgramSchema.safeParse(input);
  if (!parsed.success) throw new LearningError('LEARNING_INVALID');
  safeSkillText(JSON.stringify(parsed.data));
  return parsed.data;
}
const eventSignature = (event: RecordingEvent) =>
  JSON.stringify({
    kind: event.kind,
    role: event.target?.role,
    name: event.target?.name,
    locators: event.target?.locators,
    url: event.url,
  });
/** Only contiguous repeated patterns with a variable become list candidates. */
export function detectRecordingLoops(input: RecordingEvent[]) {
  const events = input.filter((event) => event.replay);
  const candidates: { start: number; length: number; repeats: number }[] = [];
  for (let start = 0; start < events.length - 1; start++) {
    for (
      let length = 1;
      length <= Math.min(12, Math.floor((events.length - start) / 2));
      length++
    ) {
      const group = events.slice(start, start + length);
      if (
        !group.some((event) => ['fill', 'select'].includes(event.kind)) ||
        group.some((event) => event.kind === 'navigate')
      )
        continue;
      const signature = group.map(eventSignature).join('\n');
      let repeats = 1;
      while (
        start + (repeats + 1) * length <= events.length &&
        events
          .slice(start + repeats * length, start + (repeats + 1) * length)
          .map(eventSignature)
          .join('\n') === signature
      )
        repeats++;
      if (repeats >= 2) candidates.push({ start, length, repeats });
    }
  }
  return candidates.sort((a, b) => b.length * b.repeats - a.length * a.repeats).slice(0, 20);
}
export function compileRecording(
  site: string,
  inputEvents: RecordingEvent[],
  input: z.infer<typeof learningInputSchema>,
): LearnedProgram {
  const events = inputEvents.filter((event) => event.replay);
  if (!events.length || events.length > 50) throw new LearningError('LEARNING_LIMIT');
  const variableIds = new Set(
    events.filter((event) => ['fill', 'select'].includes(event.kind)).map((event) => event.id),
  );
  if (Object.keys(input.parameters).some((id) => !variableIds.has(id)))
    throw new LearningError('LEARNING_INVALID');
  const actions: LearnedAction[] = events.map((event, index) => ({
    kind: 'action',
    id: `s${index + 1}`,
    operation: event.kind,
    intent:
      event.kind === 'navigate'
        ? `Open ${event.url}`
        : `${event.kind} ${event.target?.role ?? 'element'} ${event.target?.name ?? ''}`.trim(),
    target: event.target,
    url: event.url,
    parameter: variableIds.has(event.id)
      ? (input.parameters[event.id] ?? `value${index + 1}`)
      : null,
  }));
  const candidates = detectRecordingLoops(inputEvents);
  const chosen = [...input.loops].sort((a, b) => a.start - b.start);
  let until = 0;
  for (const loop of chosen) {
    if (
      loop.start < until ||
      !candidates.some(
        (candidate) =>
          candidate.start === loop.start &&
          candidate.length === loop.length &&
          candidate.repeats === loop.repeats,
      )
    )
      throw new LearningError('LEARNING_INVALID');
    until = loop.start + loop.length * loop.repeats;
  }
  const steps: LearnedProgram['steps'] = [];
  for (let i = 0; i < actions.length;) {
    const loop = chosen.find((candidate) => candidate.start === i);
    if (loop) {
      steps.push({
        kind: 'loop',
        id: `loop${steps.length + 1}`,
        parameter: loop.parameter,
        maxItems: 20,
        steps: actions.slice(i, i + loop.length),
      });
      i += loop.length * loop.repeats;
    } else steps.push(actions[i++]!);
  }
  return checkedProgram({ version: 1, site, steps });
}
export function applyLearningLabels(
  program: LearnedProgram,
  labels: z.infer<typeof learningLabelsSchema>,
) {
  const result = structuredClone(program);
  const actions = result.steps.flatMap((node) => (node.kind === 'loop' ? node.steps : [node]));
  if (
    labels.intents.length !== actions.length ||
    new Set(labels.intents.map((item) => item.id)).size !== actions.length ||
    labels.intents.some((item) => !actions.some((action) => action.id === item.id))
  )
    throw new LearningError('LEARNING_INVALID');
  for (const action of actions)
    action.intent = labels.intents.find((item) => item.id === action.id)!.text;
  return checkedProgram(result);
}
export function programInputSchema(program: LearnedProgram) {
  const properties: SkillManifest['inputs']['properties'] = {};
  const field = { type: 'string', maxLength: 4000 };
  for (const node of program.steps) {
    if (node.kind === 'action') {
      if (node.parameter) properties[node.parameter] = { ...field };
    } else {
      const fields = Object.fromEntries(
        node.steps.filter((step) => step.parameter).map((step) => [step.parameter!, { ...field }]),
      );
      properties[node.parameter] = {
        type: 'array',
        minItems: 1,
        maxItems: node.maxItems,
        items: {
          type: 'object',
          properties: fields,
          required: Object.keys(fields),
          additionalProperties: false,
        },
      };
    }
  }
  return {
    type: 'object' as const,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
export function expandProgram(programInput: unknown, input: unknown) {
  const program = checkedProgram(programInput);
  const values = learnedInputsSchema.parse(input);
  safeSkillText(JSON.stringify(values));
  const properties = programInputSchema(program).properties;
  if (
    Object.keys(values).length !== Object.keys(properties).length ||
    Object.keys(values).some((key) => !Object.hasOwn(properties, key))
  )
    throw new LearningError('LEARNING_INVALID');
  const output: { step: LearnedAction; value: string | null; iteration: number | null }[] = [];
  for (const node of program.steps) {
    if (node.kind === 'action') {
      const value = node.parameter ? values[node.parameter] : null;
      if (node.parameter && typeof value !== 'string') throw new LearningError('LEARNING_INVALID');
      output.push({ step: node, value: typeof value === 'string' ? value : null, iteration: null });
    } else {
      const rows = values[node.parameter];
      if (!Array.isArray(rows) || rows.length > node.maxItems)
        throw new LearningError('LEARNING_INVALID');
      const keys = new Set(node.steps.flatMap((step) => (step.parameter ? [step.parameter] : [])));
      for (const [iteration, row] of rows.entries()) {
        if (Object.keys(row).length !== keys.size || Object.keys(row).some((key) => !keys.has(key)))
          throw new LearningError('LEARNING_INVALID');
        for (const step of node.steps) {
          const value = step.parameter ? row[step.parameter] : null;
          if (step.parameter && typeof value !== 'string')
            throw new LearningError('LEARNING_INVALID');
          output.push({ step, value: value ?? null, iteration });
        }
      }
    }
  }
  if (output.length > 200) throw new LearningError('LEARNING_LIMIT');
  if (output.some(({ step, value }) => step.operation === 'select' && (value?.length ?? 0) > 500))
    throw new LearningError('LEARNING_INVALID');
  return output;
}
/** A fixed review/export template, never executable source supplied by a model. */
export function programScript(program: LearnedProgram) {
  return `// Review artifact: Sazuz executes the validated program through its policy/receipt interpreter.\n// Standalone execution requires an authorization callback before every side effect.\nexport const program = ${JSON.stringify(program, null, 2)};\n\nexport async function replay(page, inputs, authorize) {\n  if (typeof authorize !== 'function') throw new Error('An action authorization callback is required.');\n  const locate = (candidate) => {\n    if (candidate.kind === 'role') return page.getByRole(candidate.role, { name: candidate.name, exact: true });\n    if (candidate.kind === 'label') return page.getByLabel(candidate.value, { exact: true });\n    if (candidate.kind === 'text') return page.getByText(candidate.value, { exact: true });\n    if (candidate.kind === 'testId') return page.getByTestId(candidate.value);\n    return page.locator(candidate.kind === 'xpath' ? 'xpath=' + candidate.value : candidate.value);\n  };\n  const action = async (step, values) => {\n    if (step.operation === 'navigate') {\n      await authorize({ step, url: step.url });\n      await page.goto(step.url);\n      return;\n    }\n    let target;\n    for (const candidate of step.target.locators) {\n      const match = locate(candidate);\n      const count = await match.count();\n      if (count > 1) throw new Error('Ambiguous locator; review is required.');\n      if (count === 1 && await match.isVisible()) {\n      const compatible = match.and(page.getByRole(step.target.role, { name: step.target.name, exact: true }));\n      if (await compatible.count() === 1) target = target ? target.or(match) : match;\n    }\n    }\n    if (!target) throw new Error('Locator failed; Operator repair requires review.');\n    if (await target.count() !== 1) throw new Error('Conflicting locator candidates; review is required.');\n    const value = step.parameter ? values[step.parameter] : null;\n    await authorize({ step, value });\n    if (step.operation === 'fill') await target.fill(value);\n    else if (step.operation === 'select') await target.selectOption(value);\n    else await target.click();\n  };\n  for (const node of program.steps) {\n    if (node.kind === 'action') await action(node, inputs);\n    else {\n      const rows = inputs[node.parameter];\n      if (!Array.isArray(rows) || rows.length < 1 || rows.length > node.maxItems) throw new Error('Invalid list bound.');\n      for (const row of rows) for (const step of node.steps) await action(step, row);\n    }\n  }\n}\n`;
}
export function learnedFiles(name: string, description: string, programInput: unknown) {
  const program = checkedProgram(programInput);
  const script = programScript(program);
  if (script.length > 100000) throw new LearningError('LEARNING_LIMIT');
  const programHash = valueHash(program);
  const document = formatSkill(
    {
      name,
      description,
      version: '1.0.0',
      inputs: programInputSchema(program),
      tools: [
        'browser.open',
        'browser.navigate',
        'browser.resolve',
        'browser.click',
        'browser.type',
        'browser.select',
        'browser.close',
      ],
      permissions: ['read', 'write'],
    },
    `# ${name}\n\nReviewed browser procedure for ${program.site}. Run this exact revision from the learned-skill controls. Rehearse before live use. Current grants, human challenges and action approvals always apply. Do not execute the exported script as host code.\n\nProgram SHA-256: ${programHash}\n\n${program.steps.map((node) => (node.kind === 'action' ? `- ${node.id}: ${node.intent}` : `- ${node.id}: for each ${node.parameter} item (maximum ${node.maxItems})\n${node.steps.map((step) => `  - ${step.id}: ${step.intent}`).join('\n')}`)).join('\n')}`,
  );
  return { document, program, programHash, script };
}

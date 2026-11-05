import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  learningInputSchema,
  learnedProgramSchema,
  type RecordingEvent,
} from '@sazuz/core/learning';
import { SecretRedactor, secretRedactor } from '@sazuz/vault';
import {
  compileRecording,
  detectRecordingLoops,
  expandProgram,
  learnedFiles,
  applyLearningLabels,
} from './program.js';

const events: RecordingEvent[] = [
  { id: 'e1', kind: 'navigate', target: null, url: 'https://fixture.example/form', replay: true },
  {
    id: 'e2',
    kind: 'fill',
    url: null,
    replay: true,
    target: {
      role: 'textbox',
      name: 'Project',
      text: '',
      locators: [
        { kind: 'role', role: 'textbox', name: 'Project' },
        { kind: 'css', value: 'input[name="project"]' },
      ],
      box: null,
      crop: 'withheld',
    },
  },
  {
    id: 'e3',
    kind: 'click',
    url: null,
    replay: true,
    target: {
      role: 'button',
      name: 'Add item',
      text: 'Add item',
      locators: [{ kind: 'role', role: 'button', name: 'Add item' }],
      box: null,
      crop: 'withheld',
    },
  },
  {
    id: 'e4',
    kind: 'fill',
    url: null,
    replay: true,
    target: {
      role: 'textbox',
      name: 'Project',
      text: '',
      locators: [
        { kind: 'role', role: 'textbox', name: 'Project' },
        { kind: 'css', value: 'input[name="project"]' },
      ],
      box: null,
      crop: 'withheld',
    },
  },
  {
    id: 'e5',
    kind: 'click',
    url: null,
    replay: true,
    target: {
      role: 'button',
      name: 'Add item',
      text: 'Add item',
      locators: [{ kind: 'role', role: 'button', name: 'Add item' }],
      box: null,
      crop: 'withheld',
    },
  },
  { id: 'e6', kind: 'navigate', target: null, url: 'https://fixture.example/done', replay: false },
];
const input = () =>
  learningInputSchema.parse({
    requestId: randomUUID(),
    name: 'add-project',
    parameters: { e2: 'project', e4: 'project' },
  });
describe('reviewed learned programs', () => {
  it('parameterizes fields, excludes click navigation evidence and discovers a repeated list', () => {
    const candidates = detectRecordingLoops(events);
    expect(candidates).toContainEqual({ start: 1, length: 2, repeats: 2 });
    const program = compileRecording('https://fixture.example', events, {
      ...input(),
      loops: [{ start: 1, length: 2, repeats: 2, parameter: 'items' }],
    });
    expect(program.steps).toHaveLength(2);
    const expanded = expandProgram(program, {
      items: [{ project: 'New one' }, { project: 'Another' }, { project: 'Third' }],
    });
    expect(expanded).toHaveLength(7);
    expect(expanded.filter((item) => item.value).map((item) => item.value)).toEqual([
      'New one',
      'Another',
      'Third',
    ]);
    expect(() => expandProgram(program, { items: [{ project: 'OK', extra: 'No' }] })).toThrow();
    expect(() =>
      expandProgram(program, { items: Array.from({ length: 21 }, () => ({ project: 'One' })) }),
    ).toThrow();
  });
  it('keeps loops opt-in and refuses invented, overlapping or unbounded patterns', () => {
    expect(compileRecording('https://fixture.example', events, input()).steps).toHaveLength(5);
    expect(() =>
      compileRecording('https://fixture.example', events, {
        ...input(),
        loops: [{ start: 0, length: 2, repeats: 2, parameter: 'items' }],
      }),
    ).toThrow();
    expect(() =>
      compileRecording('https://fixture.example', events, {
        ...input(),
        parameters: { e1: 'url' },
      }),
    ).toThrow();
    expect(() => compileRecording('https://other.example', events, input())).toThrow();
    const program = compileRecording('https://fixture.example', events, input());
    expect(
      learnedProgramSchema.safeParse({ ...program, steps: [...program.steps, ...program.steps] })
        .success,
    ).toBe(false);
  });
  it('binds executable meaning into skill hashes and generates multi-locator review source', () => {
    const program = compileRecording('https://fixture.example', events, input());
    const files = learnedFiles('add-project', 'Add reviewed project entries.', program);
    expect(files.document.markdown).toContain(files.programHash);
    expect(files.script).toContain('page.getByRole');
    expect(files.script).toContain('for (const candidate of step.target.locators)');
    expect(files.script).toContain('await authorize');
    expect(files.document.manifest.inputs.properties).toHaveProperty('project');
    const labeled = applyLearningLabels(program, {
      description: 'Add entries.',
      intents: program.steps.flatMap((step) =>
        step.kind === 'action' ? [{ id: step.id, text: 'Reviewed intent.' }] : [],
      ),
    });
    expect(
      learnedFiles('add-project', 'Add reviewed project entries.', labeled).document.sha256,
    ).not.toBe(files.document.sha256);
    expect(() =>
      applyLearningLabels(program, {
        description: 'Bad',
        intents: [{ id: 's99', text: 'Different action.' }],
      }),
    ).toThrow();
  });
  it('rejects query-bearing navigation, injected selectors, credentials and incompatible input shapes', () => {
    const program = compileRecording('https://fixture.example', events, input());
    expect(
      learnedProgramSchema.safeParse({
        ...program,
        steps: [{ ...program.steps[0], url: 'https://fixture.example/?token=private' }],
      }).success,
    ).toBe(false);
    expect(() => expandProgram(program, { project: ['wrong shape'] })).toThrow();
    const canary = 'phase9-program-key-193278674';
    secretRedactor.register(canary);
    expect(() => expandProgram(program, { project: canary })).toThrow();
    const redactor = new SecretRedactor();
    redactor.register(canary);
    expect(redactor.redact({ event: 'fill', text: canary })).not.toEqual({
      event: 'fill',
      text: canary,
    });
  });
});

import { z } from 'zod';
import { elementFingerprintSchema } from './learned-target';

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
export const browserProfileId = id('bpr');
export const browserSessionId = id('bsn');
export const browserFileId = id('bfl');
export const browserRef = z.string().regex(/^r[1-9][0-9]{0,8}e[1-9][0-9]{0,3}$/);
export const browserSiteSchema = z
  .string()
  .max(300)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.origin === value &&
        !url.port &&
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
      );
    } catch {
      return false;
    }
  }, 'Use an HTTPS site origin, for example https://example.com.');
export const browserUrlSchema = z
  .url()
  .max(4096)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port;
  });
const secretRef = z.string().regex(/^secret:\/\/sec_[0-9A-HJKMNP-TV-Z]{26}$/);
export const browserProfileInputSchema = z.strictObject({
  projectId: id('prj'),
  agentId: z.enum(['operator', 'researcher']),
  name: z.string().trim().min(1).max(80),
  site: browserSiteSchema,
  secretRefs: z.array(secretRef).max(16).default([]),
  expiresAt: z.iso.datetime().nullable().default(null),
});
export const browserProfileSchema = browserProfileInputSchema.extend({
  id: browserProfileId,
  version: z.number().int().positive(),
  hasSavedState: z.boolean(),
  retired: z.boolean(),
  createdAt: z.iso.datetime(),
});
export const browserProfileUpdateSchema = browserProfileInputSchema
  .omit({ projectId: true, agentId: true, site: true })
  .extend({
    version: z.number().int().positive(),
  });
export const browserVersionSchema = z.strictObject({ version: z.number().int().positive() });
export const browserChallengeSchema = z.enum(['login', 'verification', 'captcha']);
export const browserSessionSchema = z.strictObject({
  id: browserSessionId,
  profileId: browserProfileId,
  runId: id('run'),
  projectId: id('prj'),
  agentId: z.string().max(128),
  status: z.enum(['opening', 'active', 'closed', 'lost']),
  control: z.enum(['agent', 'human']),
  version: z.number().int().positive(),
  sensitive: z.boolean(),
  challenge: browserChallengeSchema.nullable(),
  origin: z.string().max(300),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
const session = z.strictObject({ sessionId: browserSessionId });
const target = session.extend({ ref: browserRef });
export const browserActionInputs = {
  open: z.strictObject({ profileId: browserProfileId }),
  read: session,
  resolve: session.extend({ target: elementFingerprintSchema }),
  navigate: session.extend({ url: browserUrlSchema }),
  click: target,
  type: target.extend({
    value: z.union([
      z.strictObject({ text: z.string().max(8000) }),
      z.strictObject({ secret: secretRef }),
    ]),
  }),
  select: target.extend({ values: z.array(z.string().max(500)).min(1).max(20) }),
  scroll: session.extend({
    direction: z.enum(['up', 'down']),
    pixels: z.number().int().min(1).max(2000).default(600),
  }),
  wait_for: session.extend({
    text: z.string().min(1).max(200),
    timeoutMs: z.number().int().min(100).max(5000).default(3000),
  }),
  extract: session.extend({
    schema: z.strictObject({
      type: z.literal('object'),
      properties: z
        .record(
          z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/),
          z
            .strictObject({
              ref: browserRef.optional(),
              source: z.enum(['ref', 'title', 'text']).default('ref'),
              type: z.enum(['string', 'number', 'boolean']),
            })
            .refine((value) => value.source !== 'ref' || value.ref !== undefined),
        )
        .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 20),
    }),
  }),
  screenshot: session,
  download: target,
  upload: target.extend({ fileHandle: browserFileId }),
  tabs: session.extend({
    action: z.enum(['list', 'new', 'switch', 'close']),
    tabId: z.number().int().min(1).max(1000).optional(),
  }),
  close: session,
} as const;
export const browserOperationSchema = z.enum([
  'open',
  'read',
  'resolve',
  'navigate',
  'click',
  'type',
  'select',
  'scroll',
  'wait_for',
  'extract',
  'screenshot',
  'download',
  'upload',
  'tabs',
  'close',
]);
export type BrowserOperation = keyof typeof browserActionInputs;
export const browserCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('open'), args: browserActionInputs.open }),
  z.strictObject({ operation: z.literal('read'), args: browserActionInputs.read }),
  z.strictObject({ operation: z.literal('resolve'), args: browserActionInputs.resolve }),
  z.strictObject({ operation: z.literal('navigate'), args: browserActionInputs.navigate }),
  z.strictObject({ operation: z.literal('click'), args: browserActionInputs.click }),
  z.strictObject({ operation: z.literal('type'), args: browserActionInputs.type }),
  z.strictObject({ operation: z.literal('select'), args: browserActionInputs.select }),
  z.strictObject({ operation: z.literal('scroll'), args: browserActionInputs.scroll }),
  z.strictObject({ operation: z.literal('wait_for'), args: browserActionInputs.wait_for }),
  z.strictObject({ operation: z.literal('extract'), args: browserActionInputs.extract }),
  z.strictObject({ operation: z.literal('screenshot'), args: browserActionInputs.screenshot }),
  z.strictObject({ operation: z.literal('download'), args: browserActionInputs.download }),
  z.strictObject({ operation: z.literal('upload'), args: browserActionInputs.upload }),
  z.strictObject({ operation: z.literal('tabs'), args: browserActionInputs.tabs }),
  z.strictObject({ operation: z.literal('close'), args: browserActionInputs.close }),
]);
export type BrowserCommand = z.infer<typeof browserCommandSchema>;
export const browserFileSchema = z.strictObject({
  handle: browserFileId,
  name: z.string().max(120),
  bytes: z.number().int().min(0).max(262144),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  scan: z.literal('restricted-text'),
});
export const browserObservationSchema = z.strictObject({
  sessionId: browserSessionId,
  revision: z.number().int().min(0),
  status: z.enum(['ready', 'human_required', 'blocked', 'closed']),
  reason: z.string().max(500).nullable(),
  challenge: browserChallengeSchema.nullable(),
  origin: z.string().max(300),
  title: z.string().max(500),
  text: z.string().max(10000),
  elements: z
    .array(z.strictObject({ ref: browserRef, role: z.string().max(50), name: z.string().max(300) }))
    .max(100),
  tabs: z
    .array(
      z.strictObject({
        id: z.number().int().positive(),
        title: z.string().max(300),
        origin: z.string().max(300),
        active: z.boolean(),
      }),
    )
    .max(4),
  sensitive: z.boolean(),
  screenshot: z.enum(['available', 'withheld']),
  actionPerformed: z.boolean().optional(),
  resolution: z
    .strictObject({
      status: z.enum(['matched', 'missing', 'ambiguous', 'invalid']),
      ref: browserRef.nullable(),
    })
    .optional(),
  imageHandle: z
    .string()
    .regex(/^bim_[a-f0-9]{32}$/)
    .optional(),
  extracted: z
    .record(z.string(), z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]))
    .optional(),
  file: browserFileSchema.optional(),
});
export type BrowserObservation = z.infer<typeof browserObservationSchema>;
export const browserControlSchema = z.strictObject({
  action: z.enum(['take', 'handback']),
  version: z.number().int().positive(),
});
export const browserHumanInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('pointer'),
    event: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']),
    x: z.number().min(0).max(1280),
    y: z.number().min(0).max(800),
    button: z.enum(['left', 'right', 'none']).default('left'),
    deltaY: z.number().min(-2000).max(2000).default(0),
  }),
  z.strictObject({
    type: z.literal('key'),
    event: z.enum(['keyDown', 'keyUp']),
    key: z.string().min(1).max(40),
    code: z.string().max(40),
    modifiers: z.number().int().min(0).max(15).default(0),
  }),
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(8000) }),
]);
export type BrowserHumanInput = z.infer<typeof browserHumanInputSchema>;
export const browserImageSchema = z.strictObject({
  mimeType: z.literal('image/jpeg'),
  data: z
    .string()
    .min(4)
    .max(2000000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export const browserFrameSchema = z.strictObject({
  type: z.literal('frame'),
  data: browserImageSchema.shape.data,
  width: z.literal(1280),
  height: z.literal(800),
});
export const browserLiveMessageSchema = z.discriminatedUnion('type', [
  browserFrameSchema,
  z.strictObject({
    type: z.literal('state'),
    session: browserSessionSchema,
    inputAllowed: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('error'),
    code: z.enum(['BROWSER_DENIED', 'BROWSER_UNAVAILABLE', 'BROWSER_CONFLICT']),
  }),
]);
const browserErrors = {
  BROWSER_INVALID: 'The browser request is invalid.',
  BROWSER_DENIED: 'This browser action, profile or site is unavailable.',
  BROWSER_CONFLICT: 'Browser state changed. Refresh and try again.',
  BROWSER_UNAVAILABLE: 'The browser service is unavailable. Check Health and resume when ready.',
  BROWSER_UNCERTAIN: 'The browser action may have completed. Review the page before retrying.',
  BROWSER_EXPIRED: 'The browser session expired. Open a new session after reviewing the run.',
} as const;
export class BrowserError extends Error {
  constructor(readonly code: keyof typeof browserErrors) {
    super(browserErrors[code]);
    this.name = 'BrowserError';
  }
}

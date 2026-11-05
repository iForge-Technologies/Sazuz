import { randomUUID } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright';
import { z } from 'zod';
import {
  BrowserError,
  browserObservationSchema,
  type BrowserCommand,
  type BrowserHumanInput,
} from '@sazuz/core/browser';
import {
  browserActions,
  browserProfiles,
  browserSessions,
  browserRecordings,
  getControl,
  jsonValue,
  runs,
  valueHash,
  type Database,
} from '@sazuz/db';
import {
  browserProfileStateSchema,
  scopedStorage,
  type BrowserLaunch,
  type BrowserRpc,
  type BrowserRpcResult,
} from '@sazuz/browser/protocol';
import {
  consumeBrowserValue,
  sealBrowserValue,
  SecretRedactor,
  type BrowserBinding,
} from '@sazuz/vault';
import { issueGrant } from '@sazuz/sandbox';
import type { SettingsDocument } from '@sazuz/config/settings';
import { perform } from './actions.js';
import { observation } from './perception.js';
import { currentPage, remember, type BrowserSession } from './session.js';
import { captureSensitiveState } from './state.js';
import { humanInput } from './human.js';
import { createRecorder } from './recorder.js';
import { interruptRecordings } from '@sazuz/browser';

export interface BrowserEngineOptions {
  database: Database;
  key: string;
  egressUrl: string;
  launch?: () => Promise<Browser>;
  ignoreHTTPSErrors?: boolean;
  getSettings?: () => SettingsDocument;
}
export function createBrowserEngine(options: BrowserEngineOptions) {
  const { database, key } = options;
  const recorder = createRecorder(database);
  const serviceId = randomUUID();
  const sessions = new Map<string, BrowserSession>();
  const busy = new Set<string>();
  let browser: Browser | undefined;
  let launching: Promise<Browser> | undefined;
  async function launch() {
    if (browser && !browser.isConnected()) {
      browser = undefined;
      launching = undefined;
    }
    launching ??= (
      options.launch ??
      (() =>
        chromium.launch({
          headless: true,
          chromiumSandbox: true,
          args: [
            '--disable-quic',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--disable-features=WebRtcHideLocalIpsWithMdns',
          ],
        }))
    )();
    try {
      browser = await launching;
      return browser;
    } catch {
      launching = undefined;
      throw new BrowserError('BROWSER_UNAVAILABLE');
    }
  }
  async function saveSession(session: BrowserSession) {
    await database.orm
      .update(browserSessions)
      .set({
        status: 'active',
        control: session.control === 'human' ? 'human' : sql`${browserSessions.control}`,
        sensitive: sql`${browserSessions.sensitive} OR ${session.sensitive}`,
        challenge: session.challenge,
        origin: await observationOrigin(session),
        updatedAt: new Date(),
      })
      .where(
        and(eq(browserSessions.id, session.launch.sessionId), eq(browserSessions.status, 'active')),
      );
  }
  function observationOrigin(session: BrowserSession) {
    const url = new URL(currentPage(session).url());
    return Promise.resolve(url.protocol === 'https:' ? url.origin : '');
  }
  async function valid(id: string, allowHuman = false) {
    const session = sessions.get(id);
    const [row] = await database.orm
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.id, id));
    if (
      !session ||
      !session.context.browser()?.isConnected() ||
      !row ||
      row.status !== 'active' ||
      row.serviceId !== serviceId ||
      row.expiresAt.getTime() <= Date.now()
    )
      throw new BrowserError('BROWSER_EXPIRED');
    const [profile] = await database.orm
      .select()
      .from(browserProfiles)
      .where(eq(browserProfiles.id, row.profileId));
    const [run] = await database.orm.select().from(runs).where(eq(runs.id, row.runId));
    if (
      !profile ||
      profile.retired ||
      profile.generation !== row.profileGeneration ||
      (profile.expiresAt && profile.expiresAt.getTime() <= Date.now()) ||
      !run ||
      ['cancelled', 'completed', 'failed'].includes(run.status)
    )
      throw new BrowserError('BROWSER_DENIED');
    session.sensitive ||= row.sensitive;
    session.control = row.control === 'human' ? 'human' : 'agent';
    if (session.handbackVersion !== undefined && session.handbackVersion !== row.version)
      delete session.handbackVersion;
    const currentDomains =
      options
        .getSettings?.()
        .security.value.agentDomains.find((entry) => entry.agentId === row.agentId)?.domains ?? [];
    if (
      options.getSettings &&
      JSON.stringify([...currentDomains].sort()) !==
        JSON.stringify([...session.launch.domains].sort())
    )
      throw new BrowserError('BROWSER_DENIED');
    if (!allowHuman && ((await getControl(database)).paused || run.status !== 'running'))
      throw new BrowserError('BROWSER_DENIED');
    return session;
  }
  async function open(spec: BrowserLaunch, capsule: BrowserRpc['capsule']) {
    if (sessions.size >= spec.poolSize || spec.expiresAt <= Date.now())
      throw new BrowserError('BROWSER_DENIED');
    const [row] = await database.orm
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.id, spec.sessionId));
    if (
      !row ||
      row.runId !== spec.runId ||
      row.profileId !== spec.profileId ||
      row.profileGeneration !== spec.generation ||
      row.status !== 'opening'
    )
      throw new BrowserError('BROWSER_DENIED');
    const token = issueGrant(key, {
      service: 'egress',
      subject: spec.sessionId,
      projectId: spec.projectId,
      agentId: spec.agentId,
      domains: spec.domains,
      expiresAt: spec.expiresAt,
    });
    const stored = capsule
      ? await consumeBrowserValue(key, capsule.binding, capsule, (value) =>
          Promise.resolve(browserProfileStateSchema.parse(JSON.parse(value))),
        )
      : { state: { cookies: [], origins: [] }, redactions: [], opaque: false };
    if (
      capsule &&
      (capsule.binding.sessionId !== spec.sessionId ||
        capsule.binding.site !== spec.site ||
        capsule.binding.runId !== spec.runId ||
        capsule.binding.purpose !== 'state')
    )
      throw new BrowserError('BROWSER_DENIED');
    const state = scopedStorage(stored.state, spec.site);
    const context = await (
      await launch()
    ).newContext({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
      serviceWorkers: 'block',
      storageState: state,
      proxy: {
        server: options.egressUrl,
        username: 'sazuz',
        password: token,
        bypass: '<-loopback>',
      },
      ignoreHTTPSErrors: options.ignoreHTTPSErrors ?? false,
    });
    context.setDefaultTimeout(5000);
    const session: BrowserSession = {
      launch: spec,
      storage: structuredClone(state),
      context,
      pages: new Map(),
      nextTab: 1,
      activeTab: 1,
      revision: 0,
      signature: '',
      refs: new Map(),
      redactor: new SecretRedactor(),
      redactions: new Set(),
      fields: new Map(),
      opaque: stored.opaque,
      sensitive:
        state.cookies.length > 0 ||
        state.origins.some((origin) => origin.localStorage.length > 0) ||
        stored.redactions.length > 0,
      challenge: null,
      control: 'agent',
      files: new Map(),
      images: new Map(),
    };
    for (const value of stored.redactions) remember(session, value);
    for (const cookie of state.cookies) remember(session, cookie.value);
    for (const origin of state.origins)
      for (const entry of origin.localStorage) remember(session, entry.value);
    sessions.set(spec.sessionId, session);
    try {
      await context.route('**/*', async (route) => {
        let allowed: boolean;
        try {
          const url = new URL(route.request().url());
          allowed =
            url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            !url.port &&
            spec.domains.includes(url.hostname) &&
            (!route.request().isNavigationRequest() ||
              route.request().frame() !== route.request().frame().page().mainFrame() ||
              url.origin === spec.site);
        } catch {
          allowed = false;
        }
        if (allowed) await route.continue();
        else await route.abort('blockedbyclient');
      });
      await context.routeWebSocket('**/*', (websocket) => websocket.close());
      const binding = `sazuzInput${randomUUID().replaceAll('-', '')}`;
      await context.exposeBinding(binding, (_source, value: unknown) => {
        const parsed = z
          .strictObject({ field: z.string().max(80), value: z.string().max(8000) })
          .safeParse(value);
        if (!parsed.success) return;
        if (session.fields.size >= 256 && !session.fields.has(parsed.data.field)) {
          session.opaque = true;
          session.sensitive = true;
          return;
        }
        session.fields.set(parsed.data.field, parsed.data.value);
      });
      await context.addInitScript(
        ({ binding }) => {
          const fields = new WeakMap<Element, string>();
          document.addEventListener(
            'input',
            (event) => {
              const target = event.target;
              if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement))
                return;
              if (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type))
                return;
              let field = fields.get(target);
              if (!field) {
                field = crypto.randomUUID();
                fields.set(target, field);
              }
              const callback: unknown = Reflect.get(window, binding);
              if (typeof callback === 'function') {
                const send = callback as (input: { field: string; value: string }) => Promise<void>;
                void send({ field, value: target.value.slice(0, 8000) });
              }
            },
            true,
          );
        },
        { binding },
      );
      context.on('page', (page) => {
        const admitted = () => {
          if (page.url() === 'about:blank') return true;
          try {
            const url = new URL(page.url());
            return url.origin === spec.site && !url.username && !url.password;
          } catch {
            return false;
          }
        };
        const discard = () => {
          void page
            .close()
            .catch(() =>
              database.logger.warn(
                { code: 'BROWSER_TAB_CLOSE_FAILED' },
                'An unavailable browser tab could not close.',
              ),
            );
        };
        if (!admitted() || session.pages.size >= 4) {
          discard();
          return;
        }
        const id = session.nextTab++;
        session.pages.set(id, page);
        const remove = () => {
          session.pages.delete(id);
          if (session.activeTab === id) session.activeTab = session.pages.keys().next().value ?? 0;
        };
        page.on('close', remove);
        // Internal browser pages (including Edge's automatic downloads tab) have no site scope.
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) session.images.clear();
          if (frame !== page.mainFrame() || admitted()) return;
          remove();
          discard();
        });
        page.on('dialog', (dialog) => {
          void dialog
            .dismiss()
            .catch(() =>
              database.logger.warn(
                { code: 'BROWSER_DIALOG_CLOSED' },
                'A browser dialog became unavailable.',
              ),
            );
        });
      });
      await context.newPage();
      await database.orm
        .update(browserSessions)
        .set({ serviceId, status: 'active', sensitive: session.sensitive, updatedAt: new Date() })
        .where(and(eq(browserSessions.id, spec.sessionId), eq(browserSessions.status, 'opening')));
      return session;
    } catch {
      await context.close();
      sessions.delete(spec.sessionId);
      throw new BrowserError('BROWSER_UNAVAILABLE');
    }
  }
  async function state(session: BrowserSession, callKey: string) {
    await captureSensitiveState(session);
    const storage = session.storage;
    // Cookies/local storage are credential material and stay inside the encrypted envelope.
    const value = JSON.stringify({
      state: storage,
      redactions: [...session.redactions],
      opaque: session.opaque,
    });
    const binding: BrowserBinding = {
      sessionId: session.launch.sessionId,
      runId: session.launch.runId,
      site: session.launch.site,
      callKey,
      purpose: 'state-return',
      nonce: randomUUID(),
      expiresAt: Date.now() + 45000,
    };
    return sealBrowserValue(key, binding, value);
  }
  async function close(id: string, status: 'closed' | 'lost' = 'closed') {
    await interruptRecordings(database, id);
    const session = sessions.get(id);
    if (session) {
      await session.context.close();
      for (const file of session.files.values()) file.content.fill(0);
      sessions.delete(id);
    }
    await database.orm
      .update(browserSessions)
      .set({ status, version: sql`${browserSessions.version}+1`, updatedAt: new Date() })
      .where(eq(browserSessions.id, id));
  }
  async function action(message: BrowserRpc): Promise<BrowserRpcResult> {
    if (!message.command || !message.callKey || !message.sessionId)
      throw new BrowserError('BROWSER_INVALID');
    const command: BrowserCommand = message.command,
      id = message.sessionId;
    const [receipt] = await database.orm
      .select()
      .from(browserActions)
      .where(eq(browserActions.key, message.callKey));
    if (
      receipt &&
      (receipt.sessionId !== id ||
        receipt.argsHash !== valueHash(command) ||
        receipt.operation !== command.operation)
    )
      throw new BrowserError('BROWSER_DENIED');
    if (receipt?.status === 'done')
      return { status: 'done', observation: browserObservationSchema.parse(receipt.result) };
    if (receipt) return { status: 'unknown' };
    if (message.mode === 'verify') return { status: 'not_done' };
    await database.orm.insert(browserActions).values({
      key: message.callKey,
      sessionId: id,
      argsHash: valueHash(command),
      operation: command.operation,
    });
    let session: BrowserSession;
    if (command.operation === 'open') {
      if (!message.launch || message.launch.sessionId !== id)
        throw new BrowserError('BROWSER_INVALID');
      session = await open(message.launch, message.capsule);
    } else session = await valid(id);
    let result: Awaited<ReturnType<typeof perform>>;
    try {
      if (message.capsule && command.operation === 'type' && 'secret' in command.args.value) {
        const binding = message.capsule.binding;
        if (
          binding.sessionId !== id ||
          binding.runId !== session.launch.runId ||
          binding.site !== session.launch.site ||
          binding.callKey !== message.callKey ||
          binding.purpose !== 'secret'
        )
          throw new BrowserError('BROWSER_DENIED');
        session.sensitive = true;
        await saveSession(session);
        result = await consumeBrowserValue(key, binding, message.capsule, (value) =>
          perform(session, command, value),
        );
      } else result = await perform(session, command);
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'BROWSER_CONFLICT')
        result = await observation(
          session,
          'Element references are stale. Read the page and use its new references.',
        );
      else throw error;
    }
    await saveSession(session);
    const parsed = browserObservationSchema.parse(result);
    await database.orm
      .update(browserActions)
      .set({ status: 'done', result: jsonValue(parsed), updatedAt: new Date() })
      .where(eq(browserActions.key, message.callKey));
    const saved = await state(session, message.callKey);
    if (command.operation === 'close') await close(id);
    return { status: 'done', observation: parsed, state: saved };
  }
  async function dispatch(message: BrowserRpc): Promise<BrowserRpcResult> {
    if (message.mode === 'health') {
      await launch();
      return { ready: true };
    }
    const id = message.sessionId;
    if (!id) throw new BrowserError('BROWSER_INVALID');
    if (busy.has(id)) throw new BrowserError('BROWSER_CONFLICT');
    busy.add(id);
    try {
      if (message.mode === 'action' || message.mode === 'verify') return await action(message);
      if (message.mode === 'close') {
        await close(id);
        return { ready: true };
      }
      const session = await valid(id, true);
      if (message.mode === 'record') {
        const [record] = await database.orm
          .select()
          .from(browserRecordings)
          .where(
            and(
              eq(browserRecordings.id, message.recordingId ?? ''),
              eq(browserRecordings.sessionId, id),
              eq(browserRecordings.status, 'recording'),
            ),
          );
        if (!record || session.control !== 'human') throw new BrowserError('BROWSER_DENIED');
        if (Array.isArray(record.events) && !record.events.length) await recorder.initial(session);
        return { ready: true };
      }
      if (message.mode === 'state')
        return { state: await state(session, message.callKey ?? 'control') };
      if (message.mode === 'image') {
        await captureSensitiveState(session);
        const image = message.imageHandle ? session.images.get(message.imageHandle) : undefined;
        if (
          session.sensitive ||
          session.control === 'human' ||
          !image ||
          image.expiresAt < Date.now()
        )
          throw new BrowserError('BROWSER_DENIED');
        session.images.clear();
        return { image: { mimeType: 'image/jpeg', data: image.data } };
      }
      if (message.mode === 'take') {
        session.control = 'human';
        session.sensitive = true;
        session.images.clear();
      }
      if (message.mode === 'handback') {
        if (await recorder.active(session)) throw new BrowserError('BROWSER_CONFLICT');
        const observed = await observation(session);
        if (observed.challenge) throw new BrowserError('BROWSER_DENIED');
        const [row] = await database.orm
          .select()
          .from(browserSessions)
          .where(eq(browserSessions.id, id));
        if (!row || row.control !== 'human' || row.status !== 'active')
          throw new BrowserError('BROWSER_CONFLICT');
        // The server commits handback only after this state has reached the vault.
        const saved = await state(session, 'control');
        // Block already-forwarded input until the versioned control transition is committed.
        session.handbackVersion = row.version;
        return { ready: true, state: saved };
      }
      await saveSession(session);
      return { ready: true, state: await state(session, 'control') };
    } finally {
      busy.delete(id);
    }
  }
  return {
    serviceId,
    sessions,
    dispatch,
    valid,
    async input(id: string, message: BrowserHumanInput) {
      if (busy.has(id)) throw new BrowserError('BROWSER_CONFLICT');
      busy.add(id);
      try {
        const session = await valid(id, true);
        const [run] = await database.orm
          .select()
          .from(runs)
          .where(eq(runs.id, session.launch.runId));
        if (
          session.control !== 'human' ||
          session.handbackVersion !== undefined ||
          !run ||
          run.claimKey ||
          !['paused', 'waiting_approval', 'budget_exceeded'].includes(run.status) ||
          (await getControl(database)).paused
        )
          throw new BrowserError('BROWSER_DENIED');
        session.sensitive = true;
        session.images.clear();
        await recorder.beforeInput(session, message);
        try {
          await humanInput(session, message);
          await recorder.afterInput(session);
        } catch (error) {
          await interruptRecordings(database, id);
          throw error;
        }
      } finally {
        busy.delete(id);
      }
    },
    async initialize() {
      await database.orm
        .update(browserSessions)
        .set({ status: 'lost', updatedAt: new Date() })
        .where(
          and(
            ne(browserSessions.serviceId, serviceId),
            sql`${browserSessions.status} IN ('active','opening')`,
          ),
        );
      await database.orm
        .update(browserRecordings)
        .set({ status: 'interrupted', updatedAt: new Date() })
        .where(
          sql`${browserRecordings.status}='recording' AND ${browserRecordings.sessionId} IN (SELECT id FROM browser_sessions WHERE status IN ('lost','closed'))`,
        );
    },
    async sweep() {
      for (const [id] of sessions) {
        if (busy.has(id)) continue;
        try {
          await valid(id, true);
        } catch {
          await close(id, 'lost');
        }
      }
    },
    async stop() {
      for (const [id] of sessions) await close(id);
      await browser?.close();
    },
  };
}
export type BrowserEngine = ReturnType<typeof createBrowserEngine>;

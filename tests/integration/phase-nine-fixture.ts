import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { browserSessions, runs } from '@sazuz/db';
import { recordingSchema } from '@sazuz/core/learning';
import { browserFixture } from './phase-five-fixture.js';

export async function learningFixture() {
  let changed = false,
    ambiguous = false;
  const submissions: Record<string, string>[] = [];
  const f = await browserFixture({
    respond: ({ path, body, method }) => {
      const page = (content: string) =>
        `<!doctype html><html><head><title>Demo project</title></head><body>${content}</body></html>`;
      if (path === '/learn')
        return {
          body: page(`<form action="/learn-review" method="post">
      <label>Project<input aria-label="Project" name="project" id="project"></label>
      <label>Client<input aria-label="Client" name="client" id="client"></label>
      <label>Category<select aria-label="Category" name="category" id="category"><option>Alpha</option><option>Beta</option></select></label>
      <button ${changed ? 'id="continue-new" aria-label="Continue to summary"' : 'id="review" aria-label="Review project"'}>Review project</button>
      ${ambiguous ? '<button id="duplicate" aria-label="Review project">Other action</button>' : ''}</form>`),
        };
      if (path === '/learn-review') {
        const fields = Object.fromEntries(new URLSearchParams(body));
        return {
          body: page(`<form action="/learn-done" method="post">
        <input type="hidden" name="project" value="${fields['project'] ?? ''}">
        <input type="hidden" name="client" value="${fields['client'] ?? ''}">
        <input type="hidden" name="category" value="${fields['category'] ?? ''}">
        <label>Notes<textarea aria-label="Notes" name="notes" id="notes"></textarea></label>
        <label><input type="checkbox" aria-label="Confirmed" name="confirmed" id="confirmed">Confirmed</label>
        <button aria-label="Submit project" id="submit">Submit project</button></form>`),
        };
      }
      if (path === '/learn-done') {
        if (method === 'POST') submissions.push(Object.fromEntries(new URLSearchParams(body)));
        return { body: page('<p>Project saved.</p>') };
      }
      return undefined;
    },
  });
  async function recorded(name = 'Recorded project') {
    const run = await f.mission(name);
    const opened = await run.act({ operation: 'open', args: { profileId: run.profile.id } });
    const sessionId = opened.observation.sessionId;
    await run.act({
      operation: 'navigate',
      args: { sessionId, url: 'https://fixture.example/learn?discard=this#fragment' },
    });
    await f.db.orm
      .update(runs)
      .set({ status: 'paused', claimKey: null, workerId: null })
      .where(eq(runs.id, run.mission.run.id));
    const [session] = await f.db.orm
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.id, sessionId));
    const take = await f.request('POST', `/api/browser/sessions/${sessionId}/control`, {
      action: 'take',
      version: session!.version,
    });
    expect(take.statusCode, take.body).toBe(200);
    const version = (
      await f.db.orm.select().from(browserSessions).where(eq(browserSessions.id, sessionId))
    )[0]!.version;
    const start = { action: 'start', requestId: randomUUID(), name, version, privateOnly: true };
    const response = await f.request('POST', `/api/browser/sessions/${sessionId}/recording`, start);
    expect(response.statusCode, response.body).toBe(200);
    const record = recordingSchema.parse(response.json());
    const page = f.service.engine.sessions.get(sessionId)!.pages.values().next().value!;
    async function key(key: string) {
      for (const event of ['keyDown', 'keyUp'] as const)
        await f.service.engine.input(sessionId, {
          type: 'key',
          event,
          key,
          code: key,
          modifiers: 0,
        });
    }
    async function focus(label: string) {
      await page.getByLabel(label, { exact: true }).focus();
    }
    async function fill(label: string, value: string) {
      await focus(label);
      // Multiple text insertions must become one parameter, never persisted sample values.
      await f.service.engine.input(sessionId, { type: 'text', text: value.slice(0, 5) });
      await f.service.engine.input(sessionId, { type: 'text', text: value.slice(5) });
    }
    async function click(label: string) {
      const target = page.getByRole(label === 'Confirmed' ? 'checkbox' : 'button', {
        name: label,
        exact: true,
      });
      const box = await target.boundingBox();
      if (!box) throw new Error('Demo target has no bounding box.');
      for (const event of ['mousePressed', 'mouseReleased'] as const)
        await f.service.engine.input(sessionId, {
          type: 'pointer',
          event,
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
          button: 'left',
          deltaY: 0,
        });
    }
    async function stop() {
      const response = await f.request('POST', `/api/browser/sessions/${sessionId}/recording`, {
        action: 'stop',
        recordingId: record.id,
        version: record.version,
      });
      expect(response.statusCode, response.body).toBe(200);
      return recordingSchema.parse(response.json());
    }
    return { run, sessionId, start, record, page, key, focus, fill, click, stop };
  }
  async function eightSteps() {
    const demo = await recorded();
    await demo.fill('Project', 'Original project');
    await demo.fill('Client', 'Original client');
    await demo.focus('Category');
    await demo.key('ArrowDown');
    await demo.key('Tab');
    await demo.click('Review project');
    await demo.page.waitForURL('**/learn-review');
    await demo.fill('Notes', 'Original notes');
    await demo.click('Confirmed');
    await demo.click('Submit project');
    await demo.page.waitForURL('**/learn-done');
    return { ...demo, recording: await demo.stop() };
  }
  return {
    ...f,
    recorded,
    eightSteps,
    submissions,
    changeDom: () => {
      changed = true;
    },
    duplicateTarget: () => {
      ambiguous = true;
    },
    resetDom: () => {
      changed = false;
      ambiguous = false;
    },
  };
}

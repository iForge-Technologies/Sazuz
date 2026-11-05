import { z } from 'zod';
import { browserSessionId } from '@sazuz/core/browser';
import { recordingControlSchema, recordingSchema, LearningError } from '@sazuz/core/learning';
import { recording, startRecording, stopRecording } from '@sazuz/browser';
import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import type { BrowserGateway } from './phase-five-execution.js';
import type { BrowserControl } from './phase-five-control.js';

export function registerRecording(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  gateway: BrowserGateway,
  controls: BrowserControl,
) {
  app.post(
    '/api/browser/sessions/:id/recording',
    {
      schema: {
        params: z.strictObject({ id: browserSessionId }),
        body: recordingControlSchema,
        response: { 200: recordingSchema },
      },
    },
    async (request) => {
      const { user } = await runtime.admin(request);
      const input = request.body,
        id = request.params.id;
      if (input.action === 'start') {
        await controls.inputAllowed(user.id, id);
        const saved = await startRecording(runtime.database, user.id, id, input);
        if (saved.status === 'recording')
          await gateway.client({ mode: 'record', sessionId: id, recordingId: saved.id });
        return recording(runtime.database, user.id, saved.id);
      }
      const saved = await recording(runtime.database, user.id, input.recordingId);
      if (saved.sessionId !== id) throw new LearningError('LEARNING_DENIED');
      return stopRecording(runtime.database, user.id, saved.id, input.version);
    },
  );
}

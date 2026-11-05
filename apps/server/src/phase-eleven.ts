import type { createApp } from './app.js';
import type { PhaseOne } from './phase-one.js';
import { registerIdentity } from './phase-eleven-identity.js';
import { registerBackups } from './phase-eleven-backups.js';
import { registerUpdates } from './phase-eleven-updates.js';
import { registerVoice } from './phase-eleven-voice.js';
import { registerPush } from './phase-eleven-push.js';

export function registerPhaseEleven(
  app: Awaited<ReturnType<typeof createApp>>,
  runtime: PhaseOne,
  options: Parameters<typeof registerBackups>[2] = {},
) {
  registerIdentity(app, runtime);
  const backups = registerBackups(app, runtime, options);
  registerUpdates(app, runtime, backups);
  registerVoice(app, runtime);
  registerPush(
    app,
    runtime,
    options.background === undefined ? {} : { background: options.background },
  );
  return backups;
}

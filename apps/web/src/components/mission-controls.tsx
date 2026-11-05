import { useState } from 'react';
import Link from 'next/link';
import { runControlSchema, type Run, type RunControl } from '@sazuz/core/missions';
import { formatCost } from './chat-messages';

export function MissionControls({
  run,
  disabled,
  globallyPaused,
  onControl,
  noun = 'mission',
}: {
  run: Run;
  disabled: boolean;
  globallyPaused: boolean;
  onControl: (input: RunControl) => Promise<void>;
  noun?: 'mission' | 'task';
}) {
  const [cost, setCost] = useState('0.5');
  const [steps, setSteps] = useState('0');
  const [wallTime, setWallTime] = useState('0');
  const [error, setError] = useState('');
  const stopped = ['completed', 'cancelled'].includes(run.status);
  function control(action: RunControl['action']) {
    void onControl(runControlSchema.parse({ action, version: run.version }));
  }
  return (
    <div className="mission-controls">
      {run.reason && (
        <p className={run.status === 'budget_exceeded' ? 'setup-notice' : 'work-muted'}>
          {run.reason}
        </p>
      )}
      {globallyPaused && (
        <p className="setup-notice">
          All agents are paused. Use the header control before resuming a mission.
        </p>
      )}
      <div className="durable-actions">
        {['running', 'queued', 'waiting_tasks'].includes(run.status) && (
          <button className="secondary" disabled={disabled} onClick={() => control('pause')}>
            Pause {noun}
          </button>
        )}
        {['paused', 'failed'].includes(run.status) && (
          <button disabled={disabled || globallyPaused} onClick={() => control('resume')}>
            Resume {noun}
          </button>
        )}
        {run.status === 'waiting_approval' && (
          <Link href={`/approvals?missionId=${run.missionId}`}>Review pending approvals</Link>
        )}
        {!stopped && (
          <button
            className="secondary operation-danger"
            disabled={disabled}
            onClick={() => control('cancel')}
          >
            Cancel {noun}
          </button>
        )}
      </div>
      {run.status === 'budget_exceeded' && (
        <form
          className="budget-extension"
          onSubmit={(event) => {
            event.preventDefault();
            setError('');
            const input = runControlSchema.safeParse({
              action: 'extend',
              version: run.version,
              addCostUsd: Number(cost),
              addSteps: Number(steps),
              addWallTimeSeconds: Number(wallTime),
            });
            if (
              !input.success ||
              input.data.addCostUsd + input.data.addSteps + input.data.addWallTimeSeconds <= 0
            ) {
              setError('Add a positive cost, step or time allowance.');
              return;
            }
            void onControl(input.data);
          }}
        >
          <h3>Continue with a larger allowance</h3>
          <p>
            Project, daily and monthly caps still apply.{' '}
            <Link href="/settings?section=budgets">Review workspace budgets</Link>.
          </p>
          <fieldset disabled={disabled || globallyPaused}>
            <legend>Additional allowance for this run</legend>
            <label className="setup-field">
              Additional budget (USD)
              <input
                type="number"
                min="0"
                max="10000"
                step="0.01"
                required
                value={cost}
                onChange={(event) => setCost(event.target.value)}
              />
            </label>
            <label className="setup-field">
              Additional steps
              <input
                type="number"
                min="0"
                max="1000"
                step="1"
                required
                value={steps}
                onChange={(event) => setSteps(event.target.value)}
              />
            </label>
            <label className="setup-field">
              Additional time (seconds)
              <input
                type="number"
                min="0"
                max="86400"
                step="1"
                required
                value={wallTime}
                onChange={(event) => setWallTime(event.target.value)}
              />
            </label>
            <button>
              {Number(cost) > 0
                ? `Continue with +${formatCost(Number(cost))}`
                : 'Extend allowance and continue'}
            </button>
          </fieldset>
          {error && (
            <p role="alert" className="setup-error">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

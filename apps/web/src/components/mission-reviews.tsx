'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import {
  projectReviewSchema,
  reviewModeSchema,
  reviewRecordSchema,
  type ReviewRecord,
} from '@sazuz/core/reviews';
import { api } from '../lib/api';
import { useWorkspaceResource, workspaceError } from '../lib/use-workspace';
import { LocalTime, RequestNotice } from './durable-shared';

export function ProjectReviewControl({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const path = `projects/${projectId}/review`;
  const current = useWorkspaceResource(path, projectReviewSchema, !!projectId);
  const [mode, setMode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function save() {
    if (!current.data) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const value = await api(
        path,
        projectReviewSchema,
        {
          mode: reviewModeSchema.parse(mode ?? current.data.mode),
          expectedVersion: current.data.version,
        },
        'PUT',
      );
      client.setQueryData(['workspace', path], value);
      setMode(null);
      setMessage('Project review updated. It applies to subsequent review and execution checks.');
    } catch (cause) {
      setError(workspaceError(cause));
      await current.refetch();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="project-review" aria-label="Project Auditor settings">
      <h3>Auditor for this project</h3>
      <p className="work-muted">
        Check results against their criteria and review external actions before approval. Reviews
        use your Planner and count toward the mission budget.
      </p>
      <RequestNotice error={error || current.error} message={message} />
      {current.data && (
        <div className="durable-actions">
          <label className="setup-field">
            Auditor review mode
            <select
              disabled={busy}
              value={mode ?? current.data.mode}
              onChange={(event) => {
                setMode(event.target.value);
                setMessage('');
              }}
            >
              <option value="off">Off</option>
              <option value="external_actions">External actions</option>
              <option value="all">All outputs and external actions</option>
            </select>
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy || mode === null || mode === current.data.mode}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save review mode'}
          </button>
        </div>
      )}
    </section>
  );
}
export function MissionReviews({ reviews }: { reviews: ReviewRecord[] }) {
  if (!reviews.length) return null;
  return (
    <section className="mission-reviews" aria-label="Auditor reviews">
      <h3>Auditor reviews</h3>
      {reviews.map((review) => (
        <details key={review.id} className="review-verdict">
          <summary>
            Auditor {review.status === 'pending' ? 'reviewing' : review.status} · {review.kind} ·{' '}
            <LocalTime value={review.createdAt} />
          </summary>
          {review.verdict && (
            <>
              <p>{review.verdict.feedback || 'Every criterion and verification check passed.'}</p>
              <ul>
                {review.verdict.criteria.map((criterion) => (
                  <li key={criterion.id}>
                    <strong>
                      {criterion.id}: {criterion.passed ? 'Pass' : 'Needs correction'}
                    </strong>{' '}
                    — {criterion.reason}
                  </li>
                ))}
              </ul>
              <dl>
                {(['grounding', 'policy', 'tone'] as const).map((check) => (
                  <div key={check}>
                    <dt>{check.charAt(0).toUpperCase() + check.slice(1)}</dt>
                    <dd>
                      {review.verdict![check].passed ? 'Pass' : 'Needs correction'}:{' '}
                      {review.verdict![check].reason}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          {review.evidence.length > 0 && (
            <details>
              <summary>Evidence checked ({review.evidence.length})</summary>
              <ul>
                {review.evidence.map((entry, index) => (
                  <li key={`${entry.reference}:${index}`}>
                    <span className="review-reference">{entry.reference}</span> —{' '}
                    {entry.resolved ? 'Available' : 'Unavailable or not permitted'}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="work-muted">
            {review.attempts} review {review.attempts === 1 ? 'attempt' : 'attempts'}. An accepted
            review does not grant permission to act.
          </p>
        </details>
      ))}
    </section>
  );
}
export function ApprovalReview({
  approvalId,
  missionId,
}: {
  approvalId: string;
  missionId: string;
}) {
  const review = useWorkspaceResource(
    `approvals/${approvalId}/review`,
    reviewRecordSchema.nullable(),
    true,
  );
  return (
    <div className="approval-review">
      {review.data && (
        <p>
          Last Auditor verdict for these arguments: <strong>{review.data.status}</strong>.{' '}
          {review.data.verdict?.feedback}
        </p>
      )}
      <Link href={`/missions/${missionId}`}>View criteria and Auditor verdicts</Link>
    </div>
  );
}

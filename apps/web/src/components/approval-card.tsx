import { useState } from 'react';
import Link from 'next/link';
import { approvalDecisionSchema, type Approval, type ApprovalDecision } from '@sazuz/core/missions';
import { ApprovalPreview, ActionFields } from './approval-preview';
import { agentLabels, LocalTime } from './durable-shared';
import { ScopedRuleSuggestion } from './scoped-rule-suggestion';
import { ApprovalReview } from './mission-reviews';

export function ApprovalCard({
  approval,
  now,
  onDecision,
  busy,
}: {
  approval: Approval;
  now: number;
  onDecision: (id: string, decision: ApprovalDecision) => Promise<boolean>;
  busy: boolean;
}) {
  const [review, setReview] = useState(approval);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(approval.args);
  const [note, setNote] = useState('');
  const stale = approval.version !== review.version || approval.status !== review.status;
  const expired = new Date(review.expiresAt).getTime() <= now || review.status === 'expired';
  const disabled = busy || stale || expired || review.status !== 'pending';
  async function decide(action: ApprovalDecision['action']) {
    const payload = approvalDecisionSchema.parse({
      action,
      version: review.version,
      note,
      ...(action === 'edit_approve' ? { args: draft } : {}),
    });
    await onDecision(review.id, payload);
  }
  return (
    <article
      className="durable-card approval-card"
      aria-label={`${review.toolName} approval`}
      data-risk={review.risk}
      data-kind={review.kind}
      data-status={review.status}
    >
      <header className="durable-heading">
        <div>
          <h2>{review.toolName}</h2>
          <p>
            {agentLabels[review.agentId]} ·{' '}
            <Link href={`/missions/${review.missionId}`}>View mission</Link>
          </p>
        </div>
        <span className={`risk-tag risk-${review.risk}`}>
          {review.risk.charAt(0).toUpperCase() + review.risk.slice(1)} risk
        </span>
      </header>
      <p className="approval-reason">{review.reason}</p>
      <ApprovalReview approvalId={review.id} missionId={review.missionId} />
      {review.status === 'reviewing' && (
        <p className="setup-notice" role="status">
          Your edited action is awaiting a fresh Auditor review before it can execute.
        </p>
      )}
      <p className="approval-rule">
        Rule: <strong>{review.ruleId}</strong> · Effect: <strong>{review.effect}</strong> · Expires{' '}
        <LocalTime value={review.expiresAt} />
      </p>
      {review.tainted && (
        <p className="setup-notice">
          Proposed after reading external content. Review the destination and content carefully.
        </p>
      )}
      {review.kind === 'uncertain' && (
        <p className="uncertain-notice">
          The previous attempt may already have happened. Check the destination, then confirm its
          outcome. It will not be retried automatically.
        </p>
      )}
      {stale && (
        <div className="setup-notice" role="status">
          <p>This request changed while you were reviewing it.</p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              setReview(approval);
              setDraft(approval.args);
              setEditing(false);
              setNote('');
            }}
          >
            Review latest version
          </button>
        </div>
      )}
      {expired && (
        <p className="setup-error" role="status">
          This approval has expired. Its action is unavailable.
        </p>
      )}
      {review.status !== 'pending' && (
        <p className="work-tag">{review.status.charAt(0).toUpperCase() + review.status.slice(1)}</p>
      )}
      <ApprovalPreview toolName={review.toolName} args={editing ? draft : review.args} />
      {editing && (
        <section className="approval-edit" aria-label="Edit action">
          <h3>Edit the proposed action</h3>
          <p>
            The preview above updates as you edit. The server checks the edited action against your
            policy and obtains a fresh Auditor review when enabled.
          </p>
          <ActionFields
            name="Action fields"
            value={draft}
            disabled={disabled}
            onChange={setDraft}
          />
        </section>
      )}
      {review.status === 'pending' && (
        <>
          <label className="setup-field">
            {review.kind === 'uncertain' ? 'Verification note' : 'Decision note'}
            <textarea
              rows={2}
              maxLength={2000}
              value={note}
              disabled={disabled}
              onChange={(event) => setNote(event.target.value)}
              placeholder={
                review.kind === 'uncertain'
                  ? 'Where did you check the outcome?'
                  : 'Optional feedback for the agent'
              }
            />
          </label>
          <div className="durable-actions">
            {review.kind === 'uncertain' ? (
              <>
                <button
                  disabled={disabled}
                  onClick={() => {
                    void decide('confirm_done');
                  }}
                >
                  Confirm action completed
                </button>
                <button
                  className="secondary"
                  disabled={disabled}
                  onClick={() => {
                    void decide('confirm_not_done');
                  }}
                >
                  Confirm not completed and retry
                </button>
              </>
            ) : (
              <>
                <button
                  disabled={disabled}
                  onClick={() => {
                    void decide(editing ? 'edit_approve' : 'approve');
                  }}
                >
                  {editing ? 'Approve edited action' : 'Approve'}
                </button>
                <button
                  className="secondary"
                  disabled={disabled}
                  onClick={() => {
                    setEditing(!editing);
                    setDraft(review.args);
                  }}
                >
                  {editing ? 'Cancel editing' : 'Edit & approve'}
                </button>
              </>
            )}
            <button
              className="secondary operation-danger"
              disabled={disabled}
              onClick={() => {
                void decide('deny');
              }}
            >
              Deny with note
            </button>
          </div>
          {review.kind === 'policy' && !editing && (
            <ScopedRuleSuggestion
              key={`${review.id}:${review.version}`}
              approval={review}
              disabled={disabled}
            />
          )}
        </>
      )}
      {review.note && <p className="decision-note">Decision note: {review.note}</p>}
    </article>
  );
}

'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  auditBundleSchema,
  auditExportSchema,
  auditPageSchema,
  type AuditExport,
} from '@sazuz/core/audit';
import type { z } from 'zod';
import { api } from '../lib/api';
import { WorkPageLayout } from './work-page';

export function AuditCenter() {
  const [page, setPage] = useState<z.infer<typeof auditPageSchema> | null>(null);
  const [action, setAction] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    async (before?: number) => {
      const query = new URLSearchParams({ limit: '50' });
      if (action) query.set('action', action);
      if (before) query.set('before', String(before));
      setPage(await api(`audit?${query}`, auditPageSchema));
    },
    [action],
  );
  useEffect(() => {
    void load().catch(() => setMessage('Sign in as the owner to view audit history.'));
  }, [load]);
  async function download() {
    setBusy(true);
    setMessage('');
    try {
      const pages: AuditExport[] = [];
      let after = 0;
      for (let index = 0; index < 40; index++) {
        const first = pages[0];
        const result = await api(
          `audit/export?after=${after}${first ? `&through=${first.head.sequence}` : ''}`,
          auditExportSchema,
        );
        pages.push(result);
        after = result.entries.at(-1)?.sequence ?? after;
        if (result.complete) break;
      }
      if (!pages.at(-1)?.complete)
        throw new Error('Use the paginated audit export API for histories above 40,000 entries.');
      const bundle = auditBundleSchema.parse({
        format: 'sazuz-audit-bundle-v1',
        head: pages[0]!.head,
        pages,
      });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `sazuz-audit-${bundle.head.sequence}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage(`Exported ${after} verified entries. Head: ${bundle.head.hash}`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <WorkPageLayout
      current="Audit"
      title="Audit history"
      description="Account changes, settings and policy decisions in an append-only chain."
      actions={
        <button
          disabled={busy}
          onClick={() => {
            void download();
          }}
        >
          {busy ? 'Verifying history…' : 'Verify and export'}
        </button>
      }
    >
      <section className="setup-card operation-section audit-records" aria-label="Audit entries">
        <p>
          Keep an export outside this instance. Its head hash lets you detect replacement or
          truncation when checking later history.
        </p>
        <label className="setup-field operation-filter">
          Filter by exact action
          <input
            placeholder="settings.changed"
            maxLength={256}
            value={action}
            onChange={(event) => setAction(event.target.value)}
          />
        </label>
        {page && <p>{page.head.sequence} entries recorded.</p>}
        {page?.entries.map((entry) => (
          <article className="history-entry" key={entry.sequence}>
            <strong>
              {entry.sequence}. {entry.payload[2]}
            </strong>
            <p>{entry.payload[3]}</p>
            <small>
              {entry.payload[1]} · {new Date(entry.payload[4]).toLocaleString()}
            </small>
          </article>
        ))}
        {page?.entries.length === 0 && <p>No matching audit entries.</p>}
        <button
          className="secondary"
          disabled={!page?.entries.length}
          onClick={() => {
            void load(page?.entries.at(-1)?.sequence).catch(() =>
              setMessage('History could not be loaded.'),
            );
          }}
        >
          Older entries
        </button>
        {message && (
          <p role="status" className="setup-notice">
            {message}
          </p>
        )}
      </section>
    </WorkPageLayout>
  );
}

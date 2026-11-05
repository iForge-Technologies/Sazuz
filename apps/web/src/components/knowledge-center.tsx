'use client';
import '../lib/validation';
import { useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { projectSchema } from '@sazuz/core/work';
import {
  sourceSchema,
  chunkSchema,
  generationSchema,
  knowledgeSearchResultSchema,
  type KnowledgeChunk,
} from '@sazuz/core/knowledge';
import { api } from '../lib/api';
import { useWorkspaceSession, useWorkspaceResource, workspaceError } from '../lib/use-workspace';
import { WorkPageLayout } from './work-page';
import { WorkspaceLoading, WorkspaceSectionNav } from './workspace-section-nav';

const sourcesSchema = z.array(sourceSchema),
  chunksSchema = z.array(chunkSchema),
  indexesSchema = z.array(generationSchema);
const projectsSchema = z.array(projectSchema);
function ChunkCard({ chunk }: { chunk: KnowledgeChunk }) {
  return (
    <article className="durable-card">
      <h3>{chunk.sourceName}</h3>
      <p>
        {chunk.locator} · <Link href={`/knowledge/chunks/${chunk.id}`}>{chunk.citation}</Link>
      </p>
      {chunk.sourceUrl && (
        <a href={chunk.sourceUrl} target="_blank" rel="noreferrer">
          Original source
        </a>
      )}
      <p className="message-content">{chunk.text}</p>
    </article>
  );
}
export function ChunkView({ id }: { id: string }) {
  const session = useWorkspaceSession();
  const chunk = useWorkspaceResource(`kb/chunks/${id}`, chunkSchema, session.ready, false);
  return (
    <WorkPageLayout
      current="Knowledge"
      title="Source citation"
      description="The original passage used to support an answer."
    >
      <p>
        <Link href="/knowledge">Back to Knowledge</Link>
      </p>
      {(session.error || chunk.error) && (
        <p role="alert">{workspaceError(session.error || chunk.error)}</p>
      )}
      {chunk.isPending && <p role="status">Loading source…</p>}
      {chunk.data && <ChunkCard chunk={chunk.data} />}
    </WorkPageLayout>
  );
}
export function KnowledgeCenter() {
  const session = useWorkspaceSession();
  const projects = useWorkspaceResource('projects', projectsSchema, session.ready, false);
  const [projectId, setProjectId] = useState('');
  const selectedProject = projectId || projects.data?.[0]?.id || '';
  const sources = useWorkspaceResource(
    `kb/sources?projectId=${selectedProject}`,
    sourcesSchema,
    session.ready && !!selectedProject,
  );
  const indexes = useWorkspaceResource(
    `kb/indexes?projectId=${selectedProject}`,
    indexesSchema,
    session.ready && !!selectedProject,
  );
  const [file, setFile] = useState<File | null>(null),
    [url, setUrl] = useState(''),
    [name, setName] = useState('');
  const [query, setQuery] = useState(''),
    [preview, setPreview] = useState<KnowledgeChunk[]>([]),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0),
    [sourceId, setSourceId] = useState('');
  async function act(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
      await sources.refetch();
      await indexes.refetch();
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function showSource(id: string, page = 0) {
    const chunks = await api(`kb/sources/${id}/chunks?offset=${page}`, chunksSchema);
    setSourceId(id);
    setOffset(page);
    setPreview(chunks);
    setNotice(
      chunks.length
        ? 'Source passages loaded.'
        : 'No passages yet. Ingestion runs in the background.',
    );
  }
  return (
    <WorkPageLayout
      current="Knowledge"
      title="Knowledge"
      description="Add documents to a project, then ask questions with traceable source citations."
    >
      <WorkspaceSectionNav
        label="Knowledge sections"
        sections={[
          { id: 'knowledge-add', label: 'Add sources' },
          { id: 'knowledge-search', label: 'Search & indexing' },
          { id: 'knowledge-sources', label: 'Sources' },
        ]}
      />
      {session.loading || (session.ready && projects.isPending) ? (
        <WorkspaceLoading>Loading project knowledge…</WorkspaceLoading>
      ) : null}
      {(error || session.error || sources.error || indexes.error || projects.error) && (
        <p role="alert" className="setup-error">
          {error ||
            workspaceError(session.error || sources.error || indexes.error || projects.error)}
        </p>
      )}
      {notice && (
        <p role="status" className="setup-notice">
          {notice}
        </p>
      )}
      <label className="setup-field operation-filter">
        Project
        <select
          value={selectedProject}
          onChange={(event) => {
            setProjectId(event.target.value);
            setPreview([]);
            setSourceId('');
          }}
        >
          <option value="" disabled>
            Choose a project
          </option>
          {projects.data?.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <div className="knowledge-grid knowledge-upload-grid operation-section" id="knowledge-add">
        <section className="durable-card operation-section">
          <h2>Upload a document</h2>
          <p>PDF, DOCX, Markdown or HTML · up to 8 MiB. Scanned PDFs need a text layer.</p>
          <form
            className="work-form"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                if (!file || file.size > 8 * 1024 * 1024) throw new Error('Invalid file.');
                const kind = z
                  .enum(['pdf', 'docx', 'md', 'html'])
                  .parse(file.name.split('.').at(-1)?.toLowerCase());
                const bytes = new Uint8Array(await file.arrayBuffer());
                let binary = '';
                for (let start = 0; start < bytes.length; start += 8192)
                  binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
                await api('kb/sources/upload', sourceSchema, {
                  projectId: selectedProject,
                  requestId: crypto.randomUUID(),
                  name: file.name,
                  kind,
                  base64: btoa(binary),
                });
                setNotice('Document queued. Its passages will appear after ingestion.');
              });
            }}
          >
            <label className="setup-field">
              Document
              <input
                type="file"
                required
                accept=".pdf,.docx,.md,.html"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            {file && file.size > 8 * 1024 * 1024 && (
              <p role="alert">Choose a file smaller than 8 MiB.</p>
            )}
            <button disabled={busy || !selectedProject || !file || file.size > 8 * 1024 * 1024}>
              Upload document
            </button>
          </form>
        </section>
        <section className="durable-card operation-section">
          <h2>Add a public URL</h2>
          <form
            className="work-form"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                await api('kb/sources/url', sourceSchema, {
                  projectId: selectedProject,
                  requestId: crypto.randomUUID(),
                  name,
                  url,
                });
                setUrl('');
                setName('');
                setNotice('URL queued for ingestion.');
              });
            }}
          >
            <label className="setup-field">
              Source name
              <input
                required
                maxLength={160}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="setup-field">
              Public URL
              <input
                type="url"
                required
                maxLength={2048}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <button disabled={busy || !selectedProject}>Add URL</button>
          </form>
        </section>
      </div>
      <section className="durable-card operation-section" id="knowledge-search">
        <h2>Search and indexing</h2>
        <p>
          Set the embedding model as provider-id/model-id in{' '}
          <Link href="/settings?section=memory">Memory settings</Link>. Cloud models also need an
          input-token price in <Link href="/settings?section=models">Models settings</Link>. Search
          uses full text until an index is ready. Private projects require local embeddings.
        </p>
        <form
          className="work-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const result = await api('kb/search', knowledgeSearchResultSchema, {
                projectId: selectedProject,
                query,
              });
              setPreview(result.matches);
              setSourceId('');
              setNotice(
                `${result.mode === 'hybrid' ? 'Hybrid' : 'Full-text'} search: ${result.matches.length} passages. ${result.notice ?? ''}`,
              );
            });
          }}
        >
          <label className="setup-field">
            Search documents
            <input
              required
              maxLength={2000}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button disabled={busy || !selectedProject}>Search knowledge</button>
        </form>
        <ul>
          {indexes.data?.map((index) => (
            <li key={index.id}>
              {index.providerId}/{index.modelId} · {index.status}
              {index.dimensions ? ` · ${index.dimensions} dimensions` : ''}
            </li>
          ))}
        </ul>
        <button
          className="secondary"
          disabled={busy || !selectedProject}
          onClick={() =>
            void act(async () => {
              await api('kb/reindex', generationSchema, { projectId: selectedProject });
              setNotice(
                'Reindex queued. The current index stays available while the new one builds.',
              );
            })
          }
        >
          Rebuild embeddings
        </button>
        <p>
          Failed or interrupted jobs can be reviewed and retried in{' '}
          <Link href="/memory">Memory → Background work</Link>.
        </p>
      </section>
      <section className="durable-card operation-section" id="knowledge-sources">
        <h2>Sources</h2>
        {!sources.data?.length && <p>No sources in this project yet.</p>}
        <ul className="operation-records">
          {sources.data?.map((source) => (
            <li key={source.id}>
              <strong>{source.name}</strong> · {source.status} · {source.chunkCount} passages{' '}
              {source.errorCode && `(${source.errorCode})`}
              <div className="knowledge-actions">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void act(() => showSource(source.id))}
                >
                  Preview passages
                </button>
                <button
                  className="secondary operation-danger"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api(
                        `kb/sources/${source.id}`,
                        z.strictObject({ deleted: z.number().int() }),
                        {},
                        'DELETE',
                      );
                      setPreview([]);
                      setSourceId('');
                      setNotice('Source and its passages removed from retrieval.');
                    })
                  }
                >
                  Delete source
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      {preview.length > 0 && (
        <section aria-label="Source passages">
          <h2>Passages</h2>
          {preview.map((chunk) => (
            <ChunkCard key={chunk.id} chunk={chunk} />
          ))}
          {sourceId && (
            <div className="knowledge-actions">
              <button
                className="secondary"
                disabled={busy || offset === 0}
                onClick={() => void act(() => showSource(sourceId, Math.max(0, offset - 20)))}
              >
                Previous passages
              </button>
              <button
                className="secondary"
                disabled={busy || preview.length < 20}
                onClick={() => void act(() => showSource(sourceId, offset + 20))}
              >
                Next passages
              </button>
            </div>
          )}
        </section>
      )}
    </WorkPageLayout>
  );
}

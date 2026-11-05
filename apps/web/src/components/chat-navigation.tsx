import { useState } from 'react';
import type { projectInput, projectSchema, threadSchema } from '@sazuz/core/work';
import type { z } from 'zod';
import { Icon } from './icons';

export type Project = z.infer<typeof projectSchema>;
export type Thread = z.infer<typeof threadSchema>;

export function ChatNavigation({
  projects,
  threads,
  projectId,
  threadId,
  disabled,
  loadingThreads,
  onSelectProject,
  onSelectThread,
  onCreateProject,
  onCreateThread,
}: {
  projects: Project[];
  threads: Thread[];
  projectId: string;
  threadId: string;
  disabled: boolean;
  loadingThreads: boolean;
  onSelectProject: (id: string) => void;
  onSelectThread: (id: string) => void;
  onCreateProject: (input: z.infer<typeof projectInput>) => Promise<boolean>;
  onCreateThread: (title: string) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [privacy, setPrivacy] = useState<'standard' | 'private'>('standard');
  const [budget, setBudget] = useState('5');
  const [title, setTitle] = useState('');
  const [showProject, setShowProject] = useState(false);
  const [showThread, setShowThread] = useState(false);
  return (
    <aside className="chat-navigation" aria-label="Projects and conversations">
      <h2>Projects</h2>
      {projects.length > 0 && (
        <label className="setup-field">
          Current project
          <select
            value={projectId}
            disabled={disabled}
            onChange={(event) => onSelectProject(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
                {project.privacy === 'private' ? ' · private' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        className="secondary"
        type="button"
        disabled={disabled}
        aria-expanded={showProject || projects.length === 0}
        onClick={() => setShowProject(!showProject)}
      >
        <Icon name="plus" />
        New project
      </button>
      {(showProject || projects.length === 0) && (
        <form
          className="work-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onCreateProject({ name, brief, privacy, budgetUsd: Number(budget) }).then(
              (created) => {
                if (created) {
                  setName('');
                  setBrief('');
                  setShowProject(false);
                }
              },
            );
          }}
        >
          <fieldset disabled={disabled}>
            <legend>Create a project</legend>
            <label className="setup-field">
              Project name
              <input
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="setup-field">
              Project brief
              <textarea
                maxLength={12000}
                rows={3}
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                placeholder="Context for conversations in this project"
              />
            </label>
            <label className="setup-field">
              Privacy
              <select
                value={privacy}
                onChange={(event) =>
                  setPrivacy(event.target.value === 'private' ? 'private' : 'standard')
                }
              >
                <option value="standard">Configured providers</option>
                <option value="private">Private · local models only</option>
              </select>
            </label>
            <label className="setup-field">
              Project budget (USD)
              <input
                required
                type="number"
                min="0"
                max="10000"
                step="0.01"
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
              />
            </label>
            <button>Create project</button>
          </fieldset>
        </form>
      )}
      <div className="thread-navigation">
        <h2>Conversations</h2>
        {loadingThreads && <p role="status">Loading conversations…</p>}
        {!loadingThreads && !threads.length && (
          <p>
            {projectId
              ? 'Start the first conversation in this project.'
              : 'Create a project to get started.'}
          </p>
        )}
        <nav aria-label="Conversations">
          {threads.map((thread) => (
            <button
              className="thread-link"
              key={thread.id}
              disabled={disabled}
              aria-current={thread.id === threadId ? 'page' : undefined}
              onClick={() => onSelectThread(thread.id)}
            >
              <Icon name="chat" />
              <span>{thread.title}</span>
            </button>
          ))}
        </nav>
        {projectId && (
          <button
            type="button"
            className="secondary"
            disabled={disabled || loadingThreads}
            aria-expanded={showThread || !threads.length}
            onClick={() => setShowThread(!showThread)}
          >
            <Icon name="plus" />
            New conversation
          </button>
        )}
        {projectId && (showThread || !threads.length) && !loadingThreads && (
          <form
            className="work-form"
            onSubmit={(event) => {
              event.preventDefault();
              void onCreateThread(title).then((created) => {
                if (created) {
                  setTitle('');
                  setShowThread(false);
                }
              });
            }}
          >
            <fieldset disabled={disabled}>
              <legend>Create a conversation</legend>
              <label className="setup-field">
                Conversation title
                <input
                  required
                  maxLength={160}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <button>Create conversation</button>
            </fieldset>
          </form>
        )}
      </div>
    </aside>
  );
}

'use client';
import '../lib/validation';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { settingsDocumentSchema, type SettingsDocument } from '@sazuz/config/settings';
import { modelCatalogSchema } from '@sazuz/llm/contracts';
import {
  messageSchema,
  projectInput,
  projectSchema,
  threadInput,
  threadSchema,
  type ChatEvent,
  type WorkMessage,
} from '@sazuz/core/work';
import { api } from '../lib/api';
import { ChatStreamError, sendChat } from '../lib/chat-stream';
import { presentChatStatus } from '../lib/chat-status';
import { ChatMessage, formatCost, ToolObservation, type LiveTool } from './chat-messages';
import { ChatNavigation, type Project, type Thread } from './chat-navigation';
import { WorkHeader } from './work-header';
import { VoiceInput } from './voice-controls';
import { Icon, SazuzMark } from './icons';

const sessionSchema = z.object({ user: z.object({ id: z.string() }) }).nullable();
const costsSchema = z.object({
  totalUsd: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export function ChatWorkspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [projectId, setProjectId] = useState('');
  const [threadId, setThreadId] = useState('');
  const [messages, setMessages] = useState<WorkMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [voiceSettings, setVoiceSettings] = useState<SettingsDocument | null>(null);
  const [voiceReceiptId, setVoiceReceiptId] = useState<string | null>(null);
  const [pendingUser, setPendingUser] = useState('');
  const [pendingMessageIndex, setPendingMessageIndex] = useState(0);
  const [liveText, setLiveText] = useState('');
  const [tools, setTools] = useState<LiveTool[]>([]);
  const [notice, setNotice] = useState('');
  const [status, setStatus] = useState('');
  const [missionPath, setMissionPath] = useState<string | null>(null);
  const [configurationHint, setConfigurationHint] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [totalCost, setTotalCost] = useState<number | null>(null);
  const streamController = useRef<AbortController | null>(null);
  const messageGeneration = useRef(0);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const messageList = useRef<HTMLDivElement | null>(null);
  const [followingLatest, setFollowingLatest] = useState(true);

  useEffect(() => {
    if (followingLatest && messageList.current) {
      messageList.current.scrollTop = messageList.current.scrollHeight;
    }
  }, [messages, liveText, tools, pendingUser, loadingMessages, followingLatest]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const session = await api('auth/get-session', sessionSchema);
      if (!session) {
        window.location.assign('/login');
        return;
      }
      const [items, models, settings, costs] = await Promise.all([
        api('projects', z.array(projectSchema)),
        api('models', modelCatalogSchema),
        api('settings', settingsDocumentSchema),
        api('costs', costsSchema),
      ]);
      if (cancelled) return;
      setProjects(items);
      setVoiceSettings(settings);
      setProjectId(items[0]?.id ?? '');
      setTotalCost(costs.totalUsd);
      if (!settings.models.value.roles.executor)
        setConfigurationHint(
          'Choose an executor model in Settings before starting a conversation.',
        );
      else if (!models.length)
        setConfigurationHint('Discover your provider’s models before starting a conversation.');
      setLoading(false);
    }
    void load().catch(() => {
      if (!cancelled) {
        setNotice('Could not load the workspace. Refresh the page to try again.');
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
      streamController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoadingThreads(true);
    setThreadId('');
    setThreads([]);
    setMessages([]);
    setPendingUser('');
    setLiveText('');
    setTools([]);
    setStatus('');
    setMissionPath(null);
    void api(`threads?projectId=${encodeURIComponent(projectId)}`, z.array(threadSchema))
      .then((items) => {
        if (!cancelled) {
          setThreads(items);
          setThreadId(items[0]?.id ?? '');
        }
      })
      .catch(() => {
        if (!cancelled)
          setNotice('Could not load conversations. Select the project again or refresh.');
      })
      .finally(() => {
        if (!cancelled) setLoadingThreads(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!threadId) return;
    setVoiceReceiptId(null);
    const generation = ++messageGeneration.current;
    let cancelled = false;
    setLoadingMessages(true);
    setMessages([]);
    setPendingUser('');
    setLiveText('');
    setTools([]);
    setStatus('');
    setMissionPath(null);
    void api(`threads/${threadId}/messages`, z.array(messageSchema))
      .then((items) => {
        if (!cancelled && generation === messageGeneration.current) setMessages(items);
      })
      .catch(() => {
        if (!cancelled)
          setNotice('Could not load messages. Use Refresh conversation to try again.');
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  async function createProject(input: z.infer<typeof projectInput>) {
    setBusy(true);
    setNotice('');
    try {
      const project = await api('projects', projectSchema, projectInput.parse(input));
      setProjects((items) => [...items, project]);
      setProjectId(project.id);
      return true;
    } catch {
      setNotice('Could not create the project. Check its name and budget, then try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createThread(title: string) {
    setBusy(true);
    setNotice('');
    try {
      const thread = await api('threads', threadSchema, threadInput.parse({ projectId, title }));
      setThreads((items) => [...items, thread]);
      setThreadId(thread.id);
      return true;
    } catch {
      setNotice('Could not create the conversation. Check its title and try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function refreshConversation() {
    if (!threadId || streaming) return;
    setBusy(true);
    setNotice('');
    const generation = ++messageGeneration.current;
    try {
      const [items, costs] = await Promise.all([
        api(`threads/${threadId}/messages`, z.array(messageSchema)),
        api('costs', costsSchema),
      ]);
      if (generation !== messageGeneration.current) return;
      setMessages(items);
      setTotalCost(costs.totalUsd);
      setPendingUser('');
      setLiveText('');
      setTools([]);
    } catch {
      setNotice('Could not refresh the conversation. Your saved messages are still on the server.');
    } finally {
      setBusy(false);
    }
  }

  async function submitMessage() {
    const content = draft.trim();
    const submittedVoice = voiceReceiptId;
    if (!content || !threadId || streaming) return;
    setFollowingLatest(true);
    const controller = new AbortController();
    streamController.current = controller;
    setStreaming(true);
    setNotice('');
    setStatus(presentChatStatus({ status: 'running' }).text);
    setMissionPath(null);
    setPendingUser(content);
    setLiveText('');
    setTools([]);
    setDraft('');
    setVoiceReceiptId(null);
    setPendingMessageIndex(messages.length);
    let terminal = false;
    function handleEvent(event: ChatEvent) {
      if (controller.signal.aborted) return;
      switch (event.type) {
        case 'text.delta':
          setLiveText((text) => text + event.text);
          break;
        case 'tool.call':
          setTools((items) => [
            ...items.filter((tool) => tool.id !== event.id),
            { ...event, status: 'running' },
          ]);
          break;
        case 'tool.result':
          setTools((items) => {
            const existing = items.find((tool) => tool.id === event.id);
            return [...items.filter((tool) => tool.id !== event.id), { ...existing, ...event }];
          });
          break;
        case 'message.completed':
          setMessages((items) => [
            ...items.filter((item) => item.id !== event.message.id),
            event.message,
          ]);
          if (event.message.role === 'assistant') setLiveText('');
          break;
        case 'run.status': {
          const view = presentChatStatus(event);
          terminal = view.observationEnded;
          setStatus(view.text);
          if (view.missionPath) setMissionPath(view.missionPath);
          break;
        }
      }
    }
    try {
      await sendChat(
        threadId,
        {
          content,
          requestId: crypto.randomUUID(),
          ...(submittedVoice ? { voiceReceiptId: submittedVoice } : {}),
        },
        handleEvent,
        controller.signal,
      );
      if (!terminal) throw new ChatStreamError();
      const [items, costs] = await Promise.all([
        api(`threads/${threadId}/messages`, z.array(messageSchema)),
        api('costs', costsSchema),
      ]);
      if (controller.signal.aborted) return;
      setMessages(items);
      setPendingUser('');
      setTotalCost(costs.totalUsd);
      if (!terminal) setStatus('Response complete.');
    } catch (cause) {
      if (!controller.signal.aborted)
        setNotice(cause instanceof ChatStreamError ? cause.message : new ChatStreamError().message);
    } finally {
      if (!controller.signal.aborted) {
        setStreaming(false);
        streamController.current = null;
        composer.current?.focus();
      }
    }
  }

  const project = projects.find((item) => item.id === projectId);
  const thread = threads.find((item) => item.id === threadId);
  return (
    <div className="setup-shell work-shell chat-shell" data-work-page="chat">
      <WorkHeader current="Chat" />
      <main id="work-content" tabIndex={-1}>
        <div className="work-heading">
          <div>
            <p className="eyebrow">YOUR WORKSPACE</p>
            <h1>Chat</h1>
            <p>A conversation for every piece of work.</p>
          </div>
          {totalCost !== null && (
            <p className="cost-summary">
              Workspace usage <strong>{formatCost(totalCost)}</strong>
            </p>
          )}
        </div>
        {notice && (
          <p className="setup-error" role="alert">
            {notice}{' '}
            <Link href={missionPath ?? '/missions'}>
              {missionPath ? 'View saved mission' : 'Open Missions'}
            </Link>
          </p>
        )}
        {configurationHint && (
          <p className="setup-notice">
            {configurationHint} <Link href="/models">Open models</Link> ·{' '}
            <Link href="/settings">Open Settings</Link>
          </p>
        )}
        {loading ? (
          <p role="status">Loading your workspace…</p>
        ) : (
          <div className="chat-layout">
            <ChatNavigation
              projects={projects}
              threads={threads}
              projectId={projectId}
              threadId={threadId}
              disabled={busy || streaming}
              loadingThreads={loadingThreads}
              onSelectProject={(id) => {
                setFollowingLatest(true);
                setProjectId(id);
                setNotice('');
                setDraft('');
              }}
              onSelectThread={(id) => {
                setFollowingLatest(true);
                setThreadId(id);
                setNotice('');
                setDraft('');
              }}
              onCreateProject={createProject}
              onCreateThread={createThread}
            />
            <section className="conversation-panel" aria-label="Conversation">
              <header className="conversation-heading">
                <div>
                  <h2>{thread?.title ?? 'Start a conversation'}</h2>
                  {project && (
                    <p>
                      {project.name}{' '}
                      {project.privacy === 'private' && (
                        <span className="work-tag">Private · local models only</span>
                      )}
                    </p>
                  )}
                </div>
                {threadId && (
                  <button
                    className="secondary"
                    disabled={busy || streaming || loadingMessages}
                    onClick={() => {
                      void refreshConversation();
                    }}
                  >
                    Refresh conversation
                  </button>
                )}
              </header>
              <div
                className="chat-messages"
                ref={messageList}
                aria-busy={streaming || loadingMessages}
                onScroll={(event) => {
                  const list = event.currentTarget;
                  setFollowingLatest(list.scrollHeight - list.scrollTop - list.clientHeight < 60);
                }}
              >
                {loadingMessages && <p role="status">Loading messages…</p>}
                {!loadingMessages && !messages.length && !pendingUser && (
                  <div className="chat-empty">
                    <span className="chat-empty-mark">
                      <SazuzMark />
                    </span>
                    <h3>{threadId ? 'What would you like to work on?' : 'Start with a project'}</h3>
                    <p>
                      {threadId
                        ? 'Ask a question or describe a task. Follow its progress here and review actions when Sazuz needs your approval.'
                        : 'Choose a project and create a conversation. Its brief, budget and privacy settings stay with your work.'}
                    </p>
                  </div>
                )}
                {messages
                  .slice(0, pendingUser ? pendingMessageIndex : messages.length)
                  .map((message) => (
                    <ChatMessage key={message.id} message={message} speech={voiceSettings} />
                  ))}
                {pendingUser && (
                  <article className="chat-message chat-message-user" aria-label="Your new message">
                    <header>
                      <strong>You</strong>
                    </header>
                    <p className="message-content">{pendingUser}</p>
                  </article>
                )}
                {pendingUser &&
                  messages
                    .slice(pendingMessageIndex)
                    .map((message) => (
                      <ChatMessage key={message.id} message={message} speech={voiceSettings} />
                    ))}
                {liveText && (
                  <article
                    className="chat-message chat-message-assistant"
                    aria-label="Streaming response"
                  >
                    <header>
                      <strong>Sazuz</strong>
                      <span className="work-tag">{streaming ? 'Writing' : 'Partial response'}</span>
                    </header>
                    <p className="message-content">{liveText}</p>
                    <footer className="message-usage">
                      Usage appears when the model finishes this message.
                    </footer>
                  </article>
                )}
                {tools.length > 0 && (
                  <section className="live-tools" aria-label="Tool activity">
                    <h3>Tool activity</h3>
                    {tools.map((tool) => (
                      <ToolObservation key={tool.id} tool={tool} />
                    ))}
                  </section>
                )}
              </div>
              {!followingLatest && (
                <div className="chat-jump">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setFollowingLatest(true)}
                  >
                    Jump to latest <Icon name="arrow" />
                  </button>
                </div>
              )}
              <form
                className="chat-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitMessage();
                }}
              >
                <label className="setup-field" htmlFor="chat-prompt">
                  Message
                  <textarea
                    id="chat-prompt"
                    ref={composer}
                    required
                    maxLength={24000}
                    rows={3}
                    value={draft}
                    disabled={!threadId || streaming || loadingMessages || busy}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      if (!event.target.value) setVoiceReceiptId(null);
                    }}
                    onKeyDown={(event) => {
                      if (
                        (event.metaKey || event.ctrlKey) &&
                        event.key === 'Enter' &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder={
                      threadId ? 'Tell Sazuz what you need…' : 'Create a conversation first'
                    }
                  />
                </label>
                {voiceSettings && (
                  <VoiceInput
                    key={threadId}
                    settings={voiceSettings}
                    projectId={projectId}
                    privateOnly={
                      project?.privacy === 'private' ||
                      voiceSettings.models.value.preset === 'private'
                    }
                    disabled={!threadId || streaming || loadingMessages || busy}
                    onTranscript={(text, id) => {
                      setDraft((prior) => (prior ? `${prior}\n${text}` : text));
                      setVoiceReceiptId(id);
                      composer.current?.focus();
                    }}
                  />
                )}
                {voiceReceiptId && (
                  <p>
                    Voice transcript: review before sending. Actions still require the usual
                    approvals.
                  </p>
                )}
                <div className="composer-actions">
                  <p role="status" aria-live="polite">
                    {status ||
                      (project?.privacy === 'private'
                        ? 'Only local models can receive this project’s messages.'
                        : 'Your configured models and budgets apply.')}
                    {missionPath && (
                      <>
                        {' '}
                        <Link href={missionPath}>View mission</Link>
                      </>
                    )}
                  </p>
                  <button
                    disabled={!threadId || !draft.trim() || streaming || loadingMessages || busy}
                  >
                    {streaming ? 'Working…' : 'Send message'}
                    <Icon name="arrow" />
                  </button>
                </div>
                <p className="composer-shortcut">Ctrl / ⌘ + Enter to send</p>
              </form>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

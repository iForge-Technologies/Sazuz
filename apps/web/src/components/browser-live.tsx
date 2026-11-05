'use client';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { z } from 'zod';
import {
  browserHumanInputSchema,
  browserLiveMessageSchema,
  browserSessionSchema,
  type BrowserHumanInput,
} from '@sazuz/core/browser';
import { api } from '../lib/api';
import { workspaceError } from '../lib/use-workspace';
import { RecordingControl } from './recording-control';

export function BrowserLive({ initial }: { initial: z.infer<typeof browserSessionSchema> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLInputElement>(null);
  const connection = useRef<WebSocket | null>(null);
  const moved = useRef(0);
  const [session, setSession] = useState(initial);
  const [canInput, setCanInput] = useState(false);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Connecting to the live browser…');
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false,
      drawing = false;
    const url = new URL(`/live/browser/${initial.id}`, window.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    connection.current = socket;
    const clear = () => {
      canvas.current?.getContext('2d')?.clearRect(0, 0, 1280, 800);
    };
    socket.onopen = () => {
      if (!disposed) {
        setConnected(true);
        setMessage('Live view connected.');
      }
    };
    socket.onmessage = (event) => {
      if (disposed) return;
      try {
        const value: unknown = JSON.parse(String(event.data));
        const packet = browserLiveMessageSchema.parse(value);
        if (packet.type === 'state') {
          setSession(packet.session);
          setCanInput(packet.inputAllowed);
        } else if (packet.type === 'error') {
          setError('The live browser is unavailable. Reconnect after checking the session.');
        } else if (!drawing) {
          drawing = true;
          const picture = new Image();
          picture.onload = () => {
            if (!disposed) canvas.current?.getContext('2d')?.drawImage(picture, 0, 0, 1280, 800);
            picture.onload = null;
            picture.onerror = null;
            picture.src = '';
            drawing = false;
          };
          picture.onerror = () => {
            drawing = false;
            socket.close();
          };
          picture.src = `data:image/jpeg;base64,${packet.data}`;
        }
      } catch {
        socket.close();
      }
    };
    socket.onclose = () => {
      if (disposed) return;
      clear();
      setConnected(false);
      setCanInput(false);
      setMessage('Live view disconnected. Human control stays active until you hand back.');
    };
    socket.onerror = () => {
      if (!disposed)
        setError('Could not connect to the live browser. Check the session and reconnect.');
    };
    return () => {
      disposed = true;
      connection.current = null;
      socket.close();
      clear();
    };
  }, [initial.id, attempt]);
  const send = (value: BrowserHumanInput) => {
    if (!canInput || connection.current?.readyState !== WebSocket.OPEN) return;
    connection.current.send(JSON.stringify(browserHumanInputSchema.parse(value)));
  };
  useEffect(() => {
    const view = canvas.current;
    if (!view) return;
    const wheel = (event: WheelEvent) => {
      const socket = connection.current;
      if (!canInput || socket?.readyState !== WebSocket.OPEN) return;
      event.preventDefault();
      if (Date.now() - moved.current < 80) return;
      moved.current = Date.now();
      const bounds = view.getBoundingClientRect();
      socket.send(
        JSON.stringify(
          browserHumanInputSchema.parse({
            type: 'pointer',
            event: 'mouseWheel',
            x: Math.max(0, Math.min(1280, ((event.clientX - bounds.left) * 1280) / bounds.width)),
            y: Math.max(0, Math.min(800, ((event.clientY - bounds.top) * 800) / bounds.height)),
            button: 'none',
            deltaY: Math.max(
              -2000,
              Math.min(
                2000,
                event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1),
              ),
            ),
          }),
        ),
      );
    };
    view.addEventListener('wheel', wheel, { passive: false });
    return () => view.removeEventListener('wheel', wheel);
  }, [canInput]);
  const pointer = (
    event: PointerEvent<HTMLCanvasElement>,
    kind: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
  ) => {
    if (!canInput) return;
    event.preventDefault();
    if (kind === 'mouseMoved' && Date.now() - moved.current < 80) return;
    moved.current = Date.now();
    if (kind === 'mousePressed') {
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    send({
      type: 'pointer',
      event: kind,
      x: Math.max(0, Math.min(1280, ((event.clientX - bounds.left) * 1280) / bounds.width)),
      y: Math.max(0, Math.min(800, ((event.clientY - bounds.top) * 800) / bounds.height)),
      button: kind === 'mouseMoved' ? 'none' : event.button === 2 ? 'right' : 'left',
      deltaY: 0,
    });
  };
  const keyboard = (event: KeyboardEvent<HTMLCanvasElement>, kind: 'keyDown' | 'keyUp') => {
    if (event.key === 'Escape') {
      event.currentTarget.blur();
      return;
    }
    if (!canInput) return;
    if (!((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v'))
      event.preventDefault();
    send({
      type: 'key',
      event: kind,
      key: event.key,
      code: event.code,
      modifiers:
        (event.altKey ? 1 : 0) |
        (event.ctrlKey ? 2 : 0) |
        (event.metaKey ? 4 : 0) |
        (event.shiftKey ? 8 : 0),
    });
  };
  const press = (key: string) => {
    send({ type: 'key', event: 'keyDown', key, code: key, modifiers: 0 });
    send({ type: 'key', event: 'keyUp', key, code: key, modifiers: 0 });
  };
  async function control(action: 'take' | 'handback') {
    setBusy(true);
    setError('');
    setCanInput(false);
    try {
      const result = await api(
        `browser/sessions/${session.id}/control`,
        z.strictObject({ session: browserSessionSchema, resumed: z.boolean() }),
        { action, version: session.version },
      );
      setSession(result.session);
      setCanInput(false);
      setMessage(
        action === 'take'
          ? 'Pausing the agent for your control.'
          : result.resumed
            ? 'Control returned. The agent is resuming.'
            : 'Control returned. Review any pending approval or pause in Missions.',
      );
    } catch (cause) {
      setError(workspaceError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="durable-card browser-live operation-section" aria-label="Live browser">
      <h2>Live browser</h2>
      <p>
        {session.origin || 'New tab'} ·{' '}
        {session.control === 'human' ? 'Human control' : 'Agent control'}
      </p>
      <p role="status">{message}</p>
      {error && (
        <p role="alert" className="setup-error">
          {error}
        </p>
      )}
      <div
        className="knowledge-actions browser-session-toolbar"
        role="group"
        aria-label="Browser control"
      >
        {session.control === 'agent' ? (
          <button disabled={busy || !connected} onClick={() => void control('take')}>
            Take control
          </button>
        ) : (
          <button disabled={busy || !connected} onClick={() => void control('handback')}>
            Hand back and resume
          </button>
        )}
        <button
          className="secondary"
          disabled={connected}
          onClick={() => {
            setError('');
            setAttempt((value) => value + 1);
          }}
        >
          Reconnect
        </button>
      </div>
      <p id="browser-input-help">
        Complete login, 2FA or CAPTCHA yourself. Focus the view to use your keyboard; Escape leaves
        the view. Input is enabled after the agent has paused.
      </p>
      <canvas
        ref={canvas}
        width={1280}
        height={800}
        tabIndex={0}
        role="application"
        aria-label="Remote browser view"
        aria-describedby="browser-input-help"
        style={{
          width: '100%',
          height: 'auto',
          background: 'var(--browser-canvas, #1c2420)',
          touchAction: canInput ? 'none' : 'auto',
        }}
        onPointerDown={(event) => pointer(event, 'mousePressed')}
        onPointerUp={(event) => pointer(event, 'mouseReleased')}
        onPointerMove={(event) => pointer(event, 'mouseMoved')}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => keyboard(event, 'keyDown')}
        onKeyUp={(event) => keyboard(event, 'keyUp')}
        onPaste={(event) => {
          event.preventDefault();
          const value = event.clipboardData.getData('text/plain').slice(0, 8000);
          if (value) send({ type: 'text', text: value });
        }}
      />
      {session.control === 'human' && (
        <>
          {!canInput && (
            <p>
              Input is paused. Wait for the current action to finish, or check the global pause and
              mission status.
            </p>
          )}
          <form
            className="setup-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (text.current?.value && canInput) {
                send({ type: 'text', text: text.current.value });
                text.current.value = '';
              }
            }}
          >
            <label className="setup-field">
              Text for the focused site field
              <input
                ref={text}
                type="password"
                autoComplete="off"
                maxLength={8000}
                disabled={!canInput}
              />
            </label>
            <button disabled={!canInput}>Send text</button>
          </form>
          <div className="knowledge-actions" role="group" aria-label="Remote keyboard">
            {['Tab', 'Enter', 'Backspace', 'Escape'].map((key) => (
              <button
                key={key}
                className="secondary"
                disabled={!canInput}
                onClick={() => press(key)}
              >
                {key}
              </button>
            ))}
          </div>
          <div className="knowledge-actions" role="group" aria-label="Remote scrolling">
            {['up', 'down'].map((direction) => (
              <button
                key={direction}
                className="secondary"
                disabled={!canInput}
                onClick={() =>
                  send({
                    type: 'pointer',
                    event: 'mouseWheel',
                    x: 640,
                    y: 400,
                    button: 'none',
                    deltaY: direction === 'up' ? -500 : 500,
                  })
                }
              >
                Scroll {direction}
              </button>
            ))}
          </div>
        </>
      )}
      <RecordingControl sessionId={session.id} version={session.version} canInput={canInput} />
      {session.sensitive && (
        <p>
          Sensitive session. Images are visible only in your live view and are withheld from models.
        </p>
      )}
    </section>
  );
}

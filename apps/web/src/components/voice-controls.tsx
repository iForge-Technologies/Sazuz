'use client';
import { useEffect, useRef, useState } from 'react';
import type { SettingsDocument } from '@sazuz/config/settings';
import { speechResultSchema } from '@sazuz/core/voice';
import { api } from '../lib/api';
import { normalizeVoice, toBase64 } from '../lib/voice-audio';

export function VoiceInput({
  settings,
  projectId,
  privateOnly,
  disabled,
  onTranscript,
}: {
  settings: SettingsDocument;
  projectId: string;
  privateOnly: boolean;
  disabled: boolean;
  onTranscript: (text: string, receiptId: string) => void;
}) {
  const [recording, setRecording] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const selected = settings.speech.value.transcription;
  const provider = settings.providers.value.items.find((item) => item.id === selected?.providerId);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      controller.current?.abort();
      if (recorder.current?.state === 'recording') recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);
  if (!settings.speech.value.enabled || !selected || !provider) return null;
  const unavailable = privateOnly && provider.locality !== 'local';
  async function start() {
    if (busy || recording) return;
    setNotice('');
    setBusy(true);
    let context: AudioContext | undefined;
    try {
      if (
        !window.isSecureContext ||
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === 'undefined'
      )
        throw new Error('Microphone recording needs a supported browser on HTTPS or localhost.');
      context = new AudioContext();
      const capture = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true },
        video: false,
      });
      stream.current = capture;
      if (!mounted.current) {
        capture.getTracks().forEach((track) => track.stop());
        await context.close();
        return;
      }
      const active = new MediaRecorder(capture),
        chunks: Blob[] = [];
      recorder.current = active;
      active.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      const audioContext = context;
      active.onstop = () => {
        clearTimeout(timer.current);
        capture.getTracks().forEach((track) => track.stop());
        if (!mounted.current) {
          void audioContext.close();
          return;
        }
        setRecording(false);
        setBusy(true);
        const abort = new AbortController();
        controller.current = abort;
        void (async () => {
          const bytes = await normalizeVoice(
            new Blob(chunks, { type: active.mimeType }),
            audioContext,
          );
          const result = await api(
            'voice/transcribe',
            speechResultSchema,
            {
              requestId: crypto.randomUUID(),
              projectId,
              speechVersion: settings.speech.version,
              providersVersion: settings.providers.version,
              audio: toBase64(bytes),
              consent: true,
            },
            'POST',
            { signal: abort.signal },
          ).finally(() => bytes.fill(0));
          if (!mounted.current) return;
          if (result.receipt.status !== 'done' || !result.receipt.transcript) {
            setNotice(
              'Transcription is uncertain. It will not be retried. Check Speech history before recording again.',
            );
            return;
          }
          onTranscript(result.receipt.transcript, result.receipt.id);
          setNotice(
            `Review and edit the transcript before sending. Estimated speech cost $${result.receipt.costUsd.toFixed(5)}.`,
          );
        })()
          .catch((error: unknown) => {
            if (mounted.current)
              setNotice(
                `${error instanceof Error ? error.message : 'Transcription could not finish.'} Check Speech history before recording again.`,
              );
          })
          .finally(() => {
            void audioContext.close();
            if (mounted.current) setBusy(false);
          });
      };
      active.start(250);
      setRecording(true);
      setBusy(false);
      timer.current = setTimeout(() => {
        if (active.state === 'recording') active.stop();
      }, 30000);
    } catch (error) {
      stream.current?.getTracks().forEach((track) => track.stop());
      await context?.close();
      if (mounted.current) {
        setBusy(false);
        setNotice(
          error instanceof Error ? error.message : 'Microphone permission was unavailable.',
        );
      }
    }
  }
  return (
    <div
      className="voice-controls voice-input"
      data-recording={recording || undefined}
      aria-busy={busy}
    >
      <p>
        {provider.name} ·{' '}
        {provider.locality === 'local'
          ? 'Local transcription'
          : `Cloud transcription, estimated $${selected.pricePerMinuteUsd}/minute`}{' '}
        · 30 seconds maximum.
      </p>
      {unavailable && <p>Select a local speech provider for this private project.</p>}
      <button
        type="button"
        className="secondary"
        disabled={busy || unavailable || (disabled && !recording)}
        aria-pressed={recording}
        onClick={() => {
          if (recording) recorder.current?.stop();
          else void start();
        }}
      >
        {recording ? 'Stop recording' : busy ? 'Transcribing…' : 'Record voice'}
      </button>
      {recording && <span role="status"> Microphone on. Press Stop to transcribe.</span>}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

export function VoicePlayback({
  settings,
  messageId,
}: {
  settings: SettingsDocument;
  messageId: string;
}) {
  const [url, setUrl] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const mounted = useRef(true),
    controller = useRef<AbortController | null>(null);
  const selected = settings.speech.value.synthesis;
  const provider = settings.providers.value.items.find((item) => item.id === selected?.providerId);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  if (!settings.speech.value.enabled || !selected || !provider) return null;
  async function speak() {
    setBusy(true);
    setNotice('');
    const abort = new AbortController();
    controller.current = abort;
    try {
      const result = await api(
        'voice/speak',
        speechResultSchema,
        {
          requestId: crypto.randomUUID(),
          messageId,
          speechVersion: settings.speech.version,
          providersVersion: settings.providers.version,
          consent: true,
        },
        'POST',
        { signal: abort.signal },
      );
      if (!mounted.current) return;
      if (!result.audio || result.receipt.status !== 'done') {
        setNotice('Speech is uncertain and will not be retried. Check Speech history.');
        return;
      }
      setUrl(
        URL.createObjectURL(
          new Blob([Uint8Array.from(atob(result.audio), (letter) => letter.charCodeAt(0))], {
            type: 'audio/wav',
          }),
        ),
      );
      setNotice(`Estimated speech cost $${result.receipt.costUsd.toFixed(5)}.`);
    } catch (error) {
      if (mounted.current)
        setNotice(
          `${error instanceof Error ? error.message : 'Speech could not finish.'} Check Speech history before trying again.`,
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="voice-controls voice-playback" aria-busy={busy}>
      {url ? (
        <audio controls src={url} aria-label="Spoken answer" />
      ) : (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            void speak();
          }}
        >
          {busy ? 'Preparing audio…' : 'Read aloud'}
        </button>
      )}
      <small>
        {provider.name} ·{' '}
        {provider.locality === 'local'
          ? 'Local speech'
          : `Cloud speech, estimated $${selected.pricePerMillionCharactersUsd}/million characters`}
      </small>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

'use client';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { speechReceiptSchema } from '@sazuz/core/voice';
import { api } from '../lib/api';
export function SpeechHistory() {
  const [rows, setRows] = useState<z.infer<typeof speechReceiptSchema>[]>([]),
    [notice, setNotice] = useState('');
  const load = () =>
    api('voice', z.array(speechReceiptSchema))
      .then(setRows)
      .catch(() => setNotice('Speech history could not load.'));
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="settings-panel configuration-section" aria-label="Speech requests">
      <h2>Speech requests</h2>
      <p>
        Speech is optional. Select provider IDs already configured in Providers. Local voice uses
        the optional Whisper and Piper profile. Recordings stop at 30 seconds; read-aloud accepts up
        to 4,000 characters. Prices are estimates using your configured rates.
      </p>
      <p>
        Uncertain calls keep their cost estimate and are never automatically repeated. Audio is not
        saved. Private answers require local speech.
      </p>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          void load();
        }}
      >
        Refresh speech history
      </button>
      {rows.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Request</th>
                <th scope="col">Status</th>
                <th scope="col">Estimated cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.kind} · {new Date(row.createdAt).toLocaleString()}
                  </td>
                  <td>{row.status}</td>
                  <td>${row.costUsd.toFixed(5)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

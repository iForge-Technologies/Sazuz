import { useId } from 'react';
import type { Approval } from '@sazuz/core/missions';

type JsonValue = Approval['args'];
const fieldLabel = (name: string) =>
  name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase());
const display = (value: JsonValue | undefined): string =>
  value === undefined || value === null
    ? ''
    : typeof value === 'string'
      ? value
      : Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? value.join(', ')
        : JSON.stringify(value, null, 2);

export function ApprovalPreview({ toolName, args }: { toolName: string; args: JsonValue }) {
  const fields = typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {};
  const email = /^(?:gmail|email)\.(?:send|draft)$/.test(toolName);
  const calendar = toolName.startsWith('calendar.');
  const pullRequest = toolName === 'github.create_pull_request';
  const file = toolName === 'files.write';
  return (
    <section className="approval-preview" aria-label="Action preview">
      {email ? (
        <>
          <dl className="approval-fields">
            <dt>From account</dt>
            <dd>{display(fields['accountId'])}</dd>
            <dt>To</dt>
            <dd>{display(fields['to'])}</dd>
            {display(fields['cc']) && (
              <>
                <dt>Cc</dt>
                <dd>{display(fields['cc'])}</dd>
              </>
            )}
            <dt>Subject</dt>
            <dd>{display(fields['subject'])}</dd>
          </dl>
          <div className="email-preview-body">{display(fields['text'])}</div>
        </>
      ) : calendar ? (
        <>
          <dl className="approval-fields">
            {['accountId', 'eventId', 'summary', 'start', 'end', 'timeZone', 'location']
              .filter((key) => fields[key] !== undefined)
              .map((key) => (
                <div className="approval-field-row" key={key}>
                  <dt>{fieldLabel(key)}</dt>
                  <dd>{display(fields[key])}</dd>
                </div>
              ))}
          </dl>
          {fields['description'] !== undefined && (
            <p className="message-content">{display(fields['description'])}</p>
          )}
        </>
      ) : pullRequest ? (
        <>
          <dl className="approval-fields">
            {['accountId', 'title', 'head', 'base', 'draft'].map((key) => (
              <div className="approval-field-row" key={key}>
                <dt>{fieldLabel(key)}</dt>
                <dd>{display(fields[key])}</dd>
              </div>
            ))}
          </dl>
          <p className="message-content">{display(fields['body'])}</p>
        </>
      ) : file ? (
        <>
          <strong>{display(fields['path'])}</strong>
          <pre>{display(fields['content'])}</pre>
        </>
      ) : (
        <pre>{JSON.stringify(args, null, 2)}</pre>
      )}
      {(email || calendar || pullRequest || file) && (
        <details>
          <summary>All action fields</summary>
          <pre>{JSON.stringify(args, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}

export function ActionFields({
  name,
  value,
  onChange,
  disabled,
}: {
  name: string;
  value: JsonValue;
  onChange: (value: JsonValue) => void;
  disabled: boolean;
}) {
  const id = useId();
  if (Array.isArray(value))
    return (
      <fieldset className="action-array" disabled={disabled}>
        <legend>{fieldLabel(name)}</legend>
        {value.map((entry, index) => (
          <div key={index}>
            <ActionFields
              name={`${name} ${index + 1}`}
              value={entry}
              onChange={(next) =>
                onChange(value.map((item, position) => (position === index ? next : item)))
              }
              disabled={disabled}
            />
            <button
              type="button"
              className="secondary"
              aria-label={`Remove ${name} ${index + 1}`}
              onClick={() => onChange(value.filter((_, position) => position !== index))}
            >
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="secondary" onClick={() => onChange([...value, ''])}>
          Add {name}
        </button>
      </fieldset>
    );
  if (value !== null && typeof value === 'object')
    return (
      <fieldset className="action-fields" disabled={disabled}>
        <legend>{fieldLabel(name)}</legend>
        {Object.entries(value).map(([key, entry]) => (
          <ActionFields
            key={key}
            name={key}
            value={entry}
            disabled={disabled}
            onChange={(next) => onChange({ ...value, [key]: next })}
          />
        ))}
      </fieldset>
    );
  if (typeof value === 'boolean')
    return (
      <label className="setup-check">
        <input
          type="checkbox"
          checked={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        {fieldLabel(name)}
      </label>
    );
  if (value === null)
    return (
      <div className="setup-field">
        <span>{fieldLabel(name)}: Not set</span>
        <button
          type="button"
          className="secondary"
          disabled={disabled}
          onClick={() => onChange('')}
        >
          Set {name}
        </button>
      </div>
    );
  return (
    <label className="setup-field" htmlFor={id}>
      {fieldLabel(name)}
      {typeof value === 'string' &&
      (value.includes('\n') ||
        value.length > 100 ||
        /text|body|content|description/i.test(name)) ? (
        <textarea
          id={id}
          rows={5}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          type={typeof value === 'number' ? 'number' : 'text'}
          step="any"
          value={value}
          disabled={disabled}
          onChange={(event) =>
            onChange(typeof value === 'number' ? Number(event.target.value) : event.target.value)
          }
        />
      )}
    </label>
  );
}

'use client';
import { useId } from 'react';
import { z } from 'zod';
import { settingsSchemas, type SettingsNamespace } from '@sazuz/config/settings';
import type { SecretItem } from '../lib/api';

type Shape = {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, Shape>;
  required?: string[];
  default?: unknown;
  items?: Shape;
  anyOf?: Shape[];
  oneOf?: Shape[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  pattern?: string;
};
const label = (name: string) =>
  (
    ({
      priorityModel: 'Fast-model priority classification',
      vipSenders: 'VIP senders',
      priorityRules: 'Learned priority preferences',
      telemetry: 'Enable OpenTelemetry export',
      telemetryEndpoint: 'OTLP/HTTP traces endpoint',
      telemetrySecretRef: 'Collector bearer credential',
      prune: 'Allow scheduled deletion of backups older than retention days',
    }) as Record<string, string>
  )[name] ??
  name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase())
    .replace(/Usd/g, '(USD)')
    .replace(/Mb/g, '(MB)');
function initial(schema: Shape): unknown {
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return initial(schema.anyOf.find((entry) => entry.type !== 'null') ?? {});
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([key, child]) => schema.required?.includes(key) || child.default !== undefined)
        .map(([key, value]) => [
          key,
          value.anyOf?.some((entry) => entry.type === 'null') ? null : initial(value),
        ]),
    );
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return schema.minimum ?? 0;
  return '';
}
function Field({
  name,
  schema,
  value,
  change,
  secrets,
  optional = false,
}: {
  name: string;
  schema: Shape;
  value: unknown;
  change: (value: unknown) => void;
  secrets: SecretItem[];
  optional?: boolean;
}) {
  const id = useId();
  const title = label(name);
  if (optional && value === undefined)
    return (
      <div className="setup-field setting-unconfigured">
        <span>{title} (optional)</span>
        <button type="button" className="secondary" onClick={() => change(initial(schema))}>
          Configure {title.toLowerCase()}
        </button>
      </div>
    );
  if (optional)
    return (
      <div className="optional-setting">
        <Field name={name} schema={schema} value={value} change={change} secrets={secrets} />
        <button type="button" className="secondary" onClick={() => change(undefined)}>
          Clear {title.toLowerCase()}
        </button>
      </div>
    );
  const variants = (schema.anyOf ?? schema.oneOf)?.filter((entry) => entry.type !== 'null');
  if (variants && variants.length > 1) {
    const typedVariants = variants.filter(
      (variant) => variant.properties?.['type']?.const !== undefined,
    );
    if (typedVariants.length === variants.length) {
      const discriminator =
        value && typeof value === 'object' && 'type' in value ? value.type : undefined;
      const selected =
        typedVariants.find((variant) => variant.properties?.['type']?.const === discriminator) ??
        typedVariants[0]!;
      return (
        <div className="setting-variant">
          <label className="setup-field">
            {title} type
            <select
              value={String(selected.properties?.['type']?.const)}
              onChange={(event) => {
                const next = typedVariants.find(
                  (variant) => variant.properties?.['type']?.const === event.target.value,
                );
                if (next) change(initial(next));
              }}
            >
              {typedVariants.map((variant) => (
                <option
                  key={String(variant.properties?.['type']?.const)}
                  value={String(variant.properties?.['type']?.const)}
                >
                  {String(variant.properties?.['type']?.const)}
                </option>
              ))}
            </select>
          </label>
          <Field name={name} schema={selected} value={value} change={change} secrets={secrets} />
        </div>
      );
    }
    const kind = Array.isArray(value)
      ? 'array'
      : typeof value === 'number'
        ? 'number'
        : typeof value;
    const selectedIndex = Math.max(
      0,
      variants.findIndex(
        (variant) => variant.type === kind || (kind === 'number' && variant.type === 'integer'),
      ),
    );
    return (
      <div className="setting-variant">
        <label className="setup-field">
          {title} value type
          <select
            value={selectedIndex}
            onChange={(event) =>
              change(initial(variants[Number(event.target.value)] ?? variants[0]!))
            }
          >
            {variants.map((variant, index) => (
              <option key={index} value={index}>
                {variant.type ?? 'Value'}
              </option>
            ))}
          </select>
        </label>
        <Field
          name={name}
          schema={variants[selectedIndex]!}
          value={value}
          change={change}
          secrets={secrets}
        />
      </div>
    );
  }
  const nullable = schema.anyOf?.some((entry) => entry.type === 'null');
  const shape = schema.anyOf?.find((entry) => entry.type !== 'null') ?? schema;
  if (/secretRef$/i.test(name))
    return (
      <label className="setup-field" htmlFor={id}>
        {title}
        <select
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => change(event.target.value || (nullable ? null : undefined))}
        >
          <option value="">No credential</option>
          {secrets.map((secret) => (
            <option key={secret.id} value={secret.reference}>
              {secret.name} {secret.maskedValue}
            </option>
          ))}
        </select>
        <small>Credentials are encrypted in your vault.</small>
      </label>
    );
  if (nullable && value === null)
    return (
      <div className="setup-field setting-unconfigured">
        <span>{title}</span>
        <button type="button" className="secondary" onClick={() => change(initial(shape))}>
          Configure {title.toLowerCase()}
        </button>
      </div>
    );
  if (shape.type === 'object') {
    const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return (
      <fieldset className="setup-group setting-object">
        <legend>{title}</legend>
        {Object.entries(shape.properties ?? {}).map(([key, child]) => (
          <Field
            key={key}
            name={key}
            schema={child}
            value={record[key]}
            change={(next) => change({ ...record, [key]: next })}
            secrets={secrets}
            optional={!shape.required?.includes(key)}
          />
        ))}
        {nullable && (
          <button className="secondary" type="button" onClick={() => change(null)}>
            Clear {title.toLowerCase()}
          </button>
        )}
      </fieldset>
    );
  }
  if (shape.type === 'array') {
    const items: unknown[] = Array.isArray(value) ? value : [];
    return (
      <fieldset className="setup-group setting-collection">
        <legend>{title}</legend>
        {items.map((entry, index) => (
          <div className="setup-array" key={index}>
            <Field
              name={`${name} ${index + 1}`}
              schema={shape.items ?? {}}
              value={entry}
              change={(next) => change(items.map((item, i) => (i === index ? next : item)))}
              secrets={secrets}
            />
            <button
              type="button"
              className="secondary array-remove"
              onClick={() => change(items.filter((_, i) => i !== index))}
              aria-label={`Remove ${name} ${index + 1}`}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary"
          onClick={() => change([...items, initial(shape.items ?? {})])}
        >
          Add {title.toLowerCase()}
        </button>
      </fieldset>
    );
  }
  if (shape.type === 'boolean')
    return (
      <label className="setup-check">
        <input
          type="checkbox"
          checked={value === true}
          disabled={shape.const !== undefined}
          onChange={(event) => change(event.target.checked)}
        />
        {title}
      </label>
    );
  if (shape.enum || shape.const !== undefined)
    return (
      <label className="setup-field" htmlFor={id}>
        {title}
        <select
          id={id}
          value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
          disabled={shape.const !== undefined}
          onChange={(event) => change(event.target.value)}
        >
          {(shape.enum ?? [shape.const]).map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </label>
    );
  const numeric = shape.type === 'number' || shape.type === 'integer';
  return (
    <label className="setup-field" htmlFor={id}>
      {title}
      <input
        id={id}
        value={typeof value === 'string' || typeof value === 'number' ? value : ''}
        type={
          numeric
            ? 'number'
            : shape.format === 'email'
              ? 'email'
              : /(?:Start|End)$/.test(name)
                ? 'time'
                : 'text'
        }
        step={shape.type === 'integer' ? 1 : 'any'}
        min={shape.minimum}
        max={shape.maximum}
        minLength={shape.minLength}
        maxLength={shape.maxLength}
        required={!!shape.minLength}
        autoComplete="off"
        onChange={(event) => change(numeric ? Number(event.target.value) : event.target.value)}
      />
      {nullable && (
        <button type="button" className="secondary" onClick={() => change(null)}>
          Clear
        </button>
      )}
    </label>
  );
}
export function SettingsForm({
  namespace,
  value,
  onChange,
  secrets,
}: {
  namespace: SettingsNamespace;
  value: unknown;
  onChange: (value: unknown) => void;
  secrets: SecretItem[];
}) {
  const shape = z.toJSONSchema(settingsSchemas[namespace], { unrepresentable: 'any' }) as Shape;
  const record = value as Record<string, unknown>;
  return (
    <div className="settings-fields">
      {namespace === 'advanced' && (
        <div>
          <p>
            <a href="/agents">Edit agent instructions, permissions and versions</a>
          </p>
          <p>
            Telemetry is off by default. Enabling it authorizes metadata exports to the exact traces
            endpoint you enter, such as your collector's /v1/traces URL. Only new model calls are
            exported. Prompts, tool content and credential values are excluded. Store optional
            bearer credentials in the vault.
          </p>
          <p>
            <a href="/costs">View costs and export status</a>
          </p>
        </div>
      )}
      {Object.entries(shape.properties ?? {}).map(([key, child]) => (
        <Field
          key={key}
          name={key}
          schema={child}
          value={record[key]}
          change={(next) => onChange({ ...record, [key]: next })}
          secrets={secrets}
          optional={!shape.required?.includes(key)}
        />
      ))}
    </div>
  );
}

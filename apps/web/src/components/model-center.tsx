'use client';
import '../lib/validation';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import {
  providerSchema,
  settingsDocumentSchema,
  type SettingsDocument,
} from '@sazuz/config/settings';
import {
  modelCatalogSchema,
  modelPriceSchema,
  providerHealthSchema,
  type ModelInfo,
  type ModelPrice,
  type ProviderHealth,
} from '@sazuz/llm/contracts';
import { api, okSchema } from '../lib/api';
import { WorkPageLayout } from './work-page';

function PriceEditor({
  model,
  disabled,
  onSave,
}: {
  model: ModelInfo;
  disabled: boolean;
  onSave: (price: ModelPrice) => Promise<boolean>;
}) {
  const [input, setInput] = useState(model.price?.inputPerMTok.toString() ?? '');
  const [output, setOutput] = useState(model.price?.outputPerMTok.toString() ?? '');
  const [cached, setCached] = useState(model.price?.cachedInputPerMTok?.toString() ?? '');
  const [notice, setNotice] = useState('');
  return (
    <details className="model-price-editor">
      <summary>{model.price ? 'Edit prices' : 'Set prices'}</summary>
      <form
        aria-label={`Prices for ${model.name}`}
        onSubmit={(event) => {
          event.preventDefault();
          const value = modelPriceSchema.safeParse({
            inputPerMTok: Number(input),
            outputPerMTok: Number(output),
            ...(cached === '' ? {} : { cachedInputPerMTok: Number(cached) }),
          });
          if (!value.success) {
            setNotice('Enter nonnegative USD prices for input and output.');
            return;
          }
          setNotice('');
          void onSave(value.data).then((saved) => {
            if (saved) setNotice('Prices saved. New requests use these prices.');
          });
        }}
      >
        <fieldset disabled={disabled}>
          <legend>USD per million tokens</legend>
          <label className="setup-field">
            Input price
            <input
              type="number"
              min="0"
              max="1000000"
              step="any"
              required
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
          </label>
          <label className="setup-field">
            Output price
            <input
              type="number"
              min="0"
              max="1000000"
              step="any"
              required
              value={output}
              onChange={(event) => setOutput(event.target.value)}
            />
          </label>
          <label className="setup-field">
            Cached input price (optional)
            <input
              type="number"
              min="0"
              max="1000000"
              step="any"
              value={cached}
              onChange={(event) => setCached(event.target.value)}
            />
          </label>
          <button>Save prices</button>
        </fieldset>
      </form>
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}

function ConnectionResult({ result }: { result: ProviderHealth }) {
  const failures: Record<string, string> = {
    PROVIDER_DISABLED: 'Enable this provider in Settings to connect.',
    PROVIDER_AUTH: 'The provider rejected its credential. Check its vault credential in Settings.',
    PROVIDER_RATE_LIMIT: 'The provider is rate limited. Try again later.',
    VAULT_UNAVAILABLE: 'Unlock the vault in Settings to connect.',
    PROVIDER_INVALID_RESPONSE: 'The endpoint returned an unsupported response.',
    PROVIDER_NOT_FOUND: 'The provider configuration could not be found.',
    ABORTED: 'The connection test was interrupted. Try again.',
  };
  return (
    <p role="status" className={result.ok ? 'connection-success' : 'setup-error'}>
      {result.ok
        ? `Connected · ${Math.round(result.latencyMs)} ms · ${result.modelCount} models available`
        : (failures[result.code ?? ''] ?? 'Could not connect. Check the endpoint and try again.')}
    </p>
  );
}

export function ModelCenter() {
  const [providers, setProviders] = useState<z.infer<typeof providerSchema>[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<SettingsDocument | null>(null);
  const [results, setResults] = useState<Record<string, ProviderHealth>>({});
  const [testModels, setTestModels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const session = await api(
        'auth/get-session',
        z.object({ user: z.object({ id: z.string() }) }).nullable(),
      );
      if (!session) {
        window.location.assign('/login');
        return;
      }
      const [providerItems, catalog, document] = await Promise.all([
        api('providers', z.array(providerSchema)),
        api('models', modelCatalogSchema),
        api('settings', settingsDocumentSchema),
      ]);
      if (cancelled) return;
      setProviders(providerItems);
      setModels(catalog);
      setSettings(document);
      setLoading(false);
    }
    void load().catch(() => {
      if (!cancelled) {
        setNotice('Could not load models. Refresh the page to try again.');
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function discover(providerId: string) {
    setBusy(`${providerId}:discover`);
    setNotice('');
    try {
      const discovered = await api(
        `providers/${providerId}/discover`,
        z.object({ models: modelCatalogSchema }),
        {},
      );
      setModels((items) => [
        ...items.filter((model) => model.providerId !== providerId),
        ...discovered.models,
      ]);
      setNotice(`Discovered ${discovered.models.length} models. Select their roles in Settings.`);
    } catch {
      setNotice(
        'Model discovery failed. Check the provider connection and unlock the vault if required.',
      );
    } finally {
      setBusy('');
    }
  }

  async function testConnection(providerId: string) {
    setBusy(`${providerId}:test`);
    setNotice('');
    try {
      const modelId = testModels[providerId];
      const result = await api(
        `providers/${providerId}/test`,
        providerHealthSchema,
        modelId ? { modelId } : {},
      );
      setResults((items) => ({ ...items, [providerId]: result }));
    } catch {
      setNotice(
        'The connection test could not finish. Check the provider configuration and try again.',
      );
    } finally {
      setBusy('');
    }
  }

  async function savePrice(model: ModelInfo, price: ModelPrice) {
    setBusy(`${model.providerId}:${model.id}`);
    setNotice('');
    try {
      await api(
        'models/prices',
        okSchema,
        { providerId: model.providerId, modelId: model.id, price },
        'PUT',
      );
      setModels((items) =>
        items.map((item) =>
          item.providerId === model.providerId && item.id === model.id ? { ...item, price } : item,
        ),
      );
      return true;
    } catch {
      setNotice('Could not save prices. Check the values and try again.');
      return false;
    } finally {
      setBusy('');
    }
  }

  return (
    <WorkPageLayout
      current="Models"
      title="Models"
      description="Connect providers, discover available models, and keep usage prices accurate."
      actions={
        <Link className="work-action-link" href="/settings">
          Configure providers and roles
        </Link>
      }
    >
      {notice && (
        <p role="status" className="setup-notice">
          {notice}
        </p>
      )}
      {loading && <p role="status">Loading your models…</p>}
      {settings && (
        <section className="model-routing" aria-label="Model roles">
          <h2>Model roles</h2>
          <dl>
            {(['planner', 'executor', 'fast', 'vision'] as const).map((role) => {
              const selected = settings.models.value.roles[role];
              return (
                <div key={role}>
                  <dt>{role.charAt(0).toUpperCase() + role.slice(1)}</dt>
                  <dd>
                    {selected ? `${selected.providerId} / ${selected.modelId}` : 'Not assigned'}
                  </dd>
                </div>
              );
            })}
          </dl>
          {!settings.models.value.roles.executor && (
            <p className="setup-notice">
              Assign an executor model in <Link href="/settings">Settings</Link> to start chatting.
            </p>
          )}
          <p>
            Routing preset: <strong>{settings.models.value.preset}</strong>. Private projects use
            local models only.
          </p>
        </section>
      )}
      {!loading && !providers.length && (
        <section className="work-empty">
          <h2>Add your first provider</h2>
          <p>
            Save a provider endpoint and its vault credential in Settings, then discover its models
            here.
          </p>
          <Link href="/settings">Open Settings Center</Link>
        </section>
      )}
      <div className="provider-list">
        {providers.map((provider) => {
          const catalog = models.filter((model) => model.providerId === provider.id);
          const result = results[provider.id];
          return (
            <section
              className="provider-card"
              key={provider.id}
              aria-labelledby={`provider-${provider.id}`}
            >
              <header className="provider-heading">
                <div>
                  <h2 id={`provider-${provider.id}`}>{provider.name}</h2>
                  <p>{provider.baseUrl}</p>
                </div>
                <span className="work-tag">
                  {provider.locality === 'local' ? 'Local' : 'Cloud'} ·{' '}
                  {provider.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </header>
              <div className="provider-controls">
                <button
                  disabled={!!busy || !provider.enabled}
                  onClick={() => {
                    void discover(provider.id);
                  }}
                >
                  {busy === `${provider.id}:discover` ? 'Discovering…' : 'Discover models'}
                </button>
                <button
                  className="secondary"
                  disabled={!!busy || !provider.enabled}
                  onClick={() => {
                    void testConnection(provider.id);
                  }}
                >
                  {busy === `${provider.id}:test` ? 'Testing…' : 'Test connection'}
                </button>
                {catalog.length > 0 && (
                  <label className="setup-field">
                    Model to test
                    <select
                      disabled={!!busy}
                      value={testModels[provider.id] ?? ''}
                      onChange={(event) =>
                        setTestModels((items) => ({
                          ...items,
                          [provider.id]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Model discovery only</option>
                      {catalog.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                    <small>
                      Choosing a model generates a short response using its normal token prices.
                    </small>
                  </label>
                )}
              </div>
              {result && <ConnectionResult result={result} />}
              {!provider.enabled && (
                <p>
                  Enable this provider in <Link href="/settings">Settings</Link> before testing or
                  discovering models.
                </p>
              )}
              {!catalog.length && <p className="work-muted">No models discovered yet.</p>}
              {catalog.map((model) => (
                <article className="model-row" key={model.id} aria-label={model.name}>
                  <div className="model-identity">
                    <h3>{model.name}</h3>
                    <code>{model.id}</code>
                    <p>
                      {model.contextWindow.toLocaleString()} context tokens ·{' '}
                      {model.maxOutput.toLocaleString()} max output
                    </p>
                    <p className="work-muted">
                      If discovery omitted these limits, enter the model's documented context and
                      output limits in{' '}
                      <Link href="/settings?section=models">Settings → Models</Link>.
                    </p>
                    <div className="model-capabilities">
                      {Object.entries(model.supports)
                        .filter(([, supported]) => supported)
                        .map(([capability]) => (
                          <span className="work-tag" key={capability}>
                            {capability}
                          </span>
                        ))}
                    </div>
                  </div>
                  <div className="model-prices">
                    <p>
                      {model.price
                        ? `$${model.price.inputPerMTok} input / $${model.price.outputPerMTok} output per million tokens`
                        : 'Price unknown · set prices before using this model'}
                    </p>
                    <PriceEditor
                      model={model}
                      disabled={!!busy}
                      onSave={(price) => savePrice(model, price)}
                    />
                  </div>
                </article>
              ))}
            </section>
          );
        })}
      </div>
    </WorkPageLayout>
  );
}

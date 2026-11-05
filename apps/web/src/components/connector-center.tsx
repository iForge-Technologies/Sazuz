'use client';
import '../lib/validation';
import Link from 'next/link';
import { connectorCatalogueSchema } from '@sazuz/core/connectors';
import { settingsDocumentSchema } from '@sazuz/config/settings';
import { useWorkspaceResource, useWorkspaceSession, workspaceError } from '../lib/use-workspace';
import { WorkPageLayout } from './work-page';
import { GoogleConnections } from './google-connections';
import { McpCenter } from './mcp-center';
import { BridgeCenter } from './bridge-center';
import { WorkspaceLoading, WorkspaceSectionNav } from './workspace-section-nav';

export function ConnectorCenter() {
  const session = useWorkspaceSession();
  const catalogue = useWorkspaceResource(
    'connectors/catalogue',
    connectorCatalogueSchema,
    session.ready,
  );
  const settings = useWorkspaceResource('settings', settingsDocumentSchema, session.ready);
  const error = session.error || catalogue.error || settings.error;
  return (
    <WorkPageLayout
      current="Connectors"
      title="Connectors"
      description="Connect accounts, review their scope, and choose which agents may use them."
      actions={
        <Link className="primary" href="/settings?section=connectors">
          Configure accounts
        </Link>
      }
    >
      <WorkspaceSectionNav
        label="Connector sections"
        sections={[
          { id: 'accounts', label: 'Your accounts' },
          { id: 'catalogue', label: 'Available connectors' },
          { id: 'mcp', label: 'MCP servers' },
          { id: 'bridge', label: 'Local Bridge' },
        ]}
      />
      {session.loading || catalogue.isPending ? (
        <WorkspaceLoading>Loading connections…</WorkspaceLoading>
      ) : null}
      {error && (
        <p className="setup-error" role="alert">
          {workspaceError(error)}
        </p>
      )}
      <section
        className="setup-card operation-section connector-records"
        aria-label="Connected accounts"
        id="accounts"
      >
        <h2>Your accounts</h2>
        <p>
          Credentials stay in the vault.{' '}
          <Link href="/agents">Grant exact account permissions in Agents</Link> after connecting;
          each external change follows your approval policy.
        </p>
        {!settings.data?.connectors.value.accounts.length && (
          <p>No accounts configured yet. Add one in Settings to get started.</p>
        )}
        {settings.data?.connectors.value.accounts.map((account) => (
          <details key={account.id}>
            <summary>
              {account.name} · {account.provider ?? 'Choose provider'} · {account.mode}
            </summary>
            <p>{account.secretRef ? 'Credential stored in vault' : 'Credential needed'}</p>
            <p>Scopes: {account.scopes.join(', ') || 'No scopes granted'}</p>
            <dl>
              {Object.entries(account.options)
                .filter(([key]) => !/secret|oauth/i.test(key))
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
            </dl>
          </details>
        ))}
        {settings.data && <GoogleConnections settings={settings.data} />}
      </section>
      <section
        className="setup-card operation-section connector-catalogue"
        aria-label="Available connectors"
        id="catalogue"
      >
        <h2>Available connectors</h2>
        <p>
          Start with read access and one resource. Stripe exposes reads only. Microsoft uses
          delegated Graph permissions; Slack and Discord use official bot APIs.
        </p>
        {catalogue.data?.map((connector) => (
          <details key={connector.id}>
            <summary>
              {connector.name} · {connector.tools.length} operations
            </summary>
            <p>
              Authentication: {connector.auth}. Choose this provider in Settings and select a vault
              credential.
            </p>
            <ul>
              {connector.tools.map((tool) => (
                <li key={tool.name}>
                  <strong>{tool.name}</strong> · {tool.effect} · {tool.permission}
                  <p>{tool.description}</p>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </section>
      <McpCenter ready={session.ready} />
      <BridgeCenter ready={session.ready} />
    </WorkPageLayout>
  );
}

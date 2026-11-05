import type { RegisteredTool } from '@sazuz/tools';
import type { ConnectorDependencies } from './contracts.js';
import { createCalendarTools } from './calendar.js';
import { createEmailTools } from './mail.js';
import { createGitHubTools } from './github.js';
import { createGmailTools } from './gmail.js';
import { defineConnector, type ConnectorDefinition } from './sdk.js';
import { createGoogleWorkspaceTools } from './google-workspace.js';
import { createGraphTools } from './graph.js';
import { createProductivityTools } from './productivity.js';
import { createDavTools } from './dav.js';
import { connectorActions } from './actions.js';
import { connectorCatalogueSchema } from '@sazuz/core/connectors';

export * from './contracts.js';
export * from './actions.js';
export * from './errors.js';
export * from './sdk.js';
export * from './oauth.js';
export * from './mail.js';
export { createCalendarTools, createEmailTools, createGitHubTools, createGmailTools };

export function createConnectorTools(dependencies: ConnectorDependencies): RegisteredTool[] {
  return createConnectors(dependencies).flatMap((connector) => [...connector.tools]);
}

export function createConnectors(
  dependencies: ConnectorDependencies,
): readonly Readonly<ConnectorDefinition>[] {
  return [
    defineConnector({
      id: 'gmail',
      name: 'Gmail',
      auth: {
        type: 'oauth2',
        scopes: { read: ['email:read'], write: ['email:draft', 'email:send'] },
      },
      tools: createGmailTools(dependencies),
    }),
    defineConnector({
      id: 'email',
      name: 'IMAP and SMTP',
      auth: {
        type: 'basic',
        scopes: { read: ['email:read'], write: ['email:draft', 'email:send'] },
      },
      tools: createEmailTools(dependencies),
    }),
    defineConnector({
      id: 'calendar',
      name: 'Google Calendar',
      auth: {
        type: 'oauth2',
        scopes: { read: ['calendar:read'], write: ['calendar:write', 'calendar:delete'] },
      },
      tools: createCalendarTools(dependencies),
    }),
    defineConnector({
      id: 'github',
      name: 'GitHub',
      auth: { type: 'apiKey', scopes: { read: ['github:read'], write: ['github:write'] } },
      tools: createGitHubTools(dependencies),
    }),
    ...nativeConnectors(dependencies),
  ];
}

function nativeConnectors(dependencies: ConnectorDependencies) {
  const tools = [
    ...createGoogleWorkspaceTools(dependencies),
    ...createGraphTools(dependencies),
    ...createProductivityTools(dependencies),
    ...createDavTools(dependencies),
  ];
  const names: Record<string, string> = {
    'google-drive': 'Google Drive',
    'google-sheets': 'Google Sheets',
    'google-docs': 'Google Docs',
    'microsoft-graph': 'Microsoft 365',
    slack: 'Slack',
    discord: 'Discord',
    notion: 'Notion',
    todoist: 'Todoist',
    caldav: 'CalDAV',
    carddav: 'CardDAV',
    linear: 'Linear',
    jira: 'Jira',
    stripe: 'Stripe (read-only)',
    webhook: 'Outgoing webhook',
  };
  return Object.entries(names).map(([id, name]) => {
    const members = tools.filter((tool) => tool.connector === id);
    return defineConnector({
      id,
      name,
      auth: {
        type:
          id.startsWith('google-') || id === 'microsoft-graph'
            ? 'oauth2'
            : ['caldav', 'carddav', 'jira'].includes(id)
              ? 'basic'
              : 'apiKey',
        scopes: {
          read: [
            ...new Set(
              members
                .filter((tool) => tool.effect === 'read')
                .map((tool) => connectorActions[tool.name]!.permission),
            ),
          ],
          write: [
            ...new Set(
              members
                .filter((tool) => tool.effect !== 'read')
                .map((tool) => connectorActions[tool.name]!.permission),
            ),
          ],
        },
      },
      tools: members,
    });
  });
}

export function connectorCatalogue() {
  return connectorCatalogueSchema.parse(
    createConnectors({ getAccounts: () => [] }).map((connector) => ({
      id: connector.id,
      name: connector.name,
      auth: connector.auth.type,
      tools: connector.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        effect: tool.effect,
        permission: connectorActions[tool.name]!.permission,
      })),
    })),
  );
}

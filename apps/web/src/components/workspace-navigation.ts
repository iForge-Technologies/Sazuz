import type { IconName } from './icons';

export const navigationGroups = [
  {
    label: 'Workspace',
    pages: [
      { name: 'Chat', href: '/chat', icon: 'chat', description: 'Projects and conversations' },
      {
        name: 'Missions',
        href: '/missions',
        icon: 'missions',
        description: 'Active work, runs and deliverables',
      },
      {
        name: 'Approvals',
        href: '/approvals',
        icon: 'approvals',
        description: 'Review proposed actions',
      },
      {
        name: 'Browser',
        href: '/browser',
        icon: 'browser',
        description: 'Live sessions and human takeover',
      },
    ],
  },
  {
    label: 'Build',
    pages: [
      {
        name: 'S2A',
        href: '/s2a',
        icon: 'workflows',
        description: 'Visual workflows and schedules',
      },
      { name: 'Agents', href: '/agents', icon: 'agents', description: 'Your team and permissions' },
      {
        name: 'Workflows',
        href: '/workflows',
        icon: 'workflows',
        description: 'Build and run repeatable work',
      },
      {
        name: 'Automations',
        href: '/automations',
        icon: 'automations',
        description: 'Triggers, schedules and notifications',
      },
      {
        name: 'Recipes',
        href: '/recipes',
        icon: 'recipes',
        description: 'Ready-to-configure workflows',
      },
    ],
  },
  {
    label: 'Library',
    pages: [
      {
        name: 'Knowledge',
        href: '/knowledge',
        icon: 'knowledge',
        description: 'Sources and cited documents',
      },
      { name: 'Memory', href: '/memory', icon: 'memory', description: 'Review remembered context' },
      {
        name: 'Skills',
        href: '/skills',
        icon: 'skills',
        description: 'Built-in and learned skills',
      },
    ],
  },
  {
    label: 'Manage',
    pages: [
      {
        name: 'Models',
        href: '/models',
        icon: 'models',
        description: 'Providers, routing and pricing',
      },
      {
        name: 'Connectors',
        href: '/connectors',
        icon: 'connectors',
        description: 'Accounts, MCP and devices',
      },
      {
        name: 'Channels',
        href: '/channels',
        icon: 'chat',
        description: 'Messaging connections and WhatsApp pairing',
      },
      {
        name: 'MCP',
        href: '/mcp-connections',
        icon: 'connectors',
        description: 'Remote MCP connections and tool grants',
      },
      { name: 'Costs', href: '/costs', icon: 'costs', description: 'Usage, budgets and forecasts' },
      { name: 'Evals', href: '/evals', icon: 'evals', description: 'Evaluate and compare runs' },
      { name: 'Audit', href: '/audit', icon: 'audit', description: 'Inspect and export activity' },
    ],
  },
  {
    label: 'Instance',
    pages: [
      {
        name: 'Settings',
        href: '/settings',
        icon: 'settings',
        description: 'Workspace configuration and account',
      },
      {
        name: 'System health',
        href: '/health',
        icon: 'activity',
        description: 'Database and worker status',
      },
    ],
  },
] as const satisfies ReadonlyArray<{
  label: string;
  pages: ReadonlyArray<{ name: string; href: string; icon: IconName; description: string }>;
}>;

export const workspacePages = navigationGroups.flatMap((group) =>
  group.pages.map((page) => ({ ...page, group: group.label })),
);

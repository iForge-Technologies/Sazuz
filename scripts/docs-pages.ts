/** Only these reviewed guides may be included in the public documentation site. */
export const documentationGroups = [
  {
    title: 'Start here',
    pages: [
      ['docs/index.md', 'Overview'],
      ['docs/install.md', 'Installation and setup'],
      ['docs/security.md', 'Security and remote access'],
    ],
  },
  {
    title: 'Use Sazuz',
    pages: [
      ['docs/agents-and-missions.md', 'Agents and missions'],
      ['docs/memory-knowledge-skills.md', 'Memory and knowledge'],
      ['docs/workflows.md', 'Workflows'],
      ['docs/recipes.md', 'Recipes'],
      ['docs/learned-skills.md', 'Learned skills'],
      ['docs/sandbox-browser.md', 'Browser and code'],
    ],
  },
  {
    title: 'Connect services',
    pages: [
      ['docs/connectors-v1.md', 'Official connectors'],
      ['docs/connectors.md', 'Email, calendar and Telegram setup'],
      ['docs/webhooks.md', 'Signed webhooks'],
      ['docs/mcp.md', 'MCP'],
      ['docs/bridge.md', 'Bridge'],
    ],
  },
  {
    title: 'Operate Sazuz',
    pages: [
      ['docs/operations.md', 'Backups, accounts and updates'],
      ['docs/apps/cli/README.md', 'Operator CLI'],
      ['docs/voice-push.md', 'Voice and notifications'],
      ['docs/observability-evals.md', 'Costs and evaluations'],
    ],
  },
  {
    title: 'Releases',
    pages: [
      ['docs/releases.md', 'Release verification'],
      ['docs/releases/1.0.0.md', 'Version 1.0.0'],
    ],
  },
] as const;

export const publicDocumentation = documentationGroups.flatMap((group) =>
  group.pages.map(([source, label]) => ({
    source,
    label,
    output:
      source === 'docs/apps/cli/README.md' ? 'cli.html' : source.slice(5).replace(/\.md$/, '.html'),
  })),
);

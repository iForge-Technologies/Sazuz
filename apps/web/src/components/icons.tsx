import type { ReactNode } from 'react';

export type IconName =
  | 'activity'
  | 'database'
  | 'worker'
  | 'check'
  | 'alert'
  | 'refresh'
  | 'pause'
  | 'play'
  | 'info'
  | 'chat'
  | 'missions'
  | 'approvals'
  | 'browser'
  | 'agents'
  | 'workflows'
  | 'automations'
  | 'recipes'
  | 'knowledge'
  | 'memory'
  | 'skills'
  | 'models'
  | 'connectors'
  | 'costs'
  | 'evals'
  | 'audit'
  | 'settings'
  | 'search'
  | 'menu'
  | 'close'
  | 'chevron'
  | 'plus'
  | 'arrow';

const paths: Record<IconName, ReactNode> = {
  chat: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Zm2 5h10M7 13h6" />,
  missions: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
      <path d="m12 12 7-7" />
    </>
  ),
  approvals: (
    <>
      <path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  browser: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M7 6.5h.01m3 0h.01" />
    </>
  ),
  agents: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2" />
    </>
  ),
  workflows: (
    <>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="15" width="6" height="6" rx="1" />
      <path d="M9 6h6a3 3 0 0 1 3 3v6M6 9v9h9" />
    </>
  ),
  automations: <path d="m13 2-9 12h7l-1 8 10-12h-8l1-8Z" />,
  recipes: (
    <>
      <path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4V4Zm9 3a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2" />
      <path d="M7 8h3m-3 4h3m6-4h2m-2 4h2" />
    </>
  ),
  knowledge: (
    <>
      <path d="M5 3h10l4 4v14H5V3Zm10 0v5h4M8 12h8m-8 4h6" />
    </>
  ),
  memory: (
    <>
      <path d="M9 4a3 3 0 0 0-5 3 4 4 0 0 0-1 7 4 4 0 0 0 6 5m6-15a3 3 0 0 1 5 3 4 4 0 0 1 1 7 4 4 0 0 1-6 5M9 3v18m6-18v18M5 10h4m6 4h4" />
    </>
  ),
  skills: (
    <>
      <path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm-9 5 9 5 9-5m-9 5v9M7 5.8l9 5" />
    </>
  ),
  models: (
    <>
      <path d="m12 2 10 6-10 6L2 8l10-6ZM2 12l10 6 10-6M2 16l10 6 10-6" />
    </>
  ),
  connectors: (
    <>
      <path d="M8 3v4m8-4v4M6 7h12v3a6 6 0 0 1-12 0V7Zm6 9v5" />
    </>
  ),
  costs: (
    <>
      <path d="M4 20V10m5 10V5m6 15v-8m5 8V3M2 21h20" />
    </>
  ),
  evals: (
    <>
      <path d="M9 3v6l-6 10a1 1 0 0 0 1 2h16a1 1 0 0 0 1-2L15 9V3M7 3h10M6 15h12" />
    </>
  ),
  audit: (
    <>
      <path d="M8 4H5v17h14V4h-3M8 2h8v5H8V2Zm0 9h8m-8 4h8m-8 3h5" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="8" cy="6" r="2" />
      <circle cx="16" cy="12" r="2" />
      <circle cx="10" cy="18" r="2" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  worker: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="3" />
      <path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4" />
      <path d="M10 10h4v4h-4z" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  alert: (
    <>
      <path d="M12 8v5m0 3h.01" />
      <path d="M10.3 3.8 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.8a2 2 0 0 0-3.4 0Z" />
    </>
  ),
  refresh: (
    <path d="M20 7v5h-5M4 17v-5h5m10-4a7.5 7.5 0 0 0-12.5-2L4 9m16 6-2.5 3A7.5 7.5 0 0 1 5 16" />
  ),
  pause: <path d="M9 5v14M15 5v14" />,
  play: <path d="m8 4 12 8-12 8V4Z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10h.01" />
    </>
  ),
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {paths[name]}
    </svg>
  );
}

export function SazuzMark() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="currentColor" />
      <path
        d="M23 9H13l-4 7h14l-4 7H9"
        stroke="var(--primary-foreground, white)"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

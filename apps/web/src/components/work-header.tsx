'use client';

import Link from 'next/link';
import { useRef, type ReactNode } from 'react';
import { WorkControl } from './work-control';
import { Icon, SazuzMark } from './icons';
import { PageCommand } from './page-command';
import { navigationGroups, workspacePages } from './workspace-navigation';
import { containDialogFocus } from './dialog-focus';

export type WorkPage =
  | 'Chat'
  | 'Missions'
  | 'Approvals'
  | 'Automations'
  | 'Models'
  | 'Memory'
  | 'Knowledge'
  | 'Skills'
  | 'Recipes'
  | 'Browser'
  | 'Agents'
  | 'Workflows'
  | 'S2A'
  | 'MCP'
  | 'Channels'
  | 'Connectors'
  | 'Costs'
  | 'Evals'
  | 'Audit'
  | 'Settings'
  | 'Health';

function WorkspaceLinks({ current, onNavigate }: { current: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Workspace pages" className="workspace-nav">
      {navigationGroups.map((group) => (
        <div className="nav-group" key={group.label}>
          <p>{group.label}</p>
          {group.pages.map((page) => (
            <Link
              key={page.href}
              href={page.href}
              aria-current={current === page.name ? 'page' : undefined}
              onClick={() => onNavigate?.()}
            >
              <Icon name={page.icon} />
              <span>{page.name}</span>
              {current === page.name && <span className="nav-active-marker" aria-hidden="true" />}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function WorkHeader({
  current,
  controls,
  contentId = 'work-content',
  publicPage = false,
}: {
  current: WorkPage;
  controls?: ReactNode;
  contentId?: string;
  publicPage?: boolean;
}) {
  const mobile = useRef<HTMLDialogElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const name = current === 'Health' ? 'System health' : current;
  const page = workspacePages.find((item) => item.name === name);
  return (
    <>
      <a className="skip-link" href={`#${contentId}`}>
        Skip to content
      </a>
      <aside className="workspace-sidebar" aria-label="Workspace sidebar">
        <Link className="workspace-brand" href="/" aria-label="Sazuz home">
          <SazuzMark />
          <span>
            Sazuz<small>Personal workspace</small>
          </span>
        </Link>
        <WorkspaceLinks current={name} />
        <div className="sidebar-footer">
          <span className="instance-monogram">S</span>
          <span>
            Self-hosted<small>Your instance, your control</small>
          </span>
        </div>
      </aside>
      <header className="workspace-topbar">
        <button
          className="icon-button mobile-nav-trigger"
          ref={menuTrigger}
          type="button"
          aria-label="Open navigation"
          aria-haspopup="dialog"
          onClick={() => mobile.current?.showModal()}
        >
          <Icon name="menu" />
        </button>
        <div className="workspace-breadcrumb">
          <span>{page?.group ?? 'Workspace'}</span>
          <Icon name="chevron" />
          <strong>{name}</strong>
        </div>
        <div className="workspace-topbar-actions">
          <PageCommand />
          {controls ??
            (publicPage ? (
              <Link href="/chat" className="workspace-open">
                Open workspace <Icon name="arrow" />
              </Link>
            ) : (
              <WorkControl />
            ))}
        </div>
      </header>
      <dialog
        ref={mobile}
        className="mobile-navigation"
        aria-label="Workspace navigation"
        onKeyDown={containDialogFocus}
        onClose={() => menuTrigger.current?.focus()}
        onClick={(event) => {
          if (event.target === event.currentTarget) mobile.current?.close();
        }}
      >
        <div className="mobile-navigation-inner">
          <div className="mobile-navigation-heading">
            <Link className="workspace-brand" href="/" onClick={() => mobile.current?.close()}>
              <SazuzMark />
              <span>Sazuz</span>
            </Link>
            <button
              type="button"
              className="icon-button"
              aria-label="Close navigation"
              onClick={() => mobile.current?.close()}
            >
              <Icon name="close" />
            </button>
          </div>
          <WorkspaceLinks current={name} onNavigate={() => mobile.current?.close()} />
        </div>
      </dialog>
    </>
  );
}

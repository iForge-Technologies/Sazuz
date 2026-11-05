import type { ReactNode } from 'react';
import { WorkHeader, type WorkPage } from './work-header';

export function WorkPageLayout({
  current,
  title,
  description,
  children,
  actions,
  controls,
}: {
  current: WorkPage;
  title: string;
  description: string;
  children: ReactNode;
  actions?: ReactNode;
  controls?: ReactNode;
}) {
  return (
    <div className="setup-shell work-shell" data-work-page={current.toLowerCase()}>
      <WorkHeader current={current} controls={controls} />
      <main id="work-content" tabIndex={-1}>
        <div className="work-heading">
          <div>
            <p className="eyebrow">
              {current === 'Approvals' ? 'HUMAN REVIEW' : 'WORKSPACE / ' + current.toUpperCase()}
            </p>
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
          {actions}
        </div>
        {children}
      </main>
    </div>
  );
}

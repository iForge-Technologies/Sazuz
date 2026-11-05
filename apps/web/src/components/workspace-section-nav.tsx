import type { ReactNode } from 'react';

export function WorkspaceSectionNav({
  label,
  sections,
}: {
  label: string;
  sections: ReadonlyArray<{ id: string; label: string }>;
}) {
  return (
    <nav className="workspace-section-nav" aria-label={label}>
      {sections.map((section) => (
        <a key={section.id} href={`#${section.id}`}>
          {section.label}
        </a>
      ))}
    </nav>
  );
}

export function WorkspaceLoading({ children }: { children: ReactNode }) {
  return (
    <p className="workspace-loading" role="status">
      <span aria-hidden="true" className="workspace-loading-mark" />
      {children}
    </p>
  );
}

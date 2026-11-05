'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from './icons';
import { workspacePages } from './workspace-navigation';
import { containDialogFocus } from './dialog-focus';

export function PageCommand() {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const router = useRouter();
  const matches = workspacePages.filter((page) =>
    `${page.name} ${page.description} ${page.group}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  function open() {
    if (dialog.current?.open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : trigger.current;
    setQuery('');
    setSelected(0);
    dialog.current?.showModal();
    input.current?.focus();
  }

  function navigate(href: string) {
    dialog.current?.close();
    router.push(href);
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        // Do not supersede an approval or another open modal.
        if (document.querySelector('dialog[open]') && !dialog.current?.open) return;
        event.preventDefault();
        if (dialog.current?.open) dialog.current.close();
        else open();
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  useEffect(() => {
    dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <>
      <button
        ref={trigger}
        className="page-search"
        type="button"
        onClick={open}
        aria-label="Search pages"
        aria-haspopup="dialog"
      >
        <Icon name="search" />
        <span>Find a page</span>
        <kbd>Ctrl K</kbd>
      </button>
      <dialog
        ref={dialog}
        className="page-command"
        aria-labelledby="page-command-title"
        onKeyDown={containDialogFocus}
        onClose={() => previousFocus.current?.focus()}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <div className="command-inner">
          <header>
            <h2 id="page-command-title">Go to page</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close page search"
              onClick={() => dialog.current?.close()}
            >
              <Icon name="close" />
            </button>
          </header>
          <div className="command-search">
            <Icon name="search" />
            <input
              ref={input}
              value={query}
              aria-label="Find a page"
              role="combobox"
              aria-expanded="true"
              aria-controls="page-command-results"
              aria-autocomplete="list"
              aria-activedescendant={matches[selected] ? `page-result-${selected}` : undefined}
              placeholder="Search pages, settings, or tools…"
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setSelected((current) =>
                    matches.length
                      ? (current + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) %
                        matches.length
                      : 0,
                  );
                }
                if (event.key === 'Enter' && matches[selected]) {
                  event.preventDefault();
                  navigate(matches[selected].href);
                }
              }}
            />
          </div>
          <div
            className="command-results"
            id="page-command-results"
            role="listbox"
            aria-label="Pages"
          >
            {matches.map((page, index) => (
              <button
                type="button"
                role="option"
                id={`page-result-${index}`}
                aria-selected={index === selected}
                tabIndex={-1}
                className="command-result"
                key={page.href}
                onClick={() => navigate(page.href)}
                onPointerMove={() => setSelected(index)}
              >
                <Icon name={page.icon} />
                <span>
                  <strong>{page.name}</strong>
                  <small>{page.description}</small>
                </span>
                <span className="command-group">{page.group}</span>
                <Icon name="arrow" />
              </button>
            ))}
            {!matches.length && (
              <p className="command-empty" role="status">
                No pages match “{query}”. Try a shorter search.
              </p>
            )}
          </div>
          <footer>
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> Navigate
            </span>
            <span>
              <kbd>Enter</kbd> Open
            </span>
            <span>
              <kbd>Esc</kbd> Close
            </span>
          </footer>
        </div>
      </dialog>
    </>
  );
}

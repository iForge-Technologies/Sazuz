import type { KeyboardEvent } from 'react';

/** Keep Tab inside the modal, including browsers that otherwise move it to chrome. */
export function containDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== 'Tab' || event.defaultPrevented) return;
  const elements = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]',
    ),
  ).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
  const first = elements[0];
  const last = elements.at(-1);
  if (!first || !last) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === event.currentTarget)
  ) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

import type { ElementFingerprint, LearnedLocator } from '@sazuz/core/learning';
import type { BrowserObservation } from '@sazuz/core/browser';
import type { Page } from 'playwright';
import { currentPage, type BrowserSession } from './session.js';
import { observation } from './perception.js';

function locator(page: Page, candidate: LearnedLocator) {
  switch (candidate.kind) {
    case 'role':
      return page.getByRole(candidate.role, { name: candidate.name, exact: true });
    case 'label':
      return page.getByLabel(candidate.value, { exact: true });
    case 'text':
      return page.getByText(candidate.value, { exact: true });
    case 'testId':
      return page.getByTestId(candidate.value);
    case 'css':
      return page.locator(`css=${candidate.value}`);
    case 'xpath':
      return page.locator(`xpath=${candidate.value}`);
  }
}
/** Inspect every candidate: conflicting candidates are as unsafe as multiple matches. */
export async function resolveTarget(
  session: BrowserSession,
  target: ElementFingerprint,
): Promise<BrowserObservation> {
  const view = await observation(session);
  if (view.status !== 'ready') return { ...view, actionPerformed: false };
  const matches = new Set<string>();
  for (const candidate of target.locators) {
    let elements;
    try {
      const match = locator(currentPage(session), candidate);
      if ((await match.count()) > 100)
        return { ...view, resolution: { status: 'ambiguous', ref: null } };
      elements = await match.elementHandles();
    } catch {
      return { ...view, resolution: { status: 'invalid', ref: null } };
    }
    try {
      let visible = 0;
      for (const element of elements) {
        if (!(await element.isVisible())) continue;
        visible++;
        if (visible > 1) return { ...view, resolution: { status: 'ambiguous', ref: null } };
        for (const [ref, saved] of session.refs) {
          if (saved.role !== target.role || (target.name && saved.name !== target.name)) continue;
          if (await element.evaluate((node, other) => node === other, saved.element))
            matches.add(ref);
        }
      }
    } finally {
      for (const element of elements) await element.dispose();
    }
  }
  return {
    ...view,
    resolution: {
      status: matches.size > 1 ? 'ambiguous' : matches.size ? 'matched' : 'missing',
      ref: matches.size === 1 ? [...matches][0]! : null,
    },
  };
}

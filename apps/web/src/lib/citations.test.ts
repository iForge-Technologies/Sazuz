import { describe, expect, it } from 'vitest';
import { citationParts } from './citations';
describe('source citation links', () => {
  it('recognizes only stable chunk citations and leaves all other text inert', () => {
    const id = 'chk_01ARZ3NDEKTSV4RRFFQ69G5FAV';
    expect(citationParts(`Orchid [kb:${id}]. [kb:javascript:alert(1)] <script>`)).toEqual([
      { text: 'Orchid ' },
      { text: `[kb:${id}]`, id },
      { text: '. [kb:javascript:alert(1)] <script>' },
    ]);
  });
});

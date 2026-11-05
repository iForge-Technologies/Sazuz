/** Disposable forms for the explicit test-only host browser process. */
export function phaseNineBrowserFixture() {
  let changed = false;
  const submissions: Record<string, string>[] = [];
  const escape = (text: string) =>
    text
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  return {
    submissions,
    change() {
      changed = true;
    },
    render(path: string, method: string | undefined, fields: URLSearchParams): string | undefined {
      if (path === '/learn')
        return `<form action="/learn-review" method="post">
        <label>Project<input autofocus aria-label="Project" name="project" id="project"></label>
        <label>Client<input aria-label="Client" name="client" id="client"></label>
        <label>Category<select aria-label="Category" name="category" id="category"><option>Alpha</option><option>Beta</option></select></label>
        <button ${changed ? 'id="continue-new" aria-label="Continue to summary">Continue to summary' : 'id="review" aria-label="Review project">Review project'}</button>
      </form>`;
      if (path === '/learn-review')
        return `<form action="/learn-done" method="post">
        ${['project', 'client', 'category'].map((name) => `<input type="hidden" name="${name}" value="${escape(fields.get(name) ?? '')}">`).join('')}
        <label>Notes<textarea autofocus aria-label="Notes" name="notes" id="notes"></textarea></label>
        <label><input type="checkbox" aria-label="Confirmed" name="confirmed" id="confirmed">Confirmed</label>
        <button aria-label="Submit project" id="submit">Submit project</button>
      </form>`;
      if (path === '/learn-done') {
        if (method === 'POST') submissions.push(Object.fromEntries(fields));
        return '<p>Project saved.</p>';
      }
      return undefined;
    },
  };
}

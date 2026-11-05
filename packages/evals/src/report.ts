import { evalReportSchema, type EvalReport } from '@sazuz/core/evals';
import { secretRedactor } from '@sazuz/vault';

export const escapeHtml = (value: unknown) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
export function comparisonRows(report: EvalReport) {
  return report.suites.flatMap((suite) =>
    report.presets.map((preset) => {
      const results = report.results.filter(
        (item) => item.suite === suite.suite && item.preset === preset,
      );
      return {
        suite: suite.suite,
        preset,
        cases: results.length,
        passed: results.filter((item) => item.passed).length,
        costUsd: results.reduce((sum, item) => sum + item.costUsd, 0),
        judgeCostUsd: results.reduce((sum, item) => sum + item.judgeCostUsd, 0),
        tokens: results.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0),
        latencyMs: results.reduce((sum, item) => sum + item.latencyMs, 0),
        models: [
          ...new Set(
            results.flatMap((item) =>
              item.models.map((model) => `${model.providerId}/${model.modelId}`),
            ),
          ),
        ],
      };
    }),
  );
}
export function renderEvalHtml(input: unknown): string {
  const report = evalReportSchema.parse(secretRedactor.redact(input));
  const e = escapeHtml;
  const rows = comparisonRows(report);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"><title>Sazuz evaluation report</title><style>body{font:16px/1.55 system-ui,sans-serif;color:#17242b;background:#f7f8fa;margin:auto;padding:2rem;max-width:1200px}h1,h2,h3{line-height:1.2}section{border-top:1px solid #b8c4ca;margin-top:2rem;padding-top:1rem}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:.65rem;border-bottom:1px solid #ccd4d9;text-align:left;vertical-align:top}.scroll{overflow:auto}.notice{background:#e7eef3;padding:1rem;border-left:4px solid #315976}pre{white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer}small{color:#456}li{margin:.5rem 0}.pass{color:#17532f}.fail{color:#923225}</style></head><body>
<h1>Sazuz evaluation report</h1><p>Run ${e(report.id)} · ${e(report.status)} · ${e(report.createdAt)}</p>
<p class="notice">${report.mode === 'fixture' ? 'Deterministic fixture mode. No model inference or live tools were used. These results verify the harness and policy boundaries; they do not establish provider quality or injection immunity.' : 'Configured-model mode. Actual model inference is accounted below. Every tool is simulated; no live connector, browser, sandbox or host action is available.'}</p>
<p>${report.passedCases}/${report.totalCases} cases passed; ${report.completedCases} recorded. Total $${report.costUsd.toFixed(6)}, including $${report.judgeCostUsd.toFixed(6)} for the optional judge.</p>
<p>Unauthorized dispatch attempts: ${report.results.reduce((sum, item) => sum + item.unauthorizedEffects, 0)}. Live dispatch attempts: ${report.results.reduce((sum, item) => sum + item.liveDispatches, 0)}. Skipped judge checks are unverified and do not count as passes.</p>
<h2>Preset comparison</h2><div class="scroll"><table><thead><tr><th>Suite</th><th>Preset</th><th>Passed / recorded</th><th>Models</th><th>Tokens</th><th>Provider latency</th><th>Cost / judge</th></tr></thead><tbody>${rows.map((row) => `<tr><th>${e(row.suite)}</th><td>${e(row.preset)}</td><td>${row.passed} / ${row.cases}</td><td>${e(row.models.join(', ') || 'Fixture (no inference)')}</td><td>${row.tokens}</td><td>${row.latencyMs.toFixed(1)} ms</td><td>$${row.costUsd.toFixed(6)} / $${row.judgeCostUsd.toFixed(6)}</td></tr>`).join('')}</tbody></table></div>
${report.results.map((result) => `<section><h2>${e(result.suite)} / ${e(result.preset)} / ${e(result.caseId)}</h2><p class="${result.passed ? 'pass' : 'fail'}">${result.passed ? 'Pass' : 'Unverified or failed'} · ${e(result.outcome)} · ${result.steps} steps · ${result.modelCalls} billed usage records</p><p>Flags: ${e(result.flags.join(', ') || 'none')}</p><pre>${e(result.text)}</pre><h3>Grades</h3><ul>${result.grades.map((grade) => `<li><strong>${grade.passed === null ? 'Skipped' : grade.passed ? 'Pass' : 'Fail'}: ${e(grade.description)}</strong><br>${e(grade.evidence)}</li>`).join('')}</ul><details><summary>Policy and simulated tool evidence</summary><pre>${e(JSON.stringify({ decisions: result.decisions, dispatches: result.dispatches }, null, 2))}</pre></details></section>`).join('')}
<section><h2>Provenance</h2><ul>${report.suites.map((suite) => `<li>${e(suite.suite)} v${suite.version}: <code>${e(suite.hash)}</code></li>`).join('')}</ul><p>Model presets select routing preferences, independently of security presets. Fixture flags use a bounded injection-cue heuristic; taint-aware policy applies regardless of that heuristic. Case history retains saved observations and decisions. An interrupted billed request is not automatically retried.</p><details><summary>Report data (JSON)</summary><pre id="report-data">${e(JSON.stringify(report, null, 2))}</pre></details></section></body></html>`;
}

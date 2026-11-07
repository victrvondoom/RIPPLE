/**
 * SYNTHETIC fixture: the author's private coding-agent session for the sample PR. In a real deployment this stays on the
 * author's side and RIPPLE never stores it; here it is generated in code so the demo is reproducible. All people, code and
 * sessions are made up. Only the one disclosed step ever enters the mission record.
 */
export interface SessionStep { index: number; kind: 'prompt' | 'plan' | 'read' | 'edit' | 'test' | 'reasoning' | 'summary'; file?: string; text: string }

export function syntheticSession(prNumber: number): SessionStep[] {
  const steps: Omit<SessionStep, 'index'>[] = [
    { kind: 'prompt', text: 'Add CSV export to the reports page. Keep the existing PDF export working.' },
    { kind: 'plan', text: 'Plan: add /reports/export.csv route, stream rows, reuse the report query, add a button to the reports page.' },
    { kind: 'read', file: 'reports/views.py', text: 'Read reports/views.py: the report query is built per request and filtered by account id.' },
    { kind: 'edit', file: 'reports/export.py', text: 'Create reports/export.py with a streaming CSV writer that escapes cells beginning with = + - @.' },
    { kind: 'test', text: 'Ran tests/test_reports.py: 14 passed. Added test_csv_escapes_formula_cells.' },
    { kind: 'reasoning', file: 'auth/session.py', text: `Export requests from the scheduled-report worker arrive without a browser cookie, so the session check in auth/session.py rejected them. I changed validate_session() to accept the worker's signed service token for the /reports/export.csv route only, and kept cookie sessions required everywhere else (PR #${prNumber}).` },
    { kind: 'edit', file: 'auth/session.py', text: 'Edit auth/session.py: validate_session() accepts a signed service token when the path is /reports/export.csv.' },
    { kind: 'test', text: 'Ran tests/test_auth.py: 9 passed. Added test_service_token_rejected_on_other_routes.' },
    { kind: 'edit', file: 'reports/templates/reports.html', text: 'Add an Export CSV button next to Export PDF.' },
    { kind: 'summary', text: 'Summary: CSV export added; session check widened for one route; tests added.' },
  ];
  return steps.map((s, i) => ({ ...s, index: i }));
}
export const stepText = (s: SessionStep) => `[${s.kind}${s.file ? ` ${s.file}` : ''}] ${s.text}`;

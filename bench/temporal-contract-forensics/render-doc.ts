/** Copy the generated results/report.md into docs/TCF_BENCHMARK.md between the TCF:RESULTS markers. */
import { readFileSync, writeFileSync } from 'node:fs';

const report = readFileSync(new URL('./results/report.md', import.meta.url), 'utf8').replace(/^# .*\n/, '');
const docUrl = new URL('../../docs/TCF_BENCHMARK.md', import.meta.url);
const doc = readFileSync(docUrl, 'utf8');
const begin = '<!-- TCF:RESULTS:BEGIN -->'; const end = '<!-- TCF:RESULTS:END -->';
const a = doc.indexOf(begin); const b = doc.indexOf(end);
if (a < 0 || b < a) throw new Error('result markers not found in docs/TCF_BENCHMARK.md');
writeFileSync(docUrl, `${doc.slice(0, a + begin.length)}\n_Rendered from \`bench/temporal-contract-forensics/results/report.md\`; regenerate rather than edit._\n${report.replace(/^## /gm, '### ')}\n${doc.slice(b)}`);
console.log('docs/TCF_BENCHMARK.md updated');

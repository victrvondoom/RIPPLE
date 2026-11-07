/**
 * Deterministic counterfactuals. Each starts from a revision's exact evidence set and context, changes only the
 * listed assumptions (all-or-nothing: one invalid change makes the whole counterfactual IMPOSSIBLE), recomputes the
 * envelope and contract result, and reports exactly what changed and which change caused it. The base revision is
 * never touched (it is frozen) and the output is always labelled hypothetical.
 */
import { analyseContext, type InactiveEvidence } from './analysis.js';
import { diffResults } from './diff.js';
import { validateEvidenceShape } from './evidence.js';
import { activeEvidence, inactiveEvidence } from './revisions.js';
import { formatDuration, formatInstant, isSafeMs, parseInstant, TcfInputError } from './time.js';
import {
  AUTHORITY_CLASSES, type AnalysisContext, type AnalysisRevision, type CounterfactualChange, type CounterfactualResult, type TemporalEvidence, type TimeBound,
} from './types.js';

const LABEL = 'HYPOTHETICAL — computed from assumptions that are not established facts. It is not a finding and does not change the recorded analysis.';

function shiftIso(iso: string, by: number): string { return formatInstant(parseInstant(iso, 'time') + by); }

function bounds(e: TemporalEvidence, ep: 'start' | 'end' | 'at'): TimeBound | null {
  const a = e.assertion;
  if (a.kind === 'INTERVAL') return ep === 'start' ? a.start : ep === 'end' ? a.end : null;
  return ep === 'at' ? a.at : null;
}

function setBounds(e: TemporalEvidence, ep: 'start' | 'end' | 'at', b: TimeBound): void {
  const a = e.assertion as unknown as Record<string, TimeBound>;
  a[ep] = b;
}

export function runCounterfactual(base: AnalysisRevision, changes: CounterfactualChange[]): CounterfactualResult {
  const evidence = activeEvidence(base.ledger).map((e) => structuredClone(e));
  const inactive: InactiveEvidence[] = inactiveEvidence(base.ledger).map((i) => ({ ...i, evidence: structuredClone(i.evidence) }));
  const ctx: AnalysisContext = structuredClone(base.context);
  const rejected: CounterfactualResult['rejected'] = [];
  const attribution: CounterfactualResult['attribution'] = [];
  const find = (id: string) => evidence.find((e) => e.id === id);

  changes.forEach((c, i) => {
    const reject = (reason: string) => rejected.push({ index: i, reason });
    try {
      switch (c.type) {
        case 'SHIFT_TIME': {
          const e = find(c.evidenceId); if (!e) return reject(`no active evidence ${c.evidenceId}`);
          if (!isSafeMs(c.byMs)) return reject('byMs must be an integer');
          const eps = c.endpoint === 'all' ? (['start', 'end', 'at'] as const).filter((x) => bounds(e, x)) : [c.endpoint];
          for (const ep of eps) { const b = bounds(e, ep); if (!b) return reject(`${c.evidenceId} has no "${ep}" time`); setBounds(e, ep, { earliest: shiftIso(b.earliest, c.byMs), latest: shiftIso(b.latest, c.byMs) }); }
          if (c.endpoint === 'all' && e.assertion.kind === 'TRANSITION' && e.assertion.holdsUntil) e.assertion.holdsUntil = shiftIso(e.assertion.holdsUntil, c.byMs);
          attribution.push({ change: i, description: `${c.evidenceId} ${c.endpoint} shifted by ${formatDuration(c.byMs)}`, affectedEvidenceIds: [c.evidenceId] });
          break;
        }
        case 'SET_TIME_BOUND': {
          const e = find(c.evidenceId); if (!e) return reject(`no active evidence ${c.evidenceId}`);
          if (!bounds(e, c.endpoint)) return reject(`${c.evidenceId} has no "${c.endpoint}" time`);
          if (parseInstant(c.bound.earliest, 'bound.earliest') > parseInstant(c.bound.latest, 'bound.latest')) return reject('bound.earliest is after bound.latest');
          setBounds(e, c.endpoint, { ...c.bound });
          attribution.push({ change: i, description: `${c.evidenceId} ${c.endpoint} set to ${c.bound.earliest}–${c.bound.latest}`, affectedEvidenceIds: [c.evidenceId] });
          break;
        }
        case 'INGESTION_DELAY': {
          const e = find(c.evidenceId); if (!e) return reject(`no active evidence ${c.evidenceId}`);
          if (!isSafeMs(c.delayMs) || c.delayMs < 0) return reject('delayMs must be a non-negative integer');
          const b = bounds(e, c.endpoint); if (!b) return reject(`${c.evidenceId} has no "${c.endpoint}" time`);
          setBounds(e, c.endpoint, { earliest: shiftIso(b.earliest, -c.delayMs), latest: b.latest });
          attribution.push({ change: i, description: `${c.evidenceId} ${c.endpoint} may have happened up to ${formatDuration(c.delayMs)} before it was recorded (ingestion delay)`, affectedEvidenceIds: [c.evidenceId] });
          break;
        }
        case 'SET_CLOCK': {
          const existing = ctx.clocks.find((k) => k.clockId === c.clockId);
          if (c.knownOffsetMs !== undefined && !isSafeMs(c.knownOffsetMs)) return reject('knownOffsetMs must be an integer');
          if (c.uncertaintyMs !== undefined && (!isSafeMs(c.uncertaintyMs) || c.uncertaintyMs < 0)) return reject('uncertaintyMs must be a non-negative integer');
          if (existing) { if (c.knownOffsetMs !== undefined) existing.knownOffsetMs = c.knownOffsetMs; if (c.uncertaintyMs !== undefined) existing.uncertaintyMs = c.uncertaintyMs; }
          else { if (!evidence.some((e) => (e.source.clockId ?? e.source.system) === c.clockId)) return reject(`no evidence uses clock ${c.clockId}`); ctx.clocks.push({ clockId: c.clockId, knownOffsetMs: c.knownOffsetMs ?? 0, uncertaintyMs: c.uncertaintyMs ?? 0 }); }
          attribution.push({ change: i, description: `clock ${c.clockId}: offset ${c.knownOffsetMs ?? 'unchanged'}, uncertainty ±${c.uncertaintyMs ?? 'unchanged'} ms`, affectedEvidenceIds: evidence.filter((e) => (e.source.clockId ?? e.source.system) === c.clockId).map((e) => e.id) });
          break;
        }
        case 'SET_AUTHORITY': {
          const e = find(c.evidenceId); if (!e) return reject(`no active evidence ${c.evidenceId}`);
          if (!AUTHORITY_CLASSES.includes(c.authority)) return reject(`unknown authority ${c.authority}`);
          e.source.authority = c.authority; if (c.signatureVerified !== undefined) e.source.signatureVerified = c.signatureVerified;
          attribution.push({ change: i, description: `${c.evidenceId} treated as ${c.authority}`, affectedEvidenceIds: [c.evidenceId] });
          break;
        }
        case 'SET_EXCLUSION_STATUS': {
          const m = ctx.maintenance.find((x) => x.id === c.maintenanceId); if (!m) return reject(`no maintenance record ${c.maintenanceId}`);
          if (!['CONFIRMED', 'UNCONFIRMED', 'REJECTED'].includes(c.status)) return reject(`unknown status ${c.status}`);
          m.status = c.status;
          attribution.push({ change: i, description: `maintenance ${c.maintenanceId} ${c.status}`, affectedEvidenceIds: [] });
          break;
        }
        case 'EXCLUDE_EVIDENCE': {
          const idx = evidence.findIndex((e) => e.id === c.evidenceId); if (idx < 0) return reject(`no active evidence ${c.evidenceId}`);
          if (!c.reason?.trim()) return reject('excluding evidence needs a reason');
          inactive.push({ evidence: evidence[idx]!, code: 'COUNTERFACTUAL_EXCLUDED', detail: c.reason });
          evidence.splice(idx, 1);
          attribution.push({ change: i, description: `${c.evidenceId} excluded: ${c.reason}`, affectedEvidenceIds: [c.evidenceId] });
          break;
        }
        case 'ADD_EVIDENCE': {
          validateEvidenceShape(c.evidence, 0);
          if (evidence.some((e) => e.id === c.evidence.id) || inactive.some((e) => e.evidence.id === c.evidence.id)) return reject(`evidence id ${c.evidence.id} already exists`);
          const e = structuredClone(c.evidence);
          if (!e.provenance?.reference?.startsWith('hypothetical:')) e.provenance = { ...e.provenance, reference: `hypothetical:${e.provenance?.reference ?? ''}` };
          evidence.push(e);
          attribution.push({ change: i, description: `hypothetical record ${e.id} added (${e.assertion.kind})`, affectedEvidenceIds: [e.id] });
          break;
        }
        case 'SET_SCOPE_SEMANTICS': {
          const e = find(c.evidenceId); if (!e) return reject(`no active evidence ${c.evidenceId}`);
          e.scope.semantics = c.semantics;
          attribution.push({ change: i, description: `${c.evidenceId} read as ${c.semantics} (${c.semantics === 'AGGREGATE' ? 'its health claim no longer speaks for a narrower scope' : 'its claims apply to every sub-scope'})`, affectedEvidenceIds: [c.evidenceId] });
          break;
        }
        default: reject(`unknown change type ${(c as { type?: string }).type}`);
      }
    } catch (err) {
      if (err instanceof TcfInputError) reject(err.message); else throw err;
    }
  });

  const head = { hypothetical: true as const, label: LABEL, baseRevisionHash: base.revisionHash, baseOutputHash: base.outputHash, changes: structuredClone(changes), rejected };
  if (rejected.length) return { ...head, status: 'IMPOSSIBLE', evidenceSetHash: null, result: null, diff: [], attribution, explanation: ['The counterfactual cannot be evaluated: ' + rejected.map((r) => `change ${r.index}: ${r.reason}`).join('; '), 'No partial result is produced.'] };
  let out;
  try { out = analyseContext(ctx, evidence, inactive); } catch (err) {
    if (!(err instanceof TcfInputError)) throw err;
    return { ...head, status: 'IMPOSSIBLE', rejected: [{ index: -1, reason: err.message }], evidenceSetHash: null, result: null, diff: [], attribution, explanation: [`The changed inputs are invalid: ${err.message}`] };
  }
  const diff = diffResults(base.result, out.result);
  const explanation: string[] = [LABEL];
  const b = base.result.bounds?.qualifyingDowntimeMs; const a = out.result.bounds?.qualifyingDowntimeMs;
  explanation.push(`Recorded: ${base.result.classification}${b ? ` (${formatDuration(b.min)}–${formatDuration(b.max)})` : ''}. Hypothetical: ${out.result.classification}${a ? ` (${formatDuration(a.min)}–${formatDuration(a.max)})` : ''}.`);
  if (!diff.length) explanation.push('These assumptions change no decision-relevant field.');
  else explanation.push(`Changed: ${diff.map((d) => d.field).join(', ')}.`);
  for (const at of attribution) explanation.push(`Because: ${at.description}.`);
  const newStatuses = diff.filter((d) => d.field.startsWith('evidence.')).map((d) => `${d.field.slice(9, -7)} ${d.before ?? 'absent'} → ${d.after ?? 'absent'}`);
  if (newStatuses.length) explanation.push(`Evidence use changed: ${newStatuses.join('; ')}.`);
  if (out.result.classification === 'INDETERMINATE' && out.result.conflicts.length > base.result.conflicts.length) explanation.push('The assumptions make the evidence contradict itself; the hypothetical world is not consistent with every record.');
  return { ...head, status: 'COMPUTED', evidenceSetHash: out.result.hashes.evidenceSetHash, result: out.result, diff, attribution, explanation };
}

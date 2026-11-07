import type { FieldChange, TemporalExposureResult } from './types.js';

/** Decision-relevant fields that changed between two results (machine readable, stable order). */
export function diffResults(a: TemporalExposureResult, b: TemporalExposureResult): FieldChange[] {
  const out: FieldChange[] = [];
  const cmp = (field: string, x: unknown, y: unknown) => { if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ field, before: x ?? null, after: y ?? null }); };
  cmp('classification', a.classification, b.classification);
  cmp('contract.version', a.contract?.version, b.contract?.version);
  cmp('bounds.qualifyingDowntimeMs.min', a.bounds?.qualifyingDowntimeMs.min, b.bounds?.qualifyingDowntimeMs.min);
  cmp('bounds.qualifyingDowntimeMs.max', a.bounds?.qualifyingDowntimeMs.max, b.bounds?.qualifyingDowntimeMs.max);
  cmp('bounds.qualifyingDowntimeMs.minStatus', a.bounds?.qualifyingDowntimeMs.minStatus, b.bounds?.qualifyingDowntimeMs.minStatus);
  cmp('bounds.qualifyingDowntimeMs.maxStatus', a.bounds?.qualifyingDowntimeMs.maxStatus, b.bounds?.qualifyingDowntimeMs.maxStatus);
  cmp('bounds.breachPointMs', a.bounds?.breachPointMs, b.bounds?.breachPointMs);
  cmp('bounds.availabilityPercent', a.bounds?.availabilityPercent, b.bounds?.availabilityPercent);
  cmp('credit', a.credit, b.credit);
  cmp('sensitivity.decisionSensitiveMs', a.sensitivity.decisionSensitiveMs, b.sensitivity.decisionSensitiveMs);
  cmp('sensitivity.additionalDowntimeToConfirmMs', a.sensitivity.additionalDowntimeToConfirmMs, b.sensitivity.additionalDowntimeToConfirmMs);
  cmp('sensitivity.possibleDowntimeToEliminateMs', a.sensitivity.possibleDowntimeToEliminateMs, b.sensitivity.possibleDowntimeToEliminateMs);
  cmp('envelope.certainDowntime', a.envelope.certainDowntime.map((s) => [s.start, s.end]), b.envelope.certainDowntime.map((s) => [s.start, s.end]));
  cmp('envelope.possibleDowntime', a.envelope.possibleDowntime.map((s) => [s.start, s.end]), b.envelope.possibleDowntime.map((s) => [s.start, s.end]));
  cmp('envelope.evidenceGaps', a.envelope.evidenceGaps.map((s) => [s.start, s.end]), b.envelope.evidenceGaps.map((s) => [s.start, s.end]));
  cmp('envelope.exclusions', a.envelope.exclusions.map((x) => [x.maintenanceId, x.status]), b.envelope.exclusions.map((x) => [x.maintenanceId, x.status]));
  cmp('conflicts', a.conflicts.map((c) => [c.type, c.resolution, c.evidenceIds]), b.conflicts.map((c) => [c.type, c.resolution, c.evidenceIds]));
  cmp('reviewRequirements', a.reviewRequirements.map((r) => r.code), b.reviewRequirements.map((r) => r.code));
  const ea = new Map(a.evidence.map((e) => [e.evidenceId, e.status])); const eb = new Map(b.evidence.map((e) => [e.evidenceId, e.status]));
  for (const id of [...new Set([...ea.keys(), ...eb.keys()])].sort()) if (ea.get(id) !== eb.get(id)) out.push({ field: `evidence.${id}.status`, before: ea.get(id) ?? null, after: eb.get(id) ?? null });
  return out;
}

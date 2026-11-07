/**
 * Impact-based human routing (session 21). PURE.
 *
 * Given what the CURRENT analysis revision proposes and what the PREVIOUS one proposed, decide who must be asked:
 *  - changed / new actions          → their approvers must decide (blocking)
 *  - identical payload, already approved → the approval carries over; nobody is re-asked
 *  - previous actions no longer proposed → stale; their approvers are told the item is withdrawn
 *  - teams whose artifacts were not impacted and who own no changed decision are NOT interrupted
 * Evidence required per team comes from the impacted artifacts each team owns.
 */
export interface RouteAction { key: string; title: string; payloadHash: string; approverRoles: string[]; room: string | null; department: string }
export interface RouteInput {
  rev: number;
  current: RouteAction[];
  previous: (RouteAction & { status: string; approved: boolean })[];
  impactedArtifacts: { key: string; department: string; ownerRole: string; room: string | null }[];
  teams: { department: string; room: string | null; roles: string[] }[];
  openQuestions: { key: string; assigneeRole: string; room: string | null; blocking: boolean }[];
}
export interface RoutePlan {
  rev: number;
  affectedTeams: string[];
  deciders: { role: string; reason: string; room: string | null; blocking: boolean }[];
  evidenceRequired: { department: string; artifacts: string[] }[];
  blockingApprovals: string[];
  carriedOver: string[];
  staleActions: string[];
  notifications: { room: string | null; reason: string }[];
  notInterrupted: string[];
}

export function routeImpact(i: RouteInput): RoutePlan {
  const prevByKey = new Map(i.previous.map((p) => [p.key, p]));
  const carriedOver: string[] = []; const blocking: string[] = []; const deciders: RoutePlan['deciders'] = []; const notes = new Map<string, string>();
  const touched = new Set<string>();
  for (const a of i.current) {
    const p = prevByKey.get(a.key);
    if (p && p.payloadHash === a.payloadHash && p.approved) { carriedOver.push(a.title); continue; }
    blocking.push(a.title); touched.add(a.department);
    for (const r of a.approverRoles) deciders.push({ role: r, reason: p ? (p.payloadHash === a.payloadHash ? `re-confirm "${a.title}" (unchanged payload, not yet approved)` : `"${a.title}" changed since rev ${i.rev - 1}`) : `new: "${a.title}"`, room: a.room, blocking: true });
    if (a.room) notes.set(a.room, `${notes.has(a.room) ? `${notes.get(a.room)}; ` : ''}decision needed: ${a.title}`);
  }
  const staleActions = i.previous.filter((p) => !i.current.some((c) => c.key === p.key) && !['verified', 'rejected', 'superseded'].includes(p.status)).map((p) => p.title);
  for (const p of i.previous.filter((x) => staleActions.includes(x.title))) { touched.add(p.department); if (p.room) notes.set(p.room, `${notes.has(p.room) ? `${notes.get(p.room)}; ` : ''}withdrawn: ${p.title}`); }
  for (const q of i.openQuestions) { deciders.push({ role: q.assigneeRole, reason: `answer ${q.key}`, room: q.room, blocking: q.blocking }); if (q.room) notes.set(q.room, `${notes.has(q.room) ? `${notes.get(q.room)}; ` : ''}question ${q.key}`); }
  for (const a of i.impactedArtifacts) touched.add(a.department);
  const evidence = new Map<string, string[]>();
  for (const a of i.impactedArtifacts) evidence.set(a.department, [...(evidence.get(a.department) ?? []), a.key]);
  const affectedTeams = i.teams.map((t) => t.department).filter((d) => touched.has(d));
  const notInterrupted = i.teams.filter((t) => !touched.has(t.department) && !deciders.some((d) => t.roles.includes(d.role))).map((t) => t.department);
  return {
    rev: i.rev, affectedTeams, deciders, evidenceRequired: [...evidence.entries()].map(([department, artifacts]) => ({ department, artifacts })),
    blockingApprovals: blocking, carriedOver, staleActions, notifications: [...notes.entries()].map(([room, reason]) => ({ room, reason })), notInterrupted,
  };
}

import { useMemo } from 'react';

/** Editable table for an array of flat-ish objects. Columns come from the pack's sample change; cells are typed by the sample values. */
export function ArrayEditor({ name, value, onChange, template }: { name: string; value: any[]; onChange: (v: any[]) => void; template: any[] }) {
  const cols = useMemo(() => { const c: Record<string, any> = {}; for (const t of template) for (const [k, v] of Object.entries(t)) if (!(k in c) || c[k] === null) c[k] = v; return c; }, [template]);
  const keys = Object.keys(cols);
  const set = (i: number, k: string, raw: any) => { const next = value.map((r, j) => (j === i ? { ...r } : r)); if (raw === '' || raw === undefined) delete next[i][k]; else next[i][k] = raw; onChange(next); };
  const cell = (i: number, k: string) => {
    const sample = cols[k]; const v = value[i]?.[k];
    if (typeof sample === 'boolean') return <input type="checkbox" aria-label={`${name} ${i + 1} ${k}`} checked={!!v} onChange={(e) => set(i, k, e.target.checked)} />;
    if (typeof sample === 'number') return <input type="number" aria-label={`${name} ${i + 1} ${k}`} value={v ?? ''} onChange={(e) => set(i, k, e.target.value === '' ? undefined : Number(e.target.value))} />;
    if (sample && typeof sample === 'object') return <input aria-label={`${name} ${i + 1} ${k} (JSON)`} className="mono" defaultValue={v === undefined ? '' : JSON.stringify(v)} onBlur={(e) => { try { set(i, k, e.target.value ? JSON.parse(e.target.value) : undefined); } catch { alert(`${k}: invalid JSON`); } }} />;
    return <input aria-label={`${name} ${i + 1} ${k}`} value={v ?? ''} onChange={(e) => set(i, k, e.target.value)} />;
  };
  return <div className="table-wrap"><table><thead><tr>{keys.map((k) => <th key={k}>{k}</th>)}<th /></tr></thead><tbody>
    {value.map((_, i) => <tr key={i}>{keys.map((k) => <td key={k} style={{ minWidth: typeof cols[k] === 'number' ? 80 : 150 }}>{cell(i, k)}</td>)}<td><button type="button" className="sm" aria-label={`Remove ${name} row ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</button></td></tr>)}
  </tbody></table><button type="button" className="sm" style={{ margin: '6px 0' }} onClick={() => onChange([...value, Object.fromEntries(keys.filter((k) => typeof cols[k] !== 'object').map((k) => [k, typeof cols[k] === 'number' ? 0 : typeof cols[k] === 'boolean' ? false : '']).filter(([, v]) => v !== ''))])}>+ Add row</button></div>;
}
const isRows = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x));
export const isRowArray = isRows;

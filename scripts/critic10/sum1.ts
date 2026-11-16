// Tenth review (ported unchanged except for where it finds the build).
// @ts-nocheck (ported review tooling, kept as written)
import fs from 'node:fs';
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
const by = process.argv[3] ?? 'beh';
const keys = [...new Set(rows.map((r) => by.split('+').map((k) => r[k]).join('/')))];
const med = (xs: number[]) => xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : NaN; const p90 = (xs: number[]) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(0.9 * xs.length))] : NaN;
for (const k of keys) { const rs = rows.filter((r) => by.split('+').map((q) => r[q]).join('/') === k); const lat = rs.filter((r) => r.lat != null).map((r) => r.lat); const hc: Record<string, number> = {}; for (const r of rs) for (const h of r.hints ?? []) hc[h] = (hc[h] ?? 0) + 1;
  console.log(`${k.padEnd(26)} first ${String(rs.filter((r) => r.first).length).padStart(3)}/${rs.length}  premature ${rs.filter((r) => r.pre).length}  stuck ${rs.filter((r) => r.stuck).length}  BAD ${rs.filter((r) => r.bad).length}  lat med ${med(lat)} p90 ${p90(lat)}  hints ${JSON.stringify(hc)}`); }

// Eighth review (ported unchanged).
// Critic-8 probes: things that must NOT advance the session. usage: BUILD_DIR=... node probes8.ts <probe> [args]
import { Rig, rng, stringFor, knock, SR, type Env } from './rig8.ts';
import { sungMidi } from './sess8.ts';
import type { GOpts, VOpts } from './syn8.ts';
const [probe, ...args] = process.argv.slice(2);
const run = (rig: Rig, sec: number, until?: (v: any) => boolean) => { const end = rig.t + sec; let v = rig.s.view(); while (rig.t < end) { v = rig.step(); if (v.phase === 'done' || (until && until(v))) break; } return v; };
const out = (name: string, o: Record<string, unknown>) => console.log(`${(process.env.BUILD_DIR ?? '').split('/').pop()} ${name}: ` + Object.entries(o).map(([k, v]) => `${k} ${v}`).join(' | '));

// nothing but the room (TV, hum, reference tail): how many steps pass with no student sound at all?
function idle(name: string, env: Env, phase: 'sing' | 'play', N = 40, wait = 8) {
  const rig = new Rig({ ...env, settings: phase === 'sing' ? { skipGuitar: true, phraseReview: false } : { skipSing: true, phraseReview: false } }); rig.begin(0); let acc = 0; const det: string[] = [];
  for (let i = 0; i < N; i++) { let v = run(rig, 30, (q) => q.phase !== 'listen'); if (v.phase === 'done') break; const idx = v.index; v = run(rig, wait, (q) => q.index !== idx || q.phase === 'done'); if (v.index !== idx) { acc++; det.push(`#${idx + 1}:${rig.log[rig.log.length - 1].target}<-${(rig.s.lastAccepted?.detectedMidi ?? 0).toFixed(1)}`); } else rig.skip(); }
  out(name, { [`${phase} passed with no student`]: `${acc}/${N}`, det: det.slice(0, 8).join(' ') });
}
// student sings the answer and keeps holding it into the guitar step, never plucks
function hold(name: string, env: Env, vk: 'male' | 'female' | 'child', vo: Partial<VOpts>, N = 50, holdSec = 3, lvl = -20) {
  const rig = new Rig({ ...env, settings: { phraseReview: false } }); rig.begin(0); let acc = 0, steps = 0; const r = rng(5); const det: string[] = [];
  for (let i = 0; i < N; i++) { let v = run(rig, 30, (q) => q.phase !== 'listen'); if (v.phase === 'done') break; const idx = v.index; const sm = sungMidi(v.targetMidi, vk);
    const ev = rig.sing({ midi: sm, dur: 9, seed: i + 3, cents: Math.round(20 * (r() - 0.5)), ...vo }, lvl + 4 * (r() - 0.5)); v = run(rig, 5, (q) => q.phase !== 'sing');
    if (v.phase !== 'play') { rig.stop(ev); run(rig, 0.5); rig.skip(); continue; }
    steps++; v = run(rig, holdSec, (q) => q.index !== idx || q.phase !== 'play'); rig.stop(ev, 80); if (v.index === idx && v.phase === 'play') v = run(rig, 2, (q) => q.index !== idx || q.phase !== 'play');
    if (v.index !== idx || v.phase !== 'play') { acc++; det.push(`#${idx + 1}`); } else rig.skip(); }
  out(name, { 'guitar step passed by the held voice': `${acc}/${steps}`, det: det.slice(0, 10).join(' ') });
}
// only wrong notes are plucked (3 per step)
function wrong(name: string, env: Env, g: Partial<GOpts>, off: number, cents: number, N = 40, review = false) {
  const rig = new Rig({ ...env, settings: { skipSing: true, phraseReview: false } }); rig.begin(0); let acc = 0, steps = 0; const r = rng(9); const det: string[] = [];
  for (let i = 0; i < N; i++) { let v = run(rig, 30, (q) => q.phase !== 'listen'); if (v.phase === 'done') break; const idx = v.index; const m = v.targetMidi + off; if (m < 40 || m > 76) { rig.skip(); continue; } steps++;
    for (let k = 0; k < 3; k++) { rig.pluck({ midi: m, cents: cents + Math.round(6 * (r() - 0.5)), seed: i * 3 + k, dur: 3, ...g }, -16 + 6 * r(), 0, false); v = run(rig, 1.3, (q) => q.index !== idx); if (v.index !== idx) break; }
    if (v.index !== idx) { acc++; det.push(`#${idx + 1}:${rig.log[rig.log.length - 1].target}`); } else rig.skip(); rig.damp(); }
  out(name, { [`wrong note (${off} st ${cents} c) accepted`]: `${acc}/${steps}`, det: det.slice(0, 10).join(' ') }); void review;
}
function knocks(name: string, env: Env, N = 40) {
  const rig = new Rig({ ...env, settings: { skipSing: true, phraseReview: false } }); rig.begin(0); let acc = 0;
  for (let i = 0; i < N; i++) { let v = run(rig, 30, (q) => q.phase !== 'listen'); if (v.phase === 'done') break; const idx = v.index; for (let k = 0; k < 5; k++) { rig.add(knock(i * 5 + k, k % 2 ? 'dread' : 'parlor'), -10, 'g', -1, -1); v = run(rig, 0.9, (q) => q.index !== idx); if (v.index !== idx) break; } if (v.index !== idx) acc++; else rig.skip(); }
  out(name, { 'guitar step passed by knocking on the body': `${acc}/${N}` });
}
// sung wrong pitch: off in cents from the target (or its octave)
function sungOff(name: string, env: Env, vk: 'male' | 'female' | 'child', vo: Partial<VOpts>, cents: number, N = 40) {
  const rig = new Rig({ ...env, settings: { skipGuitar: true, phraseReview: false } }); rig.begin(0); let acc = 0, steps = 0;
  for (let i = 0; i < N; i++) { let v = run(rig, 30, (q) => q.phase !== 'listen'); if (v.phase === 'done') break; const idx = v.index; const sm = sungMidi(v.targetMidi, vk); steps++;
    const ev = rig.sing({ midi: sm, dur: 3, seed: i + 3, cents, drift: 4, ...vo }, -20); v = run(rig, 3.4, (q) => q.index !== idx); rig.stop(ev); if (v.index !== idx) acc++; else { run(rig, 0.3); rig.skip(); } }
  out(name, { [`sung ${cents} c off accepted`]: `${acc}/${steps}` });
}
const base: Env = { room: 'bed', phone: 'pixel', spk: -22 };
if (probe === 'tv') { const lvl = Number(args[0] ?? -30); const fem = args[1] === 'f'; const room = args[2] ?? 'bed'; for (const ph of ['sing', 'play'] as const) idle(`TV ${lvl} dBFS ${fem ? 'female' : 'male'} ${room}`, { ...base, room, tvDb: lvl, tvFemale: fem, seed: Number(args[3] ?? 3) }, ph, 50, 8); }
else if (probe === 'quiet') { for (const [room, phone, spk] of [['bath', 'pixel', -10], ['kitchen', 'hum', -14], ['table', 'iphoneVP', -12], ['bed', 'budget', -16]] as const) for (const ph of ['sing', 'play'] as const) idle(`nobody there ${room}/${phone} spk ${spk}`, { room, phone, spk }, ph, 40, 6); }
else if (probe === 'hold') { const cases: [string, Env, 'male' | 'female' | 'child', Partial<VOpts>][] = [['male a bed', base, 'male', { vowel: 'a' }], ['female hum table/iphoneVP', { room: 'table', phone: 'iphoneVP', spk: -20 }, 'female', { vowel: 'm', tract: 1.17 }], ['child oo kitchen/budget', { room: 'kitchen', phone: 'budget', spk: -18 }, 'child', { vowel: 'u', tract: 1.35, tilt: 3 }], ['male o bath', { room: 'bath', phone: 'pixel', spk: -20 }, 'male', { vowel: 'o', vib: 25 }], ['male breathy oo airpods', { room: 'bed', phone: 'airpods', spk: null }, 'male', { vowel: 'u', tilt: 7, breath: 0.12 }]];
  const c = cases[Number(args[0])]; hold('held ' + c[0], c[1], c[2], c[3], 50, Number(args[1] ?? 3)); }
else if (probe === 'wrong') { const [room, kind, off, cents] = args; wrong(`${kind} ${room}`, { ...base, room, phone: args[4] ?? 'pixel' }, { kind: kind as any, pluck: kind === 'nylon' ? 'finger' : 'pick' }, Number(off), Number(cents ?? 0), 45); }
else if (probe === 'knock') { for (const room of ['bed', 'kitchen']) knocks('knock ' + room, { ...base, room }); }
else if (probe === 'sungoff') { const [c, vk] = args; sungOff(`${vk ?? 'male'} bed`, base, (vk ?? 'male') as any, vk === 'female' ? { tract: 1.17 } : {}, Number(c)); }
void stringFor; void SR;

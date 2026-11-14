// Ported from the sixth external review (read-only original), kept as a permanent test.
// Honest-student sessions in rooms with speaker leak, phone chains and beginner habits.
import { honest, report, type Style, type Env } from './rig6.ts';
export const R6 = {
  dry: { rt: 0.3, drrG: 10 },
  living: { rt: 0.5, drrG: 2, taps: [[0.35, 0.8], [1.4, 0.55], [7.3, 0.45], [13.1, 0.35]] },   // phone propped on a table, 1 m away
  live: { rt: 0.8, drrG: -4, taps: [[1.7, 0.7], [5.9, 0.5], [17.3, 0.4]] },                      // bare room, phone on a music stand
  bath: { rt: 1.3, drrG: -6, taps: [[0.9, 0.8], [3.1, 0.6], [9.7, 0.5]] },                       // tiled/stairwell
  comb: { rt: 0.45, drrG: 4, taps: [[1.5, 0.85]] },                                               // one strong floor/desk reflection: notches at 333, 1000 Hz ...
} as Record<string, NonNullable<Env['room']>>;
const SPK = { db: -10 };
const hm = (_m: number, r: () => number) => ({ vowel: 'm', onset: 'soft' as const, dur: 0.3 + 0.6 * r(), fadeDbS: 8 + 17 * r() });
const la = (_m: number, r: () => number) => ({ vowel: ['a', 'o', 'u'][Math.floor(r() * 3)], onset: (['l', 'd', 'normal'] as const)[Math.floor(r() * 3)], dur: 0.25 + 0.4 * r(), fadeDbS: 15 * r(), release: 0.08 });
const held = (_m: number, r: () => number) => ({ vowel: 'm', onset: 'soft' as const, dur: 1 + r(), fadeDbS: 0 });
export const STY: Record<string, Style> = {
  H1_living_pick: { name: 'H1 pick steel, living room, spk leak', env: { seed: 61, room: R6.living, spk: SPK } },
  H2_live_finger: { name: 'H2 finger steel, live room RT0.8 DRR-4', env: { seed: 62, room: R6.live, spk: SPK }, g: () => ({ pluck: 'finger' }), v: (_m, r) => ({ vowel: 'o', vibCents: 25 * r(), onset: 'soft' }) },
  H3_bath_pick: { name: 'H3 pick, tiled room RT1.3 DRR-6', env: { seed: 63, room: R6.bath, spk: SPK }, v: () => ({ vowel: 'a', onset: 'l' }) },
  H4_nylon_thumb: { name: 'H4 nylon thumb, living', env: { seed: 64, room: R6.living, spk: SPK }, g: () => ({ pluck: 'thumb', kind: 'nylon' }), gLevel: [-24, -16], v: () => ({ vowel: 'm' }) },
  H5_chain_all: { name: 'H5 pick, living, HP180 LP7k NS AGC AEC', env: { seed: 65, room: R6.living, spk: SPK, hpHz: 180, lpHz: 7000, ns: { creepDbS: 12, floorDb: -15, beta: 2.5 }, agc: { upDbS: 5, downDbS: 60, target: -20, max: 20 }, aec: true }, female: true, v: () => ({ vowel: 'a', vibCents: 15 }) },
  H6_agc_only: { name: 'H6 finger+pick, living, AGC slow release only', env: { seed: 66, room: R6.living, spk: SPK, agc: { upDbS: 5, downDbS: 60, target: -20, max: 20 } }, g: (_m, r) => ({ pluck: r() < 0.5 ? 'pick' : 'finger' }) },
  H6b_ns_only: { name: 'H6b pick, living, NS only (constraint ignored)', env: { seed: 67, room: R6.living, spk: SPK, ns: { creepDbS: 12, floorDb: -15, beta: 2.5 } } },
  H8_sloppy: { name: 'H8 old strings sharp fretting buzz slide dbl open', env: { seed: 68, room: R6.living, spk: SPK }, g: (_m, r) => ({ age: 'old', pluck: (['pick', 'finger', 'thumb', 'nail'] as const)[Math.floor(r() * 4)] }), cents: (_m, r) => 5 + 22 * r(), buzz: 0.25, slideIn: 0.2, doublePluck: 0.2, openNeighbour: 0.15, ring: true },
  H9_singalong_ring: { name: 'H9 sings along with tone, strings ring, thinks', env: { seed: 69, room: R6.living, spk: SPK }, singAlong: 0.6, ring: true, think: [0.5, 3], hold: [0.05, 1.2], pause: [-0.3, 1.5], g: () => ({ t60x: 1.6 }) },
  H10_comb: { name: 'H10 pick, strong 1.5 ms reflection (comb)', env: { seed: 70, room: R6.comb, spk: SPK } },
  H11_bright_bridge: { name: 'H11 new strings, hard pick near bridge', env: { seed: 71, room: R6.living, spk: SPK }, g: (_m, r) => ({ age: 'new', pluck: 'hardpick', beta: 0.04 + 0.04 * r() }), gLevel: [-10, -5] },
  H12_far_quiet: { name: 'H12 soft thumb, far (DRR -4), quiet voice', env: { seed: 72, room: R6.live, spk: SPK, floorDb: -56 }, g: () => ({ pluck: 'thumb' }), gLevel: [-30, -22], vLevel: [-36, -30], v: () => ({ vowel: 'u', onset: 'soft', breath: 0.05 }) },
  B1_hum_dying: { name: 'B1 hunt-hum "hm" dying 100%, living', env: { seed: 81, room: R6.living, spk: SPK }, huntHum: 1, hum: hm },
  B1d_hum_dying_dry: { name: 'B1d hunt-hum "hm" dying 100%, dry', env: { seed: 82, room: R6.dry, spk: SPK }, huntHum: 1, hum: hm },
  B1l_hum_dying_live: { name: 'B1l hunt-hum "hm" dying 100%, live', env: { seed: 83, room: R6.live, spk: SPK }, huntHum: 1, hum: hm },
  B2_la_short: { name: 'B2 hunt "la/da/ah" short 100%, living', env: { seed: 84, room: R6.living, spk: SPK }, huntHum: 1, hum: la, humLevel: [-32, -24] },
  B2l_la_short_live: { name: 'B2l hunt "la/da/ah" short 100%, live', env: { seed: 85, room: R6.live, spk: SPK }, huntHum: 1, hum: la, humLevel: [-32, -24] },
  B3_hum_held: { name: 'B3 hunt-hum held 1-2 s 100%, living', env: { seed: 86, room: R6.living, spk: SPK }, huntHum: 1, hum: held },
  B3b_hum_held_bath: { name: 'B3b hunt-hum held 1-2 s 100%, tiled', env: { seed: 87, room: R6.bath, spk: SPK }, huntHum: 1, hum: held },
  B4_wrong_first: { name: 'B4 wrong note first 100%, living', env: { seed: 88, room: R6.living, spk: SPK }, wrongFirst: 1, ring: true },
  B4s_wrong_first_sharp: { name: 'B4s wrong first, strings +15..35 c, hard pick', env: { seed: 89, room: R6.living, spk: SPK }, wrongFirst: 1, ring: true, cents: (_m, r) => 15 + 20 * r(), g: () => ({ pluck: 'hardpick' }), gLevel: [-10, -5] },
  B5_noises_ring: { name: 'B5 thump/squeak/talk, strings ring', env: { seed: 90, room: R6.living, spk: SPK }, thump: 0.5, squeak: 0.4, talk: 0.5, ring: true, reviewNoise: 0.5, g: () => ({ t60x: 1.6 }) },
  B6_beginner: { name: 'B6 realistic beginner mix, living', env: { seed: 91, room: R6.living, spk: SPK }, huntHum: 0.35, hum: (m, r) => (r() < 0.6 ? hm(m, r) : la(m, r)), wrongFirst: 0.3, doublePluck: 0.15, slideIn: 0.1, buzz: 0.15, thump: 0.15, squeak: 0.15, talk: 0.2, singAlong: 0.2, ring: true, openNeighbour: 0.1, think: [0.4, 2], hold: [0.05, 1.0], pause: [0, 1.5], cents: (_m, r) => 18 * r(), g: (_m, r) => ({ pluck: (['pick', 'finger', 'thumb'] as const)[Math.floor(r() * 3)] }) },
  B6l_beginner_live: { name: 'B6l realistic beginner mix, live room', env: { seed: 92, room: R6.live, spk: SPK }, huntHum: 0.35, hum: (m, r) => (r() < 0.6 ? hm(m, r) : la(m, r)), wrongFirst: 0.3, doublePluck: 0.15, slideIn: 0.1, buzz: 0.15, thump: 0.15, squeak: 0.15, talk: 0.2, singAlong: 0.2, ring: true, openNeighbour: 0.1, think: [0.4, 2], hold: [0.05, 1.0], pause: [0, 1.5], cents: (_m, r) => 18 * r(), g: (_m, r) => ({ pluck: (['pick', 'finger', 'thumb'] as const)[Math.floor(r() * 3)] }) },
  B6c_beginner_chain: { name: 'B6c realistic beginner mix, AGC+NS+HP', env: { seed: 93, room: R6.living, spk: SPK, hpHz: 150, ns: { creepDbS: 12, floorDb: -15, beta: 2.5 }, agc: { upDbS: 5, downDbS: 60, target: -20, max: 20 } }, female: true, huntHum: 0.35, hum: (m, r) => (r() < 0.6 ? hm(m, r) : la(m, r)), wrongFirst: 0.3, doublePluck: 0.15, slideIn: 0.1, buzz: 0.15, thump: 0.15, squeak: 0.15, talk: 0.2, singAlong: 0.2, ring: true, openNeighbour: 0.1, think: [0.4, 2], hold: [0.05, 1.0], pause: [0, 1.5], cents: (_m, r) => 18 * r(), g: (_m, r) => ({ pluck: (['pick', 'finger', 'thumb'] as const)[Math.floor(r() * 3)] }) },
  I_pluck_while_singing: { name: 'I plucks while still singing', env: { seed: 98, room: R6.living, spk: SPK }, hold: [1.5, 2.5], pause: [-2.2, -0.4], g: (_m, r) => ({ pluck: r() < 0.5 ? 'pick' : 'finger' }) },
  S1_strict_living: { name: 'S1 STRICT on, pick, living', env: { seed: 95, room: R6.living, spk: SPK, settings: { strictCheck: true } } },
  S2_strict_dry: { name: 'S2 STRICT on, pick, dry', env: { seed: 96, room: R6.dry, spk: SPK, settings: { strictCheck: true } } },
  T1_thin_voice: { name: 'T1 thin voice (weak fundamental "ah"), living', env: { seed: 61, room: R6.living, spk: SPK }, v: () => ({ vowel: 'a', thin: true }) },
  K1_key: { name: 'K1 key cue on, pick, living', env: { seed: 97, room: R6.living, spk: SPK, settings: { playKeyAtStart: true } }, v: (_m, r) => ({ vibCents: 12 * r() }) },
};

if (process.argv[1]?.endsWith('cases6.ts')) {
  for (const n of (process.env.STYLE ?? Object.keys(STY).join(',')).split(',')) { const st = STY[n]; if (process.env.N) st.maxNotes = Number(process.env.N); const t0 = Date.now(); report(honest(st), t0); }
}

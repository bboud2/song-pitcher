// Ported from the fifth external review (read-only original), kept as a permanent test.
// Honest-student sessions in rooms (first pluck / re-plucks / stuck / accidental advances).
import { honest, line, type Style } from './rig5.ts';

export const STY: Record<string, Style> = {
  A_pick_dry: { name: 'A pick steel, near/dry, quiet', env: { seed: 21, room: { drr: 8, rt: 0.35 } } },
  B_finger_room0: { name: 'B finger steel, 1 m room DRR 0', env: { seed: 22, room: { drr: 0, rt: 0.45 } }, g: () => ({ pluck: 'finger' }), v: (_m, r) => ({ vowel: 'o', vibCents: 25 * r(), onset: 'soft' }) },
  C_thumb_nylon_room0: { name: 'C thumb nylon, 1 m room DRR 0', env: { seed: 23, room: { drr: 0, rt: 0.45 } }, g: () => ({ pluck: 'thumb', kind: 'nylon' }), gLevel: [-24, -16], v: () => ({ vowel: 'm' }) },
  D_pick_liveroom: { name: 'D pick steel, live room DRR -5', env: { seed: 24, room: { drr: -5, rt: 0.55 } }, v: () => ({ vowel: 'a', cons: 'l' }) },
  E_hardpick_sharp: { name: 'E hard pick, strings +15..30 c', env: { seed: 25, room: { drr: 6, rt: 0.35 } }, g: (_m, r) => ({ tm: 25 + 15 * r() }), cents: (_m, r) => 15 + 15 * r(), gLevel: [-10, -5], ring: true },
  F_nylon_phonechain: { name: 'F finger nylon, hp150 lp7k NS AGC', env: { seed: 26, room: { drr: 3, rt: 0.4 }, hpHz: 150, lpHz: 7000, ns: true, agc: { downDbS: 80, upDbS: 4, target: -18, max: 18 } }, g: () => ({ pluck: 'finger', kind: 'nylon' }), female: true, v: () => ({ vowel: 'a', vibCents: 20 }) },
  G_ring_think: { name: 'G pick, ring, thinks 2-6 s, AGC', env: { seed: 27, room: { drr: 3, rt: 0.4 }, agc: { downDbS: 60, upDbS: 6, target: -20, max: 20 } }, ring: true, think: [2, 6], noteDur: 9, female: true, v: () => ({ vowel: 'u' }), g: () => ({ t60x: 2 }) },
  H_thumb_soft_fan: { name: 'H soft thumb steel, fan, quiet play', env: { seed: 28, room: { drr: 3, rt: 0.4 }, fanDb: -52, floorDb: -58 }, g: () => ({ pluck: 'thumb' }), gLevel: [-30, -22], vLevel: [-34, -28], v: () => ({ vowel: 'o', onset: 'breathy' }) },
  I_pluck_while_singing: { name: 'I plucks while still singing', env: { seed: 29, room: { drr: 3, rt: 0.4 } }, hold: [1.5, 2.5], pause: [-2.2, -0.4], g: (_m, r) => ({ pluck: r() < 0.5 ? 'pick' : 'finger' }) },
  J_mute_mixed: { name: 'J mixed pluck styles, 30% palm mute, ring', env: { seed: 30, room: { drr: 0, rt: 0.5 }, hpHz: 120 }, ring: true, g: (_m, r) => ({ pluck: (['pick', 'nail', 'finger', 'thumb'] as const)[Math.floor(r() * 4)], mute: r() < 0.3 }), v: (_m, r) => ({ vowel: (['a', 'i', 'u', 'o', 'e', 'm'] as const)[Math.floor(r() * 6)], onset: r() < 0.3 ? 'hard' : 'normal', vibCents: 30 * r() }) },
  K_far_room: { name: 'K pick steel, phone 2-3 m DRR -9', env: { seed: 31, room: { drr: -9, rt: 0.6 } }, gLevel: [-24, -18], vLevel: [-34, -28] },
  M_strict_anech: { name: 'M anechoic pick, STRICT check on', env: { seed: 33, room: null, settings: { strictCheck: true } }, v: (_m, r) => ({ vibCents: 20 * r() }) },
  N_exact25_anech: { name: 'N anechoic, exact octave, +-25 c', env: { seed: 34, room: null, settings: { singExactOctave: true, singTolerance: 25 } }, v: (_m, r) => ({ vibCents: 20 * r(), drift: 4 }) },
  O_anech_base: { name: 'O anechoic pick baseline (default)', env: { seed: 35, room: null } },
  P_anech_t60x2_room: { name: 'P pick, long sustain x2, DRR +4', env: { seed: 36, room: { drr: 4, rt: 0.4 } }, g: () => ({ t60x: 2 }) },
  L_ring_think_noagc: { name: 'L pick, ring, thinks 2-6 s', env: { seed: 32, room: { drr: 3, rt: 0.4 } }, ring: true, think: [2, 6], noteDur: 9, g: () => ({ t60x: 2 }) },
};

if (process.argv[1]?.endsWith('cases5.ts')) {
  for (const n of (process.env.STYLE ?? Object.keys(STY).join(',')).split(',')) {
    const st = STY[n]; if (process.env.N) st.maxNotes = Number(process.env.N);
    const r = honest(st);
    console.log(line(r)); for (const b of r.bad.slice(0, 12)) console.log(`   BAD note ${b.index + 1} ${b.phase}${b.pos >= 0 ? ' pos ' + b.pos : ''} target ${b.target}: ${b.why}`);
    console.log('   stuck:', r.stuckAt.join(' ') || '-');
  }
}

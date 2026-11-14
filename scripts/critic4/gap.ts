// Ported from the fourth external review (read-only original), kept as a permanent test.
// How soon after the sung answer ends may an honest student pluck? (baritone: sings in the guitar's octave up to B3)
import { student } from './rig4.ts';
for (const [gl, g] of [['guitar peak -20 dBFS', { peakDb: -20 }], ['guitar peak -10 dBFS, long sustain 3 dB/s', { peakDb: -10, decay: 3 }]] as const)
  for (const vdb of [-18, -30])
    for (const gap of [-0.25, 0, 0.05, 0.1, 0.2, 0.4, 0.8]) {
      const hold = 0.3; const pause = hold + 0.09 + gap;
      const r = student({ name: 'gap', lo: 48, hold: [hold, hold], pause: [pause, pause], g, v: { levelDb: vdb }, maxNotes: 50, noReview: true });
      console.log(`${gl}; voice ${vdb} dBFS; pluck ${gap >= 0 ? `${(gap * 1000).toFixed(0)} ms after the voice has faded` : `${(-gap * 1000).toFixed(0)} ms before the voice stops`}: first pluck ok ${r.total - r.needPluck - r.stuckPlay}/${r.total}, needed re-pluck ${r.needPluck}, STUCK after 4 plucks ${r.stuckPlay}, accidental ${r.accidental.length}; false "stop singing" frames ${r.falseHints['play:"stop singing" while nobody sings'] ?? 0}`);
    }

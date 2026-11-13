// Horizontal cents meter: needle, in-tolerance zone, flat/sharp readout.
import { h } from './dom.ts';

export interface MeterHandle {
  el: HTMLElement;
  /** cents = null → no pitch. tolerance = green zone half-width. */
  set(cents: number | null, tolerance: number, opts?: { label?: string; idle?: string }): void;
}

/** Meter half-width in cents: twice the tolerance (at least ±50), so the green zone is the middle half. */
const rangeFor = (tolerance: number) => Math.max(50, tolerance * 2);

export function createMeter(): MeterHandle {
  const zone = h('div', { class: 'meter-zone' });
  const needle = h('div', { class: 'meter-needle' });
  const ticks = h('div', { class: 'meter-ticks' });
  for (const c of [-1, -0.5, 0, 0.5, 1]) {
    ticks.append(h('span', { class: 'meter-tick', style: { left: `${50 + c * 50}%` }, attrs: { 'data-c': c } }));
  }
  const track = h('div', { class: 'meter-track' }, zone, ticks, needle);
  const readout = h('div', { class: 'meter-readout', attrs: { 'aria-live': 'polite' } });
  const ends = h('div', { class: 'meter-ends' }, h('span', { text: '♭ flat' }), h('span', { text: 'sharp ♯' }));
  const el = h('div', { class: 'meter', attrs: { 'data-testid': 'meter' } }, track, ends, readout);

  return {
    el,
    set(cents, tolerance, opts = {}) {
      const RANGE = rangeFor(tolerance);
      zone.style.left = `${50 - (tolerance / RANGE) * 50}%`;
      zone.style.width = `${(tolerance / RANGE) * 100}%`;
      if (cents === null) {
        needle.style.opacity = '0';
        el.dataset.state = 'idle';
        readout.textContent = opts.idle ?? 'Waiting for sound…';
        return;
      }
      const clamped = Math.max(-RANGE, Math.min(RANGE, cents));
      needle.style.opacity = '1';
      needle.style.left = `${50 + (clamped / RANGE) * 50}%`;
      const inTol = Math.abs(cents) <= tolerance;
      el.dataset.state = inTol ? 'ok' : Math.abs(cents) > RANGE ? 'far' : 'near';
      const c = Math.round(cents);
      let txt: string;
      if (Math.abs(cents) > 150) txt = cents < 0 ? 'Too low — go up' : 'Too high — go down';
      else if (inTol) txt = Math.abs(c) <= 5 ? 'In tune' : `${Math.abs(c)}¢ ${c < 0 ? 'flat' : 'sharp'} — OK`;
      else txt = `${Math.abs(c)}¢ ${c < 0 ? 'flat — go up' : 'sharp — go down'}`;
      readout.textContent = opts.label ? `${opts.label} · ${txt}` : txt;
    },
  };
}

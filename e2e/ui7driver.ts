// Seventh review's UI driver (ported): the built app (dist/) in Chromium. Reactive fake microphone fed with critic-7 audio
// (lumped-chain guitar, Hopf voice) convolved with the modal room; the app's loudspeaker output leaks into the mic.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck (ported review tooling, kept as written)
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { G, V, IR, ROOMS, sungMidi, rng, SR, OPEN } from '../scripts/critic7/rig7.ts';
import { wet, guitar } from '../scripts/critic7/syn7.ts';
const require = createRequire(import.meta.url);
export const pw = require(join(execSync('npm root -g').toString().trim(), 'playwright'));
export const HERE = import.meta.dirname; export const PORT = Number(process.env.PORT ?? 4391); export const URL = `http://localhost:${PORT}/`;
export const OUT = join(HERE, 'out', 'long'); mkdirSync(OUT, { recursive: true });
const SONGS = await import('../src/core/songs.ts');
export const midis: number[] = SONGS.STAR_SPANGLED_BANNER.notes.map((q: any) => 48 + q.offset);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const INIT = `(() => {
  const st = { ctx: null, dest: null, bufs: {}, live: [], log: [], leak: window.__leakGain ?? 0.08 };
  const origConnect = AudioNode.prototype.connect; const RealAC = window.AudioContext;
  function ensure() {
    if (st.ctx) return; st.ctx = new RealAC({ sampleRate: 48000 }); st.dest = st.ctx.createMediaStreamDestination();
    const nb = st.ctx.createBuffer(1, 48000 * 7, 48000); const d = nb.getChannelData(0); let b = 0, c = 0;
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; c = 0.75 * c + 0.25 * w; d[i] = (b * 2.6 + c * 0.9 + 0.3 * w) * 0.0017; }
    const ns = st.ctx.createBufferSource(); ns.buffer = nb; ns.loop = true; st.noise = st.ctx.createGain(); st.noise.gain.value = window.__noiseGain ?? 1; origConnect.call(ns, st.noise); origConnect.call(st.noise, st.dest); ns.start();
  }
  AudioNode.prototype.connect = function (dst, ...a) {
    if (dst instanceof AudioDestinationNode && this.context !== st.ctx && st.leak > 0) {
      const c = this.context;
      if (!c.__tap) { ensure(); c.__tap = c.createMediaStreamDestination(); const src = st.ctx.createMediaStreamSource(c.__tap.stream); const hp = st.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 450; const g = st.ctx.createGain(); g.gain.value = st.leak; origConnect.call(src, hp); origConnect.call(hp, g); origConnect.call(g, st.dest); st.leakOn = true; }
      origConnect.call(this, c.__tap);
    }
    return origConnect.call(this, dst, ...a);
  };
  navigator.mediaDevices.getUserMedia = async (c) => { ensure(); window.__gumConstraints = c; await st.ctx.resume(); return st.dest.stream; };
  const dec = (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); const f = new Float32Array(u8.buffer); const ab = st.ctx.createBuffer(1, f.length, 48000); ab.copyToChannel(f, 0); return ab; };
  window.__mic = {
    load(name, b64) { ensure(); st.bufs[name] = dec(b64); },
    play(name, gainDb, tag) { const s = st.ctx.createBufferSource(); s.buffer = st.bufs[name]; const g = st.ctx.createGain(); g.gain.value = Math.pow(10, gainDb / 20); origConnect.call(s, g); origConnect.call(g, st.dest); s.start(); st.live.push({ s, g, tag }); return performance.now(); },
    stop(tag, fadeMs) { for (const h of st.live.filter((x) => x.tag === tag)) { h.g.gain.setTargetAtTime(0, st.ctx.currentTime, fadeMs / 3000); try { h.s.stop(st.ctx.currentTime + fadeMs / 500); } catch {} } st.live = st.live.filter((x) => x.tag !== tag); },
    noise(g) { ensure(); st.noise.gain.value = g; }, leakOn() { return !!st.leakOn; }, has(n) { return !!st.bufs[n]; },
  };
  let last = '';
  const samp = () => { const el = document.querySelector('[data-testid="session"]'); const k = el ? el.getAttribute('data-phase') + '|' + el.getAttribute('data-index') + '|' + el.getAttribute('data-review-pos') : 'none'; if (k !== last) { last = k; st.log.push([performance.now(), k]); } };
  const ch = new MessageChannel(); ch.port1.onmessage = () => { samp(); }; setInterval(() => ch.port2.postMessage(0), 4);
  window.__state = () => { samp(); return { k: last, t: performance.now(), since: st.log.length ? st.log[st.log.length - 1][0] : 0, status: document.querySelector('[data-testid="status"]')?.textContent ?? '', cap: window.__songPitcherCapture, rec: !!document.querySelector('[data-testid="rec-badge"]') }; };
  // capture what the app hands to the share sheet (when a test turns the share path on)
  window.__shared = [];
  if (window.__fakeShare) { navigator.canShare = (d) => true; navigator.share = async (d) => { for (const f of d.files) { const b = new Uint8Array(await f.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768)); window.__shared.push({ name: f.name, type: f.type, b64: btoa(s) }); } }; }
})();`;
export async function server(dir = join(HERE, '..')) {
  // (a server already answering on the port was not started here and may serve another build: refuse it)
  if (await fetch(URL).then(() => true, () => false)) throw new Error(`port ${PORT} is already in use by a server this run did not start; stop it and run again`);
  const p = spawn('node', [join(dir, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { cwd: dir, stdio: 'ignore' });
  let exited = false; p.on('exit', () => (exited = true));
  for (let i = 0; i < 60; i++) { if (exited) throw new Error('preview server exited before answering'); try { const r = await fetch(URL); if (r.ok) return p; } catch { /* */ } await sleep(200); }
  throw new Error('server did not start');
}
export const b64 = (f: Float32Array) => Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
export function audioSet(room: string, gExtra: any = {}, vExtra: any = {}) {
  const R = ROOMS[room]; const irG = R ? IR(R.g) : null, irV = R ? IR(R.v) : null; const o: Record<string, string> = {}; const uniq = [...new Set(midis)].sort((a, b) => a - b);
  for (const m of uniq) { for (let k = 0; k < 2; k++) o[`g${m}_${k}`] = b64(wet(G({ midi: m, seed: m * 5 + k, dur: 3, cents: k ? 7 : -3, kind: 'steel', pluck: 'pick', ...gExtra }).main, irG, 1.2)); const sm = sungMidi(m); o[`v${m}`] = b64(wet(V({ midi: sm, dur: 4.5, seed: m, scoop: 20, vowel: 'o', ...vExtra }), irV, 1.2)); }
  OPEN.forEach((m) => { o[`open${m}`] = b64(wet(G({ midi: m, seed: 9, dur: 3, cents: 6 }).main, irG, 1.2)); });
  return o;
}
export async function launch(extraArgs: string[] = []) { return pw.chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', ...extraArgs] }); }
export const VIEW: Record<string, any> = { se320: { viewport: { width: 320, height: 568 } }, i375: { viewport: { width: 375, height: 667 } }, iphone13: { viewport: pw.devices['iPhone 13'].viewport }, pixel7: { viewport: pw.devices['Pixel 7'].viewport } };
export async function page(browser: any, view: string, extraInit = '', settings: Record<string, unknown> | null = null, useInit = true) {
  const ctx = await browser.newContext({ ...VIEW[view], deviceScaleFactor: 1, isMobile: true, hasTouch: true, userAgent: pw.devices['Pixel 7'].userAgent, acceptDownloads: true });
  await ctx.grantPermissions(['microphone'], { origin: URL }).catch(() => {});
  const p = await ctx.newPage(); const errors: string[] = []; const requests: string[] = []; const downloads: any[] = [];
  p.on('pageerror', (e: Error) => errors.push('pageerror ' + e.message)); p.on('console', (m: any) => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  p.on('request', (r: any) => requests.push(`${r.method()} ${r.url()}`)); p.on('download', (d: any) => downloads.push(d));
  await p.addInitScript(extraInit + (useInit ? INIT : '')); await p.goto(URL);
  if (settings) { await p.evaluate((s: any) => { const cur = JSON.parse(localStorage.getItem('songPitcher.v1') ?? '{}'); cur.settings = { ...(cur.settings ?? {}), ...s }; localStorage.setItem('songPitcher.v1', JSON.stringify(cur)); }, settings); await p.reload(); }
  await p.waitForSelector('[data-testid="home"]');
  return { p, errors, ctx, requests, downloads };
}
export const state = (p: any) => p.evaluate(() => (window as any).__state());
export const parse = (k: string) => { const [phase, index, pos] = k.split('|'); return { phase, index: Number(index), pos: Number(pos) }; };
export async function waitFor(p: any, pred: (s: ReturnType<typeof parse>) => boolean, ms: number) { const end = Date.now() + ms; let s = await state(p); while (Date.now() < end) { if (pred(parse(s.k))) return { ok: true, s }; await sleep(20); s = await state(p); } return { ok: pred(parse(s.k)), s }; }
export async function loadAll(p: any, bufs: Record<string, string>) { for (const [k, v] of Object.entries(bufs)) await p.evaluate(([a, b]: string[]) => (window as any).__mic.load(a, b), [k, v]); }
export const mic = (p: any, fn: string, ...a: any[]) => p.evaluate(([f, args]: any) => (window as any).__mic[f](...args), [fn, a]);
export async function toTuner(p: any, bufs: Record<string, string>) { await p.click('[data-testid="start"]'); await p.waitForSelector('[data-testid="tuner"]'); await loadAll(p, bufs); }
export async function toSession(p: any, bufs: Record<string, string>) {
  await toTuner(p, bufs); await sleep(2500); await mic(p, 'play', 'g55_0', -14, 'g');
  await p.waitForSelector('[data-testid="begin"]:not([disabled])', { timeout: 15000 }); await sleep(1500); await p.click('[data-testid="begin"]'); await p.waitForSelector('[data-testid="session"]');
}
export interface Stats { play: number; first: number; repl: number; stuck: number; early: number; sing: number; singFirst: number; singStuck: number; rev: number; revFirst: number; revStuck: number; lat: number[]; revLat: number[]; singLat: number[]; odd: string[]; cap: string; recSeen: boolean }
export interface Hooks { beforeNote?: (idx: number, p: any) => Promise<'skip' | void>; inPlay?: (idx: number, p: any) => Promise<void> }
export async function runSession(p: any, maxNotes: number, seed = 1, label = '', hooks: Hooks = {}): Promise<Stats> {
  const r = rng(seed); const u = (a: number, b: number) => a + (b - a) * r();
  const S: Stats = { play: 0, first: 0, repl: 0, stuck: 0, early: 0, sing: 0, singFirst: 0, singStuck: 0, rev: 0, revFirst: 0, revStuck: 0, lat: [], revLat: [], singLat: [], odd: [], cap: '', recSeen: false };
  const lastChange = async () => (await state(p)).since as number; let done = 0; const hooked = new Set<number>();
  for (;;) {
    let w = await waitFor(p, (s) => s.phase !== 'listen', 60000); let s = parse(w.s.k); S.cap = w.s.cap; S.recSeen ||= w.s.rec;
    if (s.phase === 'none' || done >= maxNotes) break;
    const idx = s.index; const target = midis[idx];
    if (hooks.beforeNote && (await hooks.beforeNote(idx, p)) === 'skip') { done++; continue; }
    s = parse((await state(p)).k); if (s.phase === 'listen') { w = await waitFor(p, (q) => q.phase !== 'listen', 60000); s = parse(w.s.k); }
    if (s.phase === 'sing' && s.index === idx) {
      S.sing++; await sleep(u(400, 900)); let ok = parse((await state(p)).k).phase !== 'sing'; if (ok) S.odd.push(`sing #${idx + 1} advanced with NO voice`);
      for (let a = 0; a < 3 && !ok; a++) {
        const t0 = await mic(p, 'play', `v${target}`, -22, 'v');
        w = await waitFor(p, (q) => q.phase !== 'sing' || q.index !== idx, 4200);
        if (w.ok) { ok = true; if (a === 0) S.singFirst++; S.singLat.push((await lastChange()) - t0 - 80); } else { await mic(p, 'stop', 'v', 70); await sleep(800); }
      }
      if (!ok) { S.singStuck++; S.odd.push(`sing stuck #${idx + 1} status "${w.s.status}"`); await p.click('[data-testid="skip"]'); done++; continue; }
      await sleep(u(60, 400)); await mic(p, 'stop', 'v', 70);
    }
    s = parse((await state(p)).k);
    if (s.phase === 'play' && s.index === idx) {
      S.play++; if (hooks.inPlay && !hooked.has(idx)) { hooked.add(idx); await hooks.inPlay(idx, p); }
      await sleep(u(450, 1100)); let ok = parse((await state(p)).k).phase !== 'play'; if (ok) { S.early++; S.odd.push(`play #${idx + 1} advanced before any pluck`); }
      let k = 0;
      for (; k < 5 && !ok; k++) { const t0 = await mic(p, 'play', `g${target}_${k % 2}`, u(-18, -10), 'g' + target); w = await waitFor(p, (q) => q.index !== idx || q.phase === 'review' || q.phase === 'none', 2500); if (w.ok) { ok = true; if (k === 0) S.lat.push((await lastChange()) - t0 - 13); } }
      if (ok && k === 1) S.first++; if (ok && k > 1) S.repl += k - 1;
      if (!ok) { S.stuck++; S.odd.push(`play stuck #${idx + 1} (${target}) status "${w.s.status}"`); await p.click('[data-testid="skip"]'); done++; continue; }
    }
    s = parse((await state(p)).k);
    if (s.phase === 'listen') { w = await waitFor(p, (q) => q.phase !== 'listen', 30000); s = parse(w.s.k); }
    if (s.phase === 'review' && s.index === idx) {
      await sleep(u(500, 900)); let stuck = false; s = parse((await state(p)).k);
      while (s.phase === 'review' && s.index === idx && !stuck) {
        const pos = s.pos; const ph = SONGS.STAR_SPANGLED_BANNER.phrases.find((q: any) => q.end === idx); const tgt = midis[ph.start + pos]; S.rev++;
        let k = 0; let ok = false;
        for (; k < 5 && !ok; k++) { const t0 = await mic(p, 'play', `g${tgt}_${(pos + k) % 2}`, u(-18, -10), 'g' + tgt); w = await waitFor(p, (q) => !(q.phase === 'review' && q.index === idx && q.pos === pos), 2500); ok = w.ok; if (ok && k === 0) S.revLat.push((await lastChange()) - t0 - 13); }
        if (ok && k === 1) S.revFirst++;
        if (!ok) { S.revStuck++; S.odd.push(`review stuck #${idx + 1} pos ${pos}`); await p.click('[data-testid="skip"]'); stuck = true; break; }
        await sleep(u(380, 650)); s = parse((await state(p)).k);
      }
    }
    done++; if (done % 10 === 0) console.log(`  [${label}] ${done} notes: play ${S.first}/${S.play} first, +${S.repl}, ${S.stuck} stuck, ${S.early} early; sing ${S.singFirst}/${S.sing}; review ${S.revFirst}/${S.rev}, ${S.revStuck} stuck`);
  }
  return S;
}
export const med = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
export const pct = (xs: number[], q: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
export { existsSync, readFileSync, copyFileSync, writeFileSync, guitar };


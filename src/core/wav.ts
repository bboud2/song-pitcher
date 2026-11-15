// 16-bit PCM mono WAV encoding/decoding. Pure TypeScript, no DOM (used by the practice recorder
// in the browser and by scripts/replay.ts in Node).

/** Encode mono float samples (−1..1) as a 16-bit PCM WAV file. */
export function encodeWav(chunks: Float32Array[], sampleRate: number): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(44 + 2 * n);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + 2 * n, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, 2 * n, true);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const x = Math.max(-1, Math.min(1, c[i]));
      v.setInt16(o, Math.round(x < 0 ? x * 0x8000 : x * 0x7fff), true);
      o += 2;
    }
  }
  return out;
}

/** The 44-byte header of a 16-bit mono PCM WAV with `dataBytes` of samples, followed (after the
 * data) by `extraBytes` of further RIFF chunks. */
export function wavHeader(dataBytes: number, sampleRate: number, extraBytes = 0): Uint8Array {
  const out = new Uint8Array(44);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes + (dataBytes & 1) + extraBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  return out;
}

/** The id of the RIFF chunk that carries a recording's JSON log inside its WAV file. */
export const LOG_CHUNK = 'spjs';

/** A RIFF chunk (id, length, body, pad byte). */
export function riffChunk(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length + (body.length & 1));
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

/** The body of the first RIFF chunk called `id`, or null. */
export function readWavChunk(bytes: Uint8Array, id: string): Uint8Array | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let o = 12;
  while (o + 8 <= bytes.length) {
    const len = v.getUint32(o + 4, true);
    if (tag(o) === id) return bytes.subarray(o + 8, Math.min(bytes.length, o + 8 + len));
    o += 8 + len + (len & 1);
  }
  return null;
}

/** Decode a PCM WAV (8/16/24/32-bit integer or 32-bit float; channels are averaged to mono). */
export function decodeWav(bytes: Uint8Array): { sampleRate: number; samples: Float32Array; bits: number; channels: number; declaredFrames: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12;
  let fmt = 1;
  let ch = 1;
  let sr = 48000;
  let bits = 16;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    const len = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      fmt = v.getUint16(body, true);
      ch = v.getUint16(body + 2, true);
      sr = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
      if (fmt === 0xfffe) fmt = v.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      const bps = bits / 8;
      const frames = Math.floor(Math.min(len, bytes.length - body) / (bps * ch));
      const declaredFrames = Math.floor(len / (bps * ch));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < ch; c++) {
          const p = body + (i * ch + c) * bps;
          if (fmt === 3 && bits === 32) s += v.getFloat32(p, true);
          else if (bits === 16) s += v.getInt16(p, true) / 32768;
          else if (bits === 24) s += (((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)) << 8) >> 8) / 8388608;
          else if (bits === 32) s += v.getInt32(p, true) / 2147483648;
          else s += (bytes[p] - 128) / 128;
        }
        out[i] = s / ch;
      }
      return { sampleRate: sr, samples: out, bits, channels: ch, declaredFrames };
    }
    o = body + len + (len & 1);
  }
  throw new Error('WAV file has no data chunk');
}

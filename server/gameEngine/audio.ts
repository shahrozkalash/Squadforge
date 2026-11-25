/**
 * Phase 24: procedural sound effects — real PCM audio synthesized
 * in code (frequency sweeps / envelopes) and written as genuine WAV
 * files the generated games can ship. No samples, no placeholders.
 */

export interface WavInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  durationSec: number;
  dataBytes: number;
}

export function encodeWav(samples: Float32Array, sampleRate: number = 22050): Buffer {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

export function parseWav(buffer: Buffer): WavInfo {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataBytes = buffer.readUInt32LE(40);
  return { channels, sampleRate, bitsPerSample, dataBytes, durationSec: dataBytes / (sampleRate * channels * (bitsPerSample / 8)) };
}

function sweep(fromHz: number, toHz: number, durationSec: number, sampleRate: number, shape: 'sine' | 'square' = 'sine'): Float32Array {
  const count = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(count);
  let phase = 0;
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const freq = fromHz + (toHz - fromHz) * t;
    phase += (2 * Math.PI * freq) / sampleRate;
    const envelope = 1 - t; // linear decay
    const wave = shape === 'sine' ? Math.sin(phase) : Math.sign(Math.sin(phase)) * 0.6;
    out[i] = wave * envelope * 0.5;
  }
  return out;
}

/** Classic jump blip: rising sweep. */
export function jumpSound(sampleRate: number = 22050): Buffer {
  return encodeWav(sweep(300, 900, 0.15, sampleRate), sampleRate);
}

/** Coin chime: two-note ping (E6 -> B6-ish). */
export function coinSound(sampleRate: number = 22050): Buffer {
  const a = sweep(1318, 1318, 0.07, sampleRate);
  const b = sweep(1975, 1975, 0.18, sampleRate);
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return encodeWav(out, sampleRate);
}

/** Low thud for damage/death. */
export function hitSound(sampleRate: number = 22050): Buffer {
  return encodeWav(sweep(220, 55, 0.25, sampleRate, 'square'), sampleRate);
}

// PCM/WAV tests. The browser hands the host a WAV it produced itself, and a
// user may import a WAV file from anywhere, so the parser has to accept every
// encoding a recorder prunes to and reject malformed input loudly.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { parseWav, encodeWav, resample, peaks, rms, dbfs } from '../src/pcm.cjs'

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
}

// Minimal independent WAV writer for the formats parseWav must understand.
function makeWav(frames, options) {
  const opts = options || {}
  const channels = opts.channels || 1
  const sampleRate = opts.sampleRate || 16000
  const bits = opts.bits || 16
  const format = opts.format || 1
  const bytesPerSample = bits / 8
  const dataBytes = frames.length * channels * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, format, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bits, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  let at = 44
  for (const frame of frames) {
    const values = Array.isArray(frame) ? frame : [frame]
    for (const value of values) {
      if (format === 1 && bits === 8) {
        view.setUint8(at, Math.round((value * 0.5 + 0.5) * 255))
      } else if (format === 1 && bits === 16) {
        view.setInt16(at, Math.max(-32768, Math.min(32767, Math.round(value * 32768))), true)
      } else if (format === 1 && bits === 24) {
        const raw = Math.round(value * 8388608)
        view.setUint8(at, raw & 0xff)
        view.setUint8(at + 1, (raw >> 8) & 0xff)
        view.setUint8(at + 2, (raw >> 16) & 0xff)
      } else if (format === 1 && bits === 32) {
        view.setInt32(at, Math.round(value * 2147483648), true)
      } else if (format === 3 && bits === 32) {
        view.setFloat32(at, value, true)
      } else if (format === 3 && bits === 64) {
        view.setFloat64(at, value, true)
      } else {
        throw new Error('unsupported test encoding')
      }
      at += bytesPerSample
    }
  }
  return new Uint8Array(buffer)
}

function sine(seconds, sampleRate, frequency) {
  const count = Math.round(seconds * sampleRate)
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i += 1) samples[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.5
  return samples
}

test('encodeWav produces a canonical 16-bit mono header and parseWav reads it back', () => {
  const samples = sine(0.5, 16000, 440)
  const wav = encodeWav(samples, 16000)
  const parsed = parseWav(wav)
  assert.equal(parsed.sampleRate, 16000)
  assert.equal(parsed.channels, 1)
  assert.equal(parsed.bitsPerSample, 16)
  assert.equal(parsed.format, 1)
  assert.equal(parsed.samples.length, samples.length)
  assert.ok(Math.abs(parsed.durationSec - 0.5) < 0.001)
  assert.ok(Math.abs(parsed.samples[100] - samples[100]) < 0.001)
})

test('encodeWav resamples on the way in when resampleFrom differs', () => {
  const samples = sine(1, 44100, 440)
  const wav = encodeWav(samples, 16000, { resampleFrom: 44100 })
  const parsed = parseWav(wav)
  assert.equal(parsed.sampleRate, 16000)
  assert.equal(parsed.samples.length, 16000)
})

test('parseWav mixes stereo down to mono and keeps the original sample rate', () => {
  const frames = []
  for (let i = 0; i < 100; i += 1) frames.push([0.8, 0.2])
  const parsed = parseWav(makeWav(frames, { channels: 2, sampleRate: 8000 }))
  assert.equal(parsed.channels, 2)
  assert.equal(parsed.sampleRate, 8000)
  assert.equal(parsed.samples.length, 100)
  assert.ok(Math.abs(parsed.samples[0] - 0.5) < 0.002)
})

test('parseWav accepts 8-bit, 24-bit, 32-bit int and float PCM', () => {
  const formats = [
    { bits: 8 },
    { bits: 24 },
    { bits: 32 },
    { bits: 32, format: 3 },
    { bits: 64, format: 3 },
  ]
  for (const options of formats) {
    const wav = makeWav([0.25, -0.25, 0.5], options)
    const parsed = parseWav(wav)
    assert.equal(parsed.samples.length, 3, JSON.stringify(options))
    assert.ok(Math.abs(parsed.samples[0] - 0.25) < 0.01, JSON.stringify(options))
    assert.ok(Math.abs(parsed.samples[1] + 0.25) < 0.01, JSON.stringify(options))
  }
})

test('resample changes length proportionally and keeps a flat signal flat', () => {
  const flat = new Float32Array(4410).fill(0.25)
  const down = resample(flat, 44100, 16000)
  assert.equal(down.length, 1600)
  assert.ok(Math.abs(down[0] - 0.25) < 1e-6)
  const up = resample(flat, 16000, 48000)
  assert.equal(up.length, 13230)
  assert.ok(Math.abs(up[up.length - 1] - 0.25) < 1e-6)
})

test('peaks reports the min and max of each bucket', () => {
  const samples = new Float32Array([0, 0.5, -0.25, 1, -1, 0.2])
  const envelope = peaks(samples, 3)
  assert.equal(envelope.length, 3)
  assert.ok(Math.abs(envelope[0].max - 0.5) < 1e-6)
  assert.ok(Math.abs(envelope[0].min - 0) < 1e-6)
  assert.ok(Math.abs(envelope[1].max - 1) < 1e-6 && Math.abs(envelope[1].min + 0.25) < 1e-6)
  assert.ok(Math.abs(envelope[2].min + 1) < 1e-6)
  assert.ok(Math.abs(envelope[2].amplitude - 1) < 1e-6)
})

test('rms and dbfs describe loudness', () => {
  const quiet = new Float32Array(100).fill(0.01)
  const loud = new Float32Array(100).fill(0.5)
  assert.ok(dbfs(rms(loud, 0, 100)) > dbfs(rms(quiet, 0, 100)))
  assert.ok(dbfs(rms(loud, 0, 100)) > -10)
  assert.equal(dbfs(0), -96)
  assert.equal(rms(new Float32Array(0), 0, 0), 0)
})

test('parseWav rejects data that is not a complete WAV', () => {
  assert.throws(() => parseWav(new Uint8Array(10)), /shorter|RIFF/)
  assert.throws(() => parseWav(new Uint8Array(44)), /RIFF\/WAVE/)
  const truncated = encodeWav(sine(0.1, 16000, 300), 16000).subarray(0, 30)
  assert.throws(() => parseWav(truncated), /RIFF\/WAVE|shorter/)
})

test('parseWav rejects an unsupported encoding instead of guessing', () => {
  const wav = makeWav([0.1], { bits: 32, format: 3 })
  wav[20] = 7 // pretend it is mu-law
  assert.throws(() => parseWav(wav), /unsupported WAV encoding/)
})

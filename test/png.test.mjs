// PNG/waveform tests. The waveform is the visual evidence attached to a memo,
// so the bytes must be a real PNG and the rendering must show something for
// audio and nothing but the ruler for silence.

import { strict as assert } from 'node:assert'
import { inflateSync } from 'node:zlib'
import test from 'node:test'
import { encodePng, readPngHeader, renderWaveformPng } from '../src/png.js'

function pixelsOf(png) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let offset = 8
  while (offset + 12 <= png.length) {
    const size = view.getUint32(offset, false)
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7])
    if (type === 'IDAT') return inflateSync(png.subarray(offset + 8, offset + 8 + size))
    offset += 12 + size
  }
  throw new Error('PNG has no IDAT chunk')
}

function sine(seconds, sampleRate, frequency, amplitude) {
  const count = Math.round(seconds * sampleRate)
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i += 1) samples[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * (amplitude || 0.5)
  return samples
}

test('encodePng writes a valid RGBA PNG and round-trips its pixels', () => {
  const rgba = new Uint8Array([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 255, 0,
  ])
  const png = encodePng(2, 2, rgba)
  const header = readPngHeader(png)
  assert.equal(header.width, 2)
  assert.equal(header.height, 2)
  assert.equal(header.bitDepth, 8)
  assert.equal(header.colorType, 6)

  const raw = pixelsOf(png)
  assert.equal(raw[0], 0, 'first scanline uses filter None')
  assert.deepEqual(Array.from(raw.subarray(1, 5)), [255, 0, 0, 255])
  assert.deepEqual(Array.from(raw.subarray(5, 9)), [0, 255, 0, 255])
})

test('encodePng rejects mismatched buffers and bad dimensions', () => {
  assert.throws(() => encodePng(0, 10, new Uint8Array(0)), /positive integers/)
  assert.throws(() => encodePng(2, 2, new Uint8Array(4)), /length does not match/)
})

test('renderWaveformPng draws a wide transparent card with visible audio', () => {
  const samples = sine(2, 16000, 220, 0.6)
  const png = renderWaveformPng(samples, { width: 960, height: 220, durationSec: 2 })
  const header = readPngHeader(png)
  assert.equal(header.width, 960)
  assert.equal(header.height, 220)
  assert.equal(header.colorType, 6)

  const raw = pixelsOf(png)
  assert.equal(raw.length, (960 * 4 + 1) * 220)
  // Top corners are outside the envelope and must stay fully transparent.
  assert.equal(raw[1 + 3], 0, 'top-left alpha')
  // Around the centre line, the envelope must be painted with real colour.
  const centerRow = 110
  const start = centerRow * (960 * 4 + 1) + 1
  let painted = 0
  let alpha = 0
  for (let x = 0; x < 960; x += 1) {
    const at = start + x * 4
    if (raw[at + 3] > 0) {
      painted += 1
      alpha = Math.max(alpha, raw[at + 3])
    }
  }
  assert.ok(painted > 900, 'the centre line reaches across the card: ' + painted)
  assert.ok(alpha > 200, 'envelope alpha is strong enough to read: ' + alpha)
})

test('silence renders only the slim ruler and centre line', () => {
  const samples = new Float32Array(16000)
  const png = renderWaveformPng(samples, { width: 480, height: 120, durationSec: 1 })
  const raw = pixelsOf(png)
  let opaque = 0
  for (let at = 1; at < raw.length; at += 4) {
    if (raw[at + 3] > 200) opaque += 1
  }
  assert.ok(opaque < 480 * 4, 'silence must not paint a full envelope: ' + opaque)
  assert.equal(raw[1 + 3], 0)
})

test('renderWaveformPng falls back to 16 kHz duration when none is given', () => {
  const png = renderWaveformPng(new Float32Array(32000), { width: 320, height: 100 })
  assert.equal(readPngHeader(png).width, 320)
})

// Minimal dependency-free PNG encoder plus the waveform card used as visual
// evidence next to every memo. A PNG written here is a plain RGBA file encoded
// with node:zlib — no image library, no native binding, nothing to install.
//
// The card itself is deliberately quiet: transparent background, a soft centre
// line, a time ruler and an amplitude envelope in the harness accent range. It
// reads correctly on a light README and inside the dark panel because it paints
// its own colours instead of assuming a page background.

import { deflateSync } from 'node:zlib'
import { peaks } from './pcm.cjs'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length, false)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false)
  return out
}

export function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('PNG dimensions must be positive integers')
  }
  if (rgba.length !== width * height * 4) throw new Error('RGBA buffer length does not match the dimensions')

  const raw = new Uint8Array((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0 // filter: None
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  }

  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width, false)
  ihdrView.setUint32(4, height, false)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

// Read back the IHDR of a PNG produced here. Kept next to the encoder because
// the tests use it to prove the bytes are a real PNG, not just "some array".
export function readPngHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.byteLength < 33) throw new Error('PNG is too short')
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i += 1) if (view.getUint8(i) !== signature[i]) throw new Error('not a PNG signature')
  if (view.getUint32(8, false) !== 13) throw new Error('first chunk is not IHDR')
  return {
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
    bitDepth: view.getUint8(24),
    colorType: view.getUint8(25),
  }
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t)
}

const COLORS = {
  from: [14, 165, 233], // sky-500 — holds up on light backgrounds
  to: [99, 102, 241], // indigo-500
  axis: [100, 116, 139], // slate-500
  ruler: [71, 85, 105], // slate-600
}

export function renderWaveformPng(samples, options) {
  const opts = options || {}
  const width = Number.isFinite(opts.width) ? Math.max(160, Math.round(opts.width)) : 960
  const height = Number.isFinite(opts.height) ? Math.max(80, Math.round(opts.height)) : 220
  const durationSec = Number.isFinite(opts.durationSec) && opts.durationSec > 0
    ? opts.durationSec
    : samples.length / 16000

  const rgba = new Uint8Array(width * height * 4)
  const set = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const at = (y * width + x) * 4
    const alpha = a / 255
    // Source-over onto a transparent canvas; keeps overlapping strokes soft.
    const dstA = rgba[at + 3] / 255
    const outA = alpha + dstA * (1 - alpha)
    if (outA <= 0) return
    rgba[at] = Math.round((r * alpha + rgba[at] * dstA * (1 - alpha)) / outA)
    rgba[at + 1] = Math.round((g * alpha + rgba[at + 1] * dstA * (1 - alpha)) / outA)
    rgba[at + 2] = Math.round((b * alpha + rgba[at + 2] * dstA * (1 - alpha)) / outA)
    rgba[at + 3] = Math.round(outA * 255)
  }

  const margin = Math.round(height * 0.12)
  const center = Math.round(height / 2)
  const half = height / 2 - margin
  const envelope = peaks(samples, width)

  // Envelope: one bar per column, amplitude-scaled alpha so quiet passages
  // still read as "there is audio here", not as a hard cut.
  for (let x = 0; x < width; x += 1) {
    const peak = envelope[x]
    const amplitude = Math.min(1, peak.amplitude * 1.12)
    const extent = Math.max(1.2, amplitude * half)
    const top = Math.round(center - extent)
    const bottom = Math.round(center + extent)
    const t = width <= 1 ? 0 : x / (width - 1)
    const color = [
      mix(COLORS.from[0], COLORS.to[0], t),
      mix(COLORS.from[1], COLORS.to[1], t),
      mix(COLORS.from[2], COLORS.to[2], t),
    ]
    const alpha = Math.round(165 + 90 * Math.min(1, amplitude * 1.6))
    for (let y = top; y <= bottom; y += 1) {
      const edge = Math.min(y - top, bottom - y)
      const a = edge < 2 ? Math.round(alpha * 0.72) : alpha
      set(x, y, color[0], color[1], color[2], a)
    }
  }

  // Centre line: quiet, one pixel, drawn through the envelope.
  for (let x = 0; x < width; x += 1) set(x, center, COLORS.axis[0], COLORS.axis[1], COLORS.axis[2], 90)

  // Time ruler: a tick per second for short memos, then 5/15/30 second steps.
  const step = durationSec <= 24 ? 1 : durationSec <= 90 ? 5 : durationSec <= 300 ? 15 : 30
  const rulerTop = margin
  const rulerBottom = height - margin
  const count = Math.floor(durationSec / step)
  for (let i = 0; i <= count; i += 1) {
    const time = i * step
    const x = Math.min(width - 1, Math.round((time / durationSec) * (width - 1)))
    const major = i === 0 || i === count || (time % (step * 5) === 0)
    const alpha = major ? 120 : 60
    for (let y = rulerTop; y <= rulerBottom; y += 1) {
      if (y % 3 === 0 || major) set(x, y, COLORS.ruler[0], COLORS.ruler[1], COLORS.ruler[2], alpha)
    }
    if (major) {
      for (let d = 0; d < 6; d += 1) set(x + d, rulerTop, COLORS.ruler[0], COLORS.ruler[1], COLORS.ruler[2], 140)
    }
  }

  return encodePng(width, height, rgba)
}

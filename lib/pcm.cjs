// Pure PCM / WAV helpers shared by the Host half (Node) and the Client bundle
// (browser). No Node built-ins are used, so the build can inline this whole
// module into the browser bundle: the browser records via MediaRecorder, decodes
// through Web Audio, then uses encodeWav()/resample() below to produce the one
// canonical format the Host accepts (16 kHz mono PCM16 WAV).
//
// Everything here is synchronous and side-effect free; test/pcm.test.mjs covers
// the formats a normal recorder or a WAV file on disk can produce.

'use strict'

function clampUnit(value) {
  return value < -1 ? -1 : value > 1 ? 1 : value
}

function readAscii(view, offset, length) {
  let text = ''
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(view.getUint8(offset + i))
  return text
}

function toDataView(input) {
  if (input instanceof DataView) return input
  if (input instanceof ArrayBuffer) return new DataView(input)
  if (ArrayBuffer.isView(input)) return new DataView(input.buffer, input.byteOffset, input.byteLength)
  throw new TypeError('WAV input must be an ArrayBuffer, a typed array or a DataView')
}

// Decode PCM/float WAV into a mono Float32Array at the file's own sample rate.
// Supported encodings: PCM 8/16/24/32-bit and IEEE float 32/64-bit. Anything
// else fails loudly instead of being silently interpreted as noise.
function parseWav(input) {
  const view = toDataView(input)
  if (view.byteLength < 44) throw new Error('WAV file is shorter than a RIFF header')
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }

  let fmt
  let data
  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const id = readAscii(view, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    const available = Math.max(0, Math.min(size, view.byteLength - body))
    if (id === 'fmt ') {
      if (available < 16) throw new Error('WAV fmt chunk is truncated')
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      }
    } else if (id === 'data') {
      data = { offset: body, size: available }
    }
    offset = body + size + (size % 2)
  }

  if (fmt === undefined) throw new Error('WAV file has no fmt chunk')
  if (data === undefined) throw new Error('WAV file has no data chunk')
  if (fmt.channels < 1) throw new Error('WAV file declares no channel')
  if (fmt.sampleRate < 1000 || fmt.sampleRate > 384000) throw new Error('unsupported WAV sample rate: ' + fmt.sampleRate)

  const channels = fmt.channels
  const bytes = Math.floor(data.size / (channels * (fmt.bitsPerSample / 8))) * channels * (fmt.bitsPerSample / 8)
  if (bytes <= 0) throw new Error('WAV data chunk contains no complete sample frame')

  const samples = new Float32Array(Math.floor(bytes / (channels * (fmt.bitsPerSample / 8))))
  const bytesPerSample = fmt.bitsPerSample / 8
  const frameBytes = bytesPerSample * channels

  for (let frame = 0; frame < samples.length; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      const at = data.offset + frame * frameBytes + channel * bytesPerSample
      sum += readSample(view, at, fmt.format, fmt.bitsPerSample)
    }
    samples[frame] = clampUnit(sum / channels)
  }

  return {
    sampleRate: fmt.sampleRate,
    channels: channels,
    bitsPerSample: fmt.bitsPerSample,
    format: fmt.format,
    durationSec: samples.length / fmt.sampleRate,
    samples: samples,
  }
}

function readSample(view, at, format, bits) {
  if (format === 1) {
    if (bits === 8) return (view.getUint8(at) - 128) / 128
    if (bits === 16) return view.getInt16(at, true) / 32768
    if (bits === 24) {
      const raw = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16)
      const signed = raw & 0x800000 ? raw - 0x1000000 : raw
      return signed / 8388608
    }
    if (bits === 32) return view.getInt32(at, true) / 2147483648
  }
  if (format === 3) {
    if (bits === 32) return view.getFloat32(at, true)
    if (bits === 64) return view.getFloat64(at, true)
  }
  throw new Error('unsupported WAV encoding: format ' + format + ' / ' + bits + '-bit')
}

// Encode mono float samples as a canonical 16 kHz PCM16 WAV. When sampleRate is
// given the samples are resampled first; that is the only path the Host uses.
function encodeWav(samples, sampleRate, options) {
  const opts = options || {}
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 16000
  const source = opts.resampleFrom !== undefined && opts.resampleFrom !== rate
    ? resample(samples, opts.resampleFrom, rate)
    : samples
  const count = source.length
  const buffer = new ArrayBuffer(44 + count * 2)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + count * 2, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, count * 2, true)

  for (let i = 0; i < count; i += 1) {
    const value = clampUnit(source[i])
    const quantized = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767)
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, quantized)), true)
  }

  return new Uint8Array(buffer)
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
}

// Linear resampling. It is not a band-limited resampler: speech recorded at
// 44.1/48 kHz and reduced to 16 kHz with this filter is still perfectly usable
// by Whisper-class recognisers, and staying dependency-free is the point.
function resample(samples, fromRate, toRate) {
  const from = Math.max(1, Math.round(fromRate))
  const to = Math.max(1, Math.round(toRate))
  if (from === to) return samples
  const length = Math.max(1, Math.round((samples.length * to) / from))
  const out = new Float32Array(length)
  const step = from / to
  for (let i = 0; i < length; i += 1) {
    const position = i * step
    const left = Math.floor(position)
    const right = Math.min(samples.length - 1, left + 1)
    const fraction = position - left
    const a = samples[Math.min(left, samples.length - 1)]
    const b = samples[right]
    out[i] = a + (b - a) * fraction
  }
  return out
}

// Min/max envelope per bucket. The waveform renderer and the client meter both
// use this rather than drawing every sample.
function peaks(samples, buckets) {
  const count = Math.max(1, Math.floor(buckets))
  const result = new Array(count)
  const per = samples.length / count
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor(i * per)
    const end = Math.max(start + 1, Math.min(samples.length, Math.floor((i + 1) * per)))
    let min = 0
    let max = 0
    for (let j = start; j < end; j += 1) {
      const value = samples[j]
      if (value < min) min = value
      if (value > max) max = value
    }
    result[i] = { min: min, max: max, amplitude: Math.max(Math.abs(min), Math.abs(max)) }
  }
  return result
}

function rms(samples, start, end) {
  const from = Math.max(0, Math.floor(start))
  const to = Math.min(samples.length, Math.floor(end))
  if (to <= from) return 0
  let sum = 0
  for (let i = from; i < to; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / (to - from))
}

function dbfs(value) {
  if (!(value > 0)) return -96
  return Math.max(-96, 20 * Math.log10(value))
}

module.exports = {
  parseWav: parseWav,
  encodeWav: encodeWav,
  resample: resample,
  peaks: peaks,
  rms: rms,
  dbfs: dbfs,
}

/* dsh-voice-memo client bundle — generated from src/client.cjs */
window.__ModuleLoader__.load({
  id: "dsh-voice-memo",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
// --- inlined src/pcm.cjs (shared with the host half) ---
var __pcmBundle = (function () {
  var module = { exports: {} };
  var exports = module.exports;
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
  return module.exports;
})();
// --- end inlined pcm ---
// Client half of dsh-voice-memo: the 口述 Tab in the conversation view.
//
// Must stay CommonJS — the build wraps this in window.__ModuleLoader__.load().
// React and the two inline helpers (CSS, PCM) are supplied by the build, so this
// file carries no relative require of its own beyond those two placeholders.
//
// The panel records with MediaRecorder, decodes through Web Audio, converts to
// the canonical 16 kHz mono WAV with the shared PCM module, and posts that to the
// Host. Decoding and encoding happen in the browser so the Host never needs an
// audio decoder; the Host only ever sees WAV.

const React = require('react')
const h = React.createElement
const CSS = ".vm-root{display:flex;flex-direction:column;gap:14px;padding:18px 18px 112px;height:auto;min-height:100%;box-sizing:border-box;color:inherit;font-size:13px;line-height:1.55}\n.vm-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}\n.vm-title{font-size:16px;font-weight:600;letter-spacing:.01em}\n.vm-sub{opacity:.55;font-size:12px;margin-top:2px}\n.vm-spacer{flex:1}\n.vm-chip{display:inline-flex;align-items:center;font-size:10.5px;line-height:1.6;padding:0 8px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);white-space:nowrap}\n.vm-chip.vm-ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}\n.vm-chip.vm-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,transparent)}\n.vm-chip.vm-bad{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}\n.vm-stage{display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px 18px 14px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:14px;background:color-mix(in srgb,currentColor 3%,transparent)}\n.vm-record{display:inline-flex;align-items:center;gap:10px;min-width:196px;justify-content:center;padding:13px 24px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 46%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:inherit;font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;touch-action:none;user-select:none;transition:background .15s ease,border-color .15s ease}\n.vm-record:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}\n.vm-record:disabled{opacity:.5;cursor:default}\n.vm-record-on{border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);animation:vm-pulse 1.4s ease-in-out infinite}\n.vm-record-dot{width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-state-error-primary);flex:none}\n.vm-record-on .vm-record-dot{border-radius:2px}\n.vm-record-text{font-variant-numeric:tabular-nums}\n@keyframes vm-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent)}55%{box-shadow:0 0 0 9px transparent}}\n.vm-meter{display:flex;align-items:center;gap:3px;height:22px}\n.vm-meter i{display:block;width:3px;height:20px;border-radius:2px;background:color-mix(in srgb,currentColor 26%,transparent);transform-origin:center;transition:transform .07s linear}\n.vm-meter i.vm-meter-on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 78%,transparent)}\n.vm-stage-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center;font-size:11.5px;opacity:.68}\n.vm-live{color:var(--dsw-alias-state-error-primary);opacity:1;font-variant-numeric:tabular-nums;font-weight:600}\n.vm-path{font-size:11.5px;opacity:.5;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}\n.vm-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:8px}\n.vm-stat{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:9px;padding:8px 11px}\n.vm-stat b{display:block;font-size:18px;line-height:1.2;font-variant-numeric:tabular-nums}\n.vm-stat span{font-size:11px;opacity:.55}\n.vm-empty{border:1px dashed color-mix(in srgb,currentColor 20%,transparent);border-radius:12px;padding:24px 18px;text-align:center;font-size:12.5px;opacity:.6;max-width:640px;margin:0 auto}\n.vm-list{display:flex;flex-direction:column;gap:12px}\n.vm-card{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:9px;background:color-mix(in srgb,currentColor 2%,transparent);transition:border-color .15s ease}\n.vm-card-active{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 44%,transparent)}\n.vm-card-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}\n.vm-card-title{font-size:13.5px;font-weight:600;max-width:100%;overflow-wrap:anywhere}\n.vm-card-meta{font-size:11.5px;opacity:.55;font-variant-numeric:tabular-nums}\n.vm-wave{position:relative;border-radius:8px;overflow:hidden;background:color-mix(in srgb,currentColor 4%,transparent)}\n.vm-wave-img{display:block;width:100%;height:auto}\n.vm-wave-hit{position:absolute;inset:0;width:100%;border:0;padding:0;background:transparent;cursor:pointer}\n.vm-wave-progress{position:absolute;top:0;bottom:0;width:2px;background:var(--dsw-alias-brand-primary);box-shadow:0 0 6px color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,transparent);pointer-events:none}\n.vm-card-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n.vm-play{border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;padding:3px 12px;border-radius:6px;cursor:pointer;min-width:52px}\n.vm-play:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}\n.vm-time{font-size:11.5px;opacity:.6;font-variant-numeric:tabular-nums;min-width:96px}\n.vm-btn{border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;font:inherit;font-size:11.5px;padding:3px 9px;border-radius:6px;cursor:pointer}\n.vm-btn:hover:not(:disabled){background:color-mix(in srgb,currentColor 8%,transparent)}\n.vm-btn:disabled{opacity:.4;cursor:default}\n.vm-reason{font-size:11.5px;color:var(--dsw-alias-state-warn-primary)}\n.vm-segs{display:flex;flex-direction:column;gap:2px;border-top:1px solid color-mix(in srgb,currentColor 10%,transparent);padding-top:8px}\n.vm-seg{display:grid;grid-template-columns:92px 1fr auto;gap:8px;align-items:start;padding:3px 0}\n.vm-seg-time{border:0;background:transparent;color:inherit;font:inherit;font-size:11px;opacity:.65;font-variant-numeric:tabular-nums;text-align:left;padding:0;cursor:pointer;text-decoration:underline dotted transparent;text-underline-offset:3px}\n.vm-seg-time:hover{opacity:1;text-decoration-color:currentColor}\n.vm-seg-text{font-size:12.5px;overflow-wrap:anywhere}\n.vm-copy{border:0;background:transparent;color:inherit;font:inherit;font-size:10.5px;opacity:.4;cursor:pointer;padding:1px 2px}\n.vm-copy:hover{opacity:.9;text-decoration:underline}\n.vm-error{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);border-radius:8px;padding:7px 10px;font-size:12px}\n.vm-notice{border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 36%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent);border-radius:8px;padding:7px 10px;font-size:12px}\n.vm-root audio{display:none}\n@media (prefers-reduced-motion:reduce){.vm-record-on{animation:none}.vm-meter i{transition:none}}\n@media (max-width:520px){.vm-seg{grid-template-columns:76px 1fr auto}.vm-time{min-width:0}.vm-record{min-width:160px}}"
const PCM = __pcmBundle

const API = '/dsh-voice-memo'
const POLL_MS = 2500

let snap = { data: null, error: '', at: 0 }
const listeners = new Set()
let timer = null
let session = ''

function emit() {
  Array.from(listeners).forEach(function (fn) {
    try {
      fn(snap)
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-voice-memo] listener failed', error)
    }
  })
}

function load() {
  const query = session ? '?sessionId=' + encodeURIComponent(session) : ''
  fetch(API + '/api/state' + query, { headers: { accept: 'application/json' } })
    .then(function (res) { return res.json() })
    .then(function (data) {
      snap = { data: data, error: '', at: Date.now() }
      emit()
    })
    .catch(function (error) {
      snap = { data: snap.data, error: String((error && error.message) || error), at: Date.now() }
      emit()
    })
}

function subscribe(fn, sessionId) {
  if (typeof sessionId === 'string' && sessionId.length > 0) session = sessionId
  listeners.add(fn)
  if (timer === null) {
    load()
    timer = setInterval(load, POLL_MS)
  }
  fn(snap)
  return function () {
    listeners.delete(fn)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

function pad(value, width) {
  let text = String(Math.max(0, Math.floor(value)))
  while (text.length < width) text = '0' + text
  return text
}

function fmtClock(seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  return pad(Math.floor(value / 60), 2) + ':' + pad(Math.floor(value % 60), 2)
}

function fmtTenths(seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  const tenths = Math.round(value * 10)
  return pad(Math.floor(tenths / 600), 2) + ':' + pad(Math.floor((tenths % 600) / 10), 2) + '.' + pad(tenths % 10, 1)
}

function fmtDuration(seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  return value < 60 ? value.toFixed(1) + ' 秒' : Math.floor(value / 60) + ' 分 ' + pad(Math.round(value % 60), 2) + ' 秒'
}

function fmtSpan(segment) {
  return fmtTenths(segment.start) + '–' + fmtTenths(segment.end)
}

function toBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let at = 0; at < bytes.length; at += chunk) {
    const slice = bytes.subarray(at, at + chunk)
    binary += String.fromCharCode.apply(null, Array.from(slice))
  }
  return window.btoa(binary)
}

function pickMimeType() {
  if (typeof window.MediaRecorder === 'undefined' || typeof window.MediaRecorder.isTypeSupported !== 'function') return ''
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  for (let i = 0; i < candidates.length; i += 1) {
    if (window.MediaRecorder.isTypeSupported(candidates[i])) return candidates[i]
  }
  return ''
}

function statusTone(status) {
  if (status === 'transcribed') return 'vm-ok'
  if (status === 'transcription-failed') return 'vm-bad'
  if (status === 'transcription-unavailable' || status === 'empty-speech') return 'vm-warn'
  return ''
}

function statusText(status) {
  if (status === 'transcribed') return '已转写'
  if (status === 'empty-speech') return '未检出语音'
  if (status === 'transcription-unavailable') return '未转写'
  if (status === 'transcription-failed') return '转写失败'
  return status || '—'
}

function engineText(engine) {
  if (engine === null || engine === undefined) return '—'
  if (typeof engine === 'string') return engine
  return String(engine.name || engine.kind || '—') + (engine.model ? '（' + engine.model + '）' : '')
}

function quoteText(memo, segment, memoPath) {
  return [
    '> ' + String(segment.text || ''),
    '> —— 口述笔记 ' + String(memo.createdLocal || '') + ' · ' + fmtSpan(segment),
    '>',
    '> 笔记：`' + String(memoPath || 'memo.md') + '#seg-' + (segment.index + 1) + '`',
  ].join('\n')
}

function Box(props) {
  return h('div', { className: 'vm-stat' }, h('b', null, props.value), h('span', null, props.label))
}

function SegmentRow(props) {
  const segment = props.segment
  return h('div', { className: 'vm-seg', role: 'group' },
    h('button', {
      type: 'button',
      className: 'vm-seg-time',
      title: '从这一段开始播放',
      onClick: function () { props.onSeek(segment.start) },
    }, fmtSpan(segment)),
    h('div', { className: 'vm-seg-text' }, String(segment.text || '')),
    h('button', {
      type: 'button',
      className: 'vm-copy',
      title: '复制这一段的引用',
      onClick: function () { props.onCopyQuote(segment.index) },
    }, '引用'),
  )
}

function MemoCard(props) {
  const memo = props.memo
  const active = props.activeId === memo.id
  const progress = active && props.duration > 0 ? Math.min(100, (props.currentTime / props.duration) * 100) : 0
  const waveUrl = API + '/wave/' + encodeURIComponent(memo.id) + (session ? '?sessionId=' + encodeURIComponent(session) : '')
  const notePath = String(props.outputDir || '') + '\\' + memo.id + '\\memo.md'
  const [open, setOpen] = React.useState(true)

  return h('div', { className: 'vm-card' + (active ? ' vm-card-active' : '') },
    h('div', { className: 'vm-card-head' },
      h('div', { className: 'vm-card-title' }, String(memo.title || memo.id)),
      h('span', { className: 'vm-chip ' + statusTone(memo.status) }, statusText(memo.status)),
      h('span', { className: 'vm-card-meta' },
        String(memo.createdLocal || '') + ' · ' + fmtDuration(memo.durationSec) + ' · ' +
        String((memo.segments || []).length) + ' 段',
      ),
    ),
    h('div', { className: 'vm-wave' },
      h('img', { className: 'vm-wave-img', src: waveUrl, alt: '录音波形' }),
      progress > 0 ? h('div', { className: 'vm-wave-progress', style: { left: progress + '%' } }) : null,
      h('button', {
        type: 'button',
        className: 'vm-wave-hit',
        'aria-label': '拖动定位：点击位置从该处开始播放',
        onClick: function (event) {
          const rect = event.currentTarget.getBoundingClientRect()
          const fraction = rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0
          props.onSeek(memo.id, fraction * (Number(memo.durationSec) || 0))
        },
      }),
    ),
    h('div', { className: 'vm-card-actions' },
      h('button', {
        type: 'button',
        className: 'vm-play',
        'aria-label': active && props.playing ? '暂停' : '播放',
        onClick: function () { props.onToggle(memo) },
      }, active && props.playing ? '暂停' : '播放'),
      h('span', { className: 'vm-time' },
        active ? fmtTenths(props.currentTime) + ' / ' + fmtTenths(memo.durationSec) : fmtTenths(memo.durationSec)),
      h('span', { className: 'vm-spacer' }),
      memo.segments && memo.segments.length > 0
        ? h('button', {
          type: 'button',
          className: 'vm-btn',
          onClick: function () { props.onCopyQuote(memo, memo.segments[0].index) },
        }, '复制引用')
        : null,
      h('button', {
        type: 'button',
        className: 'vm-btn',
        onClick: function () { props.onCopy(notePath) },
      }, '复制笔记路径'),
      h('button', {
        type: 'button',
        className: 'vm-btn',
        onClick: function () { setOpen(!open) },
      }, open ? '收起分段' : '展开分段'),
    ),
    memo.reason ? h('div', { className: 'vm-reason' }, String(memo.reason)) : null,
    open && memo.segments && memo.segments.length > 0
      ? h('div', { className: 'vm-segs' }, memo.segments.map(function (segment) {
        return h(SegmentRow, {
          key: String(segment.index),
          segment: segment,
          onSeek: function (start) { props.onSeek(memo.id, start) },
          onCopyQuote: function (index) { props.onCopyQuote(memo, index) },
        })
      }))
      : null,
  )
}

function VoiceMemoView(props) {
  const [state, setState] = React.useState(snap)
  const [phase, setPhase] = React.useState('idle')
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [seconds, setSeconds] = React.useState(0)
  const [level, setLevel] = React.useState(0)
  const [playingId, setPlayingId] = React.useState('')
  const [playing, setPlaying] = React.useState(false)
  const [currentTime, setCurrentTime] = React.useState(0)
  const [duration, setDuration] = React.useState(0)

  const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : ''
  const audioRef = React.useRef(null)
  const recorderRef = React.useRef(null)
  const streamRef = React.useRef(null)
  const contextRef = React.useRef(null)
  const analyserRef = React.useRef(null)
  const chunksRef = React.useRef([])
  const startedRef = React.useRef(0)
  const meterRef = React.useRef(0)
  const timerRef = React.useRef(null)
  const fileRef = React.useRef(null)

  React.useEffect(function () {
    session = sessionId
    const unsubscribe = subscribe(setState, sessionId)
    load()
    return unsubscribe
  }, [sessionId])

  React.useEffect(function () {
    return function () {
      stopMeter()
      if (timerRef.current !== null) clearInterval(timerRef.current)
      if (streamRef.current !== null) {
        streamRef.current.getTracks().forEach(function (track) { track.stop() })
        streamRef.current = null
      }
      if (contextRef.current !== null) {
        try { contextRef.current.close() } catch (err) { /* already closed */ }
        contextRef.current = null
      }
    }
  }, [])

  React.useEffect(function () {
    if (notice.length === 0) return function () {}
    const handle = setTimeout(function () { setNotice('') }, 2400)
    return function () { clearTimeout(handle) }
  }, [notice])

  function stopMeter() {
    if (meterRef.current !== 0) {
      cancelAnimationFrame(meterRef.current)
      meterRef.current = 0
    }
  }

  function startMeter() {
    const analyser = analyserRef.current
    if (analyser === null) return
    const buffer = new Uint8Array(analyser.fftSize)
    let last = 0
    const tick = function (time) {
      meterRef.current = requestAnimationFrame(tick)
      if (time - last < 90) return
      last = time
      analyser.getByteTimeDomainData(buffer)
      let sum = 0
      for (let i = 0; i < buffer.length; i += 1) {
        const value = (buffer[i] - 128) / 128
        sum += value * value
      }
      const rms = Math.sqrt(sum / buffer.length)
      setLevel(Math.min(1, rms * 6))
    }
    meterRef.current = requestAnimationFrame(tick)
  }

  function beginTimer() {
    setSeconds(0)
    startedRef.current = performance.now()
    if (timerRef.current !== null) clearInterval(timerRef.current)
    timerRef.current = setInterval(function () {
      setSeconds((performance.now() - startedRef.current) / 1000)
    }, 100)
  }

  function stopTimer() {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  async function startRecording() {
    if (phase !== 'idle') return
    setError('')
    setNotice('')
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError('这个页面拿不到麦克风（navigator.mediaDevices 不可用）。可以改用「导入 WAV」。')
      return
    }
    if (typeof window.MediaRecorder === 'undefined') {
      setError('当前浏览器不支持 MediaRecorder，可以改用「导入 WAV」。')
      return
    }
    setPhase('starting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream
      const AudioContextClass = window.AudioContext || window.webkitAudioContext
      const context = new AudioContextClass()
      contextRef.current = context
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      analyserRef.current = analyser
      const mimeType = pickMimeType()
      const recorder = mimeType ? new window.MediaRecorder(stream, { mimeType: mimeType }) : new window.MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = function (event) {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = function () { finalizeRecording(recorder.mimeType || mimeType) }
      recorderRef.current = recorder
      recorder.start(250)
      setPhase('recording')
      beginTimer()
      startMeter()
    } catch (err) {
      setPhase('idle')
      setError('拿不到麦克风：' + String((err && err.message) || err) + '。可以改用「导入 WAV」。')
      cleanupStream()
    }
  }

  function cleanupStream() {
    stopMeter()
    stopTimer()
    if (streamRef.current !== null) {
      streamRef.current.getTracks().forEach(function (track) { track.stop() })
      streamRef.current = null
    }
    if (contextRef.current !== null && !recorderRef.current) {
      try { contextRef.current.close() } catch (err) { /* already closed */ }
      contextRef.current = null
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current
    if (recorder === null || typeof recorder.stop !== 'function') return
    if (recorder.state === 'inactive') return
    stopTimer()
    stopMeter()
    setPhase('processing')
    setSeconds((performance.now() - startedRef.current) / 1000)
    try {
      recorder.stop()
    } catch (err) {
      setPhase('idle')
      setError('停止录音失败：' + String((err && err.message) || err))
    }
  }

  async function finalizeRecording(mimeType) {
    const recorded = (performance.now() - startedRef.current) / 1000
    try {
      const chunks = chunksRef.current
      chunksRef.current = []
      if (chunks.length === 0) throw new Error('没有录到音频数据')
      const blob = new Blob(chunks, { type: mimeType || 'audio/webm' })
      const bytes = await blob.arrayBuffer()
      const context = contextRef.current
      if (context === null) throw new Error('音频上下文已关闭，无法解码')
      const audioBuffer = await new Promise(function (resolvePromise, rejectPromise) {
        context.decodeAudioData(bytes.slice(0), resolvePromise, rejectPromise)
      })
      const mono = new Float32Array(audioBuffer.length)
      for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
        const data = audioBuffer.getChannelData(channel)
        for (let i = 0; i < data.length; i += 1) mono[i] += data[i] / audioBuffer.numberOfChannels
      }
      const samples = PCM.resample(mono, audioBuffer.sampleRate, 16000)
      const wav = PCM.encodeWav(samples, 16000)
      cleanupStream()
      contextRef.current = null
      try { context.close() } catch (err) { /* already closed */ }
      if (recorded < 0.25) throw new Error('录音太短了（不足 0.25 秒）')
      await saveWav(wav)
    } catch (err) {
      setPhase('idle')
      setError('处理录音失败：' + String((err && err.message) || err) + '。可以改用「导入 WAV」。')
      cleanupStream()
    }
  }

  async function saveWav(wav) {
    setPhase('processing')
    const response = await fetch(API + '/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        audioBase64: toBase64(wav),
        sessionId: sessionId,
      }),
    })
    const data = await response.json()
    if (!data || data.ok !== true) throw new Error((data && data.error) || '保存失败')
    setPhase('idle')
    setNotice('已归档：' + String((data.memo && data.memo.title) || '') + '（' + statusText(data.memo && data.memo.status) + '）')
    load()
  }

  async function importWav(event) {
    const file = event.target.files && event.target.files[0]
    event.target.value = ''
    if (!file) return
    setError('')
    setPhase('processing')
    try {
      const bytes = await file.arrayBuffer()
      const AudioContextClass = window.AudioContext || window.webkitAudioContext
      const context = new AudioContextClass()
      let audioBuffer
      try {
        audioBuffer = await new Promise(function (resolvePromise, rejectPromise) {
          context.decodeAudioData(bytes.slice(0), resolvePromise, rejectPromise)
        })
      } finally {
        try { context.close() } catch (err) { /* already closed */ }
      }
      const mono = new Float32Array(audioBuffer.length)
      for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
        const data = audioBuffer.getChannelData(channel)
        for (let i = 0; i < data.length; i += 1) mono[i] += data[i] / audioBuffer.numberOfChannels
      }
      const samples = PCM.resample(mono, audioBuffer.sampleRate, 16000)
      const wav = PCM.encodeWav(samples, 16000)
      await saveWav(wav)
    } catch (err) {
      setPhase('idle')
      setError('导入失败：' + String((err && err.message) || err))
    }
  }

  function togglePlay(memo) {
    const audio = audioRef.current
    if (audio === null) return
    const base = API + '/audio/' + encodeURIComponent(memo.id) + (session ? '?sessionId=' + encodeURIComponent(session) : '')
    if (playingId !== memo.id) {
      audio.src = base
      audio.currentTime = 0
      setPlayingId(memo.id)
      setDuration(Number(memo.durationSec) || 0)
      setCurrentTime(0)
      audio.play().then(function () { setPlaying(true) }).catch(function (err) {
        setError('播放失败：' + String((err && err.message) || err))
      })
      return
    }
    if (playing) {
      audio.pause()
      setPlaying(false)
    } else {
      audio.play().then(function () { setPlaying(true) }).catch(function (err) {
        setError('播放失败：' + String((err && err.message) || err))
      })
    }
  }

  function seek(memoId, seconds) {
    const memo = (state.data && state.data.memos || []).find(function (item) { return item.id === memoId })
    if (!memo) return
    const audio = audioRef.current
    if (audio === null) return
    const base = API + '/audio/' + encodeURIComponent(memo.id) + (session ? '?sessionId=' + encodeURIComponent(session) : '')
    if (playingId !== memo.id || audio.src === '') {
      audio.src = base
      setPlayingId(memo.id)
      setDuration(Number(memo.durationSec) || 0)
      setCurrentTime(0)
    }
    const target = Math.max(0, Math.min(Number(seconds) || 0, Number(memo.durationSec) || 0))
    audio.currentTime = target
    setCurrentTime(target)
    audio.play().then(function () { setPlaying(true) }).catch(function () { /* play needs a gesture in some browsers */ })
  }

  function onTimeUpdate() {
    const audio = audioRef.current
    if (audio === null) return
    setCurrentTime(audio.currentTime)
    if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration)
  }

  function onEnded() {
    setPlaying(false)
    setCurrentTime(0)
  }

  function copy(text) {
    const value = String(text || '')
    if (value.length === 0) return
    const done = function () { setNotice('已复制') }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(value).then(done).catch(function () { fallbackCopy(value, done) })
      return
    }
    fallbackCopy(value, done)
  }

  function fallbackCopy(value, done) {
    try {
      const area = document.createElement('textarea')
      area.value = value
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
      done()
    } catch (err) {
      setError('复制失败：' + String((err && err.message) || err))
    }
  }

  function copyQuote(memo, segmentIndex) {
    const memoPath = String((state.data && state.data.outputDir) || '') + '\\' + memo.id + '\\memo.md'
    const segment = (memo.segments || [])[segmentIndex]
    if (!segment) return
    copy(quoteText(memo, segment, memoPath))
  }

  const data = state.data
  const engine = data && data.engine ? data.engine : null
  const memos = (data && data.memos) || []
  const limits = (data && data.limits) || { maxDurationSec: 600 }
  const recording = phase === 'recording'
  const busy = phase === 'processing' || phase === 'starting'
  const canRecord = !busy && !recording
  const secondsNow = recording ? seconds : 0

  return h('div', { className: 'vm-root' },
    h('div', { className: 'vm-head' },
      h('div', null,
        h('div', { className: 'vm-title' }, '口述'),
        h('div', { className: 'vm-sub' }, '按住说话 · 本地转写 · 波形与 markdown 笔记落进当前工作区'),
      ),
      h('div', { className: 'vm-spacer' }),
      h('span', {
        className: 'vm-chip ' + (engine && engine.available ? 'vm-ok' : 'vm-warn'),
        title: engine ? String(engine.detail || '') : '',
      }, engine ? (engine.available ? '本地识别：' + String(engine.label || '') : '本地识别未配置') : '正在读取引擎状态…'),
    ),

    state.error ? h('div', { className: 'vm-error' }, '与 Host 通信失败：' + state.error) : null,
    error ? h('div', { className: 'vm-error' }, error) : null,
    notice ? h('div', { className: 'vm-notice' }, notice) : null,

    h('div', { className: 'vm-stage' },
      h('button', {
        type: 'button',
        className: 'vm-record' + (recording ? ' vm-record-on' : ''),
        'aria-label': recording ? '松开结束录音' : busy ? '正在处理' : '按住说话',
        disabled: busy,
        onPointerDown: function (event) {
          event.preventDefault()
          if (event.currentTarget.setPointerCapture) {
            try { event.currentTarget.setPointerCapture(event.pointerId) } catch (err) { /* ignore */ }
          }
          startRecording()
        },
        onPointerUp: function (event) {
          event.preventDefault()
          stopRecording()
        },
        onPointerCancel: function () { stopRecording() },
        onContextMenu: function (event) { event.preventDefault() },
      },
        h('span', { className: 'vm-record-dot', 'aria-hidden': true }),
        h('span', { className: 'vm-record-text' },
          recording ? '松开结束' : busy ? '处理中…' : '按住说话'),
      ),
      recording
        ? h('div', { className: 'vm-meter', 'aria-hidden': true },
          Array.from({ length: 22 }).map(function (_, index) {
            const center = Math.abs(index - 10.5) / 10.5
            const scale = Math.max(0.12, Math.min(1, level * (1.2 - center * 0.7)))
            return h('i', {
              key: String(index),
              style: { transform: 'scaleY(' + scale.toFixed(3) + ')' },
              className: 'vm-meter-on',
            })
          }),
        )
        : null,
      h('div', { className: 'vm-stage-meta' },
        recording
          ? h('span', { className: 'vm-live' }, fmtTenths(secondsNow) + ' · 正在录音')
          : busy
            ? h('span', null, '本地转写中，录音不会离开这台机器…')
            : h('span', null, '最长 ' + Math.round(Number(limits.maxDurationSec) / 60) + ' 分钟 · 录音只留在本机'),
        h('button', {
          type: 'button',
          className: 'vm-btn',
          onClick: function () { if (fileRef.current) fileRef.current.click() },
          disabled: busy || recording,
        }, '导入 WAV'),
        h('input', {
          ref: fileRef,
          type: 'file',
          accept: '.wav,audio/wav',
          style: { display: 'none' },
          onChange: importWav,
        }),
      ),
    ),

    data && data.outputDir
      ? h('div', { className: 'vm-path', title: String(data.outputDir) }, '归档目录：' + String(data.outputDir))
      : null,

    h('div', { className: 'vm-stats' },
      h(Box, { label: '口述笔记', value: String(memos.length) }),
      h(Box, { label: '已转写', value: String(memos.filter(function (memo) { return memo.status === 'transcribed' }).length) }),
      h(Box, { label: '总时长', value: Math.round(memos.reduce(function (sum, memo) { return sum + (Number(memo.durationSec) || 0) }, 0)) + 's' }),
    ),

    memos.length === 0
      ? h('div', { className: 'vm-empty' }, '还没有口述笔记。按住上面的按钮录一段，或把已有 WAV 拖进来；agent 也可以用 voice_memo_save 归档现有录音。')
      : h('div', { className: 'vm-list' }, memos.map(function (memo) {
        return h(MemoCard, {
          key: memo.id,
          memo: memo,
          outputDir: data ? data.outputDir : '',
          activeId: playingId,
          playing: playing,
          currentTime: currentTime,
          duration: duration,
          onToggle: togglePlay,
          onSeek: seek,
          onCopyQuote: copyQuote,
          onCopy: copy,
        })
      })),

    h('audio', {
      ref: audioRef,
      preload: 'metadata',
      onTimeUpdate: onTimeUpdate,
      onEnded: onEnded,
      onPlay: function () { setPlaying(true) },
      onPause: function () { setPlaying(false) },
    }),
  )
}

function apply(ctx) {
  ctx.effect(function () {
    return function () {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      listeners.clear()
      snap = { data: null, error: '', at: 0 }
      session = ''
    }
  })

  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-voice-memo'
    style.textContent = CSS
    document.head.appendChild(style)
    return function () { style.remove() }
  })

  ctx.slots.inject('conversation.view', function () {
    let disposeView
    try {
      disposeView = ctx.slots.register(
        { name: 'conversation.view', id: 'voice-memo', order: 36, label: '口述' },
        VoiceMemoView,
      )
    } catch (error) {
      disposeView = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-voice-memo] could not register the 口述 view; the host archive and tools still work', error)
      }
    }
    return typeof disposeView === 'function' ? disposeView : function () {}
  })
}

module.exports = {
  name: 'dsh-voice-memo',
  inject: ['slots'],
  apply: apply,
}
    return module.exports;
  },
});

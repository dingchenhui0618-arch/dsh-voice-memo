// Memo archive on disk. One directory per memo:
//
//   <outputDir>/<id>/audio.wav      canonical 16 kHz mono PCM16
//   <outputDir>/<id>/waveform.png   rendered from the same samples
//   <outputDir>/<id>/memo.md        human note with timestamped anchors
//   <outputDir>/<id>/meta.json      machine-readable record for the panel/tools
//
// There is no separate index file: listMemos() scans the directory, so a memo
// copied in or removed by hand is reflected without a rebuild step.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { encodeWav, parseWav, resample } from './pcm.cjs'
import { renderWaveformPng } from './png.js'
import { formatDateTime, renderMemoMarkdown } from './notes.js'

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,80}$/

export function normalizeId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null
}

export function makeMemoId(date) {
  const when = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  const pad = (value) => (value < 10 ? '0' + value : String(value))
  const stamp =
    when.getFullYear() + pad(when.getMonth() + 1) + pad(when.getDate()) + '-' +
    pad(when.getHours()) + pad(when.getMinutes()) + pad(when.getSeconds())
  const suffix = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
  return stamp + '-' + suffix
}

function writeAtomic(path, data) {
  const temporary = path + '.tmp-' + process.pid
  writeFileSync(temporary, data)
  renameSync(temporary, path)
}

function readMeta(dir, id) {
  const path = join(dir, id, 'meta.json')
  const text = readFileSync(path, 'utf8')
  const meta = JSON.parse(text)
  if (meta === null || typeof meta !== 'object' || meta.id !== id) throw new Error('memo meta is invalid: ' + path)
  return meta
}

export function listMemos(dir) {
  if (typeof dir !== 'string' || dir.length === 0 || !existsSync(dir)) return []
  const entries = readdirSync(dir, { withFileTypes: true })
  const memos = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const id = normalizeId(entry.name)
    if (id === null) continue
    try {
      memos.push(readMeta(dir, id))
    } catch (error) {
      // A half-written or hand-edited directory must not hide the rest.
    }
  }
  memos.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return memos
}

export function readMemo(dir, id) {
  const safe = normalizeId(id)
  if (safe === null) return null
  try {
    const meta = readMeta(dir, safe)
    const note = readFileSync(join(dir, safe, 'memo.md'), 'utf8')
    return { meta: meta, note: note }
  } catch (error) {
    return null
  }
}

export function memoPaths(dir, id) {
  const safe = normalizeId(id)
  if (safe === null) return null
  return {
    dir: join(dir, safe),
    audio: join(dir, safe, 'audio.wav'),
    waveform: join(dir, safe, 'waveform.png'),
    note: join(dir, safe, 'memo.md'),
    meta: join(dir, safe, 'meta.json'),
  }
}

export function createMemo(options) {
  const opts = options || {}
  if (typeof opts.dir !== 'string' || opts.dir.length === 0) throw new Error('memo output directory is required')
  if (opts.wav === undefined || opts.wav === null) throw new Error('memo audio is required')

  const parsed = parseWav(opts.wav)
  if (parsed.durationSec <= 0.05) throw new Error('recording is too short to archive')

  const createdAt = opts.createdAt instanceof Date ? opts.createdAt : new Date()
  const id = normalizeId(opts.id) || makeMemoId(createdAt)
  const directory = join(opts.dir, id)
  if (existsSync(directory)) throw new Error('memo id already exists: ' + id)

  const samples = resample(parsed.samples, parsed.sampleRate, 16000)
  const wav = encodeWav(samples, 16000)
  const durationSec = Math.round((samples.length / 16000) * 1000) / 1000
  const transcript = opts.transcript && typeof opts.transcript === 'object' ? opts.transcript : null
  const segments = Array.isArray(transcript && transcript.segments) ? transcript.segments : []
  const text = transcript && typeof transcript.text === 'string'
    ? transcript.text
    : segments.map((segment) => segment.text).join('')

  const meta = {
    id: id,
    title: typeof opts.title === 'string' && opts.title.trim().length > 0
      ? opts.title.trim()
      : (segments.length > 0 ? '' : '口述 ' + formatDateTime(createdAt)),
    createdAt: createdAt.toISOString(),
    createdLocal: formatDateTime(createdAt),
    durationSec: durationSec,
    sampleRate: 16000,
    channels: 1,
    language: typeof opts.language === 'string' && opts.language.length > 0 ? opts.language : 'zh',
    source: opts.source === 'tool' || opts.source === 'import' ? opts.source : 'panel',
    engine: transcript && transcript.engine ? transcript.engine : null,
    status: transcript && typeof transcript.status === 'string' ? transcript.status : 'transcription-unavailable',
    reason: transcript && typeof transcript.reason === 'string' ? transcript.reason : '',
    segments: segments.map((segment, index) => ({
      index: index,
      start: Math.max(0, Number(segment.start) || 0),
      end: Math.max(0, Number(segment.end) || 0),
      text: String(segment.text || '').trim(),
    })),
    text: text.trim(),
  }
  if (meta.title.length === 0) {
    const first = meta.segments.find((segment) => segment.text.length > 0)
    meta.title = first !== undefined ? first.text : '口述 ' + meta.createdLocal
  }
  if (meta.title.length > 32) meta.title = Array.from(meta.title).slice(0, 32).join('') + '…'

  const waveform = renderWaveformPng(samples, { width: 960, height: 220, durationSec: durationSec })
  const note = renderMemoMarkdown(meta)

  try {
    mkdirSync(opts.dir, { recursive: true })
    mkdirSync(directory, { recursive: false })
    writeFileSync(join(directory, 'audio.wav'), wav)
    writeFileSync(join(directory, 'waveform.png'), waveform)
    writeAtomic(join(directory, 'memo.md'), note)
    meta.bytes = {
      audio: wav.length,
      waveform: waveform.length,
    }
    writeAtomic(join(directory, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  } catch (error) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch (inner) {
      // best effort: the caller still sees the original failure
    }
    throw error
  }

  const paths = memoPaths(opts.dir, id)
  return { meta: meta, dir: directory, paths: paths, note: note }
}

export function memoOutputExists(path) {
  try {
    return statSync(path).isFile()
  } catch (error) {
    return false
  }
}

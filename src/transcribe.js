// Local transcription. Two engines, both fully offline:
//
//   harness  the DSH speechToText service (shipped with the experimental voice
//            input bundle). The service transcribes complete recordings only, so
//            this module splits the canonical WAV on silence, transcribes each
//            window and turns window boundaries into segment timestamps.
//   command  a user-configured local recogniser (see workers/transcribe_faster_whisper.py).
//            It receives a 16 kHz mono WAV path and must print one JSON object
//            with segments that already carry their own timestamps.
//
// Nothing here uploads audio. A missing engine is reported as a status, never
// papered over with invented text.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeWav, dbfs, rms } from './pcm.cjs'

const MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024

export function splitCommand(text) {
  const source = String(text || '')
  const parts = []
  let current = ''
  let quote = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote.length > 0) {
      // Inside quotes only the closing quote (or an escaped quote/backslash) is
      // special; every other backslash is part of a Windows path.
      if (char === '\\' && (source[index + 1] === quote || source[index + 1] === '\\')) {
        current += source[index + 1]
        index += 1
        continue
      }
      if (char === quote) {
        quote = ''
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current.length > 0) parts.push(current)
  return parts
}

export function normalizeCommand(value) {
  if (Array.isArray(value)) {
    return value.filter((part) => typeof part === 'string' && part.trim().length > 0).map((part) => part.trim())
  }
  if (typeof value === 'string' && value.trim().length > 0) return splitCommand(value)
  return []
}

function getSpeech(ctx) {
  try {
    return typeof ctx.get === 'function' ? ctx.get('speechToText') : undefined
  } catch (error) {
    return undefined
  }
}

function harnessProvider(speech) {
  if (speech === undefined || speech === null || typeof speech.listProviders !== 'function') return null
  try {
    const providers = speech.listProviders() || []
    return providers.find((provider) => provider.location === 'host-local') || providers[0] || null
  } catch (error) {
    return null
  }
}

function describeEngines(harness, command) {
  const parts = []
  if (harness !== null) parts.push('DSH speechToText（' + harness.name + '）')
  if (command.length > 0) parts.push('本地命令 ' + command[0])
  return parts
}

// Read-only engine description for the panel and for diagnostics.
export function engineStatus(ctx, config) {
  const asr = config && config.asr ? config.asr : {}
  const speech = getSpeech(ctx)
  const harness = harnessProvider(speech)
  const command = normalizeCommand(asr.command)
  const mode = ['auto', 'harness', 'command', 'off'].includes(asr.mode) ? asr.mode : 'auto'

  let kind = 'none'
  if (mode === 'off') kind = 'none'
  else if (mode === 'harness') kind = harness !== null ? 'harness' : 'none'
  else if (mode === 'command') kind = command.length > 0 ? 'command' : 'none'
  else if (harness !== null) kind = 'harness'
  else if (command.length > 0) kind = 'command'

  const description = describeEngines(harness, command)
  return {
    mode: mode,
    kind: kind,
    available: kind !== 'none',
    harness: harness === null ? null : { id: harness.id, name: harness.name, languages: harness.languages || [] },
    command: command,
    label: kind === 'harness' ? '本地识别 · ' + harness.name : kind === 'command' ? '本地命令识别' : '未配置本地识别引擎',
    detail: kind === 'none'
      ? (description.length > 0 ? '配置了 ' + description.join(' / ') + '，但当前模式没有可用的引擎' : '没有可用的本地识别引擎：需要配置 asr.command，或启用带 speechToText 服务的语音输入插件')
      : description.join(' / '),
  }
}

// Split canonical WAV samples into speech windows using short-frame RMS. The
// timestamps of the returned windows become the segment timestamps for the
// harness engine. A recording with no detected speech becomes one window so the
// recogniser still gets a chance to return something.
export function speechWindows(samples, sampleRate, options) {
  const opts = options || {}
  const maxSec = Number.isFinite(opts.maxSec) ? Math.max(2, opts.maxSec) : 20
  const minSpeechSec = Number.isFinite(opts.minSpeechSec) ? opts.minSpeechSec : 0.24
  const minSilenceSec = Number.isFinite(opts.minSilenceSec) ? opts.minSilenceSec : 0.32
  const padSec = Number.isFinite(opts.padSec) ? opts.padSec : 0.12
  const frameSec = 0.02
  const frame = Math.max(1, Math.round(sampleRate * frameSec))
  const duration = samples.length / sampleRate
  if (duration <= 0) return []

  const levels = []
  for (let start = 0; start < samples.length; start += frame) {
    levels.push(dbfs(rms(samples, start, Math.min(samples.length, start + frame))))
  }
  const sorted = levels.slice().sort((a, b) => a - b)
  const noiseFloor = sorted[Math.floor(sorted.length * 0.1)] ?? -96
  const threshold = Math.min(-24, Math.max(-52, noiseFloor + 9))

  const minSpeechFrames = Math.max(1, Math.round(minSpeechSec / frameSec))
  const minSilenceFrames = Math.max(1, Math.round(minSilenceSec / frameSec))

  const raw = []
  let currentStart = -1
  let silenceRun = 0
  for (let index = 0; index < levels.length; index += 1) {
    const active = levels[index] >= threshold
    if (active) {
      if (currentStart < 0) currentStart = index
      silenceRun = 0
      continue
    }
    if (currentStart < 0) continue
    silenceRun += 1
    if (silenceRun >= minSilenceFrames) {
      const end = index - silenceRun + 1
      if (end - currentStart >= minSpeechFrames) raw.push([currentStart, end])
      currentStart = -1
      silenceRun = 0
    }
  }
  if (currentStart >= 0) {
    const end = levels.length
    if (end - currentStart >= minSpeechFrames) raw.push([currentStart, end])
  }

  const windows = []
  for (const [startFrame, endFrame] of raw) {
    let start = Math.max(0, startFrame * frameSec - padSec)
    let end = Math.min(duration, endFrame * frameSec + padSec)
    while (end - start > maxSec) {
      windows.push({ start: round3(start), end: round3(start + maxSec) })
      start = start + maxSec
      end = Math.min(duration, end)
    }
    if (end - start >= Math.min(minSpeechSec, 0.1)) windows.push({ start: round3(start), end: round3(end) })
  }

  if (windows.length === 0) return [{ start: 0, end: round3(Math.min(duration, maxSec)) }]
  return windows
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}

export function parseWorkerOutput(stdout) {
  const text = String(stdout || '').trim()
  if (text.length === 0) throw new Error('识别命令没有输出')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('识别命令的输出不是 JSON')
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch (inner) {
      throw new Error('识别命令的输出不是合法 JSON')
    }
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('识别命令返回的不是 JSON 对象')
  if (!Array.isArray(parsed.segments)) throw new Error('识别结果缺少 segments 数组')

  const segments = []
  for (const raw of parsed.segments) {
    if (raw === null || typeof raw !== 'object') continue
    const start = Number(raw.start)
    const end = Number(raw.end)
    const value = typeof raw.text === 'string' ? raw.text.trim() : ''
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
    if (value.length === 0) continue
    segments.push({ start: round3(Math.max(0, start)), end: round3(Math.max(0, end)), text: value })
  }
  segments.sort((a, b) => a.start - b.start)
  return {
    engine: {
      kind: 'command',
      name: typeof parsed.engine === 'string' && parsed.engine.length > 0 ? parsed.engine : 'local-command',
      model: typeof parsed.model === 'string' && parsed.model.length > 0 ? parsed.model : undefined,
    },
    language: typeof parsed.language === 'string' && parsed.language.length > 0 ? parsed.language : undefined,
    segments: segments,
    text: typeof parsed.text === 'string' && parsed.text.trim().length > 0
      ? parsed.text.trim()
      : segments.map((segment) => segment.text).join(''),
  }
}

function runCommand(command, wavPath, options) {
  const opts = options || {}
  const args = command.slice(1)
  args.push(wavPath)
  if (opts.language) args.push('--language', opts.language)
  const timeoutMs = Math.max(1000, Math.round((Number(opts.timeoutSec) || 120) * 1000))

  return new Promise((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let child
    try {
      // Python on a Chinese-locale Windows writes its pipe output in cp936
      // unless told otherwise; the worker contract is UTF-8 JSON.
      const env = Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })
      child = spawn(command[0], args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: env })
    } catch (error) {
      reject(new Error('无法启动识别命令：' + ((error && error.message) || error)))
      return
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch (error) {
        // already gone
      }
      reject(new Error('识别命令超时（' + Math.round(timeoutMs / 1000) + ' 秒）'))
    }, timeoutMs)

    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }

    child.stdout.on('data', (chunk) => {
      if (stdout.length > MAX_STDOUT_BYTES) return
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length > MAX_STDERR_BYTES) return
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish(new Error('识别命令无法运行：' + ((error && error.message) || error)))
    })
    child.on('close', (code) => {
      if (code === 0) {
        finish(null, { stdout: stdout, stderr: stderr })
        return
      }
      const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' ')
      finish(new Error('识别命令退出码 ' + code + (tail.length > 0 ? '：' + tail : '')))
    })
  })
}

async function commandEngine(ctx, config, wav, options) {
  const command = normalizeCommand(config.asr && config.asr.command)
  if (command.length === 0) throw new Error('没有配置 asr.command')
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-voice-memo-'))
  try {
    const wavPath = join(workdir, 'memo.wav')
    writeFileSync(wavPath, wav)
    const result = await runCommand(command, wavPath, {
      language: options.language,
      timeoutSec: config.asr.timeoutSec,
    })
    return parseWorkerOutput(result.stdout)
  } finally {
    try {
      rmSync(workdir, { recursive: true, force: true })
    } catch (error) {
      // a leftover temp directory is not worth failing a transcription over
    }
  }
}

async function harnessEngine(ctx, config, parsed, wav, options) {
  const speech = getSpeech(ctx)
  const provider = harnessProvider(speech)
  if (provider === null) throw new Error('speechToText 没有注册本地识别提供方')
  const signal = options.signal || new AbortController().signal
  const windows = speechWindows(parsed.samples, parsed.sampleRate, { maxSec: 20 })
  const segments = []
  let audioSeconds = 0
  let inferenceSeconds = 0
  for (const window of windows) {
    signal.throwIfAborted()
    const from = Math.floor(window.start * parsed.sampleRate)
    const to = Math.min(parsed.samples.length, Math.ceil(window.end * parsed.sampleRate))
    const slice = parsed.samples.subarray(from, to)
    if (slice.length === 0) continue
    const spec = speech.resolve({
      audio: encodeWav(slice, parsed.sampleRate),
      language: options.language,
      providerId: config.asr && config.asr.providerId ? config.asr.providerId : provider.id,
    })
    const transcript = await speech.transcribe(spec, signal)
    const text = transcript && typeof transcript.text === 'string' ? transcript.text.trim() : ''
    if (Number.isFinite(transcript && transcript.audioSeconds)) audioSeconds += transcript.audioSeconds
    if (Number.isFinite(transcript && transcript.inferenceSeconds)) inferenceSeconds += transcript.inferenceSeconds
    if (text.length === 0) continue
    segments.push({ start: round3(window.start), end: round3(window.end), text: text })
  }
  const engine = { kind: 'harness', name: provider.name, provider: String(provider.id) }
  return {
    engine: engine,
    language: options.language,
    segments: segments,
    text: segments.map((segment) => segment.text).join(''),
    audioSeconds: audioSeconds,
    inferenceSeconds: inferenceSeconds,
  }
}

// Transcribe one canonical WAV. Returns a transcript-shaped object whose status
// is what the note records; engine failures are statuses, not fabricated text.
export async function transcribeAudio(options) {
  const opts = options || {}
  const config = opts.config || {}
  const parsed = opts.parsed
  if (parsed === undefined || parsed === null) throw new Error('transcribeAudio requires parsed WAV samples')
  const wav = opts.wav
  const status = engineStatus(opts.ctx, config)
  const language = opts.language || (config.language || 'zh')

  if (status.kind === 'none') {
    return {
      status: 'transcription-unavailable',
      reason: status.detail,
      engine: null,
      segments: [],
      text: '',
    }
  }

  try {
    const result = status.kind === 'harness'
      ? await harnessEngine(opts.ctx, config, parsed, wav, { language: language, signal: opts.signal })
      : await commandEngine(opts.ctx, config, wav, { language: language, signal: opts.signal })
    if (result.segments.length === 0) {
      return {
        status: 'empty-speech',
        reason: '本地识别没有产出分段文本',
        engine: result.engine,
        segments: [],
        text: '',
      }
    }
    return {
      status: 'transcribed',
      reason: '',
      engine: result.engine,
      language: result.language || language,
      segments: result.segments,
      text: result.text,
      metrics: {
        audioSeconds: result.audioSeconds,
        inferenceSeconds: result.inferenceSeconds,
      },
    }
  } catch (error) {
    const message = String((error && error.message) || error)
    return {
      status: 'transcription-failed',
      reason: message,
      engine: status.kind === 'harness' && status.harness ? { kind: 'harness', name: status.harness.name } : { kind: 'command', name: 'local-command' },
      segments: [],
      text: '',
    }
  }
}

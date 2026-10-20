// Transcription tests. Two engines are pinned here without any model download:
// the command engine against a fake local recogniser, and the speechToText
// engine against a stub service that mirrors the real listener contract.

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeWav, parseWav } from '../src/pcm.cjs'
import {
  engineStatus,
  parseWorkerOutput,
  normalizeCommand,
  splitCommand,
  speechWindows,
  transcribeAudio,
} from '../src/transcribe.js'

function sine(seconds, sampleRate, frequency, amplitude) {
  const count = Math.round(seconds * sampleRate)
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i += 1) samples[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * (amplitude === undefined ? 0.5 : amplitude)
  return samples
}

const NO_SERVICE = { get() { return undefined } }

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'voice-memo-asr-'))
}

test('splitCommand keeps quoted arguments together', () => {
  assert.deepEqual(splitCommand('python worker.py --model small'), ['python', 'worker.py', '--model', 'small'])
  assert.deepEqual(splitCommand('"C:\\Program Files\\Python\\python.exe" w.py --x "a b"'), [
    'C:\\Program Files\\Python\\python.exe',
    'w.py',
    '--x',
    'a b',
  ])
  assert.deepEqual(splitCommand("  python   'a b c'  "), ['python', 'a b c'])
  assert.deepEqual(normalizeCommand(['  node ', '', 'x.mjs']), ['node', 'x.mjs'])
  assert.deepEqual(normalizeCommand(''), [])
  assert.deepEqual(normalizeCommand(null), [])
})

test('engineStatus reports an honest "none" when nothing is configured', () => {
  const status = engineStatus(NO_SERVICE, { asr: { mode: 'auto', command: null } })
  assert.equal(status.kind, 'none')
  assert.equal(status.available, false)
  assert.match(status.detail, /没有可用的本地识别引擎/)
})

test('engineStatus prefers the harness provider in auto mode and honours the mode', () => {
  const speech = {
    listProviders() {
      return [
        { id: 'remote', name: 'Remote', location: 'remote', languages: ['zh'] },
        { id: 'local', name: 'SenseVoice', location: 'host-local', languages: ['zh'] },
      ]
    },
  }
  const ctx = { get(name) { return name === 'speechToText' ? speech : undefined } }
  const auto = engineStatus(ctx, { asr: { mode: 'auto', command: 'python worker.py' } })
  assert.equal(auto.kind, 'harness')
  assert.equal(auto.harness.id, 'local')
  assert.equal(engineStatus(ctx, { asr: { mode: 'command', command: 'python worker.py' } }).kind, 'command')
  assert.equal(engineStatus(ctx, { asr: { mode: 'off' } }).kind, 'none')
  assert.equal(engineStatus(ctx, { asr: { mode: 'harness' } }).kind, 'harness')
})

test('speechWindows splits on silence and keeps the speech', () => {
  const sampleRate = 16000
  const quiet = new Float32Array(sampleRate / 2) // 0.5 s silence, longer than minSilenceSec
  const speech = sine(1, sampleRate, 220, 0.4)
  const samples = new Float32Array(
    Array.from(quiet).concat(Array.from(speech), Array.from(quiet), Array.from(speech), Array.from(quiet)),
  )
  const windows = speechWindows(samples, sampleRate, { maxSec: 20 })
  assert.equal(windows.length, 2)
  assert.ok(windows[0].start < 0.5 && windows[0].end > 1.0, JSON.stringify(windows[0]))
  assert.ok(windows[1].start > windows[0].end)
})

test('speechWindows returns one window for a recording with no detectable speech', () => {
  const windows = speechWindows(new Float32Array(16000), 16000)
  assert.equal(windows.length, 1)
  assert.equal(windows[0].start, 0)
})

test('parseWorkerOutput accepts JSON with log noise before it', () => {
  const parsed = parseWorkerOutput('loading model...\n{"engine":"faster-whisper","model":"small","segments":[{"start":1.2,"end":0.4,"text":" drop "},{"start":0,"end":1,"text":"keep"}]}')
  assert.equal(parsed.engine.name, 'faster-whisper')
  assert.equal(parsed.engine.model, 'small')
  assert.deepEqual(parsed.segments, [{ start: 0, end: 1, text: 'keep' }])
  assert.equal(parsed.text, 'keep')
})

test('parseWorkerOutput rejects a worker that prints nothing useful', () => {
  assert.throws(() => parseWorkerOutput(''), /没有输出/)
  assert.throws(() => parseWorkerOutput('all good'), /不是 JSON/)
  assert.throws(() => parseWorkerOutput('{"segments":{}}'), /segments 数组/)
})

test('the command engine runs a local recogniser and maps its segments', async () => {
  const dir = tempDir()
  try {
    const worker = join(dir, 'fake-asr.mjs')
    writeFileSync(worker, [
      "const payload = { engine: 'fake-asr', model: 'unit', language: 'zh',",
      "  segments: [{ start: 0, end: 0.5, text: '你好。' }, { start: 0.5, end: 1.2, text: '这是测试。' }] }",
      'process.stdout.write(JSON.stringify(payload))',
      '',
    ].join('\n'))
    const wav = encodeWav(sine(1.2, 16000, 220), 16000)
    const parsed = parseWav(wav)
    const result = await transcribeAudio({
      ctx: NO_SERVICE,
      config: { asr: { mode: 'command', command: ['node', worker], timeoutSec: 10 }, language: 'zh' },
      parsed: { samples: parsed.samples, sampleRate: parsed.sampleRate },
      wav: wav,
      language: 'zh',
    })
    assert.equal(result.status, 'transcribed')
    assert.equal(result.engine.name, 'fake-asr')
    assert.equal(result.segments.length, 2)
    assert.equal(result.text, '你好。这是测试。')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failing command becomes transcription-failed with its reason', async () => {
  const dir = tempDir()
  try {
    const worker = join(dir, 'fail-asr.mjs')
    writeFileSync(worker, "process.stderr.write('model missing'); process.exit(3)\n")
    const wav = encodeWav(sine(0.8, 16000, 220), 16000)
    const parsed = parseWav(wav)
    const result = await transcribeAudio({
      ctx: NO_SERVICE,
      config: { asr: { mode: 'command', command: ['node', worker], timeoutSec: 10 } },
      parsed: { samples: parsed.samples, sampleRate: parsed.sampleRate },
      wav: wav,
    })
    assert.equal(result.status, 'transcription-failed')
    assert.match(result.reason, /退出码 3/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a hung command is killed and reported as a timeout', async () => {
  const dir = tempDir()
  try {
    const worker = join(dir, 'hang-asr.mjs')
    writeFileSync(worker, 'setTimeout(() => {}, 5000)\n')
    const wav = encodeWav(sine(0.8, 16000, 220), 16000)
    const parsed = parseWav(wav)
    const started = Date.now()
    const result = await transcribeAudio({
      ctx: NO_SERVICE,
      config: { asr: { mode: 'command', command: ['node', worker], timeoutSec: 1 } },
      parsed: { samples: parsed.samples, sampleRate: parsed.sampleRate },
      wav: wav,
    })
    assert.equal(result.status, 'transcription-failed')
    assert.match(result.reason, /超时/)
    assert.ok(Date.now() - started < 4000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the harness engine transcribes speech windows through speechToText', async () => {
  const calls = []
  const speech = {
    listProviders() {
      return [{ id: 'local', name: 'SenseVoice', location: 'host-local', languages: ['zh'] }]
    },
    resolve(request) {
      return { provider: { id: 'local' }, audio: request.audio, language: request.language }
    },
    async transcribe(spec) {
      calls.push(spec.audio.length)
      assert.equal(spec.language, 'zh')
      return { text: '本地识别文本。', audioSeconds: 1, inferenceSeconds: 0.2 }
    },
  }
  const ctx = { get(name) { return name === 'speechToText' ? speech : undefined } }
  const wav = encodeWav(sine(1, 16000, 220, 0.5), 16000)
  const parsed = parseWav(wav)
  const result = await transcribeAudio({
    ctx: ctx,
    config: { asr: { mode: 'harness', providerId: 'local' }, language: 'zh' },
    parsed: { samples: parsed.samples, sampleRate: parsed.sampleRate },
    wav: wav,
    language: 'zh',
  })
  assert.equal(result.status, 'transcribed')
  assert.equal(result.engine.name, 'SenseVoice')
  assert.equal(result.segments.length, 1)
  assert.equal(result.segments[0].text, '本地识别文本。')
  assert.ok(calls.length >= 1)
  assert.ok(calls[0] > 44)
})

test('the harness engine surfaces a provider failure instead of inventing text', async () => {
  const speech = {
    listProviders() {
      return [{ id: 'local', name: 'SenseVoice', location: 'host-local', languages: ['zh'] }]
    },
    resolve(request) {
      return { provider: { id: 'local' }, audio: request.audio, language: request.language }
    },
    async transcribe() {
      throw new Error('provider crashed')
    },
  }
  const ctx = { get(name) { return name === 'speechToText' ? speech : undefined } }
  const wav = encodeWav(sine(0.5, 16000, 220), 16000)
  const parsed = parseWav(wav)
  const result = await transcribeAudio({
    ctx: ctx,
    config: { asr: { mode: 'harness' }, language: 'zh' },
    parsed: { samples: parsed.samples, sampleRate: parsed.sampleRate },
    wav: wav,
  })
  assert.equal(result.status, 'transcription-failed')
  assert.match(result.reason, /provider crashed/)
  assert.deepEqual(result.segments, [])
  assert.equal(result.text, '')
})

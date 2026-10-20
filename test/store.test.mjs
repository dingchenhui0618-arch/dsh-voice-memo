// Store tests: one directory per memo, canonical audio, deterministic files,
// and a list that survives a hand-edited directory.

import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeWav, parseWav } from '../src/pcm.cjs'
import { createMemo, listMemos, memoPaths, normalizeId, readMemo } from '../src/store.js'

function sine(seconds, sampleRate, frequency) {
  const count = Math.round(seconds * sampleRate)
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i += 1) samples[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.4
  return samples
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'voice-memo-store-'))
}

const TRANSCRIPT = {
  status: 'transcribed',
  reason: '',
  engine: { kind: 'command', name: 'faster-whisper', model: 'small' },
  segments: [
    { start: 0, end: 0.6, text: '第一段。' },
    { start: 0.6, end: 1.2, text: '第二段。' },
  ],
  text: '第一段。第二段。',
}

test('createMemo writes audio, waveform, note and meta, then lists and reads them', () => {
  const dir = tempDir()
  try {
    const wav = encodeWav(sine(1.2, 44100, 330), 16000, { resampleFrom: 44100 })
    const created = createMemo({
      dir: dir,
      wav: wav,
      transcript: TRANSCRIPT,
      title: '测试录音',
      language: 'zh',
      createdAt: new Date('2026-10-20T02:45:32.000Z'),
      id: '20261020-104532-aaaa',
    })
    assert.equal(created.meta.id, '20261020-104532-aaaa')
    assert.equal(created.meta.status, 'transcribed')
    assert.equal(created.meta.segments.length, 2)
    assert.ok(created.meta.title.length > 0)
    assert.ok(Math.abs(created.meta.durationSec - 1.2) < 0.01)

    const files = ['audio.wav', 'waveform.png', 'memo.md', 'meta.json']
    for (const file of files) assert.ok(existsSync(join(dir, created.meta.id, file)), file)

    // The archived audio is canonical: 16 kHz mono PCM16 no matter what came in.
    const archived = parseWav(readFileSync(join(dir, created.meta.id, 'audio.wav')))
    assert.equal(archived.sampleRate, 16000)
    assert.equal(archived.channels, 1)
    assert.ok(archived.samples.length > 18000)

    const note = readFileSync(join(dir, created.meta.id, 'memo.md'), 'utf8')
    assert.match(note, /# 测试录音/)
    assert.match(note, /第一段。/)
    assert.match(note, /status: transcribed/)

    const listing = listMemos(dir)
    assert.equal(listing.length, 1)
    assert.equal(listing[0].id, created.meta.id)
    assert.equal(listing[0].title, '测试录音')

    const read = readMemo(dir, created.meta.id)
    assert.equal(read.meta.id, created.meta.id)
    assert.match(read.note, /memo\.md#seg-1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createMemo derives a title from the first segment when none is given', () => {
  const dir = tempDir()
  try {
    const created = createMemo({
      dir: dir,
      wav: encodeWav(sine(0.6, 16000, 220), 16000),
      transcript: TRANSCRIPT,
      createdAt: new Date('2026-10-20T02:45:32.000Z'),
    })
    assert.equal(created.meta.title, '第一段。')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createMemo records a missing engine as a status, never as text', () => {
  const dir = tempDir()
  try {
    const created = createMemo({
      dir: dir,
      wav: encodeWav(sine(0.6, 16000, 220), 16000),
      transcript: { status: 'transcription-unavailable', reason: '没有可用的本地识别引擎', segments: [], text: '' },
      createdAt: new Date('2026-10-20T02:45:32.000Z'),
    })
    assert.equal(created.meta.status, 'transcription-unavailable')
    assert.equal(created.meta.text, '')
    const note = readFileSync(created.paths.note, 'utf8')
    assert.match(note, /没有可用的本地识别引擎/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listMemos tolerates a broken directory and ignores names that are not ids', () => {
  const dir = tempDir()
  try {
    createMemo({
      dir: dir,
      wav: encodeWav(sine(0.5, 16000, 220), 16000),
      transcript: TRANSCRIPT,
      createdAt: new Date('2026-10-20T02:45:32.000Z'),
      id: '20261020-104532-ab12',
    })
    writeFileSync(join(dir, 'not-a-memo.txt'), 'x')
    rmSync(join(dir, '20261020-104532-ab12', 'meta.json'), { force: true })
    assert.deepEqual(listMemos(dir), [])
    assert.deepEqual(listMemos(join(dir, 'missing')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ids are validated so a memo path can never escape the archive', () => {
  assert.equal(normalizeId('20261020-104532-ab12'), '20261020-104532-ab12')
  assert.equal(normalizeId('../etc'), null)
  assert.equal(normalizeId('a/b'), null)
  assert.equal(normalizeId('UPPER'), null)
  assert.equal(normalizeId(''), null)
  assert.equal(readMemo(tempDir(), '../../etc'), null)
})

test('createMemo refuses an empty recording and duplicate ids', () => {
  const dir = tempDir()
  try {
    assert.throws(() => createMemo({ dir: dir, wav: encodeWav(new Float32Array(0), 16000), transcript: TRANSCRIPT }), /no complete sample frame|too short/)
    const first = createMemo({
      dir: dir,
      wav: encodeWav(sine(0.5, 16000, 220), 16000),
      transcript: TRANSCRIPT,
      createdAt: new Date('2026-10-20T02:45:32.000Z'),
    })
    assert.throws(() => createMemo({
      dir: dir,
      wav: encodeWav(sine(0.5, 16000, 220), 16000),
      transcript: TRANSCRIPT,
      id: first.meta.id,
      createdAt: new Date('2026-10-20T02:45:32.000Z'),
    }), /already exists/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memoPaths returns the four files of one memo', () => {
  const paths = memoPaths('D:\\memos', '20261020-104532-ab12')
  assert.equal(paths.note, join('D:\\memos', '20261020-104532-ab12', 'memo.md'))
  assert.equal(memoPaths('D:\\memos', '../x'), null)
})

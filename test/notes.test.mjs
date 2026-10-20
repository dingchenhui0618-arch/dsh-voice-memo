// Note rendering tests. memo.md is the artefact a user quotes into a delivery
// document, so its timestamp anchors and frontmatter are pinned here.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  formatClock,
  formatSpan,
  formatDuration,
  formatDateTime,
  excerptTitle,
  engineLabel,
  statusLabel,
  quoteSegment,
  renderMemoMarkdown,
} from '../src/notes.js'

function meta(overrides) {
  return Object.assign({
    id: '20261020-104532-ab12',
    title: '开场白与结论',
    createdAt: '2026-10-20T02:45:32.000Z',
    createdLocal: '2026-10-20 10:45:32 +08:00',
    durationSec: 4.25,
    language: 'zh',
    engine: { kind: 'command', name: 'faster-whisper', model: 'small' },
    status: 'transcribed',
    reason: '',
    segments: [
      { start: 0, end: 2.4, text: '先讲结论：这个方案今天可以落地。' },
      { start: 2.4, end: 4.25, text: '剩下的细节明天补。' },
    ],
    text: '先讲结论：这个方案今天可以落地。剩下的细节明天补。',
  }, overrides || {})
}

test('formats clocks, spans and durations for humans', () => {
  assert.equal(formatClock(0), '00:00')
  assert.equal(formatClock(65), '01:05')
  assert.equal(formatClock(3.44, true), '00:03.4')
  assert.equal(formatClock(65.06, true), '01:05.1')
  assert.equal(formatSpan({ start: 0.96, end: 2.44 }), '00:01.0–00:02.4')
  assert.equal(formatDuration(4.25), '4.3 秒')
  assert.equal(formatDuration(64), '1 分 04 秒')
  assert.match(formatDateTime('2026-10-20T02:45:32.000Z'), /^2026-10-20 \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/)
  assert.equal(formatDateTime('not a date'), '—')
})

test('excerptTitle collapses whitespace and truncates on characters', () => {
  assert.equal(excerptTitle('  你好\n世界  '), '你好 世界')
  assert.equal(excerptTitle(''), '')
  const long = excerptTitle('一二三四五六七八九十', 4)
  assert.equal(long, '一二三四…')
})

test('labels fall back instead of printing undefined', () => {
  assert.equal(engineLabel(null), '无')
  assert.equal(engineLabel({ kind: 'harness', name: 'SenseVoice' }), 'SenseVoice')
  assert.equal(engineLabel({ name: 'faster-whisper', model: 'small' }), 'faster-whisper（small）')
  assert.equal(statusLabel('transcribed'), '已转写')
  assert.equal(statusLabel('transcription-unavailable'), '未转写（本地引擎不可用）')
  assert.equal(statusLabel('something-new'), 'something-new')
})

test('renderMemoMarkdown writes frontmatter, a table, segment anchors and quotes', () => {
  const note = renderMemoMarkdown(meta())
  assert.match(note, /^---\nid: 20261020-104532-ab12\n/)
  assert.match(note, /created: 2026-10-20T02:45:32\.000Z/)
  assert.match(note, /duration: 4\.25/)
  assert.match(note, /status: transcribed/)
  assert.match(note, /engine: faster-whisper/)
  assert.match(note, /\n# 开场白与结论\n/)
  assert.match(note, /\| 语言 \| 中文（zh） \|/)
  assert.match(note, /\| 识别引擎 \| faster-whisper（small） \|/)
  assert.match(note, /!\[波形\]\(waveform\.png\)/)
  assert.match(note, /<a id="seg-1"><\/a>/)
  assert.match(note, /<a id="seg-2"><\/a>/)
  assert.match(note, /### 00:00\.0–00:02\.4/)
  assert.match(note, /先讲结论：这个方案今天可以落地。/)
  assert.match(note, /## 引用/)
  assert.match(note, /—— 口述笔记 2026-10-20 10:45:32 \+08:00 · 00:00\.0–00:02\.4/)
  assert.match(note, /memo\.md#seg-1/)
})

test('renderMemoMarkdown explains a memo without transcript instead of faking text', () => {
  const note = renderMemoMarkdown(meta({
    status: 'transcription-unavailable',
    reason: '没有可用的本地识别引擎',
    segments: [],
    text: '',
    engine: null,
  }))
  assert.match(note, /未转写（本地引擎不可用） — 没有可用的本地识别引擎/)
  assert.match(note, /没有可用的分段文本：没有可用的本地识别引擎/)
  assert.doesNotMatch(note, /## 全文/)
  assert.doesNotMatch(note, /## 引用/)
})

test('quoteSegment is ready to paste and points at its anchor', () => {
  const quote = quoteSegment(meta(), { index: 1, start: 2.4, end: 4.25, text: '剩下的细节明天补。' }, 'D:\\Projects\\demo\\voice-memos\\x\\memo.md')
  assert.match(quote, /^> 剩下的细节明天补。\n/)
  assert.match(quote, /00:02\.4–00:04\.3/)
  assert.match(quote, /`D:\\Projects\\demo\\voice-memos\\x\\memo\.md#seg-2`/)
})

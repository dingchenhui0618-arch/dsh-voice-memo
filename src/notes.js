// Markdown rendering for one memo. Kept separate from storage so tests can pin
// the exact note text a user will read and quote into a delivery document.

const STATUS_LABEL = {
  transcribed: '已转写',
  'empty-speech': '未检出语音',
  'transcription-unavailable': '未转写（本地引擎不可用）',
  'transcription-failed': '转写失败',
}

const LANGUAGE_LABEL = {
  zh: '中文',
  en: 'English',
  auto: '自动',
}

export function pad(value, width) {
  let text = String(Math.max(0, Math.floor(value)))
  while (text.length < width) text = '0' + text
  return text
}

// 3.4 -> "00:03"; with tenths -> "00:03.4"
export function formatClock(seconds, withTenths) {
  const value = Math.max(0, Number(seconds) || 0)
  const total = withTenths ? Math.round(value * 10) : Math.round(value)
  const minutes = Math.floor(total / (withTenths ? 600 : 60))
  const rest = total % (withTenths ? 600 : 60)
  if (!withTenths) return pad(minutes, 2) + ':' + pad(rest, 2)
  return pad(minutes, 2) + ':' + pad(Math.floor(rest / 10), 2) + '.' + pad(rest % 10, 1)
}

export function formatSpan(segment) {
  return formatClock(segment.start, true) + '–' + formatClock(segment.end, true)
}

export function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  if (value < 60) return value.toFixed(1) + ' 秒'
  const minutes = Math.floor(value / 60)
  const rest = Math.round(value - minutes * 60)
  return minutes + ' 分 ' + pad(rest, 2) + ' 秒'
}

export function formatDateTime(input) {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return '—'
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const absolute = Math.abs(offset)
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1, 2) + '-' + pad(date.getDate(), 2) +
    ' ' + pad(date.getHours(), 2) + ':' + pad(date.getMinutes(), 2) + ':' + pad(date.getSeconds(), 2) +
    ' ' + sign + pad(Math.floor(absolute / 60), 2) + ':' + pad(absolute % 60, 2)
  )
}

export function excerptTitle(text, max) {
  const limit = Number.isFinite(max) ? max : 28
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (clean.length === 0) return ''
  const chars = Array.from(clean)
  if (chars.length <= limit) return clean
  return chars.slice(0, limit).join('') + '…'
}

export function languageLabel(language) {
  return LANGUAGE_LABEL[language] || language || '自动'
}

export function engineLabel(engine) {
  if (engine === null || engine === undefined) return '无'
  if (typeof engine === 'string') return engine
  const name = engine.name || engine.kind || '未知'
  const model = engine.model ? '（' + engine.model + '）' : ''
  return name + model
}

export function statusLabel(status) {
  return STATUS_LABEL[status] || status || '—'
}

function quoteText(text) {
  return String(text || '').replace(/\r?\n/g, ' ').trim()
}

// One ready-to-paste quote for a delivery document or a chat message.
export function quoteSegment(meta, segment, memoPath) {
  const lines = [
    '> ' + quoteText(segment.text),
    '> —— 口述笔记 ' + (meta.createdLocal || formatDateTime(meta.createdAt)) + ' · ' + formatSpan(segment),
    '>',
    '> 笔记：`' + String(memoPath || 'memo.md') + '#seg-' + (segment.index + 1) + '`',
  ]
  return lines.join('\n')
}

export function renderMemoMarkdown(meta) {
  const title = meta.title || '口述笔记'
  const lines = []
  lines.push('---')
  lines.push('id: ' + meta.id)
  lines.push('created: ' + meta.createdAt)
  lines.push('duration: ' + Number(meta.durationSec).toFixed(2))
  lines.push('language: ' + (meta.language || 'zh'))
  lines.push('engine: ' + (meta.engine && meta.engine.name ? meta.engine.name : 'none'))
  lines.push('status: ' + meta.status)
  lines.push('audio: ' + (meta.audio || 'audio.wav'))
  lines.push('waveform: ' + (meta.waveform || 'waveform.png'))
  lines.push('segments: ' + (Array.isArray(meta.segments) ? meta.segments.length : 0))
  lines.push('---')
  lines.push('')
  lines.push('# ' + title)
  lines.push('')
  lines.push('| 项目 | 值 |')
  lines.push('| --- | --- |')
  lines.push('| 录制时间 | ' + (meta.createdLocal || formatDateTime(meta.createdAt)) + ' |')
  lines.push('| 时长 | ' + formatDuration(meta.durationSec) + ' |')
  lines.push('| 语言 | ' + languageLabel(meta.language) + '（' + (meta.language || 'zh') + '） |')
  lines.push('| 识别引擎 | ' + engineLabel(meta.engine) + ' |')
  lines.push('| 状态 | ' + statusLabel(meta.status) + (meta.reason ? ' — ' + meta.reason : '') + ' |')
  lines.push('| 音频 | [audio.wav](audio.wav) |')
  lines.push('')
  lines.push('![波形](waveform.png)')
  lines.push('')

  const segments = Array.isArray(meta.segments) ? meta.segments : []
  lines.push('## 分段')
  lines.push('')
  if (segments.length === 0) {
    lines.push(meta.status === 'empty-speech'
      ? '整段录音里没有检测到可识别的语音。原始音频与波形仍然保留，可以回听。'
      : '这段录音没有可用的分段文本：' + (meta.reason || '本地识别引擎未产出结果') + '。原始音频与波形仍然保留，可以回听，也可以在配置好本地引擎后重新归档。')
    lines.push('')
  } else {
    segments.forEach((segment, index) => {
      lines.push('<a id="seg-' + (index + 1) + '"></a>')
      lines.push('')
      lines.push('### ' + formatSpan(segment))
      lines.push('')
      lines.push(quoteText(segment.text))
      lines.push('')
    })
  }

  const text = quoteText(meta.text)
  if (text.length > 0) {
    lines.push('## 全文')
    lines.push('')
    lines.push(text)
    lines.push('')
  }

  if (segments.length > 0) {
    lines.push('## 引用')
    lines.push('')
    segments.forEach((segment, index) => {
      lines.push(quoteSegment(meta, { index: index, start: segment.start, end: segment.end, text: segment.text }, 'memo.md'))
      lines.push('')
    })
  }

  lines.push('## 来源')
  lines.push('')
  lines.push('由 dsh-voice-memo 生成。音频、分段文本与波形都留在本机工作区；本插件不向任何服务上传录音。')
  lines.push('')
  return lines.join('\n')
}

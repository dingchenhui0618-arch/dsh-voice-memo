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
const CSS = require('./client-css.cjs')
const PCM = require('./pcm.cjs')

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

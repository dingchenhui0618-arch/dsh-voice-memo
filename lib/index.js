// Host half of dsh-voice-memo.
//
// Responsibilities:
//   1. own the memo archive on disk (audio + waveform + note + meta);
//   2. expose one small JSON API to the panel under /dsh-voice-memo;
//   3. expose the same operations to the agent as voice_memo_save / _list / _read.
//
// The panel and the tools call the same internal api object, so a memo archived
// by an agent tool is exactly the memo the panel lists, and a failure carries the
// same reason in both places.
//
// Transcription never uploads audio: it uses either the local DSH speechToText
// service or a user-configured local command (transcribe.js). An unavailable
// engine is recorded as a status on the memo, not invented as text.

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { encodeWav, parseWav, resample } from './pcm.cjs'
import { createMemo, listMemos, memoPaths, readMemo } from './store.js'
import { engineStatus, transcribeAudio } from './transcribe.js'
import { quoteSegment, formatSpan } from './notes.js'

export const name = 'dsh-voice-memo'
export const inject = ['webServer']

const MAX_BODY_BYTES = 64 * 1024 * 1024
const MAX_MEMOS_IN_STATE = 60

export function resolveConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const asrRaw = raw.asr !== null && typeof raw.asr === 'object' ? raw.asr : {}
  const modes = ['auto', 'harness', 'command', 'off']
  return {
    outputDir: typeof raw.outputDir === 'string' && raw.outputDir.trim().length > 0 ? raw.outputDir.trim() : 'voice-memos',
    language: typeof raw.language === 'string' && raw.language.trim().length > 0 ? raw.language.trim() : 'zh',
    maxDurationSec: Number.isFinite(raw.maxDurationSec) && raw.maxDurationSec > 0 ? raw.maxDurationSec : 600,
    maxAudioBytes: Number.isFinite(raw.maxAudioBytes) && raw.maxAudioBytes > 0 ? raw.maxAudioBytes : 20 * 1024 * 1024,
    waveform: {
      width: Number.isFinite(raw.waveform && raw.waveform.width) ? raw.waveform.width : 960,
      height: Number.isFinite(raw.waveform && raw.waveform.height) ? raw.waveform.height : 220,
    },
    asr: {
      mode: modes.includes(asrRaw.mode) ? asrRaw.mode : 'auto',
      command: asrRaw.command === undefined ? null : asrRaw.command,
      providerId: typeof asrRaw.providerId === 'string' && asrRaw.providerId.length > 0 ? asrRaw.providerId : null,
      timeoutSec: Number.isFinite(asrRaw.timeoutSec) && asrRaw.timeoutSec > 0 ? asrRaw.timeoutSec : 120,
    },
  }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function sendBytes(res, status, type, bytes) {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.setHeader('cache-control', 'no-store')
  res.end(Buffer.from(bytes))
}

function readBody(req, limit) {
  const maximum = limit || MAX_BODY_BYTES
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maximum) {
        rejectPromise(new Error('请求体过大（超过 ' + Math.round(maximum / 1024 / 1024) + ' MB）'))
        try {
          req.destroy()
        } catch (error) {
          // connection already gone
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', (error) => rejectPromise(error))
  })
}

function getService(ctx, serviceName) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined
  } catch (error) {
    return undefined
  }
}

function defaultRoot(ctx) {
  const workingDirectory = getService(ctx, 'workingDirectory')
  if (workingDirectory !== undefined && workingDirectory !== null && typeof workingDirectory.defaultDirectory === 'string') {
    return workingDirectory.defaultDirectory
  }
  return process.cwd()
}

function sessionRoot(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  const sessions = getService(ctx, 'sessions')
  const workingDirectory = getService(ctx, 'workingDirectory')
  if (sessions === undefined || sessions === null || workingDirectory === undefined || workingDirectory === null) return null
  try {
    const session = typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    if (session === undefined || session === null) return null
    return workingDirectory.get(session) || null
  } catch (error) {
    return null
  }
}

async function agentRoot(ctx, agent) {
  const workingDirectory = getService(ctx, 'workingDirectory')
  if (agent === undefined || agent === null || workingDirectory === undefined || workingDirectory === null) return null
  try {
    return typeof workingDirectory.ensure === 'function' ? await workingDirectory.ensure(agent) : null
  } catch (error) {
    return null
  }
}

function outputDirFor(root, config) {
  if (isAbsolute(config.outputDir)) return config.outputDir
  return resolve(root || process.cwd(), config.outputDir)
}

function summarize(memo, paths) {
  return {
    id: memo.id,
    title: memo.title,
    createdAt: memo.createdAt,
    createdLocal: memo.createdLocal,
    durationSec: memo.durationSec,
    language: memo.language,
    source: memo.source,
    status: memo.status,
    reason: memo.reason || '',
    engine: memo.engine || null,
    segments: memo.segments || [],
    text: memo.text || '',
    audio: memo.audio,
    waveform: memo.waveform,
    note: memo.note,
    dir: paths ? paths.dir : undefined,
  }
}

export function apply(ctx, config) {
  const settings = resolveConfig(config)
  const api = {
    async save(options) {
      const opts = options || {}
      const wav = opts.wav
      if (!(wav instanceof Uint8Array) || wav.length === 0) throw new Error('没有收到音频数据')
      if (wav.length > settings.maxAudioBytes) {
        throw new Error('音频超过上限（' + Math.round(settings.maxAudioBytes / 1024 / 1024) + ' MB）')
      }

      const parsed = parseWav(wav)
      if (parsed.durationSec > settings.maxDurationSec) {
        throw new Error('录音时长 ' + parsed.durationSec.toFixed(1) + ' 秒，超过上限 ' + settings.maxDurationSec + ' 秒')
      }

      const samples = resample(parsed.samples, parsed.sampleRate, 16000)
      const canonical = encodeWav(samples, 16000)
      const language = typeof opts.language === 'string' && opts.language.length > 0 ? opts.language : settings.language

      const transcript = await transcribeAudio({
        ctx: ctx,
        config: settings,
        parsed: { samples: samples, sampleRate: 16000 },
        wav: canonical,
        language: language,
        signal: opts.signal,
      })

      const root = opts.agent !== undefined && opts.agent !== null
        ? (await agentRoot(ctx, opts.agent)) || defaultRoot(ctx)
        : sessionRoot(ctx, opts.sessionId) || defaultRoot(ctx)
      const outputDir = outputDirFor(root, settings)

      const created = createMemo({
        dir: outputDir,
        wav: canonical,
        transcript: transcript,
        title: opts.title,
        language: language,
        createdAt: opts.createdAt,
        source: opts.source,
      })
      const paths = memoPaths(outputDir, created.meta.id)
      return { memo: summarize(created.meta, paths), paths: paths, note: created.note, outputDir: outputDir }
    },

    list(options) {
      const opts = options || {}
      const root = opts.sessionId ? sessionRoot(ctx, opts.sessionId) : null
      const outputDir = outputDirFor(root || defaultRoot(ctx), settings)
      const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(500, Math.floor(opts.limit))) : MAX_MEMOS_IN_STATE
      const memos = listMemos(outputDir).slice(0, limit).map((memo) => summarize(memo, memoPaths(outputDir, memo.id)))
      return { outputDir: outputDir, memos: memos }
    },

    read(options) {
      const opts = options || {}
      const root = opts.sessionId ? sessionRoot(ctx, opts.sessionId) : null
      const outputDir = outputDirFor(root || defaultRoot(ctx), settings)
      const found = readMemo(outputDir, opts.id)
      if (found === null) return null
      const paths = memoPaths(outputDir, found.meta.id)
      return { memo: summarize(found.meta, paths), note: found.note, paths: paths, outputDir: outputDir }
    },
  }

  // ---- HTTP API used by the panel ---------------------------------------
  ctx.effect(function () {
    let disposeRoute
    try {
      disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-voice-memo',
        handler: async function (req, res) {
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const rest = url.pathname.replace(/^\/dsh-voice-memo\/?/, '')
            const parts = rest.split('/').filter((part) => part.length > 0)
            const sessionId = url.searchParams.get('sessionId') || undefined

            if (req.method === 'GET' && (rest.length === 0 || rest === 'api/state')) {
              const listing = api.list({ sessionId: sessionId, limit: MAX_MEMOS_IN_STATE })
              sendJson(res, 200, {
                ok: true,
                version: '0.1.0',
                outputDir: listing.outputDir,
                engine: engineStatus(ctx, settings),
                limits: {
                  maxAudioBytes: settings.maxAudioBytes,
                  maxDurationSec: settings.maxDurationSec,
                },
                memos: listing.memos,
              })
              return
            }

            if (req.method === 'GET' && (parts[0] === 'audio' || parts[0] === 'wave' || parts[0] === 'note')) {
              const id = parts[1]
              const listing = api.read({ id: id, sessionId: sessionId })
              if (listing === null) {
                sendJson(res, 404, { ok: false, error: '找不到这条口述笔记' })
                return
              }
              if (parts[0] === 'audio') {
                sendBytes(res, 200, 'audio/wav', readFileSync(listing.paths.audio))
                return
              }
              if (parts[0] === 'wave') {
                sendBytes(res, 200, 'image/png', readFileSync(listing.paths.waveform))
                return
              }
              sendBytes(res, 200, 'text/markdown; charset=utf-8', Buffer.from(listing.note, 'utf8'))
              return
            }

            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }

            const raw = await readBody(req)
            let body = {}
            try {
              body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {}
            } catch (error) {
              sendJson(res, 400, { ok: false, error: '请求体不是 JSON' })
              return
            }

            if (rest === 'api/save') {
              if (typeof body.audioBase64 !== 'string' || body.audioBase64.length === 0) {
                sendJson(res, 400, { ok: false, error: '缺少 audioBase64' })
                return
              }
              let wav
              try {
                wav = Buffer.from(body.audioBase64, 'base64')
              } catch (error) {
                sendJson(res, 400, { ok: false, error: 'audioBase64 无法解码' })
                return
              }
              try {
                const saved = await api.save({
                  wav: wav,
                  title: body.title,
                  language: body.language,
                  sessionId: body.sessionId || sessionId,
                  source: 'panel',
                })
                sendJson(res, 200, {
                  ok: true,
                  memo: saved.memo,
                  outputDir: saved.outputDir,
                  quotes: saved.memo.segments.map((segment) => quoteSegment(saved.memo, segment, saved.paths.note)),
                })
              } catch (error) {
                sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
              }
              return
            }

            if (rest === 'api/read') {
              const listing = api.read({ id: body.id, sessionId: body.sessionId || sessionId })
              if (listing === null) {
                sendJson(res, 404, { ok: false, error: '找不到这条口述笔记' })
                return
              }
              sendJson(res, 200, {
                ok: true,
                memo: listing.memo,
                note: listing.note,
                quotes: listing.memo.segments.map((segment) => quoteSegment(listing.memo, segment, listing.paths.note)),
              })
              return
            }

            sendJson(res, 404, { ok: false, error: 'unknown method' })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
          }
        },
      })
    } catch (error) {
      disposeRoute = undefined
    }
    return function () {
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  })

  // ---- agent tools -------------------------------------------------------
  // Tools are optional: a host without the tools service still gets the panel.
  ctx.effect(function () {
    const tools = getService(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return function () {}

    const disposers = []
    const register = (definition) => {
      try {
        disposers.push(tools.register(definition))
      } catch (error) {
        // A failed tool registration must not take down the panel.
      }
    }

    register({
      name: 'voice_memo_save',
      description: [
        '把一段本地 WAV 录音归档成一条「口述笔记」：本地转写成带时间戳的分段文本，生成波形图，',
        '并把 audio.wav / waveform.png / memo.md / meta.json 写进当前工作区的 voice-memos/<id>/。',
        '不联网、不上传音频。需要本地识别引擎（asr.command 或 DSH speechToText）；',
        '引擎不可用时仍会归档音频与波形，并在笔记里明确标注「未转写」，不会编造文本。',
        '当用户给了一段录音、或说「把这个录音整理成笔记」时使用。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'WAV 文件路径（绝对路径，或相对当前工作区）。与 audioBase64 二选一。',
          },
          audioBase64: {
            type: 'string',
            description: 'WAV 内容的 base64；面板之外调用时可省略 path 改用这个。',
          },
          title: {
            type: 'string',
            description: '笔记标题。省略时取第一段文本的前 32 个字符。',
          },
          language: {
            type: 'string',
            description: '识别语言提示，例如 zh、en、auto。省略时用插件配置的 language。',
          },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          description: '归档结果：memo 是记录，paths 是磁盘位置，quote 是可直接粘贴的引用。',
        },
        render: function (args, value) {
          const result = value !== null && typeof value === 'object' ? value : {}
          const memo = result.memo || {}
          const lines = [
            '已归档口述笔记：' + String(memo.title || memo.id || ''),
            '状态：' + String(memo.status || '') + ' · 时长 ' + Number(memo.durationSec || 0).toFixed(1) + ' 秒 · ' +
              String((memo.segments || []).length) + ' 段',
            '笔记：' + String(result.notePath || ''),
            '音频：' + String(result.audioPath || ''),
          ]
          if (memo.reason) lines.push('说明：' + String(memo.reason))
          const quote = (result.quotes || [])[0]
          if (quote) lines.push('', '可直接引用的第一段：', String(quote))
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      isConcurrencySafe: function () {
        return false
      },
      presentCall: function (args) {
        return {
          card: 'generic',
          title: 'voice_memo_save',
          kind: 'write',
          rawInput: args,
          locations: args && typeof args.path === 'string' ? [{ path: args.path }] : undefined,
        }
      },
      execute: async function (args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        let wav
        if (typeof input.audioBase64 === 'string' && input.audioBase64.length > 0) {
          wav = Buffer.from(input.audioBase64, 'base64')
        } else if (typeof input.path === 'string' && input.path.length > 0) {
          const root = (await agentRoot(ctx, exec && exec.agent)) || defaultRoot(ctx)
          const source = isAbsolute(input.path) ? input.path : resolve(root, input.path)
          let info
          try {
            info = statSync(source)
          } catch (error) {
            throw new Error('找不到 WAV 文件：' + source)
          }
          if (!info.isFile()) throw new Error('不是文件：' + source)
          if (info.size > settings.maxAudioBytes) throw new Error('WAV 文件超过上限：' + source)
          wav = readFileSync(source)
        } else {
          throw new Error('需要 path 或 audioBase64')
        }
        const saved = await api.save({
          wav: wav,
          title: input.title,
          language: input.language,
          agent: exec && exec.agent,
          source: 'tool',
        })
        return {
          memo: saved.memo,
          notePath: saved.paths.note,
          audioPath: saved.paths.audio,
          waveformPath: saved.paths.waveform,
          outputDir: saved.outputDir,
          quotes: saved.memo.segments.map((segment) => quoteSegment(saved.memo, segment, saved.paths.note)),
        }
      },
    })

    register({
      name: 'voice_memo_list',
      description: '列出口述笔记归档（当前工作区的 voice-memos/）：标题、时间、时长、状态和笔记路径。只读。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多返回多少条，默认 20。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', description: '归档目录与笔记列表。' },
        render: function (args, value) {
          const result = value !== null && typeof value === 'object' ? value : {}
          const memos = result.memos || []
          if (memos.length === 0) return [{ type: 'text', text: '还没有口述笔记。目录：' + String(result.outputDir || '') }]
          const lines = memos.map((memo) => {
            return '- ' + String(memo.createdLocal || '') + ' · ' + Number(memo.durationSec || 0).toFixed(1) + 's · ' +
              String((memo.segments || []).length) + ' 段 · ' + String(memo.status || '') + ' · ' + String(memo.title || memo.id)
          })
          return [{ type: 'text', text: '口述笔记（' + String(result.outputDir || '') + '）：\n' + lines.join('\n') }]
        },
      },
      isConcurrencySafe: function () {
        return true
      },
      execute: function (args) {
        const input = args !== null && typeof args === 'object' ? args : {}
        const listing = api.list({ limit: Number.isFinite(input.limit) ? input.limit : 20 })
        return {
          outputDir: listing.outputDir,
          memos: listing.memos.map((memo) => ({
            id: memo.id,
            title: memo.title,
            createdLocal: memo.createdLocal,
            durationSec: memo.durationSec,
            status: memo.status,
            segments: memo.segments.length,
            notePath: join(listing.outputDir, memo.id, 'memo.md'),
          })),
        }
      },
    })

    register({
      name: 'voice_memo_read',
      description: '读取一条口述笔记的完整 markdown 与可引用分段。用于把口述内容引用进交付文档或对话。只读。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '笔记 id（voice_memo_list 返回的 id）。' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', description: '笔记 markdown、分段与引用行。' },
        render: function (args, value) {
          const result = value !== null && typeof value === 'object' ? value : {}
          const memo = result.memo || {}
          const lines = [
            '口述笔记：' + String(memo.title || memo.id || ''),
            String(memo.createdLocal || '') + ' · ' + Number(memo.durationSec || 0).toFixed(1) + ' 秒 · ' + String(memo.status || ''),
            '笔记：' + String(result.notePath || ''),
          ]
          const segments = memo.segments || []
          if (segments.length > 0) {
            lines.push('', '分段：')
            segments.slice(0, 5).forEach((segment, index) => {
              lines.push('- ' + formatSpan(segment) + ' ' + String(segment.text || ''))
            })
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      isConcurrencySafe: function () {
        return true
      },
      execute: function (args) {
        const input = args !== null && typeof args === 'object' ? args : {}
        const listing = api.read({ id: input.id })
        if (listing === null) throw new Error('找不到这条口述笔记：' + String(input.id || ''))
        return {
          memo: listing.memo,
          notePath: listing.paths.note,
          markdown: listing.note,
          quotes: listing.memo.segments.map((segment) => quoteSegment(listing.memo, segment, listing.paths.note)),
        }
      },
    })

    return function () {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose()
      }
      disposers.length = 0
    }
  })
}

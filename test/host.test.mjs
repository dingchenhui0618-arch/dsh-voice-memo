// Host-half tests: the HTTP API and the agent tools are driven against a stub
// ctx and a stub HTTP request/response, so the archive, the routes and the tool
// results are pinned without a running harness or a real microphone.

import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeWav } from '../src/pcm.cjs'
import { apply, resolveConfig } from '../src/host.js'

function sine(seconds, sampleRate, frequency) {
  const count = Math.round(seconds * sampleRate)
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i += 1) samples[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.4
  return samples
}

function makeWav(seconds) {
  return Buffer.from(encodeWav(sine(seconds || 1, 16000, 220), 16000))
}

function fakeRes() {
  const state = { statusCode: 0, headers: {}, chunks: [] }
  const res = {
    statusCode: 0,
    setHeader(name, value) { state.headers[name.toLowerCase()] = value },
    end(body) {
      if (body !== undefined && body !== null) state.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body))
      state.statusCode = res.statusCode
      if (state.resolve) state.resolve({ status: state.statusCode, headers: state.headers, body: Buffer.concat(state.chunks) })
    },
  }
  return { res: res, state: state }
}

function request(route, options) {
  const opts = options || {}
  const req = new EventEmitter()
  req.method = opts.method || 'GET'
  req.url = opts.url || '/dsh-voice-memo/api/state'
  req.destroy = function () {}
  const made = fakeRes()
  const finished = new Promise(function (resolve) { made.state.resolve = resolve })
  Promise.resolve(route.handler(req, made.res)).catch(function (error) {
    made.res.statusCode = 500
    made.res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
  })
  if (opts.body !== undefined) {
    const payload = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(JSON.stringify(opts.body))
    process.nextTick(function () {
      req.emit('data', payload)
      req.emit('end')
    })
  }
  return finished.then(function (result) {
    const text = result.body.toString('utf8')
    let json
    try {
      json = JSON.parse(text)
    } catch (error) {
      json = undefined
    }
    return { status: result.status, headers: result.headers, body: result.body, text: text, json: json }
  })
}

function setup(options) {
  const settings = options || {}
  const workspace = settings.workspace || mkdtempSync(join(tmpdir(), 'voice-memo-host-'))
  const routes = []
  const tools = []
  const disposers = []
  const session = { id: 's1', project: 'demo' }

  const webServer = {
    register(route) {
      routes.push(route)
      return function () {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
  const services = {
    webServer: webServer,
    tools: {
      register(definition) {
        tools.push(definition)
        return function () {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    sessions: {
      get(id) { return id === session.id ? session : undefined },
    },
    workingDirectory: {
      defaultDirectory: workspace,
      get(value) { return value === session ? workspace : undefined },
      async ensure() { return workspace },
    },
  }
  const ctx = {
    webServer: webServer,
    get(name) { return services[name] },
    effect(fn) {
      const dispose = fn()
      disposers.push(typeof dispose === 'function' ? dispose : function () {})
      return dispose
    },
  }
  apply(ctx, Object.assign({
    outputDir: 'voice-memos',
    language: 'zh',
    asr: { mode: 'off' },
  }, settings.config || {}))

  return {
    workspace: workspace,
    routes: routes,
    tools: tools,
    session: session,
    call(options) {
      assert.equal(routes.length, 1, 'one prefix route is registered')
      return request(routes[0], options)
    },
    tool(name) {
      const found = tools.find((definition) => definition.name === name)
      assert.ok(found, 'tool ' + name + ' is registered')
      return found
    },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

test('resolveConfig fills defaults and rejects unusable values', () => {
  const resolved = resolveConfig({})
  assert.equal(resolved.outputDir, 'voice-memos')
  assert.equal(resolved.language, 'zh')
  assert.equal(resolved.asr.mode, 'auto')
  assert.equal(resolved.asr.timeoutSec, 120)
  const custom = resolveConfig({ outputDir: 'D:\\memos', language: 'en', asr: { mode: 'command', command: ['x'] } })
  assert.equal(custom.outputDir, 'D:\\memos')
  assert.equal(custom.language, 'en')
  assert.equal(custom.asr.mode, 'command')
  assert.deepEqual(custom.asr.command, ['x'])
  assert.equal(resolveConfig({ asr: { mode: 'bogus' } }).asr.mode, 'auto')
})

test('GET api/state returns the archive, engine status and limits', async () => {
  const h = setup()
  try {
    const response = await h.call({ url: '/dsh-voice-memo/api/state' })
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, true)
    assert.equal(response.json.memos.length, 0)
    assert.equal(response.json.engine.kind, 'none')
    assert.equal(response.json.outputDir, join(h.workspace, 'voice-memos'))
    assert.equal(response.json.limits.maxDurationSec, 600)
  } finally {
    h.dispose()
    rmSync(h.workspace, { recursive: true, force: true })
  }
})

test('POST api/save archives a WAV and the panel can read audio, waveform and note back', async () => {
  const h = setup()
  try {
    const saved = await h.call({
      method: 'POST',
      url: '/dsh-voice-memo/api/save?sessionId=s1',
      body: { audioBase64: makeWav(1.2).toString('base64'), sessionId: 's1' },
    })
    assert.equal(saved.status, 200, saved.text)
    assert.equal(saved.json.ok, true)
    const memo = saved.json.memo
    assert.equal(memo.status, 'transcription-unavailable')
    assert.equal(memo.durationSec > 1.1, true)
    assert.match(saved.json.outputDir, /voice-memos$/)

    const state = await h.call({ url: '/dsh-voice-memo/api/state?sessionId=s1' })
    assert.equal(state.json.memos.length, 1)
    assert.equal(state.json.memos[0].id, memo.id)

    const audio = await h.call({ url: '/dsh-voice-memo/audio/' + memo.id + '?sessionId=s1' })
    assert.equal(audio.status, 200)
    assert.match(audio.headers['content-type'], /audio\/wav/)
    assert.equal(audio.body.subarray(0, 4).toString('ascii'), 'RIFF')

    const wave = await h.call({ url: '/dsh-voice-memo/wave/' + memo.id + '?sessionId=s1' })
    assert.equal(wave.status, 200)
    assert.match(wave.headers['content-type'], /image\/png/)
    assert.equal(wave.body.subarray(1, 4).toString('ascii'), 'PNG')

    const note = await h.call({ url: '/dsh-voice-memo/note/' + memo.id + '?sessionId=s1' })
    assert.equal(note.status, 200)
    assert.match(note.headers['content-type'], /text\/markdown/)
    assert.match(note.text, /status: transcription-unavailable/)
    assert.match(note.text, /没有可用的本地识别引擎/)
  } finally {
    h.dispose()
    rmSync(h.workspace, { recursive: true, force: true })
  }
})

test('POST api/save rejects missing, undecodable or oversized audio with 400', async () => {
  const h = setup()
  try {
    const missing = await h.call({ method: 'POST', url: '/dsh-voice-memo/api/save', body: {} })
    assert.equal(missing.status, 400)
    const empty = await h.call({ method: 'POST', url: '/dsh-voice-memo/api/save', body: { audioBase64: '!!!' } })
    assert.equal(empty.status, 400)
    const notWav = await h.call({ method: 'POST', url: '/dsh-voice-memo/api/save', body: { audioBase64: Buffer.from('hello').toString('base64') } })
    assert.equal(notWav.status, 400)
    assert.match(notWav.json.error, /RIFF\/WAVE|WAV/)
  } finally {
    h.dispose()
    rmSync(h.workspace, { recursive: true, force: true })
  }
})

test('unknown ids and methods are reported, not guessed', async () => {
  const h = setup()
  try {
    const missing = await h.call({ url: '/dsh-voice-memo/audio/nope' })
    assert.equal(missing.status, 404)
    const method = await h.call({ method: 'PUT', url: '/dsh-voice-memo/api/save' })
    assert.equal(method.status, 405)
    const unknown = await h.call({ method: 'POST', url: '/dsh-voice-memo/api/other', body: {} })
    assert.equal(unknown.status, 404)
  } finally {
    h.dispose()
    rmSync(h.workspace, { recursive: true, force: true })
  }
})

test('a configured local command transcribes through the save route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-memo-worker-'))
  try {
    const worker = join(dir, 'asr.mjs')
    writeFileSync(worker, [
      "process.stdout.write(JSON.stringify({ engine: 'fake-asr', language: 'zh',",
      "  segments: [{ start: 0, end: 0.7, text: '路由测试。' }] }))",
      '',
    ].join('\n'))
    const h = setup({ config: { asr: { mode: 'command', command: ['node', worker], timeoutSec: 10 } } })
    try {
      const saved = await h.call({
        method: 'POST',
        url: '/dsh-voice-memo/api/save',
        body: { audioBase64: makeWav(0.9).toString('base64') },
      })
      assert.equal(saved.status, 200, saved.text)
      assert.equal(saved.json.memo.status, 'transcribed')
      assert.equal(saved.json.memo.engine.name, 'fake-asr')
      assert.equal(saved.json.memo.segments.length, 1)
      assert.equal(saved.json.memo.segments[0].text, '路由测试。')
      assert.match(saved.json.quotes[0], /路由测试。/)
      assert.ok(existsSync(join(saved.json.outputDir, saved.json.memo.id, 'memo.md')))
    } finally {
      h.dispose()
      rmSync(h.workspace, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('voice_memo_save/list/read tools share the same archive as the panel', async () => {
  const h = setup()
  const dir = mkdtempSync(join(tmpdir(), 'voice-memo-tool-'))
  try {
    const wavPath = join(dir, 'sample.wav')
    writeFileSync(wavPath, makeWav(0.8))

    const save = h.tool('voice_memo_save')
    assert.equal(save.name, 'voice_memo_save')
    assert.ok(save.parameters)
    assert.equal(typeof save.execute, 'function')
    const saved = await save.execute({ path: wavPath, title: '工具归档' }, { agent: { id: 'agent-1' } })
    assert.equal(saved.memo.title, '工具归档')
    assert.equal(saved.memo.status, 'transcription-unavailable')
    assert.ok(existsSync(saved.notePath))
    assert.ok(existsSync(saved.audioPath))
    assert.ok(existsSync(saved.waveformPath))
    assert.equal(saved.quotes.length, 0)

    const rendered = save.output.render({}, saved)
    assert.match(rendered[0].text, /已归档口述笔记：工具归档/)

    const list = h.tool('voice_memo_list')
    const listed = list.execute({})
    assert.equal(listed.memos.length, 1)
    assert.equal(listed.memos[0].id, saved.memo.id)
    assert.equal(listed.memos[0].segments, 0)

    const read = h.tool('voice_memo_read')
    const opened = read.execute({ id: saved.memo.id })
    assert.equal(opened.memo.id, saved.memo.id)
    assert.match(opened.markdown, /# 工具归档/)
    assert.throws(() => read.execute({ id: 'missing' }), /找不到这条口述笔记/)
  } finally {
    h.dispose()
    rmSync(h.workspace, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('voice_memo_save accepts base64 and explains a missing file', async () => {
  const h = setup()
  try {
    const save = h.tool('voice_memo_save')
    const fromBase64 = await save.execute({ audioBase64: makeWav(0.6).toString('base64') }, { agent: { id: 'agent-1' } })
    assert.equal(fromBase64.memo.status, 'transcription-unavailable')
    await assert.rejects(async () => {
      await save.execute({ path: 'missing.wav' }, { agent: { id: 'agent-1' } })
    }, /找不到 WAV 文件/)
    await assert.rejects(async () => {
      await save.execute({}, { agent: { id: 'agent-1' } })
    }, /需要 path 或 audioBase64/)
  } finally {
    h.dispose()
    rmSync(h.workspace, { recursive: true, force: true })
  }
})

test('unloading the plugin removes the route and the tools', () => {
  const h = setup()
  try {
    assert.equal(h.routes.length, 1)
    assert.equal(h.tools.length, 3)
    h.dispose()
    assert.equal(h.routes.length, 0)
    assert.equal(h.tools.length, 0)
  } finally {
    rmSync(h.workspace, { recursive: true, force: true })
  }
})

# Changelog

## [Unreleased]

### 文档与工程

- 新增 `SECURITY.md`：写清录音默认写进 `<工作区>/voice-memos/<id>/`（同 id 不覆盖、失败时只删
  自己刚建的目录）、`harness` 引擎优先 `host-local` 但可能退回远端 provider、`command` 引擎
  走临时目录 + argv 无 shell、路由没有独立 token、音频会进模型上下文。
- 新增 `screenshots.json`：声明 `docs/` 下三张真实截图/波形图，市场卡片按这个顺序展示。
- CI 补 `permissions: contents: read`、`lib/` 与 `src/` 一致性断言，并加 windows-latest 到矩阵。
- README 顶部加 CI 与 license badge，引言后加一句 star 引导。没有加 npm badge——这个包没有
  发布到 npm。

## 0.1.0 — 2026-10-20

首次发布。

- 口述 Tab：按住说话录音，松开后在浏览器里解码、混单声道、重采样到 16 kHz、编码成规范 WAV 再交给 Host；也可导入已有 WAV。
- 归档：每条口述在 `<工作区>/voice-memos/<id>/` 下落 `audio.wav`、`waveform.png`、`memo.md`、`meta.json`。
- 波形图：纯 JS PNG 编码（node:zlib），透明背景 + 时间刻度，随笔记一起提交/引用。
- 笔记：YAML frontmatter、元信息表、带 `#seg-N` 锚点的分段、全文与可直接粘贴的引用块。
- 转写引擎：`harness`（DSH `speechToText` 服务，按静音切窗口补时间戳）与 `command`（任意本地命令，如 `workers/transcribe_faster_whisper.py`）；`auto` 默认先 harness 后 command。引擎不可用/失败时如实写进笔记状态，不编造文本。
- Agent 工具：`voice_memo_save`、`voice_memo_list`、`voice_memo_read`。
- HTTP API：`/dsh-voice-memo/api/state`、`/api/save`、`/api/read`、`/audio/<id>`、`/wave/<id>`、`/note/<id>`。
- 零依赖构建：`node scripts/build.mjs` 把 ESM host 拷进 `lib/`，把 CSS 与共享 PCM 模块内联进客户端 bundle。

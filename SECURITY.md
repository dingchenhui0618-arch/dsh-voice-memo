# 安全模型 / Security model

这份文档说明 **dsh-voice-memo** 把麦克风里的声音送到哪里、转写用的是什么引擎、录音和文本
最终落在哪个目录、会不会覆盖已有文件。它从实现（`src/host.js`、`src/store.js`、
`src/transcribe.js`、`src/client.cjs`）里读出来；**如果文档和代码不一致，以代码为准，
那说明这份文档是个 bug。**

> 一句话：录音在浏览器里采集、在宿主里归档，**默认写进当前工作区的
> `voice-memos/<id>/`**——也就是说，你的语音和转写文本会变成你项目目录里的文件。转写默认
> 优先走宿主的本地识别服务，但也可能落到**配置的本地命令**；如果宿主只注册了远端
> `speechToText` provider，音频会走那条通道。这个插件自己不联网。

## 信任边界

插件跑在 DSH 宿主进程里，`inject: ['webServer']`（`src/host.js`），并注册三个模型工具
（`voice_memo_save` / `_list` / `_read`）。

| 表面 | 谁触发 | 这一层有没有鉴权 |
| --- | --- | --- |
| 面板路由 `/dsh-voice-memo` | 能访问 DSH web server 的人 | **没有自己的 token**；边界是宿主 web server |
| 麦克风（`getUserMedia` + `MediaRecorder`，`src/client.cjs`） | 面板上按住说话 | 浏览器/操作系统的麦克风权限；插件不加二次同意 |
| 子进程（`spawn`，`src/transcribe.js`） | 配置了 `asr.command` 时 | 继承本进程权限，无沙箱；命令是你自己写的配置 |
| 模型工具 | 任何能驱动模型的会话/子代理 | 和 DSH 其它工具一样，靠宿主权限策略 |

**视为不可信输入的**：

- **上传的音频**：base64 → `Buffer`，请求体上限 64 MiB，音频上限 20 MiB（`maxAudioBytes`），
  时长上限 600 秒（`maxDurationSec`）；WAV 头由 `parseWav` 解析，解析失败即拒绝，不猜；
- **`voice_memo_save` 的 `path`**：**绝对路径也接受**（相对路径按当前工作区解析），只要
  是文件、不超过 20 MiB；
- **识别命令的输出**：`parseWorkerOutput` 只接受带 `segments` 数组的 JSON，段落要求
  `start/end` 是有限数、`end >= start`、文本非空；输出上限 8 MiB，错误输出 64 KiB；
- **已有的 `meta.json`/`memo.md`**：`listMemos` 逐条读取，`meta.id` 必须等于目录名，坏目录
  跳过而不是让整个列表失败；
- **路由上的 `id`**：`normalizeId` 要求 `^[a-z0-9][a-z0-9-]{2,80}$`，否则 404——`..`、绝对
  路径、盘符都进不来。

## 录音去哪了（最重要的一条）

`POST /dsh-voice-memo/api/save`（面板）或 `voice_memo_save`（模型）→ `createMemo`：

```
<工作区>/voice-memos/<id>/
    audio.wav      # 16 kHz 单声道 PCM16，重采样后的规范 WAV
    waveform.png   # 从同一批样本画的波形（960×220，透明背景）
    memo.md        # 带时间戳锚点的 markdown 笔记（含转写全文）
    meta.json      # 机器可读记录（id/标题/时长/段落/引擎/状态）
```

- `outputDir` 默认是相对路径 `voice-memos`，解析到**会话/代理的当前工作区**（`workingDirectory`
  服务；取不到时退回 `process.cwd()`），可用配置改成绝对路径；
- `id` 是时间戳 + 4 位十六进制随机后缀；**同 id 目录已存在就报错**（`memo id already exists`），
  **不会覆盖**已有笔记；
- 写文件用"临时文件 + `renameSync`"原子替换，建目录失败/写失败时会**删掉自己刚建的那个
  id 目录**再抛错（`rmSync(recursive)` 只作用于这个新目录）；
- 它**不删除**任何其它东西，不写 `$DSH_HOME`，不建索引文件（列表就是扫目录）。

**因此：录音是一等公民文件。** 如果你的工作区是 git 仓库，且没有把 `voice-memos/` 写进
`.gitignore`，一次按住说话就可能让一段真实语音进入 commit。这是使用这个插件前必须知道的事。

## 转写：三档引擎

`engineStatus` 按 `asr.mode`（`auto`/`harness`/`command`/`off`）选择：

1. **harness**（`auto` 时优先）：用宿主的 `speechToText` 服务。`harnessProvider` 的挑选规则
   是 **`location === 'host-local'` 的 provider 优先**，没有就用 `providers[0]`。
   本插件自己不发请求，但**它无法保证那个 provider 在本地**——如果宿主只注册了远端 provider，
   音频窗口会走宿主的远端通道。这是"本地转写"这句话的边界，照实写在这里。
   录音按静音切成 ≤20 秒窗口，逐窗转写，窗口边界变成段落时间戳。
2. **command**：`asr.command` 是你配置的本地命令（例如 `workers/transcribe_faster_whisper.py`）。
   它把规范 WAV 写到 **系统临时目录** 的 `dsh-voice-memo-*` 下（`mkdtempSync`），把文件路径
   作为最后一个参数传给你的命令，加 `--language <lang>`，超时默认 120 秒后 `kill`，
   结束后**删除临时目录**；环境变量继承本进程并额外设 `PYTHONUTF8=1`。
   命令通过 argv 数组启动（`spawn` 不走 shell），**不会**因为路径里有空格/`&` 被拼接执行；
   但那个命令本身是任意代码——它是你的配置。
3. **off / 不可用**：不转写，按 `transcription-unavailable` / `transcription-failed` /
   `empty-speech` 写进笔记状态，**不编造文本**。音频与波形照样归档。

## 它读什么、发什么

- 读请求体里的音频、或你/模型点名的 WAV 文件（任意路径，≤20 MiB）；
- 读工作区里的 `voice-memos/*` 生成列表与笔记；
- 通过路由把 `audio.wav`、`waveform.png`、`memo.md` 原样回给浏览器；
- **`src/` 里没有 `fetch`/`http` 调用**：插件自己不发网络请求、没有遥测。
  （`harness` 引擎经宿主 `speechToText` 的转发见上，不算插件自己发。）

## 已知限制（都是设计取舍，不是 bug——但你应该知道）

1. **录音默认落在工作区**：见上。没有"临时录音"模式，没有自动清理，没有加密。
2. **没有二次同意**：按下就录，唯一的门是浏览器麦克风权限。录会议/他人语音前请自己确认
   授权与当地法律。
3. **"本地转写"取决于宿主**：`harness` 引擎可能落到远端 provider，见上；要保证离线，用
   `asr.mode: 'command'` 并配一个本地识别命令，或 `off`。
4. **识别命令是任意代码**：配置里写什么就跑什么，继承完整环境变量；插件只加超时和输出上限。
5. **音频会进模型上下文**：`voice_memo_read` 与笔记里含转写全文，模型可以读到；`memo.md`
   里的引用块也会被贴进会话。语音内容因此和你在会话里说的话同级。
6. **路由没有独立鉴权**：能访问 DSH web server 的人可以列出、播放、读取这些笔记（`id` 需要
   猜/枚举，时间戳前缀可猜但后缀 4 位十六进制）。
7. **没有保留期限**：笔记越多目录越大；删除就是你自己删目录，插件不会清理。
8. **波形是示意图**：像素来自真实样本，但不是可缩放的专业音频工具；不用于取证。
9. **`meta.json` 可被手改**：`readMeta` 只校验 `id` 与目录名一致；手改其它字段会原样进
   面板与工具输出（不会执行，只当文本）。

## 明确不算漏洞的

- **录音出现在 `git status` 里**：默认输出目录就是工作区，见限制 1；`.gitignore` 是使用者的
  责任（本仓库自己的 `.gitignore` 忽略 `voice-memos/` 与 `demo-workspace/`，但那是本仓库）；
- **面板能播放别人的录音**：同机同 `DSH_HOME` 的工作区本来就是共享的，路由边界见限制 6；
- **`asr.command` 执行任意本地程序**：这是配置项，不是外部输入；
- **转写有错字/漏段**：识别引擎的能力问题，插件如实记录引擎、状态与原因；
- **`memo.md`/`meta.json` 里的文本导致 XSS**：面板用 `React.createElement` 渲染，没有
  `innerHTML`；`/note/<id>` 以 `text/markdown` 返回，不是 `text/html`。

## 报告漏洞

用 GitHub 的私密渠道：
<https://github.com/dingchenhui0618-arch/dsh-voice-memo/security/advisories/new>

这是个人维护的项目，**不承诺响应时限**；但我会读、会修，修完会在 CHANGELOG 里写清影响
范围与修复版本。请不要把还在生效的问题直接发到公开 issue 里。

## 支持范围

只维护 `main` 上的最新一版（当前 `0.1.0`，见 `package.json`）。这个包没有发布到 npm
（`npm view dsh-voice-memo version` 不存在），所以没有 npm 渠道的旧版本需要支持。

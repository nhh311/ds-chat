# 更新日志

版本号跟 APK 的 `versionName` 走。`0.1.0` 到 `0.2.1` 只留了安装包，没有留下逐条说明，所以前几版写得粗一些。

## 0.3.10 — 去掉全部官方标识，不再自带图标

- 首页中央的鲸鱼标识删除：现在只剩一句「欢迎回来，随时开始吧」和输入框，界面里不再出现任何官方图形
- **不再自带启动器图标**：`res/mipmap-*` 与自适应图标配置一并删除，清单里的 `android:icon` / `android:roundIcon` 也去掉了，系统显示默认图标。`res/` 因此是空的，两个构建脚本都改成没有资源时跳过 `aapt2 compile`
- README 不再放头图与图标插画，只留真实截图
- 仓库里第一次能完整重建：新增 `android/build-apk.ps1`（与 `build-apk.sh` 步骤一致，给没有 Git Bash 的 Windows），两个脚本的工具链路径改成可用 `ANDROID_BUILD_TOOLS` / `ANDROID_JAR` / `JAVA_HOME` 覆盖，并在缺工具链或缺 `web/dist` 时直接报出缺的是哪个路径
- `android/assets/**` 不再入库（那是构建产物），重建时由脚本从 `web/dist` 拷入
- APK：`dsk-chat-0.3.10.apk`，1,959,838 字节，SHA-256 `64DF03F6CA95027ECD57BDB9F8CBB7297CFBC9C7877CFFE6D5FAF8AFAB010FA9`

## 0.3.9 — 隐私：数据去向、训练开关、本机数据

- 设置里新增「隐私」分组，和通用设置、数据管理、扩展并列；窄屏下四个 tab 均分宽度，不折行
- 「数据去了哪里」把全部会离开手机的请求列清楚，一共 4 个：`POST /anthropic/v1/messages`（聊天、深度思考、工具调用）、`POST /anthropic/v1/files`（上传图片与文档）、`POST /v1/tools/asr`（语音识别）、`POST /v1/tools/tts`（朗读），并显示当前服务地址
- 「模型训练」说清一件事：是否用你的内容继续训练，是 DeepSeek 账户上的开关，不在这个 App 里，请求体里也没有能关掉它的字段；给出官方路径（设置 → 数据管理 → 关掉「数据用于优化体验」）和一句话直达入口
- 「本机数据」显示已用 / 可用空间，可以清除保存的位置、删除全部对话与附件（不碰 API Key 与设置）
- 外链统一走原生 `openExternally`，不再在 WebView 里打开

## 0.3.8 — 语音整理

- 语音识别只负责声学转写，出来的文本普遍带口头语、自我打断、没标点、同音错字。这一版在转写后加一次模型整理：工作类内容去口头语、补标点、改错字，随口闲聊保持原样
- 整理是可开关的（设置 → 通用设置 → 语音整理），关掉就只发原始转写

## 0.3.7 — 附件预览与相册多选

- 点回形针先弹一个小浮层，两个选项：**上传文件**（系统文件管理器，可多选）、**从相册选择**
- 相册分支：Android 13+ 用系统 Photo Picker（`MediaStore.ACTION_PICK_IMAGES`，一次最多 20 张，不需要存储权限），Android 12 及以下回落到 `ACTION_GET_CONTENT`，两边都带 `EXTRA_ALLOW_MULTIPLE`
- 选完图片立刻开始上传（仍走 `/anthropic/v1/files`）
- 点开附件是**预览**，不再是删除；删除要显式点

## 0.3.6 — 缓存命中率算对

- 流式响应里有两次用量上报：`message_start` 带本次请求的 `input_tokens`（未命中）、`cache_read_input_tokens`（命中）、`cache_creation_input_tokens`；`message_delta`（末尾）是全轮累积，其中 `output_tokens` 是准的，但输入侧字段服务端可能一并带成 **0**
- 之前直接用末尾那次计算，于是命中率经常显示 0%。现在按 `message_start` 的输入侧统计 + 末尾的 `output_tokens` 组合，命中率恢复正常
- 用量解析同时放宽：字段缺失、类型不同、只上报一次的情况都不再让整块统计变空

## 0.3.5 — 底部状态条

- 去掉「内容由 AI 生成，请仔细甄别」那行，换成一行状态条：

  ```
  1 轮 2 步 · 235 tok/s · 93.9M tok · 缓存命中 99% · 223K / 1M ◔ 21%
  ```

- 轮 = 用户发了几轮；步 = 每条回复算一步，工具回环每轮再加一步
- tok/s = 输出 token ÷ 模型用时（模型用时 = 整轮耗时 − 工具调用耗时）
- 上下文 = 已用 / 1M，后面跟一个 20px 小圆环，弧长即占用比例；≥ 80% 变琥珀色、≥ 90% 变红

## 0.3.4 — 档位英文标签与 Token 圆环

- 思考强度在中英文界面里都直接显示 `Off / Low / High / Max`，跟官方客户端一致
- 请求体：`Off` → `thinking {"type":"disabled"}`（不带 `output_config`）；`Low / High / Max` → `thinking enabled` + `output_config {"effort":"low|high|max"}`
- 输入框旁新增 token 用量圆环，点开是用量弹层

## 0.3.3 — 思考强度四档

按官方客户端的档位列表对齐，改成四档：关闭 / 低 / 高 / 极致。

## 0.3.2 — 思考强度改成三档

- 删掉「中」。服务端对 `medium` 的处理是当成 `high`，留着只会让人以为选了但没生效
- 当时的映射：`low` → 低，`medium` → 高，`high` → 高（默认值），`xhigh` → 高，`ultra` → `max`

## 0.3.1 — 语音换实现、Skill 导入放宽、MCP 只走流式 HTTP

- **语音输入换了实现路线。** 老版本在 App 里用系统 `SpeechRecognizer`，在没有 Google 语音服务 / 厂商语音助手的机型上 `isRecognitionAvailable()` 直接返回 false，点了没反应；WebView 里 `getUserMedia` 在 `file://` 页面下也拿不到麦克风。这一版改成原生 `AudioRecord` 录音（16 kHz 单声道 16-bit PCM，前面的 44 字节 WAV 头自己拼），停止后直接 `POST {origin}/v1/tools/asr`（`multipart/form-data`，字段 `file=audio.wav`），一次返回全文；单次最长 120 秒，录到不足 0.2 秒提示「没听到」
- 音源按 `VOICE_RECOGNITION → MIC → DEFAULT` 依次尝试
- **Skill 导入放宽**：同时认宽松 JSON 和 SKILL.md 的 front matter；只有启用的技能会被拼进系统提示词，单条 8000 字、合计 24000 字封顶
- **MCP 只支持流式 HTTP**（`mcp-protocol-version: 2024-11-05`），最多 64 个工具，单条工具结果 8000 字截断

## 0.2.1 — 强度档位真正生效

- 0.2.0 的强度胶囊是假的：请求里发的是 `"thinking": {"type":"enabled","effort":"low"}`，服务端只认 `type`，`effort` 被忽略，于是不管选哪一档都按默认的 `high` 跑
- 改成 `"thinking": {"type":"enabled"}` + `"output_config": {"effort":"low"}` 之后才真正生效

## 0.2.0 — 文件选择、原生语音、模式胶囊、状态栏留白、技能与 MCP

- 点回形针没反应：原生外壳没实现 `WebChromeClient.onShowFileChooser`，网页里的 `<input type=file>` 点了不弹任何东西。补上后调系统文件选择器（`ACTION_GET_CONTENT`，支持多选），回调把 Uri 交回网页
- 麦克风按钮点不动：网页用 `getUserMedia` + `AudioContext` 录音，`file://` 页面下拿不到麦克风。改成原生 `SpeechRecognizer`，网页调 `window.DSK.startSpeech()`
- 深度思考展开后把「快速 / 标准」挤没：输入框只留一个「聊天模式」胶囊，点开浮层选快速 / 标准 / 深度思考；选了深度思考才在旁边出现强度胶囊（低 / 中 / 高 / 最高），并自动弹出强度浮层
- 状态栏压住「+」（新对话）：顶栏加一条白色横条（grabber），用 `viewport-fit=cover` + 原生 `insets()` 读系统栏高度，写成 CSS 变量给页面留白
- 新增**技能（Skill）**与 **MCP 服务**，放在设置 → 扩展

## 0.1.1 / 0.1.0 — 最早两版

- 0.1.0：WebView 壳 + 网页端基本对话，能装能聊
- 0.1.1：修若干首版问题，安装包从 1.9 MB 涨到 1.9 MB

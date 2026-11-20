# 归属与声明

## 上游项目

`web/` 目录的前端源自 DeepSeek 开源的 **[chat-demo](https://github.com/deepseek-ai/chat-demo)**，以 MIT 许可发布：

```
MIT License
Copyright (c) 2026 DeepSeek
```

`web/LICENSE` 保留的是上游原文（构建时会被复制到 `dist/LICENSE`）。本仓库根目录的 [LICENSE](LICENSE) 在 MIT 正文里补了一行本项目的版权声明，两者不冲突。

在此基础上的修改包括：Android 壳与原生桥、Anthropic 兼容协议的接入、模型与聊天模式、思考强度四档、Token 用量与会话统计、技能与 MCP、语音输入与朗读、隐私面板、中英文案与移动端布局、以及若干针对老 WebView 的兼容处理。逐条见 [CHANGELOG.md](CHANGELOG.md)。

## 与官方的关系

本项目是**独立开发的第三方客户端**，与杭州深度求索人工智能基础技术研究有限公司没有隶属、合作、赞助或背书关系，也不是官方产品。具体来说：

- 没有分发、反编译、注入或重新签名任何官方安装包；
- 没有使用官方 App 的素材；界面是在上面提到的 MIT 开源 demo 上重新设计的；
- 名称 "DS Chat"、界面与图标中的鲸鱼，属于**识别性使用**（nominative use），只为说明本软件连接的是哪一家的接口，不暗示任何官方身份；
- 官方没有为本项目提供支持，遇到问题请在本仓库反馈。

## 商标

- "DeepSeek"、"深度求索" 及其鲸鱼标识归杭州深度求索人工智能基础技术研究有限公司所有，本项目不主张任何权利。
- 名称 "DS Chat"、界面与图标中的鲸鱼，仅用于说明本软件对接的是 DeepSeek 的 API，**不表示**与 DeepSeek 存在隶属、合作或背书关系。
- 如果你要基于本项目再发布一个客户端，请替换名称与图标，并在 README 显著位置声明非官方，避免让人误以为是官方产品。

## 第三方组件

前端依赖的全部是 MIT / ISC / Apache-2.0 许可的开源库，完整清单见 `web/package.json`。其中值得一提的：

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| React 18 | 界面 | MIT |
| rspack | 打包 | MIT |
| zustand | 状态 | MIT |
| KaTeX | 数学公式 | MIT |
| Mermaid | 图表 | MIT |
| Prism.js | 代码高亮 | MIT |
| fflate | ZIP 解压（历史导入） | MIT |
| idb | IndexedDB 封装 | ISC |

Android 端没有第三方依赖：`MainActivity` 与 `NativeBridge` 只用 Android SDK。

## 免责

本项目按 MIT 许可"按原样"提供，不附带任何担保。它会把你的 API Key 和对话内容发给你配置的服务地址，请自行确认该地址可信；因此产生的费用、数据泄露或其它损失，作者不承担责任。使用前请阅读 [docs/PRIVACY.md](docs/PRIVACY.md)。

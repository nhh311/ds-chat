# web

DS Chat 的前端：React 18 + TypeScript + rspack，构建成一份纯静态资源，不知道自己在浏览器里还是在 Android 的 WebView 里。

```bash
pnpm install
pnpm dev      # http://localhost:8090
pnpm build    # dist/
```

- 项目总览：[../README.md](../README.md)
- 构建细节（含 Android 壳）：[../docs/BUILD.md](../docs/BUILD.md)
- 请求与状态管理：[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

默认 API 地址由 `rspack.config.ts` 的 `createConfig({ apiOrigin })` 注入为 `__API_ORIGIN__`；运行时的"服务地址"设置优先级更高。

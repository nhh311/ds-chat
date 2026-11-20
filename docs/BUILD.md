# 构建

两个部分可以分开构建：网页端（纯静态）和 Android 壳（把网页端塞进 APK）。

## 环境要求

| | 网页端 | Android |
| --- | --- | --- |
| Node.js | 20 及以上（CI 用 24） | — |
| pnpm | 12.x（CI 锁定 12.6.0） | — |
| JDK | — | 17（`javac` 要能编 `-source 8 -target 8`） |
| Android SDK | — | `build-tools;35.0.0` + `platforms;android-35` |

Android 端**不需要 Gradle**：`build-apk.sh` 直接调 `aapt2` / `javac` / `d8` / `jar` / `zipalign` / `apksigner`。这样做的原因写在脚本注释里——本机没有 AGP 缓存，Gradle 与 AGP 的版本匹配、以及中文路径，都更容易出问题。

## 网页端

```bash
cd web
pnpm install
pnpm dev          # http://localhost:8090
pnpm type         # tsc 类型检查
pnpm lint         # oxlint
pnpm build        # 产物：web/dist（4.3 MB 左右）
```

产物是纯静态的，可以直接扔到任何静态托管；`publicPath: 'auto'` 让它也能用 `file://` 打开（Android 壳就是这么用的）。构建时 `LICENSE` 会被复制进 `dist/`。

### 改默认 API 地址

`rspack.config.ts` 里的 `createConfig({ apiOrigin })` 决定编译期常量 `__API_ORIGIN__`（默认 `https://api.deepseek.com`）。运行时的地址优先级是：设置里填的"服务地址" > `__API_ORIGIN__`。

```ts
export default defineConfig(createConfig({ apiOrigin: 'https://your-relay.example.com' }))
```

注意 JS 目标被压到 `chrome >= 61`：Android 系统 WebView 长期不更新，7.x–9.x 内核很常见，一旦主 bundle 用了新语法，整页就是 `SyntaxError` + 白屏，且没有任何可见报错。改构建配置时别把这个降级去掉。

## Android

先构建网页端（脚本会检查 `../web/dist/index.html` 是否存在），然后：

```bash
cd android
./build-apk.sh
```

Windows 上没有 Git Bash（或者不想为一次打包装一个）时，用步骤完全一致的 PowerShell 版：

```powershell
cd android
powershell -ExecutionPolicy Bypass -File .\build-apk.ps1
```

脚本按顺序做这些事：

1. `web/dist` 拷进 `build/assetsroot/assets/`，页面从 `file:///android_asset/index.html` 打开
2. `aapt2 compile` 编译 `res/` 成 `.flat`，`aapt2 link` 生成不含 assets 的 `base.apk`（minSdk 24 / targetSdk 35、versionCode / versionName 取自脚本变量）
3. `javac` 编译 `java/com/dskchat/app/*.java`
4. `d8` 转 dex
5. `jar --update` 把 `assets/` 与 `classes.dex` 塞进 APK
6. `zipalign -p 4` 对齐，`apksigner` 用 `debug.keystore` 签名
7. `apksigner verify --print-certs` 打印证书并 `ls -l` 产物

产物在 `android/build/dsk-chat-0.3.10.apk`（2,030,945 字节，SHA-256 `7F195D11AFF745974C0B5437982ED857AE92955A10D3041AFE15541F1B8B7C91`；`build/` 不入库）。

### 工具链路径

默认按开发目录摆放，也可以用环境变量指到你自己的 SDK / JDK：

```bash
ANDROID_BUILD_TOOLS=~/Android/Sdk/build-tools/35.0.0 \
ANDROID_JAR=~/Android/Sdk/platforms/android-35/android.jar \
JAVA_HOME=/usr/lib/jvm/temurin-17-jdk \
./build-apk.sh
```

脚本开头会逐个检查 `aapt2` / `android.jar` / `javac` 是否存在，缺了就直接报是哪一条。

### 关于签名

仓库里带着 `android/debug.keystore`（`CN=Android Debug`，口令 `android`）。**它不是密钥，就是 Android 调试用的那把公开钥匙**，之所以提交进来，是为了让任何人重新构建的 APK 都能覆盖安装已发布的版本（签名不同就不能升级）。

自己换一把也行，但那样就装不到官方发布的版本上了，得先卸载。签名证书指纹：

```bash
apksigner verify --print-certs android/build/dsk-chat-0.3.10.apk
```

### 安装与验证

```bash
adb install -r android/build/dsk-chat-0.3.10.apk
adb logcat -s DSKCHAT          # 原生侧日志
```

## 发版清单

1. 改 `android/build-apk.sh` 与 `android/build-apk.ps1` 里的 `VERSION_CODE` / `VERSION_NAME` / `APP_NAME`，以及 `AndroidManifest.xml` 里的同名属性（清单里的值会被 link 参数覆盖，但保持一致更清楚）
2. 改 `web/package.json` 的 `version`（它会写进 HTML 的 `application-version` meta）与 `package-lock.json` 顶部的 `version`
3. 更新 `CHANGELOG.md`，构建 APK
4. 计算 SHA-256 并写进 Release 说明：`certutil -hashfile <apk> SHA256`（Windows）或 `sha256sum`
5. 建一个 `v<version>` 的 tag，把 APK 作为 Release 资产传上去（APK 不进仓库）

## Windows 上的两个坑

脚本注释里已经写了，这里再强调一次，因为重写构建脚本时很容易踩回去：

- `aapt2` 等原生工具按 ANSI 代码页解析参数，传 UTF-8 中文绝对路径会"找不到文件"——所以全程用相对路径，脚本一进来就 `cd "$(dirname "$0")"`。
- `aapt2 -A` 在 Windows 上会把 asset 条目名写成反斜杠（`assets\static\js\...`），Android 读不到。所以 assets 只用 `jar` 加，`jar` 保证正斜杠。
- `javac` 必须显式 `-encoding UTF-8`（源码里有中文注释），且 `android.jar` 没有 `LambdaMetafactory`，所以 Java 代码里不用 lambda。

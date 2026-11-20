#!/usr/bin/env bash
# 手工构建 APK：aapt2 打包 + jar 塞入 assets 与 dex + zipalign + apksigner
# 不用 Gradle：本机没有 AGP 缓存，Gradle/AGP 版本匹配与中文路径都更容易翻车。
# 两个坑（已绕过）：
#   1) aapt2 等原生工具按 ANSI 代码页解析参数，传 UTF-8 中文绝对路径会「找不到文件」→ 全程用相对路径
#   2) aapt2 -A 在 Windows 上会把 asset 条目名写成反斜杠（assets\static\js\...），Android 读不到
#      → 只用 jar 添加 assets，jar 保证正斜杠
set -euo pipefail

cd "$(dirname "$0")"

# 工具链路径：默认按本项目的开发目录摆放，也可以用环境变量指到自己的 SDK / JDK
BT=${ANDROID_BUILD_TOOLS:-../.toolchain/android-sdk/build-tools/35.0.0}
AJ=${ANDROID_JAR:-../.toolchain/android-sdk/platforms/android-35/android.jar}
JDK=${JAVA_HOME:-../.toolchain/jdk}
APP_NAME=dsk-chat-0.3.9

for f in "$BT/aapt2.exe" "$AJ" "$JDK/bin/javac.exe"; do
  [ -e "$f" ] || { echo "缺少工具链：$f（用 ANDROID_BUILD_TOOLS / ANDROID_JAR / JAVA_HOME 指定）"; exit 1; }
done
[ -f ../web/dist/index.html ] || { echo "缺少前端产物：先 cd ../web && pnpm build"; exit 1; }
VERSION_CODE=14
VERSION_NAME=0.3.9

rm -rf build
mkdir -p build/classes build/dex build/apk build/assetsroot/assets build/res

# 1. 前端产物进 assets，页面从 file:///android_asset/index.html 打开
cp -r ../web/dist/. build/assetsroot/assets/

# 2. 启动器图标等资源先编译成 .flat（aapt2 compile），再由 link 的 -R 合并
"$BT/aapt2.exe" compile --dir res -o build/res/res.zip

# 3. 清单 + 资源打包（不含 assets）
"$BT/aapt2.exe" link \
  -o build/apk/base.apk \
  -I "$AJ" \
  --manifest AndroidManifest.xml \
  -R build/res/res.zip \
  --min-sdk-version 24 \
  --target-sdk-version 35 \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
  --auto-add-overlay

# 4. 编译 Java（目标 8；源码是 UTF-8，必须显式声明编码；android.jar 没有 LambdaMetafactory，代码里不用 lambda）
"$JDK/bin/javac.exe" -nowarn -encoding UTF-8 -source 8 -target 8 \
  -bootclasspath "$AJ" -classpath "$AJ" \
  -d build/classes java/com/dskchat/app/*.java

# 5. 转 dex（直接调 d8.jar，避开 .bat 的编码与引号问题）
"$JDK/bin/java.exe" -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 \
  --lib "$AJ" --min-api 24 --output build/dex \
  build/classes/com/dskchat/app/*.class

# 6. assets 与 dex 用 jar 塞进 APK（jar 内部统一正斜杠）
"$JDK/bin/jar.exe" --update --file build/apk/base.apk \
  -C build/assetsroot assets \
  -C build/dex classes.dex

# 7. 对齐 + 签名
"$BT/zipalign.exe" -f -p 4 build/apk/base.apk build/apk/aligned.apk

if [ ! -f debug.keystore ]; then
  "$JDK/bin/keytool.exe" -genkeypair \
    -keystore debug.keystore \
    -storepass android -keypass android \
    -alias androiddebugkey \
    -dname "CN=Android Debug,O=Android,C=US" \
    -keyalg RSA -keysize 2048 -validity 10000
fi

"$JDK/bin/java.exe" -jar "$BT/lib/apksigner.jar" sign \
  --ks debug.keystore \
  --ks-pass pass:android \
  --key-pass pass:android \
  --min-sdk-version 24 \
  --out "build/$APP_NAME.apk" \
  build/apk/aligned.apk

"$JDK/bin/java.exe" -jar "$BT/lib/apksigner.jar" verify --print-certs "build/$APP_NAME.apk" | head -3
ls -l "build/$APP_NAME.apk"
echo "APK ready: android/build/$APP_NAME.apk"

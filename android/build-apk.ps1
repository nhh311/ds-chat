# 手工构建 APK（Windows / PowerShell 版，与 build-apk.sh 等价）
# aapt2 打包 + jar 塞入 assets 与 dex + zipalign + apksigner，不需要 Gradle。
#
# 两个坑（已绕过）：
#   1) aapt2 等原生工具按 ANSI 代码页解析参数，传 UTF-8 中文绝对路径会「找不到文件」→ 全程用相对路径
#   2) aapt2 -A 在 Windows 上会把 asset 条目名写成反斜杠（assets\static\js\...），Android 读不到
#      → 只用 jar 添加 assets，jar 保证正斜杠
#
# 用法：pwsh -File build-apk.ps1   （或 powershell -ExecutionPolicy Bypass -File build-apk.ps1）
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$BT  = if ($env:ANDROID_BUILD_TOOLS) { $env:ANDROID_BUILD_TOOLS } else { '..\..\.toolchain\android-sdk\build-tools\35.0.0' }
$AJ  = if ($env:ANDROID_JAR)         { $env:ANDROID_JAR }         else { '..\..\.toolchain\android-sdk\platforms\android-35\android.jar' }
$JDK = if ($env:JAVA_HOME)           { $env:JAVA_HOME }           else { '..\..\.toolchain\jdk' }
$APP_NAME = 'dsk-chat-0.3.10'
$VERSION_CODE = '15'
$VERSION_NAME = '0.3.10'

foreach ($f in @("$BT\aapt2.exe", $AJ, "$JDK\bin\javac.exe")) {
  if (-not (Test-Path $f)) { throw "缺少工具链：$f（用 ANDROID_BUILD_TOOLS / ANDROID_JAR / JAVA_HOME 指定）" }
}
if (-not (Test-Path '..\web\dist\index.html')) { throw '缺少前端产物：先 cd ../web && pnpm build' }

function Invoke-Checked([string]$exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$exe 失败（退出码 $LASTEXITCODE）" }
}

Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue
$null = New-Item -ItemType Directory -Force build\classes, build\dex, build\apk, build\assetsroot\assets, build\res

# 1. 前端产物进 assets
Copy-Item -Recurse -Force ..\web\dist\* build\assetsroot\assets\

# 2. 资源编译成 .flat 包
Invoke-Checked "$BT\aapt2.exe" @('compile', '--dir', 'res', '-o', 'build/res/res.zip')

# 3. 清单 + 资源链接
Invoke-Checked "$BT\aapt2.exe" @(
  'link', '-o', 'build/apk/base.apk', '-I', $AJ,
  '--manifest', 'AndroidManifest.xml', '-R', 'build/res/res.zip',
  '--min-sdk-version', '24', '--target-sdk-version', '35',
  '--version-code', $VERSION_CODE, '--version-name', $VERSION_NAME,
  '--auto-add-overlay'
)

# 4. 编译 Java（目标 8；源码 UTF-8；android.jar 没有 LambdaMetafactory，代码里不用 lambda）
Invoke-Checked "$JDK\bin\javac.exe" @(
  '-nowarn', '-encoding', 'UTF-8', '-source', '8', '-target', '8',
  '-bootclasspath', $AJ, '-classpath', $AJ,
  '-d', 'build/classes', 'java/com/dskchat/app/MainActivity.java', 'java/com/dskchat/app/NativeBridge.java'
)

# 5. 转 dex（把编译出来的 class 全部交给 d8，内部类也一起）
$classFiles = Get-ChildItem 'build\classes\com\dskchat\app' -Filter *.class -Recurse |
  ForEach-Object { $_.FullName.Substring((Get-Location).Path.Length + 1) -replace '\\', '/' }
Invoke-Checked "$JDK\bin\java.exe" (@(
  '-cp', "$BT\lib\d8.jar", 'com.android.tools.r8.D8',
  '--lib', $AJ, '--min-api', '24', '--output', 'build/dex'
) + $classFiles)

# 6. assets 与 dex 用 jar 塞进 APK
Invoke-Checked "$JDK\bin\jar.exe" @(
  '--update', '--file', 'build/apk/base.apk',
  '-C', 'build/assetsroot', 'assets',
  '-C', 'build/dex', 'classes.dex'
)

# 7. 对齐 + 签名
Invoke-Checked "$BT\zipalign.exe" @('-f', '-p', '4', 'build/apk/base.apk', 'build/apk/aligned.apk')

if (-not (Test-Path 'debug.keystore')) {
  Invoke-Checked "$JDK\bin\keytool.exe" @(
    '-genkeypair', '-keystore', 'debug.keystore', '-storepass', 'android', '-keypass', 'android',
    '-alias', 'androiddebugkey', '-dname', 'CN=Android Debug,O=Android,C=US',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000'
  )
}

Invoke-Checked "$JDK\bin\java.exe" @(
  '-jar', "$BT\lib\apksigner.jar", 'sign',
  '--ks', 'debug.keystore', '--ks-pass', 'pass:android', '--key-pass', 'pass:android',
  '--min-sdk-version', '24', '--out', "build/$APP_NAME.apk", 'build/apk/aligned.apk'
)

& "$JDK\bin\java.exe" -jar "$BT\lib\apksigner.jar" verify --print-certs "build/$APP_NAME.apk" | Select-Object -First 3
$apk = Get-Item "build/$APP_NAME.apk"
"APK ready: android/build/$APP_NAME.apk  ({0:N0} 字节)" -f $apk.Length
"SHA-256  : " + (Get-FileHash $apk.FullName -Algorithm SHA256).Hash

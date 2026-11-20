package com.dskchat.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.text.method.ScrollingMovementMethod;
import android.util.Log;
import android.util.TypedValue;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.widget.FrameLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.app.Activity;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.ArrayList;
import java.util.List;

/**
 * 单 Activity 外壳：把打包进 assets 的聊天前端当成原生应用运行。
 * 前端的所有请求仍然由前端自己发起（BYOK），这里只负责窗口、返回键和录音权限。
 *
 * 另外负责「别白屏」：WebView 加载失败、控制台报错、React 迟迟没挂载时，
 * 把原因用原生文字画在屏幕上，并同时写进 logcat（tag=DSKCHAT）。
 */
public class MainActivity extends Activity {
    private static final String TAG = "DSKCHAT";
    private static final int REQ_MIC = 1001;
    private static final int REQ_FILE = 1002;
    private static final int REQ_MIC_SPEECH = 1003;
    private static final String PAGE = "file:///android_asset/index.html";
    private static final long MOUNT_RECHECK_MS = 1200L;

    private WebView webView;
    private ScrollView errorPanel;
    private TextView errorText;
    private PermissionRequest pendingPermission;
    private NativeBridge bridge;
    /** 网页里 <input type="file"> 的选择回调，等系统选择器返回 */
    private ValueCallback<Uri[]> filePathCallback;

    private final List<String> consoleErrors = new ArrayList<>();
    private final Handler handler = new Handler(Looper.getMainLooper());

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);

        errorPanel = buildErrorPanel();
        errorPanel.setVisibility(View.GONE);

        try {
            webView = new WebView(this);
            if (Build.VERSION.SDK_INT >= 26) {
                Log.i(TAG, "WebView created, package=" + WebView.getCurrentWebViewPackage());
            } else {
                Log.i(TAG, "WebView created");
            }
        } catch (Throwable t) {
            // 设备上没有可用 WebView（被卸载 / 被禁用 / 内核损坏）
            Log.e(TAG, "WebView creation failed", t);
            root.addView(errorPanel, matchParent());
            setContentView(root);
            showFatal("系统 WebView 不可用", String.valueOf(t));
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(0xFFFFFFFF);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        settings.setTextZoom(100);
        // 前端需要打开 blob: 导出与本地文件选择
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);

        // window.DSK：安全区内边距、系统语音识别、应用私有目录
        bridge = new NativeBridge(this);
        webView.addJavascriptInterface(bridge, "DSK");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request == null ? null : request.getUrl();
                return uri != null && openExternally(uri.toString());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return url != null && openExternally(url);
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                Log.i(TAG, "onPageStarted " + url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "onPageFinished " + url);
                checkMounted(0);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                String url = request == null ? "?" : String.valueOf(request.getUrl());
                String desc = error == null ? "?" : (error.getErrorCode() + " " + error.getDescription());
                Log.e(TAG, "onReceivedError main=" + (request != null && request.isForMainFrame())
                        + " url=" + url + " err=" + desc);
                if (request != null && request.isForMainFrame()) {
                    showFatal("页面加载失败", "URL: " + url + "\n错误: " + desc);
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                String line = "[" + message.messageLevel() + "] " + message.message()
                        + " (" + message.sourceId() + ":" + message.lineNumber() + ")";
                Log.i(TAG, "console " + line);
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    if (consoleErrors.size() < 6) {
                        consoleErrors.add(line);
                    }
                }
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                boolean needsMic = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                        needsMic = true;
                    }
                }
                if (!needsMic) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    return;
                }
                // 先申请系统权限，拿到后再把授权结果交回网页
                pendingPermission = request;
                requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            }

            /**
             * 网页里的 <input type="file"> 只有实现这个回调才会弹出选择器。
             * 0.1.x 缺了它，所以附件按钮点了没有任何反应。
             */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                            FileChooserParams params) {
                Log.i(TAG, "onShowFileChooser mode=" + (params == null ? -1 : params.getMode())
                        + " accept=" + (params == null ? "?" : java.util.Arrays.toString(params.getAcceptTypes())));
                // 上一次没消费的回调必须先结束，否则网页侧会一直挂住
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                    filePathCallback = null;
                }
                filePathCallback = callback;

                // 相册：网页只接受 image/* 时走系统相册（Android 13+ 是系统照片选择器），可多选
                String[] accepts = params == null ? null : params.getAcceptTypes();
                boolean imagesOnly = accepts != null && accepts.length == 1
                        && "image/*".equals(accepts[0]);
                if (imagesOnly) {
                    Intent gallery = null;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        // MediaStore.ACTION_PICK_IMAGES 是系统照片选择器，支持一次勾选多张
                        gallery = new Intent(MediaStore.ACTION_PICK_IMAGES);
                        gallery.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, 20);
                    }
                    if (gallery == null) {
                        gallery = new Intent(Intent.ACTION_GET_CONTENT);
                        gallery.setType("image/*");
                        gallery.addCategory(Intent.CATEGORY_OPENABLE);
                    }
                    gallery.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    try {
                        Log.i(TAG, "onShowFileChooser gallery sdk=" + Build.VERSION.SDK_INT);
                        startActivityForResult(gallery, REQ_FILE);
                        return true;
                    } catch (Throwable t) {
                        Log.w(TAG, "no gallery picker, fallback to files", t);
                    }
                }

                Intent intent = null;
                try {
                    intent = params == null ? null : params.createIntent();
                } catch (Throwable t) {
                    Log.w(TAG, "createIntent failed", t);
                }
                if (intent == null) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                }
                // 安卓按 MIME 过滤，accept 里的 .md/.json/.mcp 之类常被挡掉；这里统一放开
                intent.setType("*/*");
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
                        params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(
                            Intent.createChooser(intent, "选择文件"), REQ_FILE);
                    return true;
                } catch (Throwable t) {
                    Log.e(TAG, "no file picker available", t);
                    filePathCallback = null;
                    return false;
                }
            }
        });

        root.addView(webView, matchParent());
        root.addView(errorPanel, matchParent());
        setContentView(root);

        Log.i(TAG, "loading " + PAGE);
        webView.loadUrl(PAGE);
    }

    /**
     * 页面加载完成后确认 React 真的挂上了：没挂上就重试一次，仍然没挂上就摊开原因。
     * 这是「白屏」唯一能被肉眼看见的兜底。
     */
    private void checkMounted(final int attempt) {
        if (webView == null) {
            return;
        }
        final String js = "(function(){try{var r=document.getElementById('root');"
                + "return JSON.stringify({m:!!window.__dskMounted,n:r?r.childElementCount:-1,"
                + "e:(window.__dskLastError||'')});}catch(x){return JSON.stringify({m:false,n:-2,e:String(x)});}})()";
        // 不用 lambda：javac -source 8 -bootclasspath android.jar 下没有
        // java.lang.invoke.LambdaMetafactory，编译期就过不去
        webView.evaluateJavascript(js, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                boolean mounted = false;
                String raw = value == null ? "" : value;
                try {
                    Object parsed = new JSONTokener(raw).nextValue();
                    String json = parsed instanceof String ? (String) parsed : raw;
                    JSONObject o = new JSONObject(json);
                    mounted = o.optBoolean("m", false);
                    Log.i(TAG, "mount probe attempt=" + attempt + " mounted=" + mounted
                            + " rootChildren=" + o.optInt("n", -1)
                            + " bootError=" + o.optString("e", ""));
                } catch (Throwable t) {
                    Log.w(TAG, "mount probe parse failed: " + raw, t);
                }

                if (mounted) {
                    errorPanel.setVisibility(View.GONE);
                    return;
                }
                if (attempt == 0) {
                    handler.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            checkMounted(1);
                        }
                    }, MOUNT_RECHECK_MS);
                    return;
                }
                StringBuilder detail = new StringBuilder();
                detail.append("页面已经加载，但前端脚本没有跑起来。\n\n");
                detail.append("设备内核:\n").append(
                        webView == null ? "?" : webView.getSettings().getUserAgentString());
                detail.append("\n\n控制台报错:\n");
                if (consoleErrors.isEmpty()) {
                    detail.append("（没有捕获到上报的错误，多为内核版本过低导致语法解析失败）");
                } else {
                    for (String line : consoleErrors) {
                        detail.append(line).append('\n');
                    }
                }
                showFatal("前端没有挂载（白屏）", detail.toString());
            }
        });
    }

    private void showFatal(String title, String detail) {
        Log.e(TAG, "FATAL " + title + " :: " + detail);
        if (errorPanel == null || errorText == null) {
            return;
        }
        errorText.setText("DS Chat 无法启动\n\n" + title + "\n\n" + detail
                + "\n\n—— 点这里重新加载 ——");
        errorPanel.setVisibility(View.VISIBLE);
        errorPanel.scrollTo(0, 0);
    }

    @SuppressLint("ClickableViewAccessibility")
    private ScrollView buildErrorPanel() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.WHITE);
        scroll.setFillViewport(true);
        errorText = new TextView(this);
        errorText.setTextColor(Color.parseColor("#B3261E"));
        errorText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        errorText.setTypeface(android.graphics.Typeface.MONOSPACE);
        errorText.setPadding(dp(14), dp(14), dp(14), dp(14));
        errorText.setTextIsSelectable(true);
        errorText.setMovementMethod(new ScrollingMovementMethod());
        scroll.addView(errorText, matchParent());
        scroll.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (webView != null) {
                    consoleErrors.clear();
                    errorPanel.setVisibility(View.GONE);
                    webView.reload();
                }
            }
        });
        return scroll;
    }

    private static FrameLayout.LayoutParams matchParent() {
        return new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    /** 系统语音识别要用麦克风：由 NativeBridge 触发 */
    void requestMicPermission() {
        requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, REQ_MIC_SPEECH);
    }

    /** 把原生识别事件交给网页（window.__dskSpeechEvent） */
    void dispatchSpeechEvent(String json) {
        if (webView == null) {
            return;
        }
        final String js = "window.__dskSpeechEvent&&window.__dskSpeechEvent(" + json + ");";
        webView.evaluateJavascript(js, null);
    }

    /**
     * 外链交给系统浏览器：应用本身是 file:// 单页，任何 http(s) 链接在 WebView 里打开
     * 都会把页面导航走（聊天里点链接、隐私面板的按钮都走这里）。返回是否已交出去。
     */
    boolean openExternally(String url) {
        if (url == null) {
            return false;
        }
        String lower = url.toLowerCase();
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            return false;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
            Log.i(TAG, "openExternally " + url);
            return true;
        } catch (Exception error) {
            Log.w(TAG, "openExternally failed: " + url, error);
            return false;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (filePathCallback == null) {
                return;
            }
            Uri[] uris = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    uris = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        uris[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    uris = new Uri[] {data.getData()};
                }
            }
            Log.i(TAG, "file chooser result " + resultCode + " count="
                    + (uris == null ? 0 : uris.length));
            filePathCallback.onReceiveValue(uris);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == REQ_MIC_SPEECH) {
            if (bridge != null) {
                bridge.onMicPermissionResult(granted);
            }
            return;
        }
        if (requestCode != REQ_MIC || pendingPermission == null) {
            return;
        }
        if (granted) {
            pendingPermission.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            pendingPermission.deny();
        }
        pendingPermission = null;
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (bridge != null) {
            bridge.release();
            bridge = null;
        }
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}

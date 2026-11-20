package com.dskchat.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;

/**
 * 网页与原生之间的桥：window.DSK。
 *
 * 只做三件事：
 *   1. 把系统栏/刘海的内边距交给网页，避免状态栏压在顶栏按钮上；
 *   2. 录音并上传到云端的语音识别（不依赖设备自带识别服务，小米/华为上也稳）；
 *      设备识别服务可用时仍保留作为兜底；
 *   3. 给网页一个真实存在的应用私有目录，用来放 skill 与 MCP 配置。
 *
 * 所有方法都在 WebView 的 JavaBridge 线程上被调用，涉及 UI / 录音的动作都
 * 转发到主线程执行。
 */
public class NativeBridge {
    private static final String TAG = "DSKCHAT";

    /** 云端 ASR 的录音参数：16kHz 单声道 16-bit，正好是接口要求的 WAV */
    private static final int SAMPLE_RATE = 16000;
    /** 最长录 120 秒（接口上限），到点自动结束并上传 */
    private static final long MAX_RECORD_MS = 120000L;
    /** 小于 0.2 秒的录音直接判空，没必要上传 */
    private static final int MIN_PCM_BYTES = 6400;

    private final MainActivity activity;
    private final Handler main = new Handler(Looper.getMainLooper());

    private SpeechRecognizer recognizer;
    private String pendingLanguage = "zh-CN";
    /** 权限弹窗后要接着开始的那次录音 */
    private boolean startWhenGranted = false;

    // ------------------------------------------------------------ 云端 ASR 状态
    private String cloudKey = "";
    private String cloudOrigin = "";
    private boolean pendingCloud = false;
    private AudioRecord audioRecord;
    private Thread recordThread;
    private volatile boolean recording = false;
    private volatile boolean cloudCancelled = false;

    NativeBridge(MainActivity activity) {
        this.activity = activity;
    }

    // ---------------------------------------------------------------- 环境信息

    /** 系统栏与刘海的高度（CSS 像素），网页据此给顶栏留出安全区 */
    @JavascriptInterface
    public String insets() {
        JSONObject out = new JSONObject();
        try {
            float density = activity.getResources().getDisplayMetrics().density;
            int top = 0;
            int bottom = 0;
            int left = 0;
            int right = 0;
            if (Build.VERSION.SDK_INT >= 23) {
                WindowInsets insets = activity.getWindow().getDecorView().getRootWindowInsets();
                if (insets != null) {
                    if (Build.VERSION.SDK_INT >= 30) {
                        android.graphics.Insets bars = insets.getInsets(
                                WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                        top = bars.top;
                        bottom = bars.bottom;
                        left = bars.left;
                        right = bars.right;
                    } else {
                        top = insets.getSystemWindowInsetTop();
                        bottom = insets.getSystemWindowInsetBottom();
                        left = insets.getSystemWindowInsetLeft();
                        right = insets.getSystemWindowInsetRight();
                    }
                }
            }
            out.put("top", Math.round(top / density));
            out.put("bottom", Math.round(bottom / density));
            out.put("left", Math.round(left / density));
            out.put("right", Math.round(right / density));
            out.put("density", density);
            out.put("sdk", Build.VERSION.SDK_INT);
            out.put("supported", true);
        } catch (Throwable t) {
            Log.w(TAG, "insets failed", t);
            try {
                out.put("supported", false);
            } catch (Throwable ignored) {
                // 不会发生
            }
        }
        return out.toString();
    }

    /** 交给系统浏览器打开 http(s) 链接；隐私面板的「隐私政策」等按钮走这里 */
    @JavascriptInterface
    public boolean openExternal(String url) {
        return activity.openExternally(url);
    }

    /** 版本、内核与设备信息，设置页用来排查问题 */
    @JavascriptInterface
    public String info() {        JSONObject out = new JSONObject();
        try {
            out.put("versionName", activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0).versionName);
            out.put("sdk", Build.VERSION.SDK_INT);
            out.put("device", Build.MANUFACTURER + " " + Build.MODEL);
            out.put("android", Build.VERSION.RELEASE);
            String webViewPkg = "";
            if (Build.VERSION.SDK_INT >= 26) {
                android.content.pm.PackageInfo pkg = android.webkit.WebView.getCurrentWebViewPackage();
                if (pkg != null) {
                    webViewPkg = pkg.packageName + " " + pkg.versionName;
                }
            }
            out.put("webView", webViewPkg);
            out.put("speech", speechStatus());
        } catch (Throwable t) {
            Log.w(TAG, "info failed", t);
        }
        return out.toString();
    }

    // ------------------------------------------------------------------- 语音

    /** ready：系统识别服务可用；denied：没给麦克风权限；missing：本机没有识别服务 */
    @JavascriptInterface
    public String speechStatus() {
        if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
            return "missing";
        }
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            return "denied";
        }
        return "ready";
    }

    /**
     * 开始一次识别。返回 true 表示已经开始；false 表示正在申请权限或没有识别服务，
     * 结果会通过 __dskSpeechEvent 回调。
     */
    @JavascriptInterface
    public boolean startSpeech(String language) {
        pendingLanguage = language == null || language.length() == 0 ? "zh-CN" : language;
        if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
            emitError("unavailable", "本机没有可用的语音识别服务");
            return false;
        }
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            startWhenGranted = true;
            main.post(new Runnable() {
                @Override
                public void run() {
                    activity.requestMicPermission();
                }
            });
            return false;
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                begin(pendingLanguage);
            }
        });
        return true;
    }

    @JavascriptInterface
    public void stopSpeech() {
        main.post(new Runnable() {
            @Override
            public void run() {
                if (recognizer != null) {
                    try {
                        recognizer.stopListening();
                    } catch (Throwable t) {
                        Log.w(TAG, "stopListening failed", t);
                    }
                }
            }
        });
    }

    @JavascriptInterface
    public void cancelSpeech() {
        startWhenGranted = false;
        main.post(new Runnable() {
            @Override
            public void run() {
                destroyRecognizer();
            }
        });
    }

    /** 麦克风权限结果回来后由 Activity 调用 */
    void onMicPermissionResult(boolean granted) {
        if (pendingCloud) {
            pendingCloud = false;
            if (!granted) {
                emitError("denied", "没有麦克风权限");
                return;
            }
            startCloudRecording();
            return;
        }
        if (!startWhenGranted) {
            return;
        }
        startWhenGranted = false;
        if (!granted) {
            emitError("denied", "没有麦克风权限");
            return;
        }
        begin(pendingLanguage);
    }

    // ------------------------------------------------------- 云端语音识别（ASR）

    /** 麦克风权限是否已经拿到 */
    private boolean micGranted() {
        return activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * 开始录音，停止后自动上传到 {origin}/v1/tools/asr。
     *
     * @param apiKey   网页里保存的 API Key，用 Bearer 鉴权
     * @param origin   API 域名，例如 https://api.deepseek.com
     * @return true 已开始录音；false 表示正在申请麦克风权限（结果见 onMicPermissionResult）
     */
    @JavascriptInterface
    public boolean startCloudSpeech(String apiKey, String origin, String language) {
        cloudKey = apiKey == null ? "" : apiKey.trim();
        cloudOrigin = origin == null ? "" : origin.trim();
        if (cloudKey.length() == 0) {
            emitError("no_key", "还没有填写 API Key");
            return false;
        }
        cloudCancelled = false;
        if (!micGranted()) {
            pendingCloud = true;
            main.post(new Runnable() {
                @Override
                public void run() {
                    activity.requestMicPermission();
                }
            });
            return false;
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                startCloudRecording();
            }
        });
        return true;
    }

    /** 结束录音并上传；结果通过 __dskSpeechEvent 的 final / empty / error 回来 */
    @JavascriptInterface
    public void stopCloudSpeech() {
        recording = false;
    }

    /** 放弃这次录音：不上传、不回调结果 */
    @JavascriptInterface
    public void cancelCloudSpeech() {
        cloudCancelled = true;
        pendingCloud = false;
        recording = false;
    }

    private void startCloudRecording() {
        releaseAudioRecord();
        if (recording) {
            return;
        }
        int minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        int bufferSize = Math.max(minBuffer > 0 ? minBuffer * 2 : 16384, 16384);
        // 不同厂商的机型对音源支持不一：语音识别音源拿不到就退回麦克风，再退回默认
        int[] sources = {
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                MediaRecorder.AudioSource.MIC,
                MediaRecorder.AudioSource.DEFAULT,
        };
        for (int source : sources) {
            if (audioRecord != null && audioRecord.getState() == AudioRecord.STATE_INITIALIZED) {
                break;
            }
            releaseAudioRecord();
            try {
                audioRecord = new AudioRecord(source, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT, bufferSize);
            } catch (Throwable t) {
                Log.w(TAG, "new AudioRecord failed source=" + source, t);
                audioRecord = null;
            }
        }
        if (audioRecord == null || audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord unavailable");
            emitError("audio", "麦克风不可用，请检查系统有没有禁止本应用录音");
            releaseAudioRecord();
            return;
        }
        try {
            audioRecord.startRecording();
        } catch (Throwable t) {
            Log.e(TAG, "startRecording failed", t);
            emitError("audio", "录音启动失败");
            releaseAudioRecord();
            return;
        }
        recording = true;
        cloudCancelled = false;
        emit("ready");
        emit("speechstart");
        recordThread = new Thread(new Runnable() {
            @Override
            public void run() {
                captureLoop();
            }
        }, "dsk-asr");
        recordThread.start();
    }

    /** 录音线程：边读边算电平，停止后编码 WAV 并上传 */
    private void captureLoop() {
        byte[] chunk = new byte[3200]; // 100ms 的 16-bit 单声道
        ByteArrayOutputStream pcm = new ByteArrayOutputStream();
        long startedAt = System.currentTimeMillis();
        long lastVolumeAt = 0;
        while (recording && !cloudCancelled) {
            int read;
            try {
                read = audioRecord == null ? -1 : audioRecord.read(chunk, 0, chunk.length);
            } catch (Throwable t) {
                Log.w(TAG, "AudioRecord.read failed", t);
                read = -1;
            }
            if (read > 0) {
                pcm.write(chunk, 0, read);
                long now = System.currentTimeMillis();
                if (now - lastVolumeAt >= 90) {
                    lastVolumeAt = now;
                    emitVolume(chunk, read);
                }
            } else if (read < 0) {
                break;
            }
            if (System.currentTimeMillis() - startedAt > MAX_RECORD_MS) {
                break;
            }
        }
        boolean cancelled = cloudCancelled;
        recording = false;
        releaseAudioRecord();
        if (cancelled) {
            return;
        }
        emit("speechend");
        byte[] data = pcm.toByteArray();
        if (data.length < MIN_PCM_BYTES) {
            emit("empty");
            return;
        }
        finishCloudRecording(data);
    }

    private void finishCloudRecording(byte[] pcmBytes) {
        byte[] wav = encodeWav(pcmBytes, SAMPLE_RATE);
        String text = uploadAsr(wav);
        if (cloudCancelled || text == null) {
            return;
        }
        JSONObject event = new JSONObject();
        try {
            event.put("type", text.length() > 0 ? "final" : "empty");
            event.put("text", text);
        } catch (Throwable ignored) {
            return;
        }
        postEvent(event);
    }

    /** 把 16-bit PCM 前面补上 RIFF 头，接口要的是 WAV 文件 */
    private static byte[] encodeWav(byte[] pcm, int sampleRate) {
        int dataSize = pcm.length;
        int byteRate = sampleRate * 2;
        ByteArrayOutputStream out = new ByteArrayOutputStream(44 + dataSize);
        try {
            out.write(new byte[] {'R', 'I', 'F', 'F'});
            writeIntLE(out, 36 + dataSize);
            out.write(new byte[] {'W', 'A', 'V', 'E', 'f', 'm', 't', ' '});
            writeIntLE(out, 16);
            writeShortLE(out, 1);            // PCM
            writeShortLE(out, 1);            // 单声道
            writeIntLE(out, sampleRate);
            writeIntLE(out, byteRate);
            writeShortLE(out, 2);            // block align
            writeShortLE(out, 16);           // bits per sample
            out.write(new byte[] {'d', 'a', 't', 'a'});
            writeIntLE(out, dataSize);
            out.write(pcm);
        } catch (Throwable t) {
            Log.w(TAG, "encodeWav failed", t);
        }
        return out.toByteArray();
    }

    private static void writeIntLE(OutputStream out, int value) {
        try {
            out.write(value & 0xff);
            out.write((value >> 8) & 0xff);
            out.write((value >> 16) & 0xff);
            out.write((value >> 24) & 0xff);
        } catch (Throwable ignored) {
            // 内存流不会失败
        }
    }

    private static void writeShortLE(OutputStream out, int value) {
        try {
            out.write(value & 0xff);
            out.write((value >> 8) & 0xff);
        } catch (Throwable ignored) {
            // 内存流不会失败
        }
    }

    /** 上传一次识别；成功返回文本，失败返回 null（错误已经通过事件发出） */
    private String uploadAsr(byte[] wav) {
        String origin = cloudOrigin == null ? "" : cloudOrigin.trim();
        while (origin.endsWith("/")) {
            origin = origin.substring(0, origin.length() - 1);
        }
        if (!origin.startsWith("http")) {
            origin = "https://api.deepseek.com";
        }
        String boundary = "----dskchat" + System.currentTimeMillis();
        ByteArrayOutputStream body = new ByteArrayOutputStream(wav.length + 512);
        try {
            body.write(("--" + boundary + "\r\n").getBytes("UTF-8"));
            body.write(("Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n")
                    .getBytes("UTF-8"));
            body.write("Content-Type: audio/wav\r\n\r\n".getBytes("UTF-8"));
            body.write(wav);
            body.write(("\r\n--" + boundary + "--\r\n").getBytes("UTF-8"));
        } catch (Throwable t) {
            emitError("failed", "录音编码失败");
            return null;
        }
        byte[] payload = body.toByteArray();
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(origin + "/v1/tools/asr").openConnection();
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(90000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(payload.length);
            connection.setRequestProperty("Authorization", "Bearer " + cloudKey);
            connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            connection.setRequestProperty("Accept", "application/json");
            OutputStream out = connection.getOutputStream();
            try {
                out.write(payload);
                out.flush();
            } finally {
                out.close();
            }
            int code = connection.getResponseCode();
            InputStream stream = code >= 200 && code < 300
                    ? connection.getInputStream() : connection.getErrorStream();
            String raw = stream == null ? "" : readStream(stream);
            Log.i(TAG, "asr http " + code + " len=" + raw.length());
            if (code < 200 || code >= 300) {
                String detail = describeServerError(raw);
                if (code == 401 || code == 403) {
                    emitError("auth", "API Key 无法调用语音识别" + detail);
                } else if (code == 413) {
                    emitError("audio", "录音太长，请说短一些");
                } else {
                    emitError("server", "识别服务返回 " + code + detail);
                }
                return null;
            }
            return readAsrText(raw);
        } catch (Throwable t) {
            Log.w(TAG, "asr upload failed", t);
            emitError("network", "上传录音失败：" + t.getMessage());
            return null;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    /**
     * 从识别结果里取文本。公开文档没写死字段名，这里把常见的几种都试一遍：
     * text / transcript / result，以及 data.text、data.transcript 这类嵌套写法。
     */
    private static String readAsrText(String raw) {
        if (raw == null || raw.trim().length() == 0) {
            return "";
        }
        try {
            JSONObject json = new JSONObject(raw);
            String direct = firstString(json, new String[] {"text", "transcript", "result"});
            if (direct != null) {
                return direct;
            }
            Object data = json.opt("data");
            if (data instanceof JSONObject) {
                String nested = firstString((JSONObject) data,
                        new String[] {"text", "transcript", "result"});
                if (nested != null) {
                    return nested;
                }
            }
            if (data instanceof String) {
                return ((String) data).trim();
            }
        } catch (Throwable t) {
            Log.w(TAG, "asr response is not json: " + raw.substring(0, Math.min(120, raw.length())));
        }
        return "";
    }

    private static String firstString(JSONObject json, String[] keys) {
        for (String key : keys) {
            Object value = json.opt(key);
            if (value instanceof String && ((String) value).trim().length() > 0) {
                return ((String) value).trim();
            }
        }
        return null;
    }

    /** 把服务端的错误信息压缩成一句，方便在页面上直接看到原因 */
    private static String describeServerError(String raw) {
        if (raw == null || raw.trim().length() == 0) {
            return "";
        }
        String message = raw.trim();
        try {
            JSONObject json = new JSONObject(message);
            Object error = json.opt("error");
            if (error instanceof JSONObject) {
                Object text = ((JSONObject) error).opt("message");
                if (text instanceof String) {
                    message = (String) text;
                }
            } else if (error instanceof String) {
                message = (String) error;
            } else if (json.opt("message") instanceof String) {
                message = (String) json.opt("message");
            }
        } catch (Throwable ignored) {
            // 不是 JSON 就直接用原文
        }
        message = message.replace('\n', ' ').trim();
        if (message.length() > 120) {
            message = message.substring(0, 120) + "…";
        }
        return message.length() == 0 ? "" : "：" + message;
    }

    private static String readStream(InputStream stream) {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        try {
            int read;
            while ((read = stream.read(chunk)) > 0) {
                buffer.write(chunk, 0, read);
            }
            return buffer.toString("UTF-8");
        } catch (Throwable t) {
            Log.w(TAG, "readStream failed", t);
            return "";
        } finally {
            try {
                stream.close();
            } catch (Throwable ignored) {
                // 忽略
            }
        }
    }

    /** 用 PCM 的均方根算电平，归一化到 0..1，给网页画波形 */
    private void emitVolume(byte[] data, int length) {
        long sum = 0;
        int samples = length / 2;
        for (int i = 0; i + 1 < length; i += 2) {
            int value = (short) ((data[i] & 0xff) | (data[i + 1] << 8));
            sum += (long) value * value;
        }
        if (samples <= 0) {
            return;
        }
        double rms = Math.sqrt((double) sum / samples);
        float level = (float) Math.min(1d, rms / 3500d);
        JSONObject event = new JSONObject();
        try {
            event.put("type", "volume");
            event.put("value", level);
        } catch (Throwable ignored) {
            return;
        }
        postEvent(event);
    }

    private void releaseAudioRecord() {
        AudioRecord current = audioRecord;
        audioRecord = null;
        if (current == null) {
            return;
        }
        try {
            if (current.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                current.stop();
            }
        } catch (Throwable ignored) {
            // 已经停止
        }
        try {
            current.release();
        } catch (Throwable ignored) {
            // 已经释放
        }
    }

    private void begin(String language) {
        destroyRecognizer();
        try {
            recognizer = SpeechRecognizer.createSpeechRecognizer(activity);
        } catch (Throwable t) {
            Log.e(TAG, "createSpeechRecognizer failed", t);
            emitError("unavailable", "无法创建语音识别器");
            return;
        }
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override
            public void onReadyForSpeech(Bundle params) {
                emit("ready");
            }

            @Override
            public void onBeginningOfSpeech() {
                emit("speechstart");
            }

            @Override
            public void onRmsChanged(float rmsdB) {
                // 给网页画电平用；限制频率，避免桥调用过密
                long now = System.currentTimeMillis();
                if (now - lastVolumeAt < 90) {
                    return;
                }
                lastVolumeAt = now;
                JSONObject event = new JSONObject();
                try {
                    event.put("type", "volume");
                    // rmsdB 一般落在 -2..10，归一化到 0..1
                    event.put("value", Math.max(0f, Math.min(1f, (rmsdB + 2f) / 12f)));
                } catch (Throwable ignored) {
                    return;
                }
                postEvent(event);
            }

            @Override
            public void onBufferReceived(byte[] buffer) {
                // 不需要原始音频
            }

            @Override
            public void onEndOfSpeech() {
                emit("speechend");
            }

            @Override
            public void onError(int error) {
                emitError(mapError(error), describeError(error));
                destroyRecognizer();
            }

            @Override
            public void onResults(Bundle results) {
                String text = firstResult(results);
                JSONObject event = new JSONObject();
                try {
                    event.put("type", text.length() > 0 ? "final" : "empty");
                    event.put("text", text);
                } catch (Throwable ignored) {
                    // 不会发生
                }
                postEvent(event);
                destroyRecognizer();
            }

            @Override
            public void onPartialResults(Bundle partialResults) {
                String text = firstResult(partialResults);
                if (text.length() == 0) {
                    return;
                }
                JSONObject event = new JSONObject();
                try {
                    event.put("type", "partial");
                    event.put("text", text);
                } catch (Throwable ignored) {
                    return;
                }
                postEvent(event);
            }

            @Override
            public void onEvent(int eventType, Bundle params) {
                // 识别服务的自定义事件，忽略
            }
        });

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
        intent.putExtra(RecognizerIntent.EXTRA_ONLY_RETURN_LANGUAGE_PREFERENCE, language);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.getPackageName());
        try {
            recognizer.startListening(intent);
            Log.i(TAG, "speech start lang=" + language);
        } catch (Throwable t) {
            Log.e(TAG, "startListening failed", t);
            emitError("unavailable", "语音识别启动失败");
            destroyRecognizer();
        }
    }

    private long lastVolumeAt = 0;

    private void destroyRecognizer() {
        if (recognizer == null) {
            return;
        }
        try {
            recognizer.cancel();
        } catch (Throwable ignored) {
            // 已经结束
        }
        try {
            recognizer.destroy();
        } catch (Throwable ignored) {
            // 已经销毁
        }
        recognizer = null;
    }

    void release() {
        cloudCancelled = true;
        recording = false;
        releaseAudioRecord();
        destroyRecognizer();
    }

    private static String firstResult(Bundle bundle) {
        if (bundle == null) {
            return "";
        }
        ArrayList<String> list = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (list == null || list.isEmpty()) {
            return "";
        }
        String best = list.get(0);
        return best == null ? "" : best.trim();
    }

    private static String mapError(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "empty";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "network";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "denied";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "busy";
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio";
            case SpeechRecognizer.ERROR_SERVER:
                return "server";
            default:
                return "failed";
        }
    }

    private static String describeError(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "没有听到可识别的内容";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "没有检测到说话";
            case SpeechRecognizer.ERROR_NETWORK:
                return "语音识别需要网络，当前不可用";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "语音识别网络超时";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "没有麦克风权限";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "识别服务正忙";
            case SpeechRecognizer.ERROR_AUDIO:
                return "录音出错";
            case SpeechRecognizer.ERROR_SERVER:
                return "识别服务返回错误";
            default:
                return "语音识别失败（" + error + "）";
        }
    }

    private void emit(String type) {
        JSONObject event = new JSONObject();
        try {
            event.put("type", type);
        } catch (Throwable ignored) {
            return;
        }
        postEvent(event);
    }

    private void emitError(String code, String message) {
        JSONObject event = new JSONObject();
        try {
            event.put("type", "error");
            event.put("code", code);
            event.put("message", message);
        } catch (Throwable ignored) {
            return;
        }
        Log.w(TAG, "speech error " + code + " " + message);
        postEvent(event);
    }

    private void postEvent(final JSONObject event) {
        main.post(new Runnable() {
            @Override
            public void run() {
                activity.dispatchSpeechEvent(event.toString());
            }
        });
    }

    // ------------------------------------------------------- 应用私有文件目录

    /** 网页可读写的目录，对应 Android/data/com.dskchat.app/files/dsk */
    private File storeDir() {
        File dir = new File(activity.getFilesDir(), "dsk");
        if (!dir.exists() && !dir.mkdirs()) {
            Log.w(TAG, "cannot create " + dir);
        }
        return dir;
    }

    /** 绝对路径 + 文件清单，设置页展示给用户 */
    @JavascriptInterface
    public String storage() {
        JSONObject out = new JSONObject();
        try {
            File dir = storeDir();
            out.put("path", dir.getAbsolutePath());
            out.put("exists", dir.exists());
            JSONArray names = new JSONArray();
            File[] files = dir.listFiles();
            if (files != null) {
                for (File file : files) {
                    if (file.isFile()) {
                        names.put(file.getName());
                    }
                }
            }
            out.put("files", names);
        } catch (Throwable t) {
            Log.w(TAG, "storage failed", t);
        }
        return out.toString();
    }

    @JavascriptInterface
    public boolean writeStoreFile(String name, String content) {
        if (!isSafeName(name)) {
            return false;
        }
        FileOutputStream stream = null;
        try {
            stream = new FileOutputStream(new File(storeDir(), name));
            stream.write(content.getBytes("UTF-8"));
            stream.flush();
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "writeStoreFile failed " + name, t);
            return false;
        } finally {
            if (stream != null) {
                try {
                    stream.close();
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        }
    }

    @JavascriptInterface
    public String readStoreFile(String name) {
        if (!isSafeName(name)) {
            return null;
        }
        File file = new File(storeDir(), name);
        if (!file.exists()) {
            return null;
        }
        FileInputStream stream = null;
        try {
            stream = new FileInputStream(file);
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = stream.read(chunk)) > 0) {
                buffer.write(chunk, 0, read);
            }
            return buffer.toString("UTF-8");
        } catch (Throwable t) {
            Log.w(TAG, "readStoreFile failed " + name, t);
            return null;
        } finally {
            if (stream != null) {
                try {
                    stream.close();
                } catch (Throwable ignored) {
                    // 忽略
                }
            }
        }
    }

    @JavascriptInterface
    public boolean deleteStoreFile(String name) {
        if (!isSafeName(name)) {
            return false;
        }
        File file = new File(storeDir(), name);
        return file.exists() && file.delete();
    }

    /** 只允许单个文件名，杜绝 ../ 之类的路径穿越 */
    private static boolean isSafeName(String name) {
        return name != null && name.length() > 0 && name.length() <= 200
                && name.indexOf('/') < 0 && name.indexOf('\\') < 0
                && !name.equals(".") && !name.equals("..");
    }
}

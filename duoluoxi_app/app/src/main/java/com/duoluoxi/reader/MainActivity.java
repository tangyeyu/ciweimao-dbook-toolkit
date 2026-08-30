package com.duoluoxi.reader;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.Window;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.GZIPInputStream;

public class MainActivity extends Activity {
    private static final int REQ_IMPORT = 1001;
    private WebView web;
    private String pendingImportBookId = null;
    private String pendingMode = "book";
    private volatile boolean inReader = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window w = getWindow();
        w.setStatusBarColor(Color.rgb(26, 28, 34));
        w.setNavigationBarColor(Color.rgb(26, 28, 34));

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new WebViewClient() {
            // 跟踪是否在阅读页（音量键翻页只在阅读页生效）
            @Override
            public void onPageFinished(WebView view, String url) {
                inReader = url != null && url.contains("reader.html");
            }
            // http://appbook.local/<bookId>/<path>：内置书走 assets/books/，导入书走 filesDir/books/
            // （不能用自定义 scheme——WebView 的 fetch 不走 shouldInterceptRequest，须用 http 域名+CORS 头）
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!"appbook.local".equals(uri.getHost())) return null;
                String path = uri.getPath();          // /<bookId>/chapters/0001.txt
                if (path == null) return null;
                String[] segs = path.replaceFirst("^/+", "").split("/", 2);
                if (segs.length < 2) return null;
                String bookId = segs[0];
                String rel = segs[1];
                // 1) 导入书（filesDir）
                File imp = new File(new File(getFilesDir(), "books"), bookId + File.separator + rel);
                if (imp.exists() && imp.isFile()) {
                    try {
                        byte[] data = readAll(new FileInputStream(imp));
                        return cors(mimeOf(rel), data);
                    } catch (IOException e) { /* fallthrough */ }
                }
                // 2) 内置书（assets/books/<id>/<rel>）
                String assetPath = "books/" + bookId + "/" + rel;
                try {
                    InputStream is = getAssets().open(assetPath);
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                    is.close();
                    return cors(mimeOf(rel), bos.toByteArray());
                } catch (IOException e) {
                    return null; // 404 → 走默认加载
                }
            }
        });
        web.setBackgroundColor(Color.rgb(26, 28, 34));

        web.addJavascriptInterface(new Bridge(), "AppBridge");

        setContentView(web);
        web.loadUrl("file:///android_asset/shelf/index.html");
    }

    // ---------- JS 桥 ----------
    private class Bridge {
        // 应用版本号（versionName，如 "2.2"）——书架副标题自动显示，改版只改 build.gradle
        @JavascriptInterface
        public String getVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "?";
            }
        }
        // 书架数据：内置 + 导入的书列表（JSON 数组字符串）
        @JavascriptInterface
        public String getBooks() {
            try {
                JSONArray out = new JSONArray();
                // 内置书
                String[] builtins;
                try { builtins = getAssets().list("books"); } catch (IOException e) { builtins = new String[0]; }
                if (builtins != null) {
                    for (String id : builtins) {
                        if (id.startsWith(".")) continue;
                        JSONObject m = readMeta("assets:books/" + id + "/meta.json");
                        if (m != null) { m.put("id", id); m.put("src", "builtin"); out.put(m); }
                    }
                }
                // 导入书
                File booksDir = new File(getFilesDir(), "books");
                File[] imp = booksDir.listFiles();
                if (imp != null) {
                    for (File f : imp) {
                        if (!f.isDirectory()) continue;
                        JSONObject m = readMeta("file:" + new File(f, "meta.json").getAbsolutePath());
                        if (m != null) { m.put("id", f.getName()); m.put("src", "imported"); out.put(m); }
                    }
                }
                return out.toString();
            } catch (Exception e) {
                return "[]";
            }
        }

        // 发起导入（系统文件选择器选 .dbook）
        // mode: "book"=导入书（含全书数据）; "tsukkomi"=导入段评（写入指定书）
        @JavascriptInterface
        public void importDbook(String mode, String bookId) {
            pendingMode = "book".equals(mode) ? "book" : "tsukkomi";
            pendingImportBookId = bookId;
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                startActivityForResult(intent, REQ_IMPORT);
            });
        }

        // 删除导入的书
        @JavascriptInterface
        public void removeBook(String bookId) {
            File f = new File(getFilesDir(), "books/" + bookId);
            if (f.exists()) deleteRecursive(f);
        }

        // 读书文件内容（返回 null 表示不存在）：App 内阅读器主通道，避开 fetch/CORS
        @JavascriptInterface
        public String readFile(String bookId, String path) {
            try {
                File imp = new File(new File(getFilesDir(), "books"), bookId + "/" + path);
                if (imp.exists() && imp.isFile()) {
                    return new String(readAll(new FileInputStream(imp)), StandardCharsets.UTF_8);
                }
                InputStream is = getAssets().open("books/" + bookId + "/" + path);
                String s = new String(readAll(is), StandardCharsets.UTF_8);
                is.close();
                return s;
            } catch (Exception e) {
                return null;
            }
        }
    }

    // ---------- 导入解析 ----------
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_IMPORT && resultCode == RESULT_OK && data != null) {
            Uri uri = data.getData();
            if (uri == null) return;
            final String mode = pendingMode;
            final String bookIdTarget = pendingImportBookId;
            try {
                InputStream is = getContentResolver().openInputStream(uri);
                if (is == null) return;
                ImportResult r = parseDbook(is, mode, bookIdTarget);
                is.close();
                if (r == null) {
                    notifyJs("window.onImportResult && window.onImportResult(false, '文件格式不正确（不是 .dbook）', " + jsonStr(mode) + ");");
                    return;
                }
                if (!r.ok) {
                    notifyJs("window.onImportResult && window.onImportResult(false, " + jsonStr(r.error) + ", " + jsonStr(mode) + ");");
                    return;
                }
                notifyJs("window.onImportResult && window.onImportResult(true, " + jsonStr(r.bookId) + ", " + jsonStr(mode) + ");");
            } catch (Exception e) {
                notifyJs("window.onImportResult && window.onImportResult(false, " + jsonStr(String.valueOf(e.getMessage())) + ", " + jsonStr(mode) + ");");
            }
        }
    }

    private static class ImportResult { String bookId; String error; boolean ok = true; }

    // .dbook 格式: MAGIC(8B "DLCBOOK1") + u32 metaLen + meta JSON + u32 fileCount +
    //   每文件: u32 nameLen + name + u32 gzLen + gzip(data)
    // mode="book": 完整导入/覆盖书（chapters + tsukkomi）
    // mode="tsukkomi": 只写 tsukkomi/ 到目标书（bookIdTarget），不覆盖正文
    private ImportResult parseDbook(InputStream in, String mode, String bookIdTarget) throws IOException, org.json.JSONException {
        byte[] magic = new byte[8];
        readFully(in, magic, 8);
        if (!"DLCBOOK1".equals(new String(magic, StandardCharsets.US_ASCII))) return null;

        int metaLen = readU32(in);
        byte[] metaBuf = new byte[metaLen];
        readFully(in, metaBuf, metaLen);
        JSONObject meta = new JSONObject(new String(metaBuf, StandardCharsets.UTF_8));
        String bookId = meta.optString("book_id", "book_" + System.currentTimeMillis());

        int fileCount = readU32(in);
        // 收集文件
        java.util.List<String> names = new java.util.ArrayList<>();
        java.util.Map<String, byte[]> datas = new java.util.HashMap<>();
        for (int i = 0; i < fileCount; i++) {
            int nameLen = readU32(in);
            byte[] nameBuf = new byte[nameLen];
            readFully(in, nameBuf, nameLen);
            String name = new String(nameBuf, StandardCharsets.UTF_8);
            int gzLen = readU32(in);
            byte[] gz = new byte[gzLen];
            readFully(in, gz, gzLen);
            if (name.contains("..")) continue; // 防路径穿越
            names.add(name);
            try (GZIPInputStream gis = new GZIPInputStream(new ByteArrayInputStream(gz))) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = gis.read(buf)) > 0) bos.write(buf, 0, n);
                datas.put(name, bos.toByteArray());
            }
        }

        ImportResult r = new ImportResult();
        r.bookId = bookId;
        if ("tsukkomi".equals(mode)) {
            // 段评导入：写入目标书（内置书也支持——filesDir 覆盖 assets 读取顺序）
            String target = (bookIdTarget != null && !bookIdTarget.isEmpty()) ? bookIdTarget : bookId;
            boolean hasTk = false;
            for (String name : names) {
                if (name.startsWith("tsukkomi/")) hasTk = true;
            }
            if (!hasTk) { r.ok = false; r.error = "包里没有段评数据（tsukkomi/）"; return r; }
            File base = new File(getFilesDir(), "books/" + target);
            base.mkdirs();
            for (String name : names) {
                if (!name.startsWith("tsukkomi/")) continue;
                File out = new File(base, name);
                out.getParentFile().mkdirs();
                FileOutputStream fos = new FileOutputStream(out);
                fos.write(datas.get(name));
                fos.close();
            }
            // 同时更新 meta.json（段评计数）到 filesDir，readFile 读取时 filesDir 优先
            try {
                JSONObject m2 = readMeta("file:" + new File(base, "meta.json").getAbsolutePath());
                JSONObject newMeta = (m2 != null) ? m2 : new JSONObject();
                newMeta.put("has_tsukkomi", true);
                int total = 0;
                JSONObject chTk = newMeta.optJSONObject("chapter_tsukkomi");
                if (chTk == null) chTk = new JSONObject();
                for (String name : names) {
                    if (name.startsWith("tsukkomi/") && name.endsWith(".json")) {
                        String idx = name.substring("tsukkomi/".length(), name.length() - 5).replaceFirst("^0+", "");
                        try {
                            JSONObject j = new JSONObject(new String(datas.get(name), StandardCharsets.UTF_8));
                            JSONArray paras = j.optJSONArray("paragraphs");
                            int n2 = 0;
                            if (paras != null) for (int k = 0; k < paras.length(); k++) {
                                JSONArray tks = paras.getJSONObject(k).optJSONArray("tsukkomi");
                                if (tks != null) n2 += tks.length();
                            }
                            chTk.put(idx, n2);
                            total += n2;
                        } catch (Exception e) { /* skip */ }
                    }
                }
                newMeta.put("chapter_tsukkomi", chTk);
                newMeta.put("tsukkomi_count", total);
                FileOutputStream fos = new FileOutputStream(new File(base, "meta.json"));
                fos.write(newMeta.toString().getBytes(StandardCharsets.UTF_8));
                fos.close();
            } catch (Exception e) { /* meta 更新失败不致命 */ }
            r.bookId = target;
            return r;
        }

        // mode="book": 完整导入/覆盖
        File base = new File(getFilesDir(), "books/" + bookId);
        deleteRecursive(base);
        base.mkdirs();
        for (String name : names) {
            File out = new File(base, name);
            out.getParentFile().mkdirs();
            FileOutputStream fos = new FileOutputStream(out);
            fos.write(datas.get(name));
            fos.close();
        }
        return r;
    }

    // ---------- 工具 ----------
    private JSONObject readMeta(String path) {
        try {
            String content;
            if (path.startsWith("assets:")) {
                InputStream is = getAssets().open(path.substring(7));
                content = new String(readAll(is), StandardCharsets.UTF_8);
                is.close();
            } else if (path.startsWith("file:")) {
                content = new String(readAll(new FileInputStream(path.substring(5))), StandardCharsets.UTF_8);
            } else {
                return null;
            }
            return new JSONObject(content);
        } catch (Exception e) {
            return null;
        }
    }

    private byte[] readAll(InputStream is) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
        return bos.toByteArray();
    }

    private void readFully(InputStream in, byte[] buf, int len) throws IOException {
        int off = 0;
        while (off < len) {
            int n = in.read(buf, off, len - off);
            if (n < 0) throw new IOException("意外结束");
            off += n;
        }
    }

    private int readU32(InputStream in) throws IOException {
        byte[] b = new byte[4];
        readFully(in, b, 4);
        return (b[0] & 0xff) | ((b[1] & 0xff) << 8) | ((b[2] & 0xff) << 16) | ((b[3] & 0xff) << 24);
    }

    // CORS 响应（file:// 页面 fetch http://appbook.local 属跨源，必须放行）
    private WebResourceResponse cors(String mime, byte[] data) {
        java.util.Map<String, String> headers = new java.util.HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse(mime, "utf-8", 200, "OK", headers, new ByteArrayInputStream(data));
    }

    private String mimeOf(String path) {        int dot = path.lastIndexOf('.');
        if (dot >= 0) {
            String ext = path.substring(dot + 1).toLowerCase();
            switch (ext) {
                case "txt": return "text/plain";
                case "json": return "application/json";
                case "html": return "text/html";
                case "css": return "text/css";
                case "js": return "application/javascript";
                case "png": return "image/png";
                case "jpg": case "jpeg": return "image/jpeg";
                default: return "application/octet-stream";
            }
        }
        return "application/octet-stream";
    }

    private void deleteRecursive(File f) {
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) for (File c : children) deleteRecursive(c);
        }
        f.delete();
    }

    private void notifyJs(final String js) {
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript(js, null);
        });
    }

    private String jsonStr(String s) {
        if (s == null) return "\"\"";
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r") + "\"";
    }

    // 音量键翻页时记录按键前的媒体音量（部分系统在拦截后仍会调音量，需要还原）
    private int lastVolume = -1;

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // 音量键翻页（仅在阅读页）：音量+ = 上一章，音量- = 下一章
        if (inReader && (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            final int dir = keyCode == KeyEvent.KEYCODE_VOLUME_UP ? -1 : 1;
            final android.media.AudioManager am = (android.media.AudioManager) getSystemService(AUDIO_SERVICE);
            // 只在首次按下记录音量（长按 repeatCount>0 时保持原值，避免越还原越偏）
            if (am != null && event.getRepeatCount() == 0) {
                lastVolume = am.getStreamVolume(android.media.AudioManager.STREAM_MUSIC);
            }
            web.evaluateJavascript("window.__volPage && window.__volPage(" + dir + ")", null);
            // 延迟还原音量：系统可能在事件分发后偷改，100ms 后写回按键前的值
            if (am != null && lastVolume >= 0) {
                final int vol = lastVolume;
                web.postDelayed(() -> {
                    if (vol != am.getStreamVolume(android.media.AudioManager.STREAM_MUSIC)) {
                        am.setStreamVolume(android.media.AudioManager.STREAM_MUSIC, vol, 0);
                    }
                }, 100);
            }
            return true; // 拦截，不调系统音量
        }
        if (keyCode == KeyEvent.KEYCODE_BACK && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onResume() {
        super.onResume();
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(decor.getSystemUiVisibility() & ~View.SYSTEM_UI_FLAG_HIDE_NAVIGATION);
    }
}

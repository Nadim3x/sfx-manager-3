/*
 * bridge.js — communication layer between the panel and After Effects / the OS.
 *
 * Inside After Effects this talks to:
 *   - window.__adobe_cep__  (evalScript, system paths, URLs)
 *   - window.cep.fs         (file system, base64 reads)
 *   - Node.js fs            (when --enable-nodejs is active)
 *
 * In a plain browser (live preview / development) a fully mocked
 * environment with a virtual SFX library is used instead.
 */

var Bridge = (function () {
    "use strict";

    var isCEP = (typeof window !== "undefined") &&
        !!(window.__adobe_cep__ && typeof window.__adobe_cep__.evalScript === "function");

    var hasNode = false;
    var nodeFs = null;
    var nodePath = null;
    try {
        if (typeof require === "function") {
            nodeFs = require("fs");
            nodePath = require("path");
            if (nodeFs && nodeFs.readdirSync) hasNode = true;
        }
    } catch (e) { hasNode = false; }

    /* ------------------------------------------------------------------ */
    /* ExtendScript eval                                                   */
    /* ------------------------------------------------------------------ */

    /** Escape a JS string as an ExtendScript string-literal argument. */
    function esLiteral(str) {
        return '"' + String(str)
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")
            .replace(/\t/g, "\\t") + '"';
    }

    /**
     * Call a hostscript.jsx function.
     * fn   – function name, e.g. "sfxm_addAtPlayhead"
     * args – array of arguments (strings/numbers) serialised automatically
     * cb   – callback receiving the parsed JSON object (or {ok:false,error})
     */
    function evalHost(fn, args, cb) {
        args = args || [];
        var literals = [];
        for (var i = 0; i < args.length; i++) {
            var a = args[i];
            literals.push(typeof a === "number" ? String(a) : esLiteral(a));
        }
        var code = fn + "(" + literals.join(",") + ")";

        if (!isCEP) {
            Mock.evalHost(fn, args, cb);
            return;
        }

        var done = false;
        function finish(raw) {
            if (done) return;
            done = true;
            if (typeof cb !== "function") return;
            var out;
            if (raw === "EvalScript error." || raw === undefined || raw === null) {
                out = { ok: false, error: "After Effects did not respond." };
            } else {
                try { out = JSON.parse(raw); }
                catch (e) { out = { ok: false, error: String(raw) }; }
            }
            cb(out);
        }

        try {
            window.__adobe_cep__.evalScript(code, finish);
        } catch (e) {
            finish("EvalScript error.");
        }
    }

    /* ------------------------------------------------------------------ */
    /* Paths                                                               */
    /* ------------------------------------------------------------------ */

    function fileUrlToPath(url) {
        if (!url) return "";
        var p = String(url);
        if (p.indexOf("file://") === 0) {
            p = p.substring(7);
            try { p = decodeURIComponent(p); } catch (e) {}
            // Windows file:///C:/...
            if (/^\/[A-Za-z]:\//.test(p)) p = p.substring(1);
        }
        return p;
    }

    function extensionPath() {
        if (!isCEP) return "";
        try {
            var raw = window.__adobe_cep__.getSystemPath("extension");
            return fileUrlToPath(raw);
        } catch (e) { return ""; }
    }

    function userDataPath() {
        if (!isCEP) return "";
        try { return fileUrlToPath(window.__adobe_cep__.getSystemPath("userData")); }
        catch (e) { return ""; }
    }

    /* ------------------------------------------------------------------ */
    /* Folder picker (native dialog via ExtendScript)                      */
    /* ------------------------------------------------------------------ */

    function pickFolder(cb) {
        if (!isCEP) { Mock.pickFolder(cb); return; }
        // The dialog + JSON serialisation live inside hostscript.jsx
        // (sfxm_pickFolder) — no fragile inline escaping on this side.
        evalHost("sfxm_pickFolder", [], function (out) {
            if (out && out.ok && out.path) { cb(out); return; }
            if (out && out.cancelled) { cb({ ok: false, cancelled: true }); return; }
            cb(out && out.error ? out : { ok: false, error: "Folder picker failed." });
        });
    }

    /* ------------------------------------------------------------------ */
    /* Misc host integration                                               */
    /* ------------------------------------------------------------------ */

    /**
     * Open a URL in the user's DEFAULT browser (whatever the customer uses).
     * Order matters — the Node shell-out is the most reliable on desktop,
     * the CEP hand-off is next, window.open only for plain-browser preview.
     */
    function openExternal(url) {
        var u = String(url);
        if (isCEP) {
            // 0) CEP util API — Adobe's runtime call that opens the OS default browser
            try {
                if (window.cep && window.cep.util &&
                    typeof window.cep.util.openURLInDefaultBrowser === "function") {
                    window.cep.util.openURLInDefaultBrowser(u);
                    return;
                }
            } catch (eCepUtil) {}
            // 1) OS shell → default browser (macOS "open", Windows "start", xdg-open)
            try {
                var req = null;
                if (typeof require === "function") req = require;
                else if (typeof window.require === "function") req = window.require;
                else if (typeof cep_node !== "undefined" && cep_node && cep_node.require) req = cep_node.require;
                if (req) {
                    var cp = req("child_process");
                    var plat = (typeof process !== "undefined" && process.platform) || "";
                    if (plat === "win32") {
                        cp.execFile("cmd.exe", ["/c", "start", "", u]);
                    } else if (plat === "darwin") {
                        cp.execFile("open", [u]);
                    } else {
                        cp.execFile("xdg-open", [u]);
                    }
                    return;
                }
            } catch (eNode) {}
            // 2) official CEP hand-off
            try {
                if (window.__adobe_cep__ && typeof window.__adobe_cep__.openURLInDefaultBrowser === "function") {
                    window.__adobe_cep__.openURLInDefaultBrowser(u);
                    return;
                }
            } catch (eCep) {}
        }
        // 3) plain browsers / live preview
        try { window.open(u, "_blank"); } catch (eOpen) {}
    }

    /**
     * Show in Folder — open the OS file manager with the audio file selected.
     * Recipe (user spec): child_process.exec + path; strip any file:/// prefix,
     * decodeURIComponent() the path, then:
     *   win32  → explorer.exe /select,"<path>"
     *   darwin → open -R "<path>"
     *   linux  → xdg-open "<dirname>"
     * Manifest must keep --enable-nodejs + --mixed-context for require().
     */
    /**
     * Show in Folder (debug spec):
     *  1) caller passes the COMPLETE ABSOLUTE path (folder + file name)
     *  2) Node via window.cep_node.require first — bare require() can be
     *     hijacked by bundlers; fall back to require only if needed
     *  3) Windows: normalize to backslashes and
     *       spawn('explorer.exe', ['/select,"<path>"'], {shell:true, detached:true})
     *     (handles commas + spaces in paths)
     *  4) any Node failure → ExtendScript fallback:
     *       new File("<path>").parent.execute()
     */
    function revealPath(p) {
        if (!p) return;
        var raw = String(p).replace(/^\s+|\s+$/g, "");
        if (!raw) return;
        // strip file:/// prefix; file:///C:/… → C:/…
        var cleaned = raw.replace(/^file:\/\//, "");
        if (/^\/[A-Za-z]:/.test(cleaned)) cleaned = cleaned.slice(1);
        // decodeURIComponent — tolerant of bad % sequences (%zz etc.)
        var decoded = cleaned;
        try {
            decoded = decodeURIComponent(cleaned);
        } catch (eDec) {
            decoded = cleaned.replace(/(?:%[0-9A-Fa-f]{2})+/g, function (run) {
                var bytes = [];
                for (var i = 0; i < run.length; i += 3) bytes.push(parseInt(run.substr(i + 1, 2), 16));
                try { return new TextDecoder("utf-8").decode(new Uint8Array(bytes)); }
                catch (eTxt) { return run; }
            });
        }
        if (!isCEP) return; // live preview has no filesystem

        // ── 2) Node, bundler-safe ─────────────────────────────────────
        try {
            var nodeRequire = (window.cep_node && window.cep_node.require)
                ? window.cep_node.require
                : (typeof require === "function" ? require : null);
            if (nodeRequire) {
                var cp = nodeRequire("child_process");
                var pathMod = nodeRequire("path");
                // prefer whichever candidate exists: decoded vs raw literal %20 name
                var target = decoded;
                try {
                    var fsMod = nodeRequire("fs");
                    if (!fsMod.existsSync(decoded) && fsMod.existsSync(cleaned)) target = cleaned;
                } catch (eFs) {}
                target = target.replace(/"/g, "");
                var plat = (typeof process !== "undefined" && process.platform) || "";
                if (plat === "win32") {
                    var winPath = pathMod.normalize(target).replace(/\//g, "\\");
                    var child = cp.spawn("explorer.exe",
                        ['/select,"' + winPath + '"'], { shell: true, detached: true });
                    if (child && typeof child.unref === "function") child.unref();
                } else if (plat === "darwin") {
                    var child2 = cp.spawn("open", ["-R", target], { detached: true });
                    if (child2 && typeof child2.unref === "function") child2.unref();
                } else {
                    var child3 = cp.spawn("xdg-open", [pathMod.dirname(target)], { detached: true });
                    if (child3 && typeof child3.unref === "function") child3.unref();
                }
                return;
            }
        } catch (eNode) { /* fall through to ExtendScript */ }

        // ── 3) ExtendScript fallback: open the containing folder ──────
        try {
            if (window.__adobe_cep__ && typeof window.__adobe_cep__.evalScript === "function") {
                var jsxPath = decoded.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
                window.__adobe_cep__.evalScript(
                    'new File("' + jsxPath + '").parent.execute();',
                    function () {}
                );
                return;
            }
        } catch (eJsx) { /* fall through */ }

        // ── 4) last resort: CEP built-in ──────────────────────────────
        try {
            if (window.__adobe_cep__ && typeof window.__adobe_cep__.revealInFileExplorer === "function") {
                window.__adobe_cep__.revealInFileExplorer(decoded);
            }
        } catch (eCep) {}
    }

    /** Read a UTF-8 text file. cb(errStringOrNull, text) */
    function readTextFile(p, cb) {
        if (hasNode) {
            try { cb(null, nodeFs.readFileSync(p, "utf8")); }
            catch (e) { cb(String(e), null); }
            return;
        }
        if (isCEP && window.cep && window.cep.fs) {
            var r = window.cep.fs.readFile(p, window.cep.encoding.UTF8);
            if (r.err === window.cep.fs.NO_ERROR) cb(null, r.data);
            else cb("read error " + r.err, null);
            return;
        }
        Mock.readTextFile(p, cb);
    }

    /** Write a UTF-8 text file (creates parent dir). cb(errOrNull) */
    function writeTextFile(p, data, cb) {
        if (hasNode) {
            try {
                var dir = nodePath.dirname(p);
                if (!nodeFs.existsSync(dir)) mkdirDeep(dir);
                nodeFs.writeFileSync(p, data, "utf8");
                if (cb) cb(null);
            } catch (e) { if (cb) cb(String(e)); }
            return;
        }
        if (isCEP && window.cep && window.cep.fs) {
            var dir2 = p.replace(/[\\/][^\\/]+$/, "");
            if (dir2) window.cep.fs.makedir(dir2);
            var r = window.cep.fs.writeFile(p, data, window.cep.encoding.UTF8);
            if (cb) cb(r.err === window.cep.fs.NO_ERROR ? null : "write error " + r.err);
            return;
        }
        Mock.writeTextFile(p, data, cb);
    }

    function mkdirDeep(dir) {
        if (!hasNode) return;
        var parts = dir.split(/[\\/]+/);
        var cur = parts[0] || "";
        for (var i = 1; i < parts.length; i++) {
            cur = cur + "/" + parts[i];
            try { if (!nodeFs.existsSync(cur)) nodeFs.mkdirSync(cur); } catch (e) {}
        }
    }

    /**
     * Read a file as an ArrayBuffer (for decodeAudioData).
     * cb(errOrNull, arrayBuffer)
     */
    function readFileBuffer(p, cb) {
        if (hasNode) {
            nodeFs.readFile(p, function (err, buf) {
                if (!err && buf) {
                    // Buffer → ArrayBuffer (works across CEP Chromium versions)
                    cb(null, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
                    return;
                }
                readViaCepFs(p, cb); // Node failed → native CEP fs
            });
            return;
        }
        if (isCEP) { readViaCepFs(p, cb); return; }
        Mock.readFileBuffer(p, cb);
    }

    function readViaCepFs(p, cb) {
        if (isCEP && window.cep && window.cep.fs) {
            var r = window.cep.fs.readFile(p, window.cep.encoding.Base64);
            if (r.err !== window.cep.fs.NO_ERROR) { cb("read error " + r.err, null); return; }
            try {
                cb(null, base64ToArrayBuffer(r.data));
            } catch (e) { cb(String(e), null); }
            return;
        }
        if (isCEP) { cb("No file system available.", null); return; }
        Mock.readFileBuffer(p, cb);
    }

    function base64ToArrayBuffer(b64) {
        var binary = atob(b64);
        var len = binary.length;
        var bytes = new Uint8Array(len);
        for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }

    /**
     * Read only the first `n` bytes of a file (header parsing).
     * cb(errOrNull, arrayBuffer)
     */
    function readFileHead(p, n, cb) {
        if (hasNode) {
            try {
                var fd = nodeFs.openSync(p, "r");
                var buf = Buffer.alloc(n);
                var read = nodeFs.readSync(fd, buf, 0, n, 0);
                nodeFs.closeSync(fd);
                cb(null, buf.buffer.slice(buf.byteOffset, buf.byteOffset + read));
            } catch (e) { cb(String(e), null); }
            return;
        }
        // Fallback: full read (works everywhere, just heavier)
        readFileBuffer(p, cb);
    }

    /* ------------------------------------------------------------------ */
    /* Directory listing                                                   */
    /* ------------------------------------------------------------------ */

    /**
     * cb(errOrNull, { dirs:[{name,path,isDir}], files:[{name,path,size}] })
     * dirs and files are sorted alphabetically, folders first on the UI side.
     */
    /**
     * cb(errOrNull, { dirs:[{name,path,isDir}], files:[{name,path,size}] })
     * Cascade: Node fs (fast) → on any failure ExtendScript Folder.getFiles.
     */
    function listDir(p, cb) {
        if (!isCEP) { Mock.listDir(p, cb); return; }

        function viaExtendScript() {
            evalHost("sfxm_listDir", [p], function (out) {
                if (out && out.ok) cb(null, { dirs: out.dirs || [], files: out.files || [] });
                else cb((out && out.error) || "Folder could not be read.", null);
            });
        }

        if (hasNode) {
            listDirNode(p, function (err, listing) {
                // Node failed (old runtime, odd fs…) → fall back, don't give up
                if (!err && listing) cb(null, listing);
                else viaExtendScript();
            });
        } else {
            viaExtendScript();
        }
    }

    function listDirNode(p, cb) {
        try {
            var entries = nodeFs.readdirSync(p, { withFileTypes: true });
            var dirs = [], files = [];
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i];
                var name = e.name;
                if (name.charAt(0) === ".") continue;
                var full = nodePath.join(p, name);
                if (e.isDirectory()) {
                    dirs.push({ name: name, path: full, isDir: true });
                } else if (e.isFile()) {
                    var size = 0;
                    try { size = nodeFs.statSync(full).size; } catch (e2) {}
                    files.push({ name: name, path: full, size: size });
                }
            }
            dirs.sort(nameCmp); files.sort(nameCmp);
            cb(null, { dirs: dirs, files: files });
        } catch (e) { cb(String(e), null); }
    }

    function nameCmp(a, b) {
        return a.name.toLowerCase() < b.name.toLowerCase() ? -1 :
               a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0;
    }

    /**
     * Recursive walk used by search. Returns at most `limit` audio files.
     * Steps are scheduled asynchronously so huge libraries can't blow the
     * call stack when the Node backend answers synchronously.
     */
    function walkAudio(root, limit, cb) {
        var results = [];
        var queue = [{ dir: root, depth: 0 }];
        var guard = 0;
        var done = false;

        function finish() {
            if (done) return;
            done = true;
            cb(null, results);
        }

        function next() {
            if (done) return;
            if (++guard > 20000 || results.length >= limit || queue.length === 0) {
                finish();
                return;
            }
            var item = queue.shift();
            try {
                listDir(item.dir, function (err, listing) {
                    if (!err && listing) {
                        if (item.depth < 12) {
                            for (var i = 0; i < listing.dirs.length; i++) {
                                queue.push({ dir: listing.dirs[i].path, depth: item.depth + 1 });
                            }
                        }
                        for (var j = 0; j < listing.files.length && results.length < limit; j++) {
                            var f = listing.files[j];
                            if (Bridge.AUDIO_EXT.test(String(f.name).toLowerCase())) results.push(f);
                        }
                    }
                    schedule();
                });
            } catch (e) {
                schedule(); // skip broken folders, keep walking
            }
        }

        function schedule() { setTimeout(next, 0); }

        schedule();
    }

    /* ------------------------------------------------------------------ */

    /* ------------------------------------------------------------------ */
    /* Host app detection: "AE" or "PPRO" (Premiere Pro), cached.          */
    /* ------------------------------------------------------------------ */

    var _hostApp = null;
    function hostApp() {
        if (_hostApp) return _hostApp;
        if (!isCEP) { _hostApp = "AE"; return _hostApp; }
        try {
            var env = JSON.stringify(window.__adobe_cep__.getHostEnvironment() || {});
            if (env.indexOf("PPRO") >= 0 ||
                env.indexOf("Premiere") >= 0 || env.indexOf("premiere") >= 0) {
                _hostApp = "PPRO";
            } else if (env.indexOf("AEFT") >= 0 || env.indexOf("After Effects") >= 0) {
                _hostApp = "AE";
            }
        } catch (e) {}
        if (!_hostApp) _hostApp = "AE";
        return _hostApp;
    }

    var Bridge = {
        isCEP: isCEP,
        hasNode: hasNode,
        evalHost: evalHost,
        hostApp: hostApp,
        pickFolder: pickFolder,
        extensionPath: extensionPath,
        userDataPath: userDataPath,
        openExternal: openExternal,
        revealPath: revealPath,
        readTextFile: readTextFile,
        writeTextFile: writeTextFile,
        readFileBuffer: readFileBuffer,
        readFileHead: readFileHead,
        listDir: listDir,
        walkAudio: walkAudio,

        isAudioFile: function (name) {
            return Bridge.AUDIO_EXT.test(String(name).toLowerCase());
        },
        AUDIO_EXT: /\.(wav|mp3|aif|aiff?|m4a|aac|flac|ogg|oga|opus|caf|w64|mp2|au|snd|voc|wmv|wma)$/i
    };

    return Bridge;
})();

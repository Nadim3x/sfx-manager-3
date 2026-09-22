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
        // ExtendScript Folder.selectDialog blocks until closed, then returns JSON.
        var code =
            '(function(){' +
            'var f = Folder.selectDialog("Choose your SFX folder");' +
            'if (f) return "{\\"ok\\":true,\\"path\\":\\"" + f.fsName.replace(/\\\\/g,"/\\\\").replace(/"/g,"\\\\\\"") + "\\"}";' +
            'return "{\\"ok\\":false}";' +
            '})()';
        window.__adobe_cep__.evalScript(code, function (raw) {
            var out;
            try { out = JSON.parse(raw); } catch (e) { out = { ok: false }; }
            cb(out);
        });
    }

    /* ------------------------------------------------------------------ */
    /* Misc host integration                                               */
    /* ------------------------------------------------------------------ */

    function openExternal(url) {
        if (isCEP) {
            try { window.__adobe_cep__.openURLInDefaultBrowser(url); return; }
            catch (e) {}
        }
        window.open(url, "_blank");
    }

    function revealPath(p) {
        if (!p) return;
        // Opening the file:// URL of a folder shows it in Finder / Explorer.
        var norm = String(p).replace(/\\/g, "/");
        if (!/^file:\/\//.test(norm)) {
            if (/^[A-Za-z]:\//.test(norm)) norm = "file:///" + norm;
            else norm = "file://" + (norm.charAt(0) === "/" ? "" : "/") + norm;
        }
        openExternal(norm);
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
                if (err) { cb(String(err), null); return; }
                // Buffer → ArrayBuffer (works across CEP Chromium versions)
                var ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
                cb(null, ab);
            });
            return;
        }
        if (isCEP && window.cep && window.cep.fs) {
            var r = window.cep.fs.readFile(p, window.cep.encoding.Base64);
            if (r.err !== window.cep.fs.NO_ERROR) { cb("read error " + r.err, null); return; }
            try {
                cb(null, base64ToArrayBuffer(r.data));
            } catch (e) { cb(String(e), null); }
            return;
        }
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
    function listDir(p, cb) {
        if (hasNode) { listDirNode(p, cb); return; }
        if (isCEP) {
            evalHost("sfxm_listDir", [p], function (out) {
                if (out && out.ok) cb(null, { dirs: out.dirs || [], files: out.files || [] });
                else cb((out && out.error) || "list failed", null);
            });
            return;
        }
        Mock.listDir(p, cb);
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

    /** Recursive walk used by search. Returns at most `limit` audio files. */
    function walkAudio(root, limit, cb) {
        var results = [];
        var queue = [{ dir: root, depth: 0 }];
        var guard = 0;

        function next() {
            if (++guard > 20000 || results.length >= limit || queue.length === 0) {
                cb(null, results);
                return;
            }
            var item = queue.shift();
            listDir(item.dir, function (err, listing) {
                if (!err && listing) {
                    if (item.depth < 12) {
                        for (var i = 0; i < listing.dirs.length; i++) {
                            queue.push({ dir: listing.dirs[i].path, depth: item.depth + 1 });
                        }
                    }
                    for (var j = 0; j < listing.files.length && results.length < limit; j++) {
                        results.push(listing.files[j]);
                    }
                }
                next();
            });
        }

        next();
    }

    /* ------------------------------------------------------------------ */

    var Bridge = {
        isCEP: isCEP,
        hasNode: hasNode,
        evalHost: evalHost,
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

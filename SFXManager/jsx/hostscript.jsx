/*
 * SFX Manager — After Effects host script (ExtendScript / ES3)
 * Loaded automatically via the CEP manifest <ScriptPath>.
 * All functions are invoked from the panel via evalScript().
 * NOTE: keep this file ES3-only (var, function, no arrows/let/const/JSON).
 */

(function (global) {

    /* ---------- helpers (ES3-safe JSON building) ---------- */

    function esc(s) {
        if (s === null || s === undefined) return "";
        s = String(s);
        s = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        s = s.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
        // Strip control chars that would break JSON
        return s.replace(/[\u0000-\u001f]/g, "");
    }

    function jstr(s) { return '"' + esc(s) + '"'; }

    function jnum(n) {
        if (typeof n !== "number" || isNaN(n) || !isFinite(n)) return "0";
        // avoid scientific notation (invalid in ES3 ExtendScript JSON consumers is fine, but keep clean)
        return String(Math.round(n * 100000) / 100000);
    }

    function ok(extra) {
        return '{"ok":true' + (extra ? "," + extra : "") + '}';
    }

    function fail(msg) {
        return '{"ok":false,"error":' + jstr(msg) + '}';
    }

    /* ---------- internal ---------- */

    function getComp() {
        var item = app.project.activeItem;
        if (item && item instanceof CompItem) return item;
        return null;
    }

    function findFootageByPath(path) {
        var norm = String(path).toLowerCase().replace(/\\/g, "/");
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof FootageItem) {
                try {
                    var f = it.mainSource.file;
                    if (f) {
                        var p = String(f.fsName).toLowerCase().replace(/\\/g, "/");
                        if (p === norm) return it;
                    }
                } catch (e) { /* keep looking */ }
            }
        }
        return null;
    }

    function baseName(path) {
        var p = String(path).replace(/\\/g, "/");
        var i = p.lastIndexOf("/");
        var n = i >= 0 ? p.substring(i + 1) : p;
        var d = n.lastIndexOf(".");
        return d > 0 ? n.substring(0, d) : n;
    }

    function timecodeFps(fps, t) {
        // HH:MM:SS:FF using the given frame rate
        if (!fps || fps <= 0) fps = 24;
        var totalFrames = Math.round(t * fps);
        var ff = totalFrames % Math.round(fps);
        var totalSec = Math.floor(totalFrames / Math.round(fps));
        var ss = totalSec % 60;
        var totalMin = Math.floor(totalSec / 60);
        var mm = totalMin % 60;
        var hh = Math.floor(totalMin / 60);
        function pad(n) { return (n < 10 ? "0" : "") + n; }
        return pad(hh) + ":" + pad(mm) + ":" + pad(ss) + ":" + pad(ff);
    }

    function timecode(comp, t) { return timecodeFps(comp.frameRate, t); }

    /* ---------- host detection (After Effects vs Premiere Pro) ---------- */

    function isPremiere() {
        try {
            if (String(app.name || "").toLowerCase().indexOf("premiere") >= 0) return true;
        } catch (eName) {}
        try {
            // Premiere's Project always exposes activeSequence (null when none);
            // After Effects' Project has no such property at all.
            if (app.project && typeof app.project.activeSequence !== "undefined") return true;
        } catch (eSeq) {}
        return false;
    }

    function seqFps(seq) {
        try {
            var st = seq.getSettings();
            if (st) {
                if (st.videoFrameRate) {
                    var fr = parseFloat(st.videoFrameRate);
                    if (fr > 1 && fr < 240) return fr;
                }
                if (st.frameDurationTicks) {
                    var fd = Number(st.frameDurationTicks);
                    if (fd > 0) {
                        var f2 = 254016000000 / fd;
                        if (f2 > 1 && f2 < 240) return f2;
                    }
                }
            }
        } catch (e) {}
        return 24;
    }

    /* Premiere: walk root bins for a project item with this media path.
       Premiere collections are 0-based (AE is 1-based) — scan both. */
    function findPPItem(path) {
        var norm = String(path).toLowerCase().replace(/\\/g, "/");
        function walk(items) {
            if (!items) return null;
            var n = 0;
            try { n = items.numItems; } catch (eN) {}
            if (!n) { try { n = items.length; } catch (eL) {} }
            for (var i = 0; i <= n; i++) {
                var it = null;
                try { it = items[i]; } catch (eIt) {}
                if (!it) continue;
                try {
                    if (it.getMediaPath) {
                        var mp = String(it.getMediaPath()).toLowerCase().replace(/\\/g, "/");
                        if (mp === norm) return it;
                    }
                } catch (eMp) {}
                try {
                    if (it.children && it.children.numItems) {
                        var r = walk(it.children);
                        if (r) return r;
                    }
                } catch (eCh) {}
            }
            return null;
        }
        try { return walk(app.project.rootItem.children); } catch (e) { return null; }
    }

    function trackFree(track, tSec) {
        try {
            var clips = track.clips;
            var n = 0;
            try { n = clips.numItems; } catch (eN) {}
            if (!n) { try { n = clips.length; } catch (eL) {} }
            for (var i = 0; i < n; i++) {
                var c = null;
                try { c = clips[i]; } catch (eC) {}
                if (!c) continue;
                try {
                    var st = Number(c.start.seconds), en = Number(c.end.seconds);
                    if (tSec >= st && tSec < en) return false;
                } catch (eT) {}
            }
            return true;
        } catch (e) { return true; }
    }

    /**
     * Place an imported project item on a Premiere audio track at the playhead.
     * Units disagree across Premiere versions/docs (seconds vs ticks) — try
     * each known-good form until one is accepted.
     */
    function placeOnTrack(track, pi, pos) {
        try { if (track.overwriteClip(pi, pos.seconds) !== false) return true; } catch (e1) {}
        try { if (track.overwriteClip(pi, String(pos.ticks)) !== false) return true; } catch (e2) {}
        try {
            var t = new Time();
            t.ticks = String(pos.ticks);
            if (track.overwriteClip(pi, t.seconds) !== false) return true;
        } catch (e3) {}
        try { if (track.insertClip(pi, String(pos.ticks)) !== false) return true; } catch (e4) {}
        try { if (track.insertClip(pi, pos.seconds) !== false) return true; } catch (e5) {}
        return false;
    }

    function pproImport(path, file) {
        var existing = findPPItem(path);
        if (existing) {
            var exName = "";
            try { exName = String(existing.name || baseName(path)); } catch (e) { exName = baseName(path); }
            return ok('"name":' + jstr(exName) + ',"imported":false');
        }
        var item = app.project.importFile(new ImportOptions(file));
        if (!item) return fail("Import failed.");
        var nm = "";
        try { nm = String(item.name || baseName(path)); } catch (e2) { nm = baseName(path); }
        return ok('"name":' + jstr(nm) + ',"imported":true');
    }

    function pproAddAtPlayhead(path, file) {
        var seq = app.project.activeSequence;
        if (!seq) return fail("No active sequence. Open a sequence first.");

        var pi = findPPItem(path);
        var importedNow = false;
        if (!pi) {
            pi = app.project.importFile(new ImportOptions(file));
            importedNow = true;
        }
        if (!pi) return fail("Premiere Pro could not import this file.");

        var pos = seq.getPlayerPosition();
        if (!pos) return fail("Could not read the playhead position.");
        var pp = Number(pos.seconds);
        if (isNaN(pp)) pp = 0;

        // Pick an audio track with free space at the playhead; otherwise use
        // the last audio track (overwrites there — user can undo with Ctrl+Z).
        var tracks = seq.audioTracks;
        var count = 0;
        try { count = tracks.numTracks; } catch (eN) {}
        if (!count) { try { count = tracks.length; } catch (eL) {} }
        if (!count) return fail("Sequence has no audio tracks.");

        var tIdx = -1, overwrote = false;
        for (var i = 0; i < count; i++) {
            var tr = null;
            try { tr = tracks[i]; } catch (eTr) {}
            if (tr && trackFree(tr, pp)) { tIdx = i; break; }
        }
        if (tIdx < 0) { tIdx = count - 1; overwrote = true; }
        var track = tracks[tIdx];
        if (!track) return fail("Could not find an audio track.");
        if (!placeOnTrack(track, pi, pos)) return fail("Could not place the clip on the timeline.");

        var fps = seqFps(seq);
        return ok(
            '"host":"PPRO",' +
            '"name":' + jstr(baseName(path)) +
            ',"track":' + jnum(tIdx) +
            ',"time":' + jnum(pp) +
            ',"timecode":' + jstr(timecodeFps(fps, pp)) +
            ',"imported":' + (importedNow ? "true" : "false") +
            ',"overwrote":' + (overwrote ? "true" : "false")
        );
    }

    /* ---------- public API ---------- */

    /** Lightweight state poll: current comp + playhead. */
    function sfxm_getState() {
        try {
            if (isPremiere()) {
                var seq = null;
                try { seq = app.project.activeSequence; } catch (eSeq) {}
                if (!seq) {
                    return '{"ok":true,"host":"PPRO","hasComp":false,"comp":"","time":0,"fps":24,"timecode":"00:00:00:00"}';
                }
                var pos = null;
                try { pos = seq.getPlayerPosition(); } catch (ePos) {}
                var t = pos ? Number(pos.seconds) : 0;
                if (isNaN(t)) t = 0;
                var fps = seqFps(seq);
                var sname = "";
                try { sname = String(seq.name || ""); } catch (eNm) {}
                return '{"ok":true,"host":"PPRO","hasComp":true,' +
                    '"comp":' + jstr(sname || "Active Sequence") + ',' +
                    '"time":' + jnum(t) + ',' +
                    '"duration":0,' +
                    '"fps":' + jnum(fps) + ',' +
                    '"timecode":' + jstr(timecodeFps(fps, t)) + '}';
            }
            var comp = getComp();
            if (!comp) {
                return '{"ok":true,"host":"AE","hasComp":false,"comp":"","time":0,"fps":24,"timecode":"00:00:00:00"}';
            }
            return '{"ok":true,"host":"AE","hasComp":true,' +
                '"comp":' + jstr(comp.name) + ',' +
                '"time":' + jnum(comp.time) + ',' +
                '"duration":' + jnum(comp.duration) + ',' +
                '"fps":' + jnum(comp.frameRate) + ',' +
                '"timecode":' + jstr(timecode(comp, comp.time)) + '}';
        } catch (e) {
            return fail(String(e));
        }
    }

    /**
     * Import the sound (reusing an existing project item when possible)
     * and add it as a layer starting exactly at the playhead.
     */
    function sfxm_addAtPlayhead(path) {
        try {
            var file = new File(path);
            if (!file.exists) return fail("File not found on disk.");

            if (isPremiere()) return pproAddAtPlayhead(path, file);

            var comp = getComp();
            if (!comp) return fail("No active composition. Open a comp first.");

            app.beginUndoGroup("SFX Manager: Add Sound");

            var footage = findFootageByPath(path);
            var importedNow = false;
            if (!footage) {
                var opts = new ImportOptions(file);
                footage = app.project.importFile(opts);
                importedNow = true;
            }
            if (!footage) {
                app.endUndoGroup();
                return fail("After Effects could not import this file.");
            }

            var layer = comp.layers.add(footage);
            // Place the start of the source exactly at the current playhead time.
            layer.startTime = comp.time;
            layer.name = baseName(path);

            // Make sure audio is on for the new layer.
            try { layer.audioEnabled = true; } catch (e1) {}

            // Select it so the user sees it immediately.
            for (var i = 1; i <= comp.numLayers; i++) comp.layers[i].selected = false;
            layer.selected = true;

            app.endUndoGroup();

            return ok(
                '"layer":' + jstr(layer.name) +
                ',"time":' + jnum(comp.time) +
                ',"timecode":' + jstr(timecode(comp, comp.time)) +
                ',"imported":' + (importedNow ? "true" : "false")
            );
        } catch (e) {
            try { app.endUndoGroup(); } catch (e2) {}
            return fail(String(e));
        }
    }

    /** Import into the Project panel only (no timeline placement). */
    function sfxm_importToProject(path) {
        try {
            var file = new File(path);
            if (!file.exists) return fail("File not found on disk.");
            if (isPremiere()) return pproImport(path, file);
            var existing = findFootageByPath(path);
            if (existing) {
                return ok('"name":' + jstr(existing.name) + ',"imported":false');
            }
            app.beginUndoGroup("SFX Manager: Import Sound");
            var footage = app.project.importFile(new ImportOptions(file));
            app.endUndoGroup();
            if (!footage) return fail("Import failed.");
            return ok('"name":' + jstr(footage.name) + ',"imported":true');
        } catch (e) {
            try { app.endUndoGroup(); } catch (e2) {}
            return fail(String(e));
        }
    }

    /**
     * Native folder picker. Runs inside ExtendScript so there is no
     * inline-code escaping involved — JSON is built with jstr().
     */
    function sfxm_pickFolder() {
        try {
            var f = Folder.selectDialog("Choose your SFX folder");
            if (!f) return '{"ok":false,"cancelled":true}';
            return '{"ok":true,"path":' + jstr(f.fsName) + '}';
        } catch (e) {
            return fail(String(e));
        }
    }

    /** Fallback directory listing used only when Node.js is unavailable. */
    function sfxm_listDir(path) {
        try {
            var folder = new Folder(path);
            if (!folder.exists) return fail("Folder not found.");
            var entries = folder.getFiles();
            var dirs = [];
            var files = [];
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i];
                var name = e.name;
                if (name.charAt(0) === ".") continue; // hide dotfiles
                if (e instanceof Folder) {
                    dirs.push({ "name": name, "path": e.fsName, "isDir": true });
                } else if (e instanceof File) {
                    files.push({
                        "name": name,
                        "path": e.fsName,
                        "isDir": false,
                        "size": e.length || 0
                    });
                }
            }
            dirs.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
            files.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });

            var json = '{"ok":true,"dirs":[';
            for (var d = 0; d < dirs.length; d++) {
                if (d) json += ",";
                json += '{"name":' + jstr(dirs[d].name) + ',"path":' + jstr(dirs[d].path) + '}';
            }
            json += '],"files":[';
            for (var f = 0; f < files.length; f++) {
                if (f) json += ",";
                json += '{"name":' + jstr(files[f].name) + ',"path":' + jstr(files[f].path) + ',"size":' + jnum(files[f].size) + '}';
            }
            json += ']}';
            return json;
        } catch (e) {
            return fail(String(e));
        }
    }

    /* expose */
    global.sfxm_getState = sfxm_getState;
    global.sfxm_addAtPlayhead = sfxm_addAtPlayhead;
    global.sfxm_importToProject = sfxm_importToProject;
    global.sfxm_pickFolder = sfxm_pickFolder;
    global.sfxm_listDir = sfxm_listDir;

})(this);

/*
 * app.js — SFX Manager main controller.
 * Wires the UI: folder tree, sound list, search, favourites, colour tags,
 * recent sounds, preview player, drag & drop, shortcuts and modals.
 */

(function () {
    "use strict";

    /* ═══════════════════ helpers ═══════════════════ */

    var $ = function (id) { return document.getElementById(id); };

    function escHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function baseName(p) {
        var n = String(p).split(/[\\/]/).pop();
        return n.replace(/\.[^.]+$/, "");
    }
    function extOf(p) {
        var m = /\.([^.\\/]+)$/.exec(String(p));
        return m ? m[1].toUpperCase() : "";
    }
    function parentOf(p) {
        var s = String(p).replace(/[\\/]+$/, "");
        var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
        return i > 0 ? s.substring(0, i) : s;
    }
    /* Some sound packs ship percent-encoded filenames ("Button%20Click.wav"
       or UTF-8 emoji as %F0%9F…). Decode for DISPLAY only — stored paths,
       data-path attributes and lookups always keep the real on-disk name. */
    function decodeName(s) {
        s = String(s);
        if (s.indexOf("%") === -1) return s;
        try { return decodeURIComponent(s); } catch (e) {}
        // Whole-string decode failed (stray "%" or truncated UTF-8 run):
        // decode every valid %-sequence run independently so one bad byte
        // can't leave the entire label percent-encoded.
        return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, function (run) {
            var bytes = [];
            for (var i = 0; i + 2 < run.length + 1; i += 3) {
                bytes.push(parseInt(run.substr(i + 1, 2), 16));
            }
            try {
                if (typeof TextDecoder !== "undefined") {
                    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
                }
            } catch (eDec) {}
            try { return decodeURIComponent(run); } catch (eRun) { return run; }
        });
    }

    function baseNameFull(p) { return decodeName(String(p).split(/[\\/]/).pop()); }

    function fmtTime(sec) {
        if (!isFinite(sec) || sec < 0) sec = 0;
        var m = Math.floor(sec / 60);
        var s = sec - m * 60;
        var ss = s < 10 ? "0" + s.toFixed(2) : s.toFixed(2);
        return m + ":" + ss;
    }

    function fmtSize(bytes) {
        if (!bytes) return "";
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    /* ═══════════════════ state ═══════════════════ */

    var S = {
        view: "all",            // all | favorites | recent | folder | search
        folderPath: "",
        query: "",
        tagFilter: 0,
        items: [],              // [{name, path, size}]
        selectedPath: "",
        aeState: { host: "AE", hasComp: false, comp: "", time: 0, fps: 24, timecode: "00:00:00:00", connected: false },
        openFolders: {},
        durations: {},          // path -> seconds
        searchTimer: null,
        countTimer: null,
        lastTick: 0
    };

    var durationQueue = [];
    var durationBusy = false;
    var rowEls = {};

    /* ═══════════════════ toasts ═══════════════════ */

    function toast(msg, kind) {
        var host = $("toastHost");
        while (host.children.length >= 3) host.removeChild(host.firstChild);
        var el = document.createElement("div");
        el.className = "toast " + (kind || "");
        el.innerHTML = '<span class="t-dot"></span><span>' + escHtml(msg) + "</span>";
        host.appendChild(el);
        setTimeout(function () {
            el.classList.add("out");
            setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
        }, 2600);
    }

    /* ═══════════════════ theme ═══════════════════ */

    function applyTheme(theme) {
        document.documentElement.setAttribute("data-theme", theme === "light" ? "light" : "dark");
    }

    /* ═══════════════════ sidebar counts ═══════════════════ */

    var totalCount = -1; // -1 = unknown

    function refreshCounts() {
        $("cntFav").textContent = Store.favoritePaths().length || "";
        $("cntRecent").textContent = Store.recent().length || "";
        $("cntAll").textContent = totalCount > 0 ? totalCount : "";
    }

    function recomputeTotalCount() {
        var root = Store.get().root;
        totalCount = -1;
        $("cntAll").textContent = "";
        if (!root) return;
        if (S.countTimer) clearTimeout(S.countTimer);
        S.countTimer = setTimeout(function () {
            Bridge.walkAudio(root, 20000, function (err, files) {
                if (err) return;
                totalCount = files.length;
                $("cntAll").textContent = totalCount > 0 ? totalCount : "";
            });
        }, 300);
    }

    /* ═══════════════════ folder tree ═══════════════════ */

    var FOLDER_ICO =
        '<svg class="tree-folder-ico" viewBox="0 0 16 16" width="13" height="13">' +
        '<path d="M1.8 4.2c0-.9.7-1.6 1.6-1.6h2.7l1.4 1.6h5.1c.9 0 1.6.7 1.6 1.6v6c0 .9-.7 1.6-1.6 1.6H3.4c-.9 0-1.6-.7-1.6-1.6z" fill="currentColor" opacity=".92"/></svg>';

    var CHEV_ICO =
        '<svg viewBox="0 0 8 8"><path d="M2.6 1.4 5.4 4 2.6 6.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    function renderTree() {
        var treeEl = $("tree");
        var root = Store.get().root;
        treeEl.innerHTML = "";
        if (!root) {
            $("treeEmpty").classList.remove("hidden");
            return;
        }
        $("treeEmpty").classList.add("hidden");

        var node = buildTreeNode({
            name: baseNameFull(root) || root,
            path: root,
            isDir: true
        }, 0);
        treeEl.appendChild(node);

        // expand root automatically
        expandNode(node, function () {
            if (S.view === "folder") markSelectedTreeNode();
        });
    }

    function buildTreeNode(entry, depth) {
        var wrap = document.createElement("div");
        wrap.className = "tree-node";
        wrap.dataset.path = entry.path;
        wrap.style.animationDelay = Math.min(depth * 40, 240) + "ms";

        var row = document.createElement("div");
        row.className = "tree-row";
        row.style.paddingLeft = (6 + depth * 13) + "px";
        row.title = entry.path;
        row.innerHTML =
            '<span class="tree-chevron empty">' + CHEV_ICO + "</span>" +
            FOLDER_ICO +
            '<span class="tree-label">' + escHtml(decodeName(entry.name)) + "</span>";

        var children = document.createElement("div");
        children.className = "tree-children";

        wrap.appendChild(row);
        wrap.appendChild(children);

        row.addEventListener("click", function (ev) {
            // chevron area toggles expansion
            var rect = row.getBoundingClientRect();
            var isChevronZone = (ev.clientX - rect.left) < (20 + depth * 13 + 6);
            if (isChevronZone) {
                toggleNode(wrap);
            } else {
                selectFolder(entry.path);
                toggleNode(wrap, true);
            }
        });

        return wrap;
    }

    function toggleNode(node, forceOpen) {
        var isOpen = node.classList.contains("open");
        if (forceOpen && isOpen) return;
        if (isOpen && !forceOpen) {
            node.classList.remove("open");
            return;
        }
        expandNode(node);
    }

    function expandNode(node, done) {
        if (node.dataset.loaded === "1") {
            node.classList.add("open");
            if (done) done();
            return;
        }
        var path = node.dataset.path;
        Bridge.listDir(path, function (err, listing) {
            node.dataset.loaded = "1";
            if (err) {
                node.querySelector(".tree-children").innerHTML =
                    '<div class="empty-mini" style="padding:6px 10px">Could not read folder</div>';
                node.classList.add("open");
                if (done) done();
                return;
            }
            var holder = node.querySelector(".tree-children");
            holder.innerHTML = "";
            if (!listing.dirs.length) {
                node.querySelector(".tree-chevron").classList.add("empty");
            } else {
                node.querySelector(".tree-chevron").classList.remove("empty");
                for (var i = 0; i < listing.dirs.length; i++) {
                    holder.appendChild(buildTreeNode(listing.dirs[i], depthOf(node) + 1));
                }
            }
            node.classList.add("open");
            S.openFolders[path] = true;
            if (done) done();
        });
    }

    function depthOf(node) {
        var d = 0, p = node.parentNode;
        while (p && p !== $("tree")) {
            if (p.classList && p.classList.contains("tree-node")) d++;
            p = p.parentNode;
        }
        return d;
    }

    function markSelectedTreeNode() {
        var rows = document.querySelectorAll("#tree .tree-row");
        for (var i = 0; i < rows.length; i++) {
            var n = rows[i].parentNode;
            rows[i].classList.toggle("selected",
                S.view === "folder" && n.dataset.path === S.folderPath);
        }
    }

    function selectFolder(path) {
        S.view = "folder";
        S.folderPath = path;
        S.query = "";
        $("searchInput").value = "";
        $("searchClear").classList.add("hidden");
        Store.set({ lastFolder: path });
        setNavActive(null);
        markSelectedTreeNode();
        closeDrawer();
        loadFolderList(path);
    }

    function setNavActive(view) {
        var items = document.querySelectorAll("#virtualNav .nav-item");
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle("active", view !== null && items[i].dataset.view === view);
        }
    }

    /* ═══════════════════ list loading ═══════════════════ */

    function loadFolderList(path) {
        showEmpty(false);
        $("soundList").innerHTML = '<div class="list-bump"></div>';
        Bridge.listDir(path, function (err, listing) {
            if (err) {
                S.items = [];
                renderList();
                setListHeader(baseNameFull(path), path);
                showEmpty(true, "This folder could not be read.");
                return;
            }
            S.items = listing.files
                .filter(function (f) { return Bridge.isAudioFile(f.name); })
                .map(function (f) { return { name: f.name, path: f.path, size: f.size }; });
            renderList();
            setListHeader(baseNameFull(path), path, S.items.length);
        });
    }

    function loadVirtual(view) {
        S.view = view;
        S.query = "";
        $("searchInput").value = "";
        $("searchClear").classList.add("hidden");
        setNavActive(view);
        markSelectedTreeNode();

        var root = Store.get().root;
        if (view === "all") {
            if (!root) {
                S.items = [];
                renderList();
                setListHeader("All Sounds", "");
                showEmpty(true, "Choose your SFX folder to get started.");
                return;
            }
            $("soundList").innerHTML = '<div class="list-bump"></div>';
            setListHeader("All Sounds", root);
            Bridge.walkAudio(root, 10000, function (err, files) {
                if (err) { showEmpty(true, "Could not read your SFX folder."); return; }
                S.items = files.map(function (f) {
                    return { name: f.name, path: f.path, size: f.size };
                });
                renderList();
                setListHeader("All Sounds", root, S.items.length);
            });
        } else if (view === "favorites") {
            var favs = Store.favoritePaths().map(function (p) {
                return { name: baseNameFull(p), path: p, size: 0 };
            });
            favs.sort(function (a, b) {
                return (Store.get().favorites[b.path] || 0) - (Store.get().favorites[a.path] || 0);
            });
            S.items = favs;
            renderList();
            setListHeader("Favorites", favs.length + " starred sound" + (favs.length === 1 ? "" : "s"), favs.length);
            if (!favs.length) showEmpty(true, "Star sounds to keep them one click away.");
        } else if (view === "recent") {
            var rec = Store.recent().map(function (r) {
                return { name: r.name || baseNameFull(r.path), path: r.path, size: 0, at: r.at };
            });
            S.items = rec;
            renderList();
            setListHeader("Recently Used", "sounds you previewed or added", rec.length);
            if (!rec.length) showEmpty(true, "Sounds you preview or add will show up here.");
        }
    }

    function runSearch(q) {
        S.view = "search";
        S.query = q;
        setNavActive(null);
        markSelectedTreeNode();

        var root = Store.get().root;
        if (!root || !q) {
            if (!q) { loadVirtual("all"); return; }
            return;
        }
        $("soundList").innerHTML = '<div class="list-bump"></div>';
        setListHeader('"' + q + '"', "searching your library…");

        Bridge.walkAudio(root, 6000, function (err, files) {
            if (err) { showEmpty(true, "Search failed — folder unavailable."); return; }
            var ql = q.toLowerCase();
            var hits = [];
            for (var i = 0; i < files.length; i++) {
                var f = files[i];
                var nl = f.name.toLowerCase();
                var nld = decodeName(f.name).toLowerCase();
                var pl = f.path.toLowerCase();
                var pld = decodeName(f.path).toLowerCase();
                var score = -1;
                if (nl.indexOf(ql) === 0 || nld.indexOf(ql) === 0) score = 0;
                else if (nl.indexOf(ql) > 0 || nld.indexOf(ql) > 0) score = 1;
                else if (pl.indexOf(ql) >= 0 || pld.indexOf(ql) >= 0) score = 2;
                if (score >= 0) hits.push({ f: f, score: score });
            }
            hits.sort(function (a, b) {
                if (a.score !== b.score) return a.score - b.score;
                return a.f.name.toLowerCase() < b.f.name.toLowerCase() ? -1 : 1;
            });
            S.items = hits.map(function (h) {
                return { name: h.f.name, path: h.f.path, size: h.f.size };
            });
            renderList();
            setListHeader('"' + q + '"', S.items.length + " match" + (S.items.length === 1 ? "" : "es"), S.items.length);
            if (!S.items.length) showEmpty(true, "No sounds match “" + q + "”.");
        });
    }

    function setListHeader(title, path, count) {
        $("listTitle").textContent = title;
        $("listPath").textContent = path ? decodeName(path) : "";
        $("listPath").title = path || "";
        if (typeof count === "number") {
            $("listCount").textContent = count;
            $("listCount").classList.remove("bump");
            void $("listCount").offsetWidth;
            $("listCount").classList.add("bump");
        } else {
            $("listCount").textContent = S.items.length;
        }
    }

    function showEmpty(show, text) {
        var el = $("listEmpty");
        if (show) {
            if (text) $("listEmptyText").textContent = text;
            el.classList.remove("hidden");
        } else {
            el.classList.add("hidden");
        }
    }

    /* ═══════════════════ durations ═══════════════════ */

    function fmtDur(sec) {
        if (sec == null) return "—";
        return fmtTime(sec);
    }

    function requestDurations() {
        durationQueue = [];
        for (var i = 0; i < S.items.length; i++) {
            var p = S.items[i].path;
            if (S.durations[p] == null) durationQueue.push(p);
        }
        pumpDurations();
    }

    function pumpDurations() {
        if (durationBusy) return;
        var path = durationQueue.shift();
        if (!path) return;
        durationBusy = true;

        // WAV/AIFF header parse — cheap, no full decode
        Bridge.readFileHead(path, 131072, function (err, ab) {
            durationBusy = false;
            if (!err && ab) {
                var d = AudioEngine.quickDuration(ab);
                if (d != null && d > 0) {
                    S.durations[path] = d;
                    var el = rowEls[path];
                    if (el && el.dataset.path === path) {
                        var dur = el.querySelector(".row-dur");
                        if (dur) dur.textContent = fmtDur(d);
                    }
                }
            }
            pumpDurations();
        });
    }

    /* ═══════════════════ list rendering ═══════════════════ */

    var STAR_SVG =
        '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 1.8l1.95 3.95 4.36.63-3.15 3.07.74 4.34L8 11.82l-3.89 2.03.74-4.34-3.15-3.07 4.36-.63z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

    var PLAY_SVG = '<svg class="ico-play" viewBox="0 0 16 16" width="10" height="10"><path d="M5.1 3.4v9.2L12.6 8z" fill="currentColor" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
        '<svg class="ico-pause" viewBox="0 0 16 16" width="10" height="10"><g fill="currentColor"><rect x="4.1" y="3.5" width="2.9" height="9" rx="1.25"/><rect x="9" y="3.5" width="2.9" height="9" rx="1.25"/></g></svg>';

    var TAG_COLORS = { 1: "var(--d1)", 2: "var(--d2)", 3: "var(--d3)", 4: "var(--d4)", 5: "var(--d5)", 6: "var(--d6)" };

    function filteredItems() {
        if (!S.tagFilter) return S.items;
        return S.items.filter(function (it) { return Store.getTag(it.path) === S.tagFilter; });
    }

    function renderList() {
        var list = $("soundList");
        var items = filteredItems();
        rowEls = {};
        var html = [];

        showEmpty(!items.length,
            S.view === "search" ? "No matches." :
            S.view === "favorites" ? "Star sounds to keep them one click away." :
            S.view === "recent" ? "Sounds you preview or add will show up here." :
            !Store.get().root ? "Choose your SFX folder to get started." :
            "No audio files in this folder.");

        var showFolder = S.view !== "folder";

        for (var i = 0; i < items.length && i < 4000; i++) {
            var it = items[i];
            var tag = Store.getTag(it.path);
            var fav = Store.isFavorite(it.path);
            var sel = it.path === S.selectedPath;
            var playing = AudioEngine.current() && AudioEngine.current().path === it.path && AudioEngine.isPlaying();

            var sub = [];
            if (tag) sub.push('<i class="tag-dot" style="background:' + TAG_COLORS[tag] + ";color:" + TAG_COLORS[tag] + '"></i>');
            var ext = extOf(it.name);
            if (ext) sub.push(ext);
            if (it.size) sub.push(fmtSize(it.size));
            else if (S.durations[it.path] != null) sub.push(fmtTime(S.durations[it.path]));
            if (showFolder) sub.push(escHtml(baseNameFull(parentOf(it.path))));

            html.push(
                '<div class="sound-row' + (sel ? " selected" : "") + (playing ? " playing" : "") + '"' +
                ' data-path="' + escHtml(it.path) + '" draggable="true" style="--i:' + Math.min(i, 16) + '">' +
                '<button class="row-play" title="Preview">' + PLAY_SVG + "</button>" +
                '<div class="row-meta">' +
                '<div class="row-name">' + escHtml(decodeName(baseName(it.name))) + "</div>" +
                (sub.length ? '<div class="row-sub">' + sub.join("<span>·</span>") + "</div>" : "") +
                "</div>" +
                '<span class="row-dur">' + (playing || AudioEngine.current() && AudioEngine.current().path === it.path
                    ? fmtDur(AudioEngine.current().duration || S.durations[it.path] || null)
                    : fmtDur(S.durations[it.path])) + "</span>" +
                '<button class="row-tag' + (tag ? " has" : "") + '" title="Colour tag">' +
                '<i style="background:' + (tag ? TAG_COLORS[tag] : "var(--text-3)") +
                ";color:" + (tag ? TAG_COLORS[tag] : "transparent") + '"></i></button>' +
                '<button class="row-fav' + (fav ? " on" : "") + '" title="Favourite (F)">' + STAR_SVG + "</button>" +
                "</div>"
            );
        }

        list.innerHTML = html.join("");

        // index row elements
        var rows = list.querySelectorAll(".sound-row");
        for (var r = 0; r < rows.length; r++) {
            rowEls[rows[r].dataset.path] = rows[r];
            wireRow(rows[r]);
        }

        setListHeader(
            $("listTitle").textContent,
            $("listPath").textContent,
            items.length
        );
        requestDurations();
    }

    function wireRow(row) {
        var path = row.dataset.path;

        row.addEventListener("click", function (ev) {
            if (ev.target.closest(".row-fav")) { toggleFav(path, ev.target.closest(".row-fav")); return; }
            if (ev.target.closest(".row-tag")) { openContextMenu(ev, path); return; }
            if (ev.target.closest(".row-play")) {
                var cur = AudioEngine.current();
                if (cur && cur.path === path) AudioEngine.togglePlay();
                else selectSound(path, true);
                return;
            }
            selectSound(path, true);
        });

        row.addEventListener("dblclick", function (ev) {
            ev.preventDefault();
            selectSound(path, false);
            addAtPlayhead(path);
        });

        row.addEventListener("contextmenu", function (ev) {
            ev.preventDefault();
            if (path !== S.selectedPath) selectSound(path, true);
            openContextMenu(ev, path);
        });

        row.addEventListener("dragstart", function (ev) {
            dragStart(ev, path, row);
        });
        row.addEventListener("dragend", dragEnd);
    }

    /* ═══════════════════ selection & preview ═══════════════════ */

    function selectSound(path, autoplay) {
        if (!path) return;

        if (S.selectedPath && rowEls[S.selectedPath]) {
            rowEls[S.selectedPath].classList.remove("selected");
        }
        S.selectedPath = path;
        var row = rowEls[path];
        if (row) {
            row.classList.add("selected");
            row.scrollIntoView({ block: "nearest" });
        }
        Store.set({ lastFile: path });

        var name = decodeName(baseName(path));
        $("btnAdd").disabled = false;
        $("btnPlay").disabled = false;
        $("btnStop").disabled = false;

        if (autoplay !== false) {
            Store.pushRecent(path, baseNameFull(path));
            refreshCounts();
            AudioEngine.select(path, name, {});
        } else {
            // just stage it without playing
            $("npName").textContent = name;
        }
        refreshRowStates();
    }

    var lastRowStateKey = null;

    function refreshRowStates() {
        var cur = AudioEngine.current();
        var playing = AudioEngine.isPlaying();
        // only re-scan rows when (current sound, playing state) actually changes
        var key = (cur ? cur.path : "") + (playing ? "|p" : "|s") + "|" + S.selectedPath;
        if (key === lastRowStateKey) return;
        lastRowStateKey = key;
        for (var p in rowEls) {
            if (!Object.prototype.hasOwnProperty.call(rowEls, p)) continue;
            var el = rowEls[p];
            var isCur = cur && cur.path === p;
            el.classList.toggle("playing", !!(isCur && playing));
            el.classList.toggle("selected", p === S.selectedPath);
        }
    }

    function toggleFav(path, btn) {
        var now = Store.toggleFavorite(path);
        var row = rowEls[path];
        if (row) {
            var fb = row.querySelector(".row-fav");
            if (fb) {
                fb.classList.toggle("on", now);
                fb.classList.remove("burst");
                void fb.offsetWidth;
                fb.classList.add("burst");
            }
        }
        toast(now ? "Added to Favorites ★" : "Removed from Favorites", now ? "ok" : "");
        refreshCounts();
        if (S.view === "favorites") loadVirtual("favorites");
    }

    function setTag(path, colorIndex) {
        Store.setTag(path, colorIndex);
        toast(colorIndex ? "Colour tag " + colorIndex + " applied" : "Colour tag cleared", "ok");
        renderList();
    }

    /* ═══════════════════ AE actions ═══════════════════ */

    function addAtPlayhead(path) {
        if (!path) {
            toast("Select a sound first", "warn");
            return;
        }
        if (!S.aeState.hasComp && Bridge.isCEP) {
            toast(Bridge.hostApp() === "PPRO" ? "Open a sequence first" : "Open a composition first", "err");
            return;
        }
        Bridge.evalHost("sfxm_addAtPlayhead", [path], function (res) {
            if (res && res.ok) {
                Store.pushRecent(path, baseNameFull(path));
                refreshCounts();
                if (S.view === "recent") loadVirtual("recent");
                var btn = $("btnAdd");
                btn.style.transform = "scale(.95)";
                setTimeout(function () { btn.style.transform = ""; }, 140);
                var addMsg = 'Added “' + decodeName(baseName(path)) + '” at ' + (res.timecode || "");
                if (res.overwrote) addMsg += "  (overwrote a clip — Ctrl/Cmd+Z to undo)";
                toast(addMsg, res.overwrote ? "warn" : "ok");
                pollAE(true);
            } else {
                toast((res && res.error) || "Could not add sound", "err");
            }
        });
    }

    function importToProject(path) {
        Bridge.evalHost("sfxm_importToProject", [path], function (res) {
            if (res && res.ok) {
                Store.pushRecent(path, baseNameFull(path));
                refreshCounts();
                toast("Imported to Project panel", "ok");
            } else {
                toast((res && res.error) || "Import failed", "err");
            }
        });
    }

    /* ═══════════════════ context menu ═══════════════════ */

    function openContextMenu(ev, path) {
        var menu = $("ctxMenu");
        var tag = Store.getTag(path);
        var fav = Store.isFavorite(path);

        var swatches = "";
        for (var c = 1; c <= 6; c++) {
            swatches += '<button class="ctx-swatch" data-tag="' + c + '" style="background:var(--d' + c + ')" title="Tag ' + c + '"></button>';
        }
        swatches += '<button class="ctx-swatch clear" data-tag="0" title="Clear tag"></button>';

        menu.innerHTML =
            '<button class="ctx-item" data-act="preview"><span class="ctx-ico">▶</span>Preview<span class="ctx-kbd">Space</span></button>' +
            '<button class="ctx-item" data-act="add"><span class="ctx-ico"><svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 2.1v7.8M2.1 6h7.8"/></svg></span>Add<span class="ctx-kbd">⏎</span></button>' +
            '<button class="ctx-item" data-act="import"><span class="ctx-ico">↓</span>Import to Project</button>' +
            '<div class="ctx-sep"></div>' +
            '<button class="ctx-item" data-act="fav"><span class="ctx-ico">' + (fav ? "★" : "☆") + "</span>" +
            (fav ? "Remove from Favorites" : "Add to Favorites") + '<span class="ctx-kbd">F</span></button>' +
            '<div class="ctx-label">Colour tag</div>' +
            '<div class="ctx-swatches">' + swatches + "</div>" +
            '<div class="ctx-sep"></div>' +
            '<button class="ctx-item" data-act="reveal"><span class="ctx-ico">↗</span>Reveal in Folder</button>' +
            '<button class="ctx-item" data-act="copy"><span class="ctx-ico">⧉</span>Copy Path</button>';

        menu.classList.remove("hidden");

        var x = ev.clientX, y = ev.clientY;
        var mw = menu.offsetWidth, mh = menu.offsetHeight;
        if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
        if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
        menu.style.left = x + "px";
        menu.style.top = y + "px";

        menu.onclick = function (e) {
            var tagBtn = e.target.closest(".ctx-swatch");
            if (tagBtn) {
                setTag(path, parseInt(tagBtn.dataset.tag, 10));
                closeContextMenu();
                return;
            }
            var item = e.target.closest(".ctx-item");
            if (!item) return;
            var act = item.dataset.act;
            closeContextMenu();
            if (act === "preview") selectSound(path, true);
            else if (act === "add") { selectSound(path, false); addAtPlayhead(path); }
            else if (act === "import") importToProject(path);
            else if (act === "fav") toggleFav(path);
            else if (act === "reveal") Bridge.revealPath(path);
            else if (act === "copy") copyText(path);
        };
    }

    function closeContextMenu() {
        $("ctxMenu").classList.add("hidden");
        $("ctxMenu").onclick = null;
    }

    function copyText(text) {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); toast("Path copied", "ok"); }
        catch (e) { toast("Copy failed", "err"); }
        document.body.removeChild(ta);
    }

    /* ═══════════════════ drag & drop ═══════════════════ */

    function dragStart(ev, path, row) {
        var dt = ev.dataTransfer;
        dt.effectAllowed = "copy";
        try {
            // Adobe CEP payload used by host applications
            dt.setData("com.adobe.cep.dnd.file.0", path);
        } catch (e0) {}
        try {
            var norm = path.replace(/\\/g, "/");
            var uri = /^[A-Za-z]:\//.test(norm) ? "file:///" + encodeURI(norm) : "file://" + encodeURI(norm);
            dt.setData("text/uri-list", uri);
            dt.setData("text/plain", path);
        } catch (e1) {}

        // custom drag image
        try {
            var ghost = row.cloneNode(true);
            ghost.style.cssText =
                "position:fixed;left:-9999px;top:0;width:" + row.offsetWidth +
                "px;background:var(--surface-3);border:1px solid var(--accent);" +
                "border-radius:9px;padding:0 10px;opacity:.95;color:var(--text);";
            document.body.appendChild(ghost);
            dt.setDragImage(ghost, 20, 14);
            setTimeout(function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 0);
        } catch (e2) {}

        row.classList.add("dragging");
        setTimeout(function () { $("dragHint").classList.remove("hidden"); }, 0);
    }

    function dragEnd() {
        $("dragHint").classList.add("hidden");
        var dragging = document.querySelectorAll(".sound-row.dragging");
        for (var i = 0; i < dragging.length; i++) dragging[i].classList.remove("dragging");
    }

    /* ═══════════════════ player UI wiring ═══════════════════ */

    function wirePlayer() {
        var wf = $("waveform");
        AudioEngine.Waveform.attach(wf);

        AudioEngine.on("decoding", function (info) {
            $("npName").textContent = info.name;
            $("npTime").textContent = "0:00.00";
            $("npDur").textContent = "0:00.00";
            $("npDecode").classList.remove("hidden");
            $("btnPlay").disabled = true;
            $("waveHint").classList.add("off");
        });

        AudioEngine.on("decoded", function (rec) {
            $("npDecode").classList.add("hidden");
            $("npName").textContent = rec.name;
            $("npDur").textContent = fmtTime(rec.duration);
            $("btnPlay").disabled = false;
            $("waveHint").classList.add("off");
            $("waveform").parentNode.classList.add("active");
            S.durations[rec.path] = rec.duration;
            var row = rowEls[rec.path];
            if (row) {
                var d = row.querySelector(".row-dur");
                if (d) d.textContent = fmtDur(rec.duration);
            }
            AudioEngine.animateDrawIn();
        });

        AudioEngine.on("state", function (st) {
            var pb = $("btnPlay");
            pb.classList.toggle("playing", st.playing);
            pb.disabled = !st.hasSound || !!AudioEngine.current() && !AudioEngine.current().buffer;
            $("btnStop").disabled = !st.hasSound;
            if (st.duration) $("npDur").textContent = fmtTime(st.duration);
            refreshRowStates();
        });

        AudioEngine.on("time", function (t) {
            $("npTime").textContent = fmtTime(t.time);
            if (t.duration) $("npDur").textContent = fmtTime(t.duration);
            AudioEngine.Waveform.draw();
        });

        AudioEngine.on("error", function (e) {
            $("npDecode").classList.add("hidden");
            var detail = e && e.message ? String(e.message).replace(/\s+/g, " ").trim() : "";
            if (!detail || detail === "Could not decode audio") {
                toast("Preview unavailable for this codec — you can still add it to the timeline", "err");
            } else {
                if (detail.length > 110) detail = detail.slice(0, 107) + "\u2026";
                toast("Preview failed \u2014 " + detail, "err");
            }
            $("btnPlay").disabled = true;
        });

        AudioEngine.on("zoom", function (z) {
            $("zoomLabel").textContent = (z % 1 === 0 ? z : z.toFixed(1)) + "×";
        });

        /* play / stop */
        $("btnPlay").addEventListener("click", function () { AudioEngine.togglePlay(); });
        $("btnStop").addEventListener("click", function () { AudioEngine.stop(); });

        /* loop */
        $("btnLoop").addEventListener("click", function () {
            var next = !AudioEngine.getSettings().loop;
            AudioEngine.setLoop(next);
            $("btnLoop").classList.toggle("on", next);
            Store.set({ loop: next });
        });

        /* zoom */
        $("btnZoomIn").addEventListener("click", function () {
            AudioEngine.Waveform.setZoom(AudioEngine.Waveform.zoom * 2);
        });
        $("btnZoomOut").addEventListener("click", function () {
            AudioEngine.Waveform.setZoom(AudioEngine.Waveform.zoom / 2);
        });

        /* waveform scrub */
        var scrubbing = false;
        wf.addEventListener("mousedown", function (ev) {
            scrubbing = true;
            doScrub(ev);
            ev.preventDefault();
        });
        window.addEventListener("mousemove", function (ev) {
            if (scrubbing) doScrub(ev);
        });
        window.addEventListener("mouseup", function () { scrubbing = false; });

        function doScrub(ev) {
            var rect = wf.getBoundingClientRect();
            var x = ev.clientX - rect.left;
            var t = AudioEngine.Waveform.xToTime(x);
            AudioEngine.seek(t);
            AudioEngine.Waveform.draw();
        }

        /* waveform wheel: pan / zoom */
        wf.addEventListener("wheel", function (ev) {
            ev.preventDefault();
            var W = AudioEngine.Waveform;
            if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
                var factor = ev.deltaY < 0 ? 1.25 : 0.8;
                var rect = wf.getBoundingClientRect();
                var anchor = (ev.clientX - rect.left) / rect.width;
                zoomAt(W, factor, anchor);
            } else {
                var d = ev.deltaY || ev.deltaX;
                if (W.zoom > 1) W.setPan(W.pan + d / 900);
            }
        }, { passive: false });

        function zoomAt(W, factor, anchor) {
            var oldZoom = W.zoom;
            var newZoom = Math.max(1, Math.min(64, oldZoom * factor));
            if (newZoom === oldZoom) return;
            var visOld = 1 / oldZoom, visNew = 1 / newZoom;
            // keep the anchor point stable: bucket fraction under anchor stays
            var startOld = W.pan * (1 - visOld);
            var target = startOld + anchor * visOld;
            var newStart = target - anchor * visNew;
            W.setZoom(newZoom);
            if (W.zoom > 1) W.setPan(newStart / (1 - visNew));
        }

        /* volume */
        var vol = $("volSlider");
        vol.value = Math.round(Store.get().volume * 100);
        paintRange(vol);
        AudioEngine.setVolume(Store.get().volume);
        vol.addEventListener("input", function () {
            AudioEngine.setVolume(vol.value / 100);
            paintRange(vol);
            Store.set({ volume: vol.value / 100 });
        });

        /* speed */
        var spd = $("speedSlider");
        spd.value = Math.round(Store.get().speed * 100);
        paintRange(spd);
        AudioEngine.setSpeed(Store.get().speed);
        $("speedLabel").textContent = (+spd.value / 100).toFixed(2).replace(/0$/, "") + "×";
        spd.addEventListener("input", function () {
            var v = spd.value / 100;
            AudioEngine.setSpeed(v);
            $("speedLabel").textContent = v.toFixed(2).replace(/0$/, "") + "×";
            paintRange(spd);
            Store.set({ speed: v });
        });

        if (Store.get().loop) {
            AudioEngine.setLoop(true);
            $("btnLoop").classList.add("on");
        }
        $("zoomLabel").textContent = "1×";

        /* add button */
        $("btnAdd").addEventListener("click", function () {
            addAtPlayhead(S.selectedPath);
        });
    }

    function paintRange(el) {
        var min = +el.min, max = +el.max, v = +el.value;
        var pct = ((v - min) / (max - min)) * 100;
        el.style.setProperty("--fill", pct + "%");
    }

    /* ═══════════════════ keyboard ═══════════════════ */

    function moveSelection(delta) {
        var items = filteredItems();
        if (!items.length) return;
        var idx = -1;
        for (var i = 0; i < items.length; i++) {
            if (items[i].path === S.selectedPath) { idx = i; break; }
        }
        idx = Math.max(0, Math.min(items.length - 1, idx + delta));
        selectSound(items[idx].path, true);
    }

    function anyOverlayOpen() {
        return !$("settingsOverlay").classList.contains("hidden") ||
               !$("helpOverlay").classList.contains("hidden");
    }
    function closeOverlays() {
        $("settingsOverlay").classList.add("hidden");
        $("helpOverlay").classList.add("hidden");
    }

    function wireKeyboard() {
        document.addEventListener("keydown", function (ev) {
            var inInput = ev.target && (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA");
            var mod = ev.metaKey || ev.ctrlKey;

            /* ⌘F / Ctrl+F → search */
            if (mod && (ev.key === "f" || ev.key === "F")) {
                ev.preventDefault();
                $("searchInput").focus();
                $("searchInput").select();
                return;
            }

            if (ev.key === "Escape") {
                if (anyOverlayOpen()) { closeOverlays(); return; }
                if (!$("ctxMenu").classList.contains("hidden")) { closeContextMenu(); return; }
                if (drawerOpen()) { closeDrawer(); return; }
                if (inInput && ev.target.value) {
                    ev.target.value = "";
                    clearSearch();
                    ev.target.blur();
                    return;
                }
                if (inInput) { ev.target.blur(); return; }
                AudioEngine.stop();
                return;
            }

            if (inInput) return;
            if (anyOverlayOpen()) return;

            switch (ev.key) {
                case "ArrowDown":
                    ev.preventDefault();
                    moveSelection(1);
                    break;
                case "ArrowUp":
                    ev.preventDefault();
                    moveSelection(-1);
                    break;
                case "Enter":
                    ev.preventDefault();
                    if (mod || ev.metaKey) {
                        var row = rowEls[S.selectedPath];
                        if (row) {
                            var r = row.getBoundingClientRect();
                            openContextMenu({ clientX: r.left + 40, clientY: r.bottom }, S.selectedPath);
                        }
                    } else {
                        addAtPlayhead(S.selectedPath);
                    }
                    break;
                case " ":
                case "Spacebar":
                    ev.preventDefault();
                    AudioEngine.togglePlay();
                    break;
                case "ArrowRight":
                    ev.preventDefault();
                    AudioEngine.seek(AudioEngine.currentPosition() + (ev.shiftKey ? 1 : 0.1));
                    AudioEngine.Waveform.draw();
                    break;
                case "ArrowLeft":
                    ev.preventDefault();
                    AudioEngine.seek(AudioEngine.currentPosition() - (ev.shiftKey ? 1 : 0.1));
                    AudioEngine.Waveform.draw();
                    break;
                case "+": case "=":
                    ev.preventDefault();
                    AudioEngine.Waveform.setZoom(AudioEngine.Waveform.zoom * 2);
                    break;
                case "-": case "_":
                    ev.preventDefault();
                    AudioEngine.Waveform.setZoom(AudioEngine.Waveform.zoom / 2);
                    break;
                case "f": case "F":
                    if (S.selectedPath) { ev.preventDefault(); toggleFav(S.selectedPath); }
                    break;
                case "l": case "L":
                    ev.preventDefault();
                    $("btnLoop").click();
                    break;
                case "?":
                    ev.preventDefault();
                    $("helpOverlay").classList.remove("hidden");
                    break;
                case "0": case "1": case "2": case "3": case "4": case "5": case "6":
                    if (S.selectedPath) {
                        ev.preventDefault();
                        setTag(S.selectedPath, ev.key === "0" ? 0 : +ev.key);
                    }
                    break;
                default:
                    break;
            }
        });
    }

    /* ═══════════════════ search ═══════════════════ */

    function wireSearch() {
        var input = $("searchInput");
        var clear = $("searchClear");

        input.addEventListener("input", function () {
            clear.classList.toggle("hidden", !input.value);
            if (S.searchTimer) clearTimeout(S.searchTimer);
            S.searchTimer = setTimeout(function () {
                var q = input.value.trim();
                if (!q) { clearSearch(); return; }
                runSearch(q);
            }, 180);
        });

        input.addEventListener("keydown", function (ev) {
            if (ev.key === "Enter") {
                var items = filteredItems();
                if (items.length) { selectSound(items[0].path, true); input.blur(); }
            }
        });

        clear.addEventListener("click", function () {
            input.value = "";
            clear.classList.add("hidden");
            clearSearch();
            input.focus();
        });
    }

    function clearSearch() {
        S.query = "";
        var lastFolder = Store.get().lastFolder;
        if (S.view === "search") {
            if (lastFolder) { selectFolder(lastFolder); }
            else loadVirtual("all");
        }
    }

    /* ═══════════════════ AE state polling ═══════════════════ */

    function pollAE(force) {
        var now = Date.now();
        if (!force && now - S.lastTick < 450) return;
        S.lastTick = now;

        Bridge.evalHost("sfxm_getState", [], function (res) {
            var dot = $("aeDot");
            if (res && res.ok) {
                S.aeState = res;
                dot.classList.remove("off", "err");
                var hostName = res.host || Bridge.hostApp();
                if (res.hasComp) {
                    $("aeState").textContent = "Playhead " + res.timecode + "  ·  " + res.comp;
                    $("playheadChip").textContent = res.timecode;
                } else {
                    $("aeState").textContent = hostName === "PPRO" ? "No sequence open" : "No composition open";
                    $("playheadChip").textContent = "––:––:––:––";
                }
            } else {
                S.aeState.hasComp = false;
                dot.classList.remove("off");
                dot.classList.add("err");
                $("aeState").textContent = Bridge.hostApp() === "PPRO"
                    ? "Premiere Pro not connected"
                    : "After Effects not connected";
            }
        });
    }

    /* ═══════════════════ folder picker ═══════════════════ */

    function wireFolderButtons() {
        function pick() {
            Bridge.pickFolder(function (res) {
                if (res && res.ok && res.path) {
                    Store.set({ root: res.path, lastFolder: res.path });
                    recomputeTotalCount();
                    renderTree();
                    refreshCounts();
                    toast("SFX folder set — " + baseNameFull(res.path), "ok");
                    // if the root only contains subfolders, show everything instead
                    Bridge.listDir(res.path, function (err2, listing) {
                        if (err2) {
                            toast("Couldn't read that folder — check file permissions", "err");
                            loadVirtual("all");
                            return;
                        }
                        var hasFiles = listing.files.some(function (f) {
                            return Bridge.isAudioFile(f.name);
                        });
                        if (hasFiles) selectFolder(res.path);
                        else { Store.set({ lastFolder: "" }); loadVirtual("all"); }
                    });
                } else if (res && res.cancelled) {
                    // user closed the dialog — not an error
                } else {
                    toast((res && res.error) || "Folder picker failed — try again", "err");
                }
            });
        }
        ["btnChooseFolder", "btnChooseFolder2", "btnChooseFolder3"].forEach(function (id) {
            var el = $(id);
            if (el) el.addEventListener("click", pick);
        });
    }

    /* ═══════════════════ modals ═══════════════════ */

    function wireModals() {
        $("btnSettings").addEventListener("click", function () {
            $("settingsOverlay").classList.remove("hidden");
            applyAccent(Store.get().accent, false); // refresh swatch state
        });
        $("btnShortcuts").addEventListener("click", function () {
            $("helpOverlay").classList.remove("hidden");
        });

        wireAccent();

        var closes = document.querySelectorAll("[data-close]");
        for (var i = 0; i < closes.length; i++) {
            closes[i].addEventListener("click", function () {
                $(this.dataset.close).classList.add("hidden");
            });
        }
        var overlays = document.querySelectorAll(".overlay");
        for (var j = 0; j < overlays.length; j++) {
            overlays[j].addEventListener("mousedown", function (ev) {
                if (ev.target === this) this.classList.add("hidden");
            });
        }

        // Label is just "Instagram" (no URL).
        // Inside CEP, standard <a href> links and window.open() do NOT launch
        // an external browser — the click listener must hand the URL to the
        // CEP runtime, which opens the system default browser.
        $("btnInstagram").addEventListener("click", function () {
            var url = "https://www.instagram.com/nadim.3x/";
            var viaCep = false;
            try {
                if (window.cep && window.cep.util &&
                    typeof window.cep.util.openURLInDefaultBrowser === "function") {
                    window.cep.util.openURLInDefaultBrowser(url);
                    viaCep = true;
                }
            } catch (eCep) {}
            if (!viaCep) Bridge.openExternal(url); // safety net: shell / __adobe_cep__ / window.open
            toast("Opening Instagram in your default browser\u2026", "ok");
        });
    }

    /* ═══════════════════ drawer (narrow / vertical layout) ═══════════════════ */

    function drawerOpen() {
        return $("sidebar").classList.contains("open");
    }
    function closeDrawer() {
        $("sidebar").classList.remove("open");
        $("drawerShade").classList.remove("show");
    }
    function toggleDrawer() {
        var open = $("sidebar").classList.toggle("open");
        $("drawerShade").classList.toggle("show", open);
    }

    /* ═══════════════════ accent colour ═══════════════════ */

    function normalizeHex(h) {
        if (!h) return null;
        h = String(h).trim().toLowerCase();
        if (/^#[0-9a-f]{6}$/.test(h)) return h;
        if (/^#[0-9a-f]{3}$/.test(h)) return "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
        return null;
    }

    function hexToRgb(hex) {
        return [parseInt(hex.slice(1, 3), 16),
                parseInt(hex.slice(3, 5), 16),
                parseInt(hex.slice(5, 7), 16)];
    }

    function mixHex(hex, target, amt) {
        var c = hexToRgb(hex), out = "";
        for (var i = 0; i < 3; i++) {
            var v = Math.round(c[i] + (target[i] - c[i]) * amt);
            out += (v < 16 ? "0" : "") + v.toString(16);
        }
        return "#" + out;
    }

    /** Apply an accent colour across the whole panel (live + persisted). */
    function applyAccent(hex, persist) {
        hex = normalizeHex(hex) || "#066ce7";
        var rgb = hexToRgb(hex);
        var root = document.documentElement;
        root.style.setProperty("--accent", hex);
        root.style.setProperty("--accent-rgb", rgb.join(", "));
        root.style.setProperty("--accent-hi", mixHex(hex, [255, 255, 255], 0.28));
        root.style.setProperty("--accent-dk", mixHex(hex, [0, 0, 0], 0.34));
        root.style.setProperty("--accent-soft", "rgba(" + rgb.join(", ") + ", .16)");
        root.style.setProperty("--accent-glow", "rgba(" + rgb.join(", ") + ", .42)");
        root.setAttribute("data-accent", hex);
        if (persist) Store.set({ accent: hex });

        var swatches = document.querySelectorAll("#accentRow .accent-swatch");
        for (var i = 0; i < swatches.length; i++) {
            var isOn = normalizeHex(swatches[i].dataset.accent) === hex;
            swatches[i].classList.toggle("active", isOn);
        }
        var picker = $("accentCustom");
        if (picker && picker.value !== hex) picker.value = hex;
        var hexField = $("accentHex");
        if (hexField && document.activeElement !== hexField) hexField.value = hex.toUpperCase().replace(/^#/, "");
        var accentDot = $("accentDot");
        if (accentDot) accentDot.style.background = hex;

        try { AudioEngine.Waveform.draw(); } catch (e) {}
    }

    function applyBg(hex, persist) {
        hex = normalizeHex(hex) || "";
        var root = document.documentElement;
        if (hex) root.style.setProperty("--bg", hex);
        else root.style.removeProperty("--bg");
        // bright user-picked backgrounds: flip text/surface tokens for contrast
        if (hex) {
            var rgb = hexToRgb(hex);
            var lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
            if (lum > 0.55) root.setAttribute("data-bg-contrast", "light");
            else root.removeAttribute("data-bg-contrast");
        } else {
            root.removeAttribute("data-bg-contrast");
        }
        var swatches = document.querySelectorAll("#bgRow .bg-swatch");
        for (var i = 0; i < swatches.length; i++) {
            var want = normalizeHex(swatches[i].getAttribute("data-bg")) || "";
            swatches[i].classList.toggle("active", want === hex);
        }
        var picker = $("bgCustom");
        if (picker && hex && picker.value !== hex) picker.value = hex;
        var hf = $("bgHex");
        if (hf && document.activeElement !== hf) hf.value = hex ? hex.toUpperCase().replace(/^#/, "") : "";
        var bgDot = $("bgDot");
        if (bgDot) bgDot.style.background = hex || "var(--bg)";
        if (persist) Store.set({ bgColor: hex });
    }

    function wireHexField(id, apply, allowEmpty) {
        var f = $(id);
        if (!f) return;
        f.addEventListener("focus", function () { f.classList.remove("bad"); });
        function commit() {
            var raw = String(f.value || "").trim();
            if (!raw && allowEmpty) {
                f.classList.remove("bad");
                apply("");
                return;
            }
            var v = normalizeHex(raw.charAt(0) === "#" ? raw : "#" + raw);
            if (v) {
                f.classList.remove("bad");
                apply(v);
            } else {
                f.classList.add("bad");
            }
        }
        f.addEventListener("change", commit);
        f.addEventListener("keydown", function (ev) {
            if (ev.key === "Enter") { commit(); f.blur(); }
        });
    }

    function wireBg() {
        var row = $("bgRow");
        if (row) {
            row.addEventListener("click", function (ev) {
                var b = ev.target.closest(".bg-swatch");
                if (!b) return;
                applyBg(b.getAttribute("data-bg") || "", true);
            });
        }
        var picker = $("bgCustom");
        if (picker) {
            picker.addEventListener("input", function () { applyBg(picker.value, true); });
        }
        wireHexField("bgHex", function (v) { applyBg(v, true); }, true);
        wireHexField("accentHex", function (v) { applyAccent(v, true); }, false);
        var applyBtn = $("btnApplySettings");
        if (applyBtn) {
            applyBtn.addEventListener("click", function () {
                toast("Settings applied \u2713", "ok");
                $("settingsOverlay").classList.add("hidden");
            });
        }
    }

    function wireAccent() {
        var swatches = document.querySelectorAll("#accentRow .accent-swatch");
        for (var i = 0; i < swatches.length; i++) {
            swatches[i].addEventListener("click", function () {
                applyAccent(this.dataset.accent, true);
            });
        }
        $("accentCustom").addEventListener("input", function () {
            applyAccent(this.value, true);
        });
    }

    /* ═══════════════════ panel tone (Settings) ═══════════════════ */

    function applyTone(tone, persist) {
        tone = tone === "ink" ? "ink" : "";
        if (tone) document.documentElement.setAttribute("data-tone", tone);
        else document.documentElement.removeAttribute("data-tone");
        var sw = document.querySelectorAll("#toneRow .tone-swatch");
        for (var i = 0; i < sw.length; i++) {
            sw[i].classList.toggle("active", (sw[i].getAttribute("data-tone") || "") === tone);
        }
        if (persist) Store.set({ tone: tone });
    }

    function wireTone() {
        var row = $("toneRow");
        if (!row) return;
        row.addEventListener("click", function (ev) {
            var b = ev.target.closest(".tone-swatch");
            if (!b) return;
            applyTone(b.getAttribute("data-tone") || "", true);
        });
    }

    /* ═══════════════════ list / grid view ═══════════════════ */

    function applyViewMode(mode, persist) {
        mode = mode === "grid" ? "grid" : "list";
        var list = $("soundList");
        list.classList.toggle("grid-view", mode === "grid");
        $("btnViewList").classList.toggle("active", mode === "list");
        $("btnViewGrid").classList.toggle("active", mode === "grid");
        if (persist) Store.set({ viewMode: mode });
    }

    function wireViewToggle() {
        $("btnViewList").addEventListener("click", function () { applyViewMode("list", true); });
        $("btnViewGrid").addEventListener("click", function () { applyViewMode("grid", true); });
    }

    /* ═══════════════════ misc UI ═══════════════════ */

    function wireChrome() {
        wireViewToggle();
        wireTone();
        wireBg();
        $("btnTheme").addEventListener("click", function () {
            var next = Store.get().theme === "light" ? "dark" : "light";
            Store.set({ theme: next });
            applyTheme(next);
            AudioEngine.Waveform.draw();
        });

        $("btnSidebar").addEventListener("click", toggleDrawer);
        $("drawerShade").addEventListener("click", closeDrawer);

        var navs = document.querySelectorAll("#virtualNav .nav-item");
        for (var i = 0; i < navs.length; i++) {
            navs[i].addEventListener("click", function () {
                loadVirtual(this.dataset.view);
                closeDrawer();
            });
        }

        var chips = document.querySelectorAll("#tagFilter .chip");
        for (var c = 0; c < chips.length; c++) {
            chips[c].addEventListener("click", function () {
                var t = +this.dataset.tag;
                S.tagFilter = t;
                for (var k = 0; k < chips.length; k++) chips[k].classList.remove("active");
                this.classList.add("active");
                renderList();
            });
        }

        document.addEventListener("click", function (ev) {
            if (!ev.target.closest("#ctxMenu")) closeContextMenu();
        });

        // highlight slider fill on both thumbs & keyboard focus niceties
        window.addEventListener("blur", function () { closeContextMenu(); });
    }

    /* ═══════════════════ init ═══════════════════ */

    function init() {
        var st = Store.load();
        applyTheme(st.theme);
        applyAccent(st.accent || "#066ce7", false);
        applyViewMode(st.viewMode);
        applyTone(st.tone);
        applyBg(st.bgColor);
        wirePlayer();
        wireKeyboard();
        wireSearch();
        wireFolderButtons();
        wireModals();
        wireChrome();

        // preview mode: use the bundled demo library automatically
        if (!Bridge.isCEP && !st.root) {
            Store.set({ root: Mock.ROOT });
            st = Store.get();
        }

        if (!Bridge.isCEP) {
            $("aeDot").classList.remove("off");
        }

        function showLibrary() {
            var s = Store.get();
            recomputeTotalCount();
            if (s.root) {
                renderTree();
                refreshCounts();
                // resume last folder when set; otherwise start on All Sounds
                if (s.lastFolder) selectFolder(s.lastFolder);
                else loadVirtual("all");
            } else {
                refreshCounts();
                loadVirtual("all");
            }
        }

        // restoreFromBackup always invokes its callback (sync when no CEP)
        Store.restoreFromBackup(function () {
            showLibrary();
            var s2 = Store.get();
            if (s2.lastFile) {
                $("npName").textContent = decodeName(baseName(s2.lastFile)) + "  (press Space to preview)";
            }
        });

        pollAE(true);
        setInterval(function () { pollAE(false); }, 500);

        // in browser preview, nudge waveform size after layout
        setTimeout(function () { AudioEngine.Waveform.resize(); }, 60);
    }

    init();
})();

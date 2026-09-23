/*
 * store.js — persistence for settings, favorites, recent sounds and colour tags.
 * Primary: localStorage (fast, synchronous). Backup: JSON file next to the
 * extension so state survives profile clean-ups.
 */

var Store = (function () {
    "use strict";

    var KEY = "sfxm.v1";

    var defaults = {
        root: "",                 // user's SFX folder
        volume: 0.85,             // 0..1
        speed: 1.0,               // 0.5..2
        loop: false,
        theme: "dark",            // dark | light
        viewMode: "list",         // list | grid
        accent: "#066ce7",        // UI accent colour (#066CE7 = default blue)
        zoom: 1,                  // waveform zoom level
        favorites: {},            // path -> timestamp
        recent: [],               // [{path, name, at}] newest first
        tags: {},                 // path -> color index (1..6)
        lastFolder: "",
        lastFile: ""
    };

    var state = null;
    var saveTimer = null;
    var backupTimer = null;

    function deepMerge(base, extra) {
        var out = {};
        var k;
        for (k in base) {
            if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
        }
        if (extra && typeof extra === "object") {
            for (k in extra) {
                if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] !== undefined) {
                    out[k] = extra[k];
                }
            }
        }
        return out;
    }

    function load() {
        var raw = null;
        try { raw = localStorage.getItem(KEY); } catch (e) {}
        var parsed = null;
        if (raw) {
            try { parsed = JSON.parse(raw); } catch (e2) {}
        }
        state = deepMerge(defaults, parsed);
        // defensive copies
        if (!state.favorites || typeof state.favorites !== "object") state.favorites = {};
        if (!state.tags || typeof state.tags !== "object") state.tags = {};
        if (!Array.isArray(state.recent)) state.recent = [];
        return state;
    }

    function persist() {
        if (!state) return;
        try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}

        // debounced file backup — ONLY outside the extension folder, so a
        // signed (ZXP) install keeps a valid signature at load time
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(function () {
            var base = Bridge.userDataPath();
            if (!base) return; // browser preview / no userData: localStorage only
            var file = base.replace(/[\\/]+$/, "") + "/sfxmanager.settings.json";
            Bridge.writeTextFile(file, JSON.stringify(state), null);
        }, 600);
    }

    /** Merge a settings file found in the CEP userData folder (migration/restore). */
    function restoreFromBackup(cb) {
        var base = Bridge.userDataPath();
        if (!base) { if (cb) cb(false); return; }
        var file = base.replace(/[\\/]+$/, "") + "/sfxmanager.settings.json";
        Bridge.readTextFile(file, function (err, text) {
            if (err || !text) { if (cb) cb(false); return; }
            try {
                var parsed = JSON.parse(text);
                // don't clobber newer local state — only fill missing root
                if (!state.root && parsed.root) {
                    state.root = parsed.root;
                    state.favorites = parsed.favorites || state.favorites;
                    state.tags = parsed.tags || state.tags;
                    state.recent = Array.isArray(parsed.recent) ? parsed.recent : state.recent;
                    persist();
                    if (cb) cb(true);
                    return;
                }
            } catch (e) {}
            if (cb) cb(false);
        });
    }

    /* ---------------- public helpers ---------------- */

    return {
        defaults: defaults,
        load: load,
        get: function () { if (!state) load(); return state; },
        set: function (patch, silent) {
            if (!state) load();
            for (var k in patch) {
                if (Object.prototype.hasOwnProperty.call(patch, k)) state[k] = patch[k];
            }
            if (!silent) persist();
        },
        persist: persist,
        restoreFromBackup: restoreFromBackup,

        isFavorite: function (path) {
            if (!state) load();
            return !!state.favorites[path];
        },
        toggleFavorite: function (path) {
            if (!state) load();
            if (state.favorites[path]) delete state.favorites[path];
            else state.favorites[path] = Date.now();
            persist();
            return !!state.favorites[path];
        },
        favoritePaths: function () {
            if (!state) load();
            return Object.keys(state.favorites);
        },

        pushRecent: function (path, name) {
            if (!state) load();
            state.recent = state.recent.filter(function (r) { return r.path !== path; });
            state.recent.unshift({ path: path, name: name, at: Date.now() });
            if (state.recent.length > 30) state.recent.length = 30;
            state.lastFile = path;
            persist();
        },
        recent: function () {
            if (!state) load();
            return state.recent.slice();
        },

        getTag: function (path) {
            if (!state) load();
            return state.tags[path] || 0;
        },
        setTag: function (path, colorIndex) {
            if (!state) load();
            if (!colorIndex) delete state.tags[path];
            else state.tags[path] = colorIndex;
            persist();
            return state.tags[path] || 0;
        },
        tags: function () {
            if (!state) load();
            return state.tags;
        }
    };
})();

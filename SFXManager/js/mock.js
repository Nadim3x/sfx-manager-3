/*
 * mock.js — a virtual After Effects + filesystem environment.
 * Used automatically when the panel runs outside of CEP (live preview),
 * so the full UI, waveform and audio preview can be experienced in a browser.
 */

var Mock = (function () {
    "use strict";

    /* ------------------------------------------------------------------ */
    /* Virtual SFX library                                                 */
    /* ------------------------------------------------------------------ */

    var ROOT = "/SFX Library";

    // name : [duration seconds, kind]
    // kinds → whoosh | impact | riser | ui | ambience | riser_down | click
    var TREE = {
        "Impacts": {
            "Deep Impact 01.wav": [2.4, "impact"],
            "Deep Impact 02.wav": [3.1, "impact"],
            "Cinematic Hit Big.wav": [2.8, "impact"],
            "Metal Slam.wav": [1.2, "impact"],
            "Sub Drop Heavy.wav": [2.0, "impact"]
        },
        "Whooshes": {
            "Whoosh Fast 01.wav": [0.9, "whoosh"],
            "Whoosh Fast 02.wav": [1.1, "whoosh"],
            "Whoosh Slow Airy.wav": [1.8, "whoosh"],
            "Swish Transition.wav": [0.7, "whoosh"],
            "Reverse Whoosh.wav": [1.5, "whoosh"]
        },
        "Risers": {
            "Riser Tension 2s.wav": [2.0, "riser"],
            "Riser Tension 4s.wav": [4.0, "riser"],
            "Downer Fall.wav": [2.2, "riser_down"],
            "Riser with Pitch.wav": [3.2, "riser"],
            "Uplifter Bright.wav": [2.6, "riser"]
        },
        "UI / Interface": {
            "Button Click Soft.wav": [0.3, "click"],
            "Button Click Crisp.wav": [0.2, "click"],
            "Notification Pop.wav": [0.6, "ui"],
            "Success Chime.wav": [1.2, "ui"],
            "Error Buzz.wav": [0.8, "ui"],
            "Toggle Switch.wav": [0.25, "click"]
        },
        "Ambience": {
            "Room Tone Soft.wav": [6.0, "ambience"],
            "City Night Loop.wav": [6.0, "ambience"],
            "Wind Desert.wav": [5.0, "ambience"],
            "Forest Morning.wav": [5.5, "ambience"]
        },
        "Transitions": {
            "Scene Transition Deep.wav": [1.6, "whoosh"],
            "Logo Reveal Sting.wav": [2.5, "riser"],
            "Text Whoosh In.wav": [0.6, "whoosh"]
        },
        "Button%20Pack%20%F0%9F%8E%B5": {
            "Click%20Soft%20%F0%9F%94%B5.wav": [0.3, "click"],
            "Correct%20%20Approve%20Button.wav": [0.9, "ui"]
        }
    };

    function buildFS() {
        var fs = {};
        fs[ROOT] = { dirs: [], files: [] };
        Object.keys(TREE).forEach(function (folder) {
            var p = ROOT + "/" + folder;
            fs[ROOT].dirs.push({ name: folder, path: p, isDir: true });
            fs[p] = { dirs: [], files: [] };
            Object.keys(TREE[folder]).forEach(function (file) {
                var info = TREE[folder][file];
                var fp = p + "/" + file;
                fs[p].files.push({
                    name: file,
                    path: fp,
                    size: Math.round(info[0] * 44100 * 2)
                });
                fs[fp] = { kind: info[1], duration: info[0] };
            });
        });
        return fs;
    }

    var FS = buildFS();

    /* ------------------------------------------------------------------ */
    /* WAV synthesiser — produces real decodable PCM audio                 */
    /* ------------------------------------------------------------------ */

    function hashStr(s) {
        var h = 2166136261;
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h * 16777619) >>> 0;
        }
        return h >>> 0;
    }

    function mulberry32(a) {
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            var t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function encodeWav(samples, sampleRate) {
        var n = samples.length;
        var buffer = new ArrayBuffer(44 + n * 2);
        var view = new DataView(buffer);
        function writeStr(off, s) {
            for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
        }
        writeStr(0, "RIFF");
        view.setUint32(4, 36 + n * 2, true);
        writeStr(8, "WAVE");
        writeStr(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);          // PCM
        view.setUint16(22, 1, true);          // mono
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeStr(36, "data");
        view.setUint32(40, n * 2, true);
        for (var i = 0; i < n; i++) {
            var s = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
        return buffer;
    }

    var synthCache = {};

    function synthFor(path) {
        if (synthCache[path]) return synthCache[path];

        var meta = FS[path] || { kind: "whoosh", duration: 1.5 };
        var dur = meta.duration;
        var kind = meta.kind;
        var sr = 44100;
        var n = Math.round(dur * sr);
        var out = new Float32Array(n);
        var rnd = mulberry32(hashStr(path));
        var phase = rnd() * Math.PI * 2;
        var i, t, v, f;

        for (i = 0; i < n; i++) {
            t = i / sr;
            var p = t / dur; // 0..1

            if (kind === "impact") {
                f = 90 * Math.exp(-p * 6) + 35;
                phase += (2 * Math.PI * f) / sr;
                var env = Math.exp(-p * 4.5);
                var noise = (rnd() * 2 - 1) * Math.exp(-p * 24);
                v = (Math.sin(phase) * 0.85 + noise * 0.55) * env;
            } else if (kind === "whoosh") {
                var env2 = Math.sin(Math.PI * Math.pow(p, 0.85));
                var noise2 = (rnd() * 2 - 1);
                // simple one-pole band shaping
                f = 300 + 2600 * env2;
                phase += (2 * Math.PI * f) / sr;
                v = (noise2 * 0.5 + Math.sin(phase) * 0.3) * env2 * 0.9;
            } else if (kind === "riser" || kind === "riser_down") {
                var pp = kind === "riser" ? p : 1 - p;
                f = 140 * Math.pow(8.5, pp * pp);
                phase += (2 * Math.PI * f) / sr;
                var env3 = Math.pow(pp, 1.2) * (1 - Math.pow(p, 8) * 0.4);
                v = (Math.sin(phase) * 0.55 + Math.sin(phase * 2) * 0.2 + (rnd() * 2 - 1) * 0.12) * env3;
            } else if (kind === "ui") {
                f = 660 + 320 * Math.sin(p * 9);
                phase += (2 * Math.PI * f) / sr;
                v = Math.sin(phase) * Math.exp(-p * 3.2) * 0.8;
            } else if (kind === "click") {
                phase += (2 * Math.PI * (1400 + rnd() * 40)) / sr;
                v = (Math.sin(phase) * 0.6 + (rnd() * 2 - 1) * 0.6) * Math.exp(-p * 28);
            } else { // ambience
                var slow = 0.55 + 0.45 * Math.sin(p * Math.PI * 2 * (1 + rnd() * 0.01));
                v = ((rnd() * 2 - 1) * 0.5 + Math.sin(2 * Math.PI * 110 * t) * 0.06) * slow * 0.6;
                // fade edges
                v *= Math.min(1, p * 8, (1 - p) * 8);
            }

            // master fade-out tail + gentle limiter
            if (p > 0.92) v *= (1 - p) / 0.08;
            out[i] = Math.max(-0.95, Math.min(0.95, v));
        }

        var buf = encodeWav(out, sr);
        synthCache[path] = buf;
        return buf;
    }

    /* ------------------------------------------------------------------ */
    /* Fake comp + playhead                                                */
    /* ------------------------------------------------------------------ */

    var fakeState = {
        hasComp: true,
        comp: "Preview Comp 1920×1080",
        fps: 30,
        duration: 12,
        start: Date.now(),
        added: []   // log of "adds" so the demo feels real
    };

    function pad2(n) { return (n < 10 ? "0" : "") + n; }

    function tcFor(t, fps) {
        var totalFrames = Math.round(t * fps);
        var ff = totalFrames % fps;
        var totalSec = Math.floor(totalFrames / fps);
        return pad2(Math.floor(totalSec / 3600)) + ":" +
               pad2(Math.floor(totalSec / 60) % 60) + ":" +
               pad2(totalSec % 60) + ":" + pad2(ff);
    }

    function stateObj() {
        var t = ((Date.now() - fakeState.start) / 1000) % fakeState.duration;
        return {
            ok: true,
            host: "AE",
            hasComp: fakeState.hasComp,
            comp: fakeState.comp,
            time: t,
            duration: fakeState.duration,
            fps: fakeState.fps,
            timecode: tcFor(t, fakeState.fps)
        };
    }

    /* ------------------------------------------------------------------ */

    var store = {}; // virtual text files (session only)

    return {
        ROOT: ROOT,

        evalHost: function (fn, args, cb) {
            // simulate evalScript latency
            setTimeout(function () {
                if (fn === "sfxm_getState") {
                    cb(stateObj());
                } else if (fn === "sfxm_addAtPlayhead") {
                    var path = args[0] || "";
                    var st = stateObj();
                    fakeState.added.push(path);
                    // nudge the fake playhead forward like a busy editor
                    fakeState.start -= 900;
                    cb({
                        ok: true,
                        layer: path.split("/").pop().replace(/\.[^.]+$/, ""),
                        time: st.time,
                        timecode: st.timecode,
                        imported: fakeState.added.length % 3 !== 1
                    });
                } else if (fn === "sfxm_importToProject") {
                    cb({ ok: true, name: (args[0] || "").split("/").pop(), imported: true });
                } else if (fn === "sfxm_listDir") {
                    Mock.listDir(args[0], function (err, listing) {
                        cb(err ? { ok: false, error: err } : {
                            ok: true, dirs: listing.dirs, files: listing.files
                        });
                    });
                } else {
                    cb({ ok: true });
                }
            }, 60);
        },

        pickFolder: function (cb) {
            setTimeout(function () { cb({ ok: true, path: ROOT }); }, 50);
        },

        listDir: function (p, cb) {
            setTimeout(function () {
                var node = FS[p];
                if (!node) { cb("Folder not found.", null); return; }
                var dirs = node.dirs.slice().sort(function (a, b) {
                    return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
                });
                var files = node.files.slice().sort(function (a, b) {
                    return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
                });
                cb(null, { dirs: dirs, files: files });
            }, 40);
        },

        readFileBuffer: function (p, cb) {
            setTimeout(function () {
                if (!FS[p]) { cb("File not found.", null); return; }
                cb(null, synthFor(p));
            }, 30);
        },

        readFileHead: function (p, n, cb) {
            var buf = synthFor(p);
            cb(null, buf.slice(0, n));
        },

        readTextFile: function (p, cb) {
            if (store[p] !== undefined) cb(null, store[p]);
            else cb("not found", null);
        },

        writeTextFile: function (p, data, cb) {
            store[p] = data;
            if (cb) cb(null);
        },

        /** exercise the real WAV header parser used for list durations */
        synthFor: synthFor
    };
})();

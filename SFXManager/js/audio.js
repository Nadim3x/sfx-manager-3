/*
 * audio.js — Web Audio playback, decoding, waveform peaks & rendering.
 * Works in CEP (Chromium) and in regular browsers (preview mode).
 */

var AudioEngine = (function () {
    "use strict";

    var PEAK_BUCKETS = 16384;

    var ctx = null;
    var masterGain = null;
    var source = null;

    var current = null;        // { path, name, buffer, peaks, duration }
    var playing = false;
    var position = 0;          // seconds within current sound
    var startedAt = 0;         // ctx.currentTime when started
    var startedOffset = 0;     // position at start
    var rafId = 0;

    var cache = Object.create(null);      // path -> record
    var pending = Object.create(null);    // path -> Promise
    var listeners = {};                   // event -> [fn]

    var settings = { volume: 0.85, speed: 1.0, loop: false };

    /* ---------------- events ---------------- */

    function on(evt, fn) {
        if (!listeners[evt]) listeners[evt] = [];
        listeners[evt].push(fn);
    }
    function emit(evt, payload) {
        var fns = listeners[evt];
        if (!fns) return;
        for (var i = 0; i < fns.length; i++) {
            try { fns[i](payload); } catch (e) {}
        }
    }

    /* ---------------- context ---------------- */

    function ensureCtx() {
        if (!ctx) {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            ctx = new AC();
            masterGain = ctx.createGain();
            masterGain.gain.value = settings.volume;
            masterGain.connect(ctx.destination);
        }
        if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) {} }
        return ctx;
    }

    function setVolume(v) {
        settings.volume = Math.max(0, Math.min(1, v));
        if (masterGain) masterGain.gain.value = settings.volume;
        emit("volume", settings.volume);
    }

    function setSpeed(s) {
        settings.speed = Math.max(0.25, Math.min(4, s));
        if (source) { try { source.playbackRate.value = settings.speed; } catch (e) {} }
        emit("speed", settings.speed);
    }

    function setLoop(loop) {
        settings.loop = !!loop;
        if (source) { try { source.loop = settings.loop; } catch (e) {} }
        emit("loop", settings.loop);
    }

    /* ---------------- decoding ---------------- */

    function decodeArray(ab) {
        return new Promise(function (resolve, reject) {
            var c = ensureCtx();
            if (!c) { reject(new Error("Web Audio unavailable")); return; }
            var p;
            try { p = c.decodeAudioData(ab, resolve, reject); }
            catch (e) { reject(e); return; }
            if (p && typeof p.then === "function") p.then(resolve, reject);
        });
    }

    function computePeaks(buffer) {
        var len = buffer.length;
        var ch = buffer.numberOfChannels;
        var buckets = Math.min(PEAK_BUCKETS, Math.max(64, len));
        var per = len / buckets;
        var mins = new Float32Array(buckets);
        var maxs = new Float32Array(buckets);

        // mix down to one channel (average of first two)
        var data0 = buffer.getChannelData(0);
        var data1 = ch > 1 ? buffer.getChannelData(1) : null;

        for (var b = 0; b < buckets; b++) {
            var start = Math.floor(b * per);
            var end = Math.min(len, Math.floor((b + 1) * per));
            if (end <= start) end = Math.min(len, start + 1);
            var mn = 1e9, mx = -1e9;
            // sample at most ~64 points per bucket for speed on long files
            var step = Math.max(1, Math.floor((end - start) / 64));
            for (var i = start; i < end; i += step) {
                var v = data0[i];
                if (data1) v = (v + data1[i]) * 0.5;
                if (v < mn) mn = v;
                if (v > mx) mx = v;
            }
            if (mn > mx) { mn = 0; mx = 0; }
            mins[b] = mn; maxs[b] = mx;
        }
        return { mins: mins, maxs: maxs, buckets: buckets };
    }

    /**
     * Load + decode a sound. Resolves with the record:
     * { path, name, buffer, peaks, duration }
     */
    function load(path, name) {
        if (cache[path]) {
            var rec = cache[path];
            rec.name = name || rec.name;
            return Promise.resolve(rec);
        }
        if (pending[path]) return pending[path];

        ensureCtx();

        var promise = new Promise(function (resolve, reject) {
            Bridge.readFileBuffer(path, function (err, ab) {
                if (err) { reject(new Error(err)); return; }
                decodeArray(ab).then(function (buffer) {
                    var rec = {
                        path: path,
                        name: name || path.split(/[\\/]/).pop(),
                        buffer: buffer,
                        peaks: computePeaks(buffer),
                        duration: buffer.duration
                    };
                    cache[path] = rec;
                    delete pending[path];
                    resolve(rec);
                }, function (e) {
                    delete pending[path];
                    reject(e || new Error("Could not decode audio"));
                });
            });
        });

        pending[path] = promise;
        return promise;
    }

    /* ---------------- quick duration from headers ---------------- */

    function readU32(v, off, le) {
        return le ? v.getUint32(off, true) : v.getUint32(off, false);
    }

    /** Returns duration in seconds parsed from a WAV/AIFF header, or null. */
    function quickDuration(ab) {
        try {
            if (ab.byteLength < 64) return null;
            var v = new DataView(ab);
            var magic = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));

            if (magic === "RIFF") {
                var pos = 12;
                var byteRate = 0, dataSize = 0, found = false;
                while (pos + 8 <= Math.min(v.byteLength, 131072)) {
                    var id = String.fromCharCode(v.getUint8(pos), v.getUint8(pos + 1),
                        v.getUint8(pos + 2), v.getUint8(pos + 3));
                    var sz = v.getUint32(pos + 4, true);
                    if (id === "fmt ") {
                        byteRate = v.getUint32(pos + 16, true) || 0; // offset: pos+8+12
                    } else if (id === "data") {
                        dataSize = sz;
                        found = true;
                        break;
                    }
                    if (sz <= 0) break;
                    pos += 8 + sz + (sz % 2);
                }
                if (found && byteRate > 0) return dataSize / byteRate;
                return null;
            }

            if (magic === "FORM") {
                var p2 = 12;
                var channels = 0, frames = 0, srate = 0;
                while (p2 + 8 <= Math.min(v.byteLength, 131072)) {
                    var id2 = String.fromCharCode(v.getUint8(p2), v.getUint8(p2 + 1),
                        v.getUint8(p2 + 2), v.getUint8(p2 + 3));
                    var sz2 = v.getUint32(p2 + 4, false);
                    if (id2 === "COMM") {
                        channels = v.getUint16(p2 + 8, false);
                        frames = v.getUint32(p2 + 10, false);
                        srate = readExtendedFloat(v, p2 + 14);
                        break;
                    }
                    if (sz2 <= 0) break;
                    p2 += 8 + sz2 + (sz2 % 2);
                }
                if (frames > 0 && srate > 0) return frames / srate;
                return null;
            }
        } catch (e) {}
        return null;
    }

    /** 80-bit IEEE 754 extended (AIFF sample rate) → Number */
    function readExtendedFloat(v, off) {
        var mantissaHi = v.getUint32(off + 2, false);
        var mantissaLo = v.getUint32(off + 6, false);
        var exponent = v.getUint16(off, false);
        var sign = 1;
        if (exponent & 0x8000) { sign = -1; exponent &= 0x7FFF; }
        if (exponent === 0 && mantissaHi === 0 && mantissaLo === 0) return 0;
        var exp = exponent - 16383;
        var mant = mantissaHi * Math.pow(2, 32) + mantissaLo;
        return sign * mant * Math.pow(2, exp - 63);
    }

    /* ---------------- playback ---------------- */

    function stopSource() {
        if (source) {
            try { source.onended = null; source.stop(0); } catch (e) {}
            try { source.disconnect(); } catch (e2) {}
            source = null;
        }
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    }

    function currentPosition() {
        if (!current) return 0;
        if (!playing) return position;
        var t = position + (ctx.currentTime - startedAt) * settings.speed;
        var d = current.duration;
        if (settings.loop && d > 0) {
            t = t % d;
        } else if (t >= d) {
            return d;
        }
        return t;
    }

    /** Stop the playback loop after a natural end (keeps rafId consistent). */
    function finishNaturally() {
        if (!playing) return;
        playing = false;
        position = current ? current.duration : 0;
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        emit("state", stateObj());
        emit("time", { time: position, duration: current ? current.duration : 0 });
    }

    function tick() {
        if (!playing) return;
        var t = currentPosition();
        if (!settings.loop && current && t >= current.duration) {
            finishNaturally();
            return;
        }
        emit("time", { time: t, duration: current.duration });
        rafId = requestAnimationFrame(tick);
    }

    function startSource(offset) {
        stopSource();
        var c = ensureCtx();
        if (!c || !current) return;

        source = c.createBufferSource();
        source.buffer = current.buffer;
        source.playbackRate.value = settings.speed;
        source.loop = settings.loop;
        source.connect(masterGain);

        var off = offset;
        if (off >= current.duration - 0.005) off = 0;
        source.start(0, Math.max(0, off));

        source.onended = function () {
            if (!settings.loop) finishNaturally();
        };

        playing = true;
        startedAt = c.currentTime;
        startedOffset = off;
        position = off;
        emit("state", stateObj());
        if (!rafId) rafId = requestAnimationFrame(tick);
    }

    function stateObj() {
        return {
            hasSound: !!current,
            playing: playing,
            path: current ? current.path : "",
            name: current ? current.name : "",
            duration: current ? current.duration : 0,
            position: currentPosition(),
            volume: settings.volume,
            speed: settings.speed,
            loop: settings.loop
        };
    }

    /**
     * Select (and auto-play) a sound.
     * opts = { autoplay:true, onDecoded:fn }
     */
    function select(path, name, opts) {
        opts = opts || {};
        ensureCtx();

        // selecting the same sound while playing → restart from 0 (re-preview)
        if (current && current.path === path && playing && opts.restart !== false) {
            startSource(0);
            return Promise.resolve(current);
        }
        // paused on this sound and already decoded → just resume/replay (no flicker)
        if (current && current.path === path && current.buffer && !opts.forceReload) {
            stopSource();
            position = opts.autoplay === false ? position : 0;
            if (opts.autoplay !== false) startSource(0);
            else emit("state", stateObj());
            return Promise.resolve(current);
        }

        stopSource();
        playing = false;
        position = 0;
        current = { path: path, name: name, buffer: null, peaks: null, duration: 0 };
        emit("state", stateObj());
        emit("decoding", { path: path, name: name });

        return load(path, name).then(function (rec) {
            if (current && current.path !== path) return rec; // superseded
            current = rec;
            if (opts.onDecoded) opts.onDecoded(rec);
            emit("decoded", rec);
            emit("state", stateObj());
            if (opts.autoplay !== false) startSource(0);
            return rec;
        }, function (err) {
            if (current && current.path === path) {
                current = { path: path, name: name, buffer: null, peaks: null, duration: 0, error: true };
                emit("error", { path: path, message: String(err && err.message || err) });
                emit("state", stateObj());
            }
            throw err;
        });
    }

    function togglePlay() {
        if (!current || !current.buffer) return;
        if (playing) pause();
        else startSource(position);
    }

    function pause() {
        if (!playing) return;
        position = currentPosition();
        playing = false;
        stopSource();
        emit("state", stateObj());
        emit("time", { time: position, duration: current ? current.duration : 0 });
    }

    function stop() {
        stopSource();
        playing = false;
        position = 0;
        emit("state", stateObj());
        emit("time", { time: 0, duration: current ? current.duration : 0 });
    }

    function seek(t) {
        if (!current) return;
        var d = current.duration;
        t = Math.max(0, Math.min(d, t));
        if (playing) startSource(t);
        else {
            position = t;
            emit("time", { time: position, duration: d });
        }
    }

    /* ---------------- waveform renderer ---------------- */

    var Waveform = {
        canvas: null,
        g: null,
        dpr: 1,
        zoom: 1,
        pan: 0,          // 0..1
        drawProgress: 0, // 0..1 intro animation

        attach: function (canvas) {
            this.canvas = canvas;
            this.g = canvas.getContext("2d");
            this.resize();
            var self = this;
            if (window.ResizeObserver) {
                new ResizeObserver(function () { self.resize(); }).observe(canvas);
            } else {
                window.addEventListener("resize", function () { self.resize(); });
            }
        },

        resize: function () {
            if (!this.canvas) return;
            this.dpr = window.devicePixelRatio || 1;
            var r = this.canvas.getBoundingClientRect();
            var w = Math.max(10, Math.round(r.width));
            var h = Math.max(10, Math.round(r.height));
            this.canvas.width = Math.round(w * this.dpr);
            this.canvas.height = Math.round(h * this.dpr);
            this.draw();
        },

        setZoom: function (z) {
            this.zoom = Math.max(1, Math.min(64, z));
            if (this.zoom === 1) this.pan = 0;
            this.draw();
            emit("zoom", this.zoom);
        },

        setPan: function (p) {
            this.pan = Math.max(0, Math.min(1, p));
            this.draw();
        },

        /** map a click x (css px) → time in seconds */
        xToTime: function (x) {
            if (!current || !current.duration) return 0;
            var w = this.canvas.getBoundingClientRect().width;
            var vis = 1 / this.zoom;
            var start = this.pan * (1 - vis);
            var frac = start + (x / w) * vis;
            return Math.max(0, Math.min(1, frac)) * current.duration;
        },

        /** time → css x, or null when outside viewport */
        timeToX: function (t) {
            if (!current || !current.duration) return null;
            var w = this.canvas.getBoundingClientRect().width;
            var frac = t / current.duration;
            var vis = 1 / this.zoom;
            var start = this.pan * (1 - vis);
            var local = (frac - start) / vis;
            if (local < -0.02 || local > 1.02) return null;
            return local * w;
        },

        draw: function () {
            var g = this.g;
            if (!g || !this.canvas) return;
            var W = this.canvas.width;
            var H = this.canvas.height;
            var dpr = this.dpr;
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, W, H);

            // background subtle grid
            var styles = getComputedStyle(document.documentElement);
            var gridColor = styles.getPropertyValue("--wf-grid").trim() || "rgba(255,255,255,.05)";
            g.strokeStyle = gridColor;
            g.lineWidth = 1;
            var mid = H / 2;
            g.beginPath();
            g.moveTo(0, mid); g.lineTo(W, mid);
            g.stroke();

            if (!current || !current.peaks) {
                // idle / decoding shimmer placeholder
                var idle = styles.getPropertyValue("--wf-idle").trim() || "rgba(255,255,255,.10)";
                g.fillStyle = idle;
                var bw = 3 * dpr, gap = 5 * dpr, n = Math.floor(W / (bw + gap));
                for (var i = 0; i < n; i++) {
                    var hh = (H * 0.18) + (Math.sin(i * 0.7) * 0.5 + 0.5) * H * 0.14;
                    var xx = i * (bw + gap) + gap;
                    g.fillRect(xx, mid - hh, bw, hh * 2);
                }
                return;
            }

            var peaks = current.peaks;
            var B = peaks.buckets;
            var vis = 1 / this.zoom;
            var startB = this.pan * (1 - vis) * B;
            var endB = startB + vis * B;

            var pos = currentPosition();
            var posFrac = current.duration ? pos / current.duration : 0;

            var accent = styles.getPropertyValue("--accent").trim() || "#066ce7";
            var accentSoft = styles.getPropertyValue("--wf-unplayed").trim() || "rgba(6,108,231,.45)";

            var grad = g.createLinearGradient(0, 0, 0, H);
            grad.addColorStop(0, accent);
            grad.addColorStop(1, shade(accent, -0.25));

            var playedGrad = g.createLinearGradient(0, 0, 0, H);
            playedGrad.addColorStop(0, "#57b0ff");
            playedGrad.addColorStop(1, accent);

            var barW = Math.max(dpr, 2 * dpr);
            var n = Math.ceil(W / barW);
            var prog = this.drawProgress;
            var visH = H * 0.86;
            var center = mid;

            for (var c = 0; c < n; c++) {
                var fx = c / n;
                if (fx > prog) break;
                // bucket range covered by this column
                var range0 = Math.floor(startB + fx * (endB - startB));
                var range1 = Math.ceil(startB + (fx + 1 / n) * (endB - startB));
                if (range1 <= range0) range1 = range0 + 1;
                range0 = Math.max(0, Math.min(B - 1, range0));
                range1 = Math.max(range0 + 1, Math.min(B, range1));

                var mn = 1, mx = -1;
                var stepB = Math.max(1, Math.floor((range1 - range0) / 8));
                for (var b = range0; b < range1; b += stepB) {
                    if (peaks.mins[b] < mn) mn = peaks.mins[b];
                    if (peaks.maxs[b] > mx) mx = peaks.maxs[b];
                }
                if (mx < mn) { mn = 0; mx = 0; }

                var x = c * barW;
                var yTop = center - mx * visH;
                var yBot = center - mn * visH;
                var hgt = Math.max(dpr, yBot - yTop);

                var centerFrac = (fx + 0.5 / n);
                if (centerFrac <= posFrac) g.fillStyle = playedGrad;
                else g.fillStyle = accentSoft;

                g.fillRect(x, yTop, barW - dpr, hgt);
            }

            // playhead
            var phX = posFrac;
            if (phX >= 0 && phX <= 1) {
                var px = phX * W;
                g.strokeStyle = "rgba(255,255,255,.92)";
                g.lineWidth = Math.max(1, dpr);
                g.beginPath();
                g.moveTo(px, 0); g.lineTo(px, H);
                g.stroke();
                g.fillStyle = "rgba(255,255,255,.92)";
                g.beginPath();
                g.moveTo(px - 4 * dpr, 0);
                g.lineTo(px + 4 * dpr, 0);
                g.lineTo(px, 6 * dpr);
                g.closePath();
                g.fill();
            }
        }
    };

    /** lighten/darken a hex colour by amt (-1..1) */
    function shade(hex, amt) {
        hex = hex.replace("#", "");
        if (hex.length === 3) hex = hex.replace(/(.)/g, "$1$1");
        var num = parseInt(hex, 16);
        var r = (num >> 16) & 255, gg = (num >> 8) & 255, b = num & 255;
        r = Math.round(Math.max(0, Math.min(255, r + 255 * amt)));
        gg = Math.round(Math.max(0, Math.min(255, gg + 255 * amt)));
        b = Math.round(Math.max(0, Math.min(255, b + 255 * amt)));
        return "rgb(" + r + "," + gg + "," + b + ")";
    }

    /* ---------------- intro draw animation ---------------- */

    function animateDrawIn() {
        Waveform.drawProgress = 0;
        var t0 = performance.now();
        function step(now) {
            var p = Math.min(1, (now - t0) / 420);
            // ease-out cubic
            Waveform.drawProgress = 1 - Math.pow(1 - p, 3);
            Waveform.draw();
            if (p < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    /* ---------------- public ---------------- */

    return {
        on: on,
        ensureCtx: ensureCtx,
        load: load,
        select: select,
        togglePlay: togglePlay,
        pause: pause,
        stop: stop,
        seek: seek,
        setVolume: setVolume,
        setSpeed: setSpeed,
        setLoop: setLoop,
        getSettings: function () { return settings; },
        state: stateObj,
        currentPosition: currentPosition,
        isPlaying: function () { return playing; },
        current: function () { return current; },
        quickDuration: quickDuration,
        Waveform: Waveform,
        animateDrawIn: animateDrawIn,
        invalidate: function (path) { delete cache[path]; delete pending[path]; }
    };
})();

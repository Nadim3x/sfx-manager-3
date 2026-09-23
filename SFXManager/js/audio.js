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

    /**
     * Native decode first, with a built-in WAV parser as fallback for codecs
     * Chromium's decodeAudioData refuses (µ-law, A-law, ADPCM, 24-bit, odd
     * containers). The ArrayBuffer is copied for the native attempt because
     * older CEP Chromium versions detach it on failure.
     */
    /** Linear resample of channel data (used when the AudioContext refuses
     *  the file's native rate — e.g. 96 kHz on older CEP Chromium builds). */
    function resampleChannels(channels, fromRate, toRate) {
        if (fromRate === toRate || !channels.length) return channels;
        var inFrames = channels[0].length;
        var outFrames = Math.max(1, Math.round(inFrames * toRate / fromRate));
        var ratio = fromRate / toRate;
        var out = [];
        for (var c = 0; c < channels.length; c++) {
            var src = channels[c];
            var dst = new Float32Array(outFrames);
            for (var i = 0; i < outFrames; i++) {
                var pos = i * ratio;
                var i0 = Math.floor(pos);
                var frac = pos - i0;
                var s0 = src[Math.min(i0, inFrames - 1)];
                var s1 = src[Math.min(i0 + 1, inFrames - 1)];
                dst[i] = s0 + (s1 - s0) * frac;
            }
            out.push(dst);
        }
        return out;
    }

    function decodeAny(ab) {
        return new Promise(function (resolve, reject) {
            decodeArray(ab.slice(0)).then(resolve, function (nativeErr) {
                var parsed = null;
                try { parsed = parseWav(ab); } catch (eParse) { parsed = null; }
                if (!parsed) {
                    var why = parseWav.lastReason;
                    if (why && why !== "not a RIFF/WAVE file") reject(new Error("WAV " + why));
                    else reject(nativeErr || new Error("Unsupported audio format"));
                    return;
                }
                var c = ensureCtx();
                if (!c) { reject(new Error("Web Audio unavailable")); return; }
                var chans = parsed.channels;
                var frames = Math.max(1, parsed.frames);
                var rate = parsed.sampleRate;
                var buf = null;
                try {
                    buf = c.createBuffer(chans.length, frames, rate);
                } catch (eRate) {
                    // Context refuses this rate (24-bit/96 kHz files on older
                    // CEP Chromium) → resample to the context rate and retry.
                    try {
                        var target = c.sampleRate || 44100;
                        chans = resampleChannels(chans, rate, target);
                        frames = Math.max(1, chans[0].length);
                        rate = target;
                        buf = c.createBuffer(chans.length, frames, rate);
                    } catch (eRetry) { buf = null; }
                }
                if (!buf) {
                    reject(new Error("Decoded " + parsed.formatName + " WAV, but " +
                        parsed.sampleRate + " Hz playback is unsupported"));
                    return;
                }
                try {
                    for (var i = 0; i < chans.length; i++) buf.getChannelData(i).set(chans[i]);
                    resolve(buf);
                } catch (eFill) {
                    reject(new Error("Decoded " + parsed.formatName + " WAV, but could not fill the buffer"));
                }
            });
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
                decodeAny(ab).then(function (buffer) {
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

    /* ---------------- built-in WAV decoder (fallback) ---------------- */

    var MS_ADAPT = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
    var IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
    var IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31,
        34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173,
        190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
        876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024,
        3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
        11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];

    /* G.711 reference decoders (Sun/libaudio algorithm), 16-bit linear out */
    function ulaw16(u) {
        u = ~u & 0xff;
        var t = ((u & 0x0f) << 3) + 0x84;
        t <<= (u & 0x70) >> 4;
        return (u & 0x80) ? (0x84 - t) : (t - 0x84);
    }

    function alaw16(a) {
        a ^= 0x55;
        var t = (a & 0x0f) << 4;
        var seg = (a & 0x70) >> 4;
        switch (seg) {
            case 0: t += 8; break;
            case 1: t += 0x108; break;
            default: t += 0x108; t <<= seg - 1; break;
        }
        return (a & 0x80) ? t : -t;
    }

    function decodePcm(data, ch, bits) {
        if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) return null;
        var bytes = bits >> 3;
        var frames = Math.floor(data.length / (bytes * ch));
        if (frames <= 0) return null;
        var dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        var out = [];
        for (var c = 0; c < ch; c++) out.push(new Float32Array(frames));
        for (var f = 0; f < frames; f++) {
            for (var c2 = 0; c2 < ch; c2++) {
                var off = (f * ch + c2) * bytes;
                var v;
                if (bits === 8) v = (data[off] - 128) / 128;
                else if (bits === 16) v = dv.getInt16(off, true) / 32768;
                else if (bits === 24) {
                    var v24 = data[off] | (data[off + 1] << 8) | (data[off + 2] << 16);
                    if (v24 & 0x800000) v24 -= 0x1000000;
                    v = v24 / 8388608;
                } else v = dv.getInt32(off, true) / 2147483648;
                out[c2][f] = v;
            }
        }
        return { channels: out, frames: frames, formatName: "PCM " + bits + "-bit" };
    }

    function decodeFloat(data, ch, bits) {
        if (bits !== 32 && bits !== 64) return null;
        var bytes = bits >> 3;
        var frames = Math.floor(data.length / (bytes * ch));
        if (frames <= 0) return null;
        var dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        var out = [];
        for (var c = 0; c < ch; c++) out.push(new Float32Array(frames));
        for (var f = 0; f < frames; f++) {
            for (var c2 = 0; c2 < ch; c2++) {
                var off = (f * ch + c2) * bytes;
                out[c2][f] = bits === 32 ? dv.getFloat32(off, true) : dv.getFloat64(off, true);
            }
        }
        return { channels: out, frames: frames, formatName: "float " + bits + "-bit" };
    }

    function decodeCompanded(data, ch, kind) {
        var frames = Math.floor(data.length / ch);
        if (frames <= 0) return null;
        var out = [];
        for (var c = 0; c < ch; c++) out.push(new Float32Array(frames));
        for (var f = 0; f < frames; f++) {
            for (var c2 = 0; c2 < ch; c2++) {
                var b = data[f * ch + c2];
                out[c2][f] = (kind === "ulaw" ? ulaw16(b) : alaw16(b)) / 32768;
            }
        }
        return { channels: out, frames: frames, formatName: kind === "ulaw" ? "\u00b5-law" : "A-law" };
    }

    function decodeMsAdpcm(data, ch, blockAlign, fmtBytes) {
        if (ch > 4 || blockAlign < 7 * ch) return null;
        var dvF = new DataView(fmtBytes.buffer, fmtBytes.byteOffset, fmtBytes.byteLength);
        var coef1 = [256, 512, 0, 192, 240, 460, 392, 1728];
        var coef2 = [0, -256, 0, 64, 0, -208, -232, -400];
        if (fmtBytes.length >= 18) {
            var cbSize = dvF.getUint16(16, true);
            var nCoef = 0, cOff = 0;
            if (18 + cbSize === fmtBytes.length && cbSize >= 4) {
                nCoef = dvF.getUint16(20, true); cOff = 22;
            } else if (fmtBytes.length >= 20) {
                nCoef = dvF.getUint16(18, true); cOff = 20;
            }
            if (nCoef > 0 && nCoef <= 8 && cOff + nCoef * 4 <= fmtBytes.length) {
                coef1 = []; coef2 = [];
                for (var k = 0; k < nCoef; k++) {
                    coef1.push(dvF.getInt16(cOff + k * 4, true));
                    coef2.push(dvF.getInt16(cOff + k * 4 + 2, true));
                }
            }
        }
        var blocks = Math.floor(data.length / blockAlign);
        if (blocks <= 0) return null;
        var samplesPerBlock = Math.floor((blockAlign - 7 * ch) * 2 / ch) + 2;
        var frames = blocks * samplesPerBlock;
        var out = [];
        for (var c = 0; c < ch; c++) out.push(new Float32Array(frames));
        var dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        var fo = 0;
        for (var b = 0; b < blocks; b++) {
            var o = b * blockAlign;
            var preds = [], deltas = [], s1 = [], s2 = [], c1;
            for (c1 = 0; c1 < ch; c1++) {
                var pn = data[o++];
                preds.push(pn < coef1.length ? pn : 0);
            }
            for (c1 = 0; c1 < ch; c1++) { deltas.push(dv.getInt16(o, true)); o += 2; }
            for (c1 = 0; c1 < ch; c1++) { s1.push(dv.getInt16(o, true)); o += 2; }
            for (c1 = 0; c1 < ch; c1++) { s2.push(dv.getInt16(o, true)); o += 2; }
            for (c1 = 0; c1 < ch; c1++) out[c1][fo] = s2[c1] / 32768;
            for (c1 = 0; c1 < ch; c1++) out[c1][fo + 1] = s1[c1] / 32768;
            var idx = 0;
            var blockEnd = b * blockAlign + blockAlign;
            while (o < blockEnd) {
                var byteV = data[o++];
                for (var half = 0; half < 2; half++) {
                    var nib = half === 0 ? (byteV >> 4) : (byteV & 0x0f);
                    var frPos = 2 + Math.floor(idx / ch);
                    if (frPos >= samplesPerBlock) break;
                    var cch = idx % ch;
                    var predict = (s1[cch] * coef1[preds[cch]] + s2[cch] * coef2[preds[cch]]) >> 8;
                    var dn = nib < 8 ? nib : nib - 16;
                    var sample = predict + dn * deltas[cch];
                    if (sample > 32767) sample = 32767;
                    else if (sample < -32768) sample = -32768;
                    s2[cch] = s1[cch];
                    s1[cch] = sample;
                    deltas[cch] = (MS_ADAPT[nib] * deltas[cch]) >> 8;
                    if (deltas[cch] < 16) deltas[cch] = 16;
                    out[cch][fo + frPos] = sample / 32768;
                    idx++;
                }
                if (2 + Math.floor(idx / ch) >= samplesPerBlock) break;
            }
            fo += samplesPerBlock;
        }
        return { channels: out, frames: frames, formatName: "MS-ADPCM" };
    }

    function decodeImaAdpcm(data, ch, blockAlign) {
        if (ch > 4 || blockAlign < 4 * ch) return null;
        var blocks = Math.floor(data.length / blockAlign);
        if (blocks <= 0) return null;
        var perChBytes = Math.floor((blockAlign - 4 * ch) / ch);
        var samplesPerBlock = perChBytes * 2 + 1;
        var frames = blocks * samplesPerBlock;
        var out = [];
        for (var c = 0; c < ch; c++) out.push(new Float32Array(frames));
        var dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        var fo = 0;
        for (var b = 0; b < blocks; b++) {
            var o = b * blockAlign;
            var samples = [], idxs = [], c1;
            for (c1 = 0; c1 < ch; c1++) {
                // header per channel: initial sample (i16) + step index (u8) + pad (u8)
                samples.push(dv.getInt16(o, true)); o += 2;
                var ix = data[o++];
                o++;
                if (ix > 88) ix = 88;
                if (ix < 0) ix = 0;
                idxs.push(ix);
            }
            for (c1 = 0; c1 < ch; c1++) out[c1][fo] = samples[c1] / 32768;
            var p = 0;
            var blockEnd = (b + 1) * blockAlign;
            while (o < blockEnd) {
                var byteV = data[o++];
                for (var half = 0; half < 2; half++) {
                    var nib = half === 0 ? (byteV & 0x0f) : (byteV >> 4);
                    if (p >= (samplesPerBlock - 1) * ch) break;
                    var cch = p % ch;
                    var fr = 1 + Math.floor(p / ch);
                    p++;
                    var step = IMA_STEP[idxs[cch]];
                    var diff = step >> 3;
                    if (nib & 1) diff += step >> 2;
                    if (nib & 2) diff += step >> 1;
                    if (nib & 4) diff += step;
                    var prev = samples[cch];
                    if (nib & 8) prev -= diff; else prev += diff;
                    if (prev > 32767) prev = 32767;
                    else if (prev < -32768) prev = -32768;
                    samples[cch] = prev;
                    idxs[cch] += IMA_INDEX[nib];
                    if (idxs[cch] < 0) idxs[cch] = 0;
                    else if (idxs[cch] > 88) idxs[cch] = 88;
                    out[cch][fr] = prev / 32768;
                }
                if (p >= (samplesPerBlock - 1) * ch) break;
            }
            fo += samplesPerBlock;
        }
        return { channels: out, frames: frames, formatName: "IMA-ADPCM" };
    }

    /**
     * Parse a RIFF/WAVE file into { channels:[Float32Array], frames, sampleRate,
     * formatName }. Returns null when the buffer is not a decodable WAV.
     * Covers codecs Chromium refuses: PCM 8/16/24/32, IEEE float 32/64,
     * µ-law, A-law, WAVE_FORMAT_EXTENSIBLE, MS-ADPCM and IMA-ADPCM.
     * Tolerates broken/streaming headers: data-size 0 or 0xFFFFFFFF, RF64,
     * data chunk before fmt, junk prefixes, truncated chunks.
     * On failure, parseWav.lastReason explains why (for the error toast).
     */
    function parseWav(ab) {
        parseWav.lastReason = "";
        try {
            if (!ab || ab.byteLength < 44) { parseWav.lastReason = "file too small"; return null; }
            var u8 = new Uint8Array(ab);
            var dv = new DataView(ab);

            // locate RIFF or RF64 (some files carry junk/ID3 prefixes)
            var riff = -1;
            var isRf64 = false;
            var scanMax = Math.min(u8.length - 12, 1024);
            for (var st = 0; st <= scanMax; st++) {
                if (u8[st] === 0x52) {
                    if (u8[st + 1] === 0x49 && u8[st + 2] === 0x46 && u8[st + 3] === 0x46) {
                        riff = st; isRf64 = false; break;               // RIFF
                    }
                    if (u8[st + 1] === 0x46 && u8[st + 2] === 0x36 && u8[st + 3] === 0x34) {
                        riff = st; isRf64 = true; break;                // RF64
                    }
                }
            }
            if (riff < 0) { parseWav.lastReason = "not a RIFF/WAVE file"; return null; }
            if (u8[riff + 8] !== 0x57 || u8[riff + 9] !== 0x41 ||
                u8[riff + 10] !== 0x56 || u8[riff + 11] !== 0x45) {
                parseWav.lastReason = "not a WAVE container";
                return null;
            }

            var pos = riff + 12;
            var fmt = null;
            var dataOff = -1;
            var dataSize = 0;
            var ds64Off = -1;
            var end = u8.length;
            while (pos + 8 <= end) {
                var id = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
                var sz = dv.getUint32(pos + 4, true);
                var body = pos + 8;
                if (body >= end) break;
                if (id === "fmt " && !fmt) {
                    fmt = { off: body, len: Math.min(sz, end - body) };
                } else if (id === "ds64") {
                    ds64Off = body;
                } else if (id === "data" && dataOff < 0) {
                    dataOff = body;
                    dataSize = sz;
                    // keep scanning when fmt hasn't been seen yet
                    if (fmt) break;
                }
                if (sz <= 0 || sz === 0xffffffff) {
                    // streaming / untrustworthy size — cannot advance further
                    if (fmt && dataOff >= 0) break;
                    if (sz === 0 || sz === 0xffffffff) {
                        // skip zero-sized junk conservatively
                        if (sz === 0) { pos = body; if (pos <= body - 1) break; continue; }
                        break;
                    }
                }
                pos = body + sz + (sz % 2);
                if (fmt && dataOff >= 0) break;
            }
            if (!fmt || fmt.len < 16) {
                parseWav.lastReason = !fmt ? "missing fmt chunk" : "fmt chunk too small";
                return null;
            }
            if (dataOff < 0) { parseWav.lastReason = "missing data chunk"; return null; }

            // RF64: real sizes live in the ds64 table (riffSize64, dataSize64, …)
            if (isRf64 && (dataSize === 0 || dataSize === 0xffffffff) && ds64Off >= 0 && ds64Off + 16 <= end) {
                var lo = dv.getUint32(ds64Off + 8, true);
                var hi = dv.getUint32(ds64Off + 12, true);
                dataSize = hi ? hi * 4294967296 + lo : lo;
            }
            // streaming WAVs write size 0 / -1 → use every remaining byte
            if (dataSize <= 0 || dataOff + dataSize > end) dataSize = end - dataOff;
            if (dataSize <= 0) { parseWav.lastReason = "empty data chunk"; return null; }

            var tag = dv.getUint16(fmt.off, true);
            var channels = dv.getUint16(fmt.off + 2, true);
            var sampleRate = dv.getUint32(fmt.off + 4, true);
            var blockAlign = dv.getUint16(fmt.off + 12, true) || 1;
            var bits = dv.getUint16(fmt.off + 14, true);
            if (tag === 0xfffe) {
                // WAVE_FORMAT_EXTENSIBLE — real tag lives in the SubFormat GUID
                if (fmt.len < 26) { parseWav.lastReason = "truncated EXTENSIBLE fmt"; return null; }
                tag = dv.getUint16(fmt.off + 24, true);
            }
            if (!channels || channels > 32) { parseWav.lastReason = "bad channel count"; return null; }
            if (!sampleRate) sampleRate = 44100; // streaming headers sometimes omit it

            var data = u8.subarray(dataOff, dataOff + dataSize);
            var fmtBytes = u8.subarray(fmt.off, fmt.off + fmt.len);
            var out = null;
            if (tag === 1) out = decodePcm(data, channels, bits);
            else if (tag === 3) out = decodeFloat(data, channels, bits);
            else if (tag === 6) out = decodeCompanded(data, channels, "ulaw");
            else if (tag === 7) out = decodeCompanded(data, channels, "alaw");
            else if (tag === 2) out = decodeMsAdpcm(data, channels, blockAlign, fmtBytes);
            else if (tag === 17) out = decodeImaAdpcm(data, channels, blockAlign);
            if (!out) {
                parseWav.lastReason = "unsupported codec (format tag " + tag + ", " + bits + "-bit)";
                return null;
            }
            out.sampleRate = sampleRate;
            return out;
        } catch (e) {
            parseWav.lastReason = "parse error: " + (e && e.message ? e.message : e);
            return null;
        }
    }
    parseWav.lastReason = "";

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

    /**
     * playLocalFile(path, name) — full Web Audio pipeline in one call:
     *   1) initialise (or reuse) the AudioContext          → ensureCtx()
     *   2) fetch the local file as an ArrayBuffer          → Bridge.readFileBuffer
     *   3) decode natively with decodeAudioData            → decodeAny()
     *      (on codec failure — e.g. 24-bit/96 kHz PCM on older Chromium —
     *       the built-in WAV parser takes over, resampling if required)
     *   4) route source → masterGain → destination and play → startSource()
     * No HTML5 <audio> element is involved anywhere in this panel.
     */
    function playLocalFile(path, name) {
        return select(path, name, { autoplay: true });
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
            var accentSoft = styles.getPropertyValue("--wf-unplayed").trim() || "rgba(var(--accent-rgb), .45)";

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
        playLocalFile: playLocalFile,
        resampleChannels: resampleChannels,
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
        parseWav: parseWav,
        Waveform: Waveform,
        animateDrawIn: animateDrawIn,
        invalidate: function (path) { delete cache[path]; delete pending[path]; }
    };
})();

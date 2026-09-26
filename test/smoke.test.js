/*
 * smoke.test.js — headless integration test of the SFX Manager panel UI.
 * Runs the real panel scripts inside jsdom with mocked CEP/AE/audio APIs
 * and drives it like a user would.
 *
 *   node test/smoke.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "SFXManager");

/* ---------------- tiny assertion helpers ---------------- */
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; failures.push(name + (extra ? "  →  " + extra : "")); console.log("  ✗ " + name + (extra ? "  →  " + extra : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- build the page ---------------- */
async function main() {
  const html = fs.readFileSync(path.join(EXT, "index.html"), "utf8");

  const virtualConsole = new VirtualConsole();
  const jsdomErrors = [];
  virtualConsole.on("jsdomError", (e) => {
    // CSS parse complaints are irrelevant for the logic test
    if (String(e.message || e).includes("Could not parse CSS")) return;
    jsdomErrors.push(String(e.message || e));
  });

  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole
  });
  const { window } = dom;
  const { document } = window;

  /* ---------------- polyfills ---------------- */

  window.Element.prototype.scrollIntoView = function () {};

  // canvas 2D recorder
  const ctxCalls = { fillRect: 0, drawCalls: 0 };
  function makeCtx() {
    const grad = { addColorStop() {} };
    return {
      canvas: null,
      fillStyle: "", strokeStyle: "", lineWidth: 1,
      setTransform() {}, clearRect() { ctxCalls.drawCalls++; },
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, closePath() {},
      fillRect() { ctxCalls.fillRect++; },
      createLinearGradient() { return grad; }
    };
  }
  window.HTMLCanvasElement.prototype.getContext = function () { return makeCtx(); };

  // fake Web Audio: decodes the mock WAVs, advancing clock
  const t0 = Date.now();
  const bufferCache = new Map();
  function fakeBuffer(ab) {
    const view = new DataView(ab);
    const rate = view.getUint32(28, true) || 44100;
    const dataSize = view.getUint32(40, true);
    const duration = dataSize / rate;
    const key = ab.byteLength + ":" + dataSize;
    if (bufferCache.has(key)) return bufferCache.get(key);
    const length = Math.round(duration * rate);
    let chData = null;
    const buf = {
      duration, length, numberOfChannels: 1, sampleRate: rate,
      getChannelData() {
        if (!chData) {
          chData = new Float32Array(length);
          for (let i = 0; i < length; i++) chData[i] = Math.sin(i / 30) * 0.4;
        }
        return chData;
      }
    };
    bufferCache.set(key, buf);
    return buf;
  }
  window.AudioContext = class {
    constructor() {
      this.state = "running";
      this.sampleRate = 44100;
      this.destination = {};
    }
    get currentTime() { return (Date.now() - t0) / 1000; }
    resume() { return Promise.resolve(); }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createBufferSource() {
      const src = {
        buffer: null, loop: false, onended: null,
        playbackRate: { value: 1 },
        connect() {}, disconnect() {},
        start() {}, stop() {}
      };
      return src;
    }
    createBuffer(ch, len, rate) {
      // mirror Chromium behaviour: refuse rates outside the context's range
      // when the test sets __forceHiRateReject (e.g. 96 kHz on old CEP)
      if (window.__forceHiRateReject && rate !== this.sampleRate) {
        throw new Error("NotSupportedError: sampleRate " + rate);
      }
      const chans = [];
      for (let i = 0; i < ch; i++) chans.push(new Float32Array(len));
      return {
        duration: len / rate, length: len, numberOfChannels: ch, sampleRate: rate,
        getChannelData: (i) => chans[i]
      };
    }
    decodeAudioData(ab, ok, err) {
      if (window.__forceNativeFail) {
        const e = new Error("EncodingError: codec error (simulated)");
        if (err) err(e);
        const rejected = Promise.reject(e);
        rejected.catch(() => {});
        return rejected;
      }
      const buf = fakeBuffer(ab);
      if (ok) ok(buf);
      return Promise.resolve(buf);
    }
  };

  /* ---------------- load the real panel scripts ---------------- */
  const files = ["js/mock.js", "js/bridge.js", "js/store.js", "js/audio.js", "js/app.js"];
  for (const f of files) {
    const code = fs.readFileSync(path.join(EXT, f), "utf8");
    try { window.eval(code + "\n//# sourceURL=" + f); }
    catch (e) { console.error("FATAL loading " + f + ": " + e); process.exit(1); }
  }

  const $ = (id) => document.getElementById(id);
  const rows = () => Array.from(document.querySelectorAll(".sound-row"));
  const key = (k, opts = {}) =>
    document.dispatchEvent(new window.KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, cancelable: true }, opts)));
  const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));

  /* ================= initial load ================= */
  console.log("\n── init & library load ──");
  await sleep(700);

  check("mock root applied", window.localStorage.getItem("sfxm.v1") && JSON.parse(window.localStorage.getItem("sfxm.v1")).root === "/SFX Library");
  check("tree rendered with root node", document.querySelectorAll("#tree .tree-node").length >= 1);
  await sleep(400); // root expansion
  check("tree expanded children", document.querySelectorAll("#tree .tree-children .tree-node").length >= 5,
    "got " + document.querySelectorAll("#tree .tree-children .tree-node").length);

  check("sound list has rows", rows().length > 15, "rows=" + rows().length);
  check("list count matches", $("listCount").textContent === String(rows().length),
    $("listCount").textContent + " vs " + rows().length);
  check("all count populated", $("cntAll").textContent !== "", "cnt=" + $("cntAll").textContent);
  check("initial view is All Sounds", $("listTitle").textContent === "All Sounds",
    $("listTitle").textContent);

  // durations from WAV headers
  const durCells = rows().slice(0, 6).map((r) => r.querySelector(".row-dur").textContent);
  await sleep(500);
  const durCells2 = rows().slice(0, 6).map((r) => r.querySelector(".row-dur").textContent);
  check("quick WAV durations parsed", durCells2.some((d) => d !== "—"),
    JSON.stringify(durCells2));

  /* ================= selection + autoplay ================= */
  console.log("\n── selection & auto-preview ──");
  const first = rows()[0];
  const firstPath = first.dataset.path;
  click(first);
  await sleep(400);

  check("row selected", first.classList.contains("selected"));
  check("now-playing name set", $("npName").textContent.includes(
    firstPath.split("/").pop().replace(/\.[^.]+$/, "")), $("npName").textContent);
  check("decoding badge cleared (decoded)", $("npDecode").classList.contains("hidden"));
  check("duration shown in player", $("npDur").textContent !== "0:00.00", $("npDur").textContent);
  check("waveform activated", $("waveform").parentNode.classList.contains("active"));
  check("waveform bars drawn", ctxCalls.fillRect > 0, "fillRect=" + ctxCalls.fillRect);
  check("playhead chip ticking", /\d\d:\d\d:\d\d:\d\d/.test($("playheadChip").textContent), $("playheadChip").textContent);
  check("status bar shows playhead", $("aeState").textContent.indexOf("Playhead") === 0, $("aeState").textContent);

  // auto-play: play button should be in .playing state (autoplay on select)
  await sleep(150);
  check("auto-preview started on select", $("btnPlay").classList.contains("playing"));
  check("row shows playing state", rows()[0].classList.contains("playing"));

  // time advances
  await sleep(700);
  const t1 = $("npTime").textContent;
  check("preview time advances", t1 !== "0:00.00", "t=" + t1);

  /* ================= transport controls ================= */
  console.log("\n── transport ──");
  key(" ");
  await sleep(100);
  check("space pauses", !$("btnPlay").classList.contains("playing"));
  key(" ");
  await sleep(100);
  check("space resumes", $("btnPlay").classList.contains("playing"));

  click($("btnLoop"));
  check("loop toggles on", $("btnLoop").classList.contains("on"));
  check("loop setting stored", JSON.parse(window.localStorage.getItem("sfxm.v1")).loop === true);
  click($("btnLoop"));

  click($("btnZoomIn"));
  check("zoom in → 2×", $("zoomLabel").textContent === "2×", $("zoomLabel").textContent);
  click($("btnZoomOut"));
  check("zoom out → 1×", $("zoomLabel").textContent === "1×", $("zoomLabel").textContent);

  const vol = $("volSlider");
  vol.value = "40";
  vol.dispatchEvent(new window.Event("input", { bubbles: true }));
  check("volume stored", JSON.parse(window.localStorage.getItem("sfxm.v1")).volume === 0.4);

  const spd = $("speedSlider");
  spd.value = "150";
  spd.dispatchEvent(new window.Event("input", { bubbles: true }));
  check("speed label updates", $("speedLabel").textContent.indexOf("1.5") === 0, $("speedLabel").textContent);
  spd.value = "100";
  spd.dispatchEvent(new window.Event("input", { bubbles: true }));

  key("Escape");
  await sleep(80);
  check("esc stops preview", !$("btnPlay").classList.contains("playing"));

  /* ================= keyboard navigation ================= */
  console.log("\n── keyboard ──");
  key("ArrowDown");
  await sleep(400);
  const sel2 = document.querySelector(".sound-row.selected");
  check("arrow key moves selection", sel2 && sel2.dataset.path !== firstPath,
    sel2 && sel2.dataset.path);
  check("arrow key auto-previews", $("btnPlay").classList.contains("playing"));

  key("f");
  await sleep(150);
  check("F marks favourite", JSON.parse(window.localStorage.getItem("sfxm.v1")).favorites[sel2.dataset.path] != null);
  check("fav count = 1", $("cntFav").textContent === "1", $("cntFav").textContent);

  key("1");
  await sleep(150);
  check("key 1 applies colour tag", JSON.parse(window.localStorage.getItem("sfxm.v1")).tags[sel2.dataset.path] === 1);
  const tagBtn = document.querySelector(".sound-row.selected .row-tag");
  check("tag dot visible on row", tagBtn && tagBtn.classList.contains("has"));

  /* ================= add at playhead ================= */
  check("primary button label is just Add", !/Add at Playhead/.test($("btnAdd").textContent),
    JSON.stringify($("btnAdd").textContent));
  console.log("\n── add at playhead ──");
  check("add button enabled after selection", !$("btnAdd").disabled);

  check("btnAdd label is Add only",
    $("btnAdd").querySelector(".pb-label").textContent.trim() === "Add to timeline" &&
    !/Add at Playhead/.test($("btnAdd").textContent),
    JSON.stringify($("btnAdd").querySelector(".pb-label").textContent));
  const addCalls = [];
  const realEvalAdd = window.Bridge.evalHost;
  window.Bridge.evalHost = function (fn, args, cb) { addCalls.push({ fn: fn, args: args }); return realEvalAdd(fn, args, cb); };
  click($("btnAdd"));
  window.Bridge.evalHost = realEvalAdd;
  await sleep(300);
  check("add passes absolute path + preview volume to host",
    addCalls.some((c) => c.fn === "sfxm_addAtPlayhead" &&
      /^([A-Za-z]:[\\\/]|\/)/.test(String(c.args[0])) &&
      typeof c.args[1] === "number" && c.args[1] >= 0 && c.args[1] <= 200),
    JSON.stringify(addCalls.map((c) => ({ fn: c.fn, args: c.args }))));
  const toasts = () => Array.from($("toastHost").children).map((t) => t.textContent);
  check("add shows success toast", toasts().some((t) => /Added/.test(t)), JSON.stringify(toasts()));
  // recent = the 2 previewed sounds (add dedupes, doesn't grow)
  check("recent count = 2 after previews+add", $("cntRecent").textContent === "2", $("cntRecent").textContent);

  key("Enter");
  await sleep(300);
  check("Enter adds again without duplicating recent", $("cntRecent").textContent === "2", $("cntRecent").textContent);

  /* ================= tag filter & virtual views ================= */
  console.log("\n── views, filters, favourites ──");
  const chip1 = document.querySelector('#tagFilter .chip[data-tag="1"]');
  click(chip1);
  await sleep(120);
  check("tag filter narrows list", rows().length >= 1 && rows().every((r) =>
    r.querySelector(".row-tag.has")), "rows=" + rows().length);
  click(document.querySelector('#tagFilter .chip[data-tag="0"]'));
  await sleep(80);
  const allRows = rows().length;
  check("filter cleared", allRows > 1, "rows=" + allRows);

  click(document.querySelector('.nav-item[data-view="favorites"]'));
  await sleep(150);
  check("favorites view shows 1 star", rows().length === 1, "rows=" + rows().length);
  check("favorites header", $("listTitle").textContent === "Favorites");

  click(document.querySelector('.nav-item[data-view="recent"]'));
  await sleep(150);
  check("recent view shows previewed sounds", rows().length === 2, "rows=" + rows().length);

  click(document.querySelector('.nav-item[data-view="all"]'));
  await sleep(500);
  check("back to all sounds", rows().length > 15, "rows=" + rows().length);

  /* ================= folder tree navigation ================= */
  console.log("\n── folder tree ──");
  const childNode = document.querySelector("#tree .tree-children .tree-node");
  check("a child folder exists", !!childNode);
  const childLabel = childNode.querySelector(".tree-label").textContent;
  // clientX past the disclosure zone → selects the folder (like a real click)
  childNode.querySelector(".tree-row").dispatchEvent(
    new window.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 150, clientY: 20 }));
  await sleep(400);
  check("folder view header = folder name", $("listTitle").textContent === childLabel,
    $("listTitle").textContent + " vs " + childLabel);
  const folderPaths = rows().map((r) => r.dataset.path);
  check("folder list files live under that folder",
    folderPaths.length > 0 && folderPaths.every((p) => p.indexOf(childLabel + "/") >= 0),
    JSON.stringify(folderPaths.slice(0, 2)));
  check("folder row marked selected in tree",
    childNode.querySelector(".tree-row").classList.contains("selected"));

  /* ================= search ================= */
  console.log("\n── search ──");
  const si = $("searchInput");
  si.value = "riser";
  si.dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(800);
  check("search finds risers", rows().length >= 3, "rows=" + rows().length);
  check("search results match query", rows().every((r) =>
    (r.dataset.path).toLowerCase().indexOf("riser") >= 0),
    JSON.stringify(rows().slice(0, 3).map((r) => r.dataset.path)));
  check("search header", /"riser"/.test($("listTitle").textContent), $("listTitle").textContent);

  si.value = "zzzznotfound";
  si.dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(700);
  check("empty search state", rows().length === 0 && !$("listEmpty").classList.contains("hidden"));

  si.value = "";
  si.dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(900);
  check("cleared search restores folder", rows().length > 0, "rows=" + rows().length);

  /* ================= context menu ================= */
  console.log("\n── context menu ──");
  const r0 = rows()[0];
  r0.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await sleep(80);
  check("context menu opens", !$("ctxMenu").classList.contains("hidden"));
  check("context menu has add item", $("ctxMenu").querySelector('[data-act="add"]'));
  check("context menu has swatches", $("ctxMenu").querySelectorAll(".ctx-swatch").length === 7);
  const sw = $("ctxMenu").querySelector('.ctx-swatch[data-tag="3"]');
  click(sw);
  await sleep(150);
  check("swatch applies tag", JSON.parse(window.localStorage.getItem("sfxm.v1")).tags[r0.dataset.path] === 3);
  check("context menu closes after choice", $("ctxMenu").classList.contains("hidden"));

  // Reveal in Folder must target the FILE (selected in Finder / Explorer)
  r0.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await sleep(80);
  let revealedPath = null;
  const origReveal = window.Bridge.revealPath;
  window.Bridge.revealPath = function (x) { revealedPath = x; };
  click($("ctxMenu").querySelector('[data-act="reveal"]'));
  window.Bridge.revealPath = origReveal;
  check("reveal in folder fires with the file path", revealedPath === r0.dataset.path,
    JSON.stringify(revealedPath));
  check("reveal path is absolute", /^([A-Za-z]:[\\\/]|\/)/.test(String(revealedPath)),
    JSON.stringify(revealedPath));
  check("context menu closes after reveal", $("ctxMenu").classList.contains("hidden"));

  // audio-only listing — .txt and friends never reach All Sounds / search / counts
  const walked = await new Promise((resolve) => {
    window.Bridge.walkAudio("/SFX Library", 500, (err, files) => resolve(files || []));
  });
  check("walkAudio returns audio only", walked.length > 0 &&
    walked.every((f) => window.Bridge.isAudioFile(f.name)),
    "n=" + walked.length + " " + JSON.stringify(walked.map((f) => f.name)));
  check("txt file excluded from library", !walked.some((f) => /\.txt$/i.test(f.name)));

  /* ================= settings, about, theme ================= */
  console.log("\n── settings, about, theme ──");
  check("settings button replaces about", !!$("btnSettings") && !$("btnAbout"));
  check("search sits in the header", !!$("searchBox") && !!$("searchInput") &&
    $("topbar").contains($("searchBox")));
  click($("btnSettings"));
  check("settings modal opens", !$("settingsOverlay").classList.contains("hidden"));
  check("settings shows the name", $("settingsAbout").textContent.indexOf("Anamoul Houqe Nadim") >= 0);
  check("settings shows v1.1.3 badge (verify install)", $("settingsAbout").textContent.indexOf("v1.1.3") >= 0,
    $("settingsAbout").textContent);
  const igBtn = $("btnInstagram");
  const igLabel = igBtn ? igBtn.textContent.replace(/\s+/g, " ").trim() : "";
  check("instagram button: label only, no URL",
    igLabel === "Instagram" && igLabel.indexOf("instagram.com") < 0 && igLabel.indexOf("http") < 0,
    JSON.stringify(igLabel));
  const openedUrls = [];
  const origOpen = window.open;
  window.open = function (u) { openedUrls.push(String(u)); return null; };
  click(igBtn);
  window.open = origOpen;
  check("instagram click opens default browser",
    openedUrls.length === 1 && openedUrls[0].indexOf("instagram.com/nadim.3x") >= 0,
    JSON.stringify(openedUrls));
  check("instagram shows opening toast", toasts().some((t) => /Opening Instagram/.test(t)),
    JSON.stringify(toasts()));
  // The click listener must call window.cep.util.openURLInDefaultBrowser with
  // the exact profile URL whenever the CEP runtime provides it (user spec).
  const cepUrls = [];
  window.cep = { util: { openURLInDefaultBrowser: (u) => { cepUrls.push(String(u)); } } };
  const opensBeforeCep = openedUrls.length;
  click($("btnInstagram"));
  check("button calls window.cep.util.openURLInDefaultBrowser",
    cepUrls.length === 1 && cepUrls[0] === "https://www.instagram.com/nadim.3x/",
    JSON.stringify(cepUrls));
  check("cep.util path skips window.open", openedUrls.length === opensBeforeCep,
    JSON.stringify(openedUrls));
  delete window.cep;

  // custom accent selector
  click(document.querySelector('.accent-swatch[data-accent="#30d158"]'));
  check("accent applied live", document.documentElement.getAttribute("data-accent") === "#30d158");
  check("accent css vars set",
    document.documentElement.style.getPropertyValue("--accent") === "#30d158" &&
    /48,\s*209,\s*88/.test(document.documentElement.style.getPropertyValue("--accent-rgb") || "48, 209, 88"),
    document.documentElement.style.getPropertyValue("--accent-rgb"));
  check("accent persisted",
    JSON.parse(window.localStorage.getItem("sfxm.v1")).accent === "#30d158");
  const ci = $("accentCustom");
  ci.value = "#bf5af2";
  ci.dispatchEvent(new window.Event("input", { bubbles: true }));
  check("custom colour picker works", document.documentElement.getAttribute("data-accent") === "#bf5af2",
    document.documentElement.getAttribute("data-accent"));
  click(document.querySelector('.accent-swatch[data-accent="#066ce7"]'));

  // redesigned flat settings panel — ACCENT COLOR + BACKGROUND COLOR + Apply
  console.log("\n── settings colors ──");
  const btnLabel = $("accentRow").closest(".set-section").querySelector(".set-label").textContent;
  check("accent row labelled ACCENT COLOR", btnLabel === "ACCENT COLOR", JSON.stringify(btnLabel));
  check("accent choices = 7 swatches + rainbow", $("accentRow").querySelectorAll(".accent-swatch").length === 7 &&
    $("accentRow").querySelectorAll(".sq-swatch.rainbow").length === 1);
  check("accent hex field raw (no #)", !!$("accentHex") && $("accentHex").value.indexOf("#") < 0,
    JSON.stringify($("accentHex") && $("accentHex").value));
  const ah = $("accentHex");
  ah.value = "zzzz";
  ah.dispatchEvent(new window.Event("change", { bubbles: true }));
  check("invalid accent hex rejected", ah.classList.contains("bad") &&
    document.documentElement.getAttribute("data-accent") === "#066ce7",
    document.documentElement.getAttribute("data-accent"));
  ah.value = "30D158";
  ah.dispatchEvent(new window.Event("change", { bubbles: true }));
  check("raw hex applies accent",
    document.documentElement.getAttribute("data-accent") === "#30d158" &&
    JSON.parse(window.localStorage.getItem("sfxm.v1")).accent === "#30d158",
    document.documentElement.getAttribute("data-accent"));
  check("accent dot follows color", !!$("accentDot"));
  click(document.querySelector('.accent-swatch[data-accent="#066ce7"]'));
  check("hex field follows swatch (raw)", ah.value === "066CE7", JSON.stringify(ah.value));

  const bgLabel = $("bgRow").closest(".set-section").querySelector(".set-label").textContent;
  check("background row labelled BACKGROUND COLOR", bgLabel === "BACKGROUND COLOR", JSON.stringify(bgLabel));
  check("background choices = 7 swatches + rainbow",
    $("bgRow").querySelectorAll(".bg-swatch").length === 7 &&
    $("bgRow").querySelectorAll(".sq-swatch.rainbow").length === 1 &&
    !!$("bgHex") && !!$("bgCustom"));
  check("background defaults to AUTO", !document.documentElement.style.getPropertyValue("--bg") &&
    JSON.parse(window.localStorage.getItem("sfxm.v1")).bgColor === "");
  click($("bgRow").querySelector('.bg-swatch[data-bg="#0b0b0d"]'));
  check("bg swatch applies hex", document.documentElement.style.getPropertyValue("--bg") === "#0b0b0d",
    document.documentElement.style.getPropertyValue("--bg"));
  check("bg colour persisted", JSON.parse(window.localStorage.getItem("sfxm.v1")).bgColor === "#0b0b0d");
  const bh = $("bgHex");
  bh.value = "123456";
  bh.dispatchEvent(new window.Event("change", { bubbles: true }));
  check("raw hex applies background", document.documentElement.style.getPropertyValue("--bg") === "#123456" &&
    !bh.classList.contains("bad"), document.documentElement.style.getPropertyValue("--bg"));
  bh.value = "nope";
  bh.dispatchEvent(new window.Event("change", { bubbles: true }));
  check("invalid bg hex rejected", bh.classList.contains("bad") &&
    document.documentElement.style.getPropertyValue("--bg") === "#123456");
  bh.value = "ECECEC";
  bh.dispatchEvent(new window.Event("change", { bubbles: true }));
  check("bright bg flips contrast tokens", document.documentElement.getAttribute("data-bg-contrast") === "light",
    document.documentElement.getAttribute("data-bg-contrast"));
  bh.value = "";
  bh.dispatchEvent(new window.Event("change", { bubbles: true }));
  check("empty bg hex = AUTO reset", !document.documentElement.style.getPropertyValue("--bg") &&
    !document.documentElement.getAttribute("data-bg-contrast") &&
    JSON.parse(window.localStorage.getItem("sfxm.v1")).bgColor === "");
  check("apply button exists", !!$("btnApplySettings") &&
    $("btnApplySettings").textContent.trim() === "Apply changes");
  click($("btnApplySettings"));
  check("apply closes settings", $("settingsOverlay").classList.contains("hidden"));
  check("apply shows confirmation", toasts().some((t) => /Settings applied/.test(t)),
    JSON.stringify(toasts()));
  check("back to default SFX blue", document.documentElement.getAttribute("data-accent") === "#066ce7");
  click($("settingsOverlay").querySelector("[data-close]"));
  check("settings modal closes", $("settingsOverlay").classList.contains("hidden"));

  key("?");
  check("? opens shortcuts", !$("helpOverlay").classList.contains("hidden"));
  key("Escape");
  check("esc closes shortcuts", $("helpOverlay").classList.contains("hidden"));

  click($("btnTheme"));
  check("theme → light", document.documentElement.getAttribute("data-theme") === "light");
  click($("btnTheme"));
  check("theme → dark", document.documentElement.getAttribute("data-theme") === "dark");

  /* ================= narrow drawer (vertical layout) ================= */
  console.log("\n── narrow drawer ──");
  check("sidebar toggle exists", !!$("btnSidebar"));
  check("drawer shade exists", !!$("drawerShade"));
  click($("btnSidebar"));
  check("drawer opens", $("sidebar").classList.contains("open") &&
    $("drawerShade").classList.contains("show"));
  click($("drawerShade"));
  check("shade click closes drawer", !$("sidebar").classList.contains("open"));
  click($("btnSidebar"));
  key("Escape");
  check("Esc closes drawer before stopping preview",
    !$("sidebar").classList.contains("open"));
  click($("btnSidebar"));
  click(document.querySelector('.nav-item[data-view="all"]'));
  check("nav selection auto-closes drawer", !$("sidebar").classList.contains("open"));
  await sleep(700); // let "All Sounds" finish loading for the next section
  check("list ready after drawer nav", rows().length > 5, "rows=" + rows().length);

  /* ================= percent-encoded names ================= */
  console.log("\n── percent-encoded names ──");
  const encRows = rows().filter((r) => r.dataset.path.indexOf("%20") >= 0);
  check("encoded filenames present", encRows.length >= 2, "n=" + encRows.length);
  const decRow = encRows.find((r) =>
    r.querySelector(".row-name").textContent.indexOf("Correct  Approve Button") === 0);
  check("row displays decoded name", !!decRow,
    decRow && decRow.querySelector(".row-name").textContent);
  check("data-path keeps real encoded path",
    !!decRow && decRow.dataset.path.indexOf("%20") >= 0);
  const labels = [...document.querySelectorAll("#tree .tree-label")].map((e) => e.textContent);
  check("tree shows decoded folder", labels.some((l) => l.indexOf("Button Pack") >= 0 && l.indexOf("%") < 0),
    JSON.stringify(labels));
  check("tree decodes emoji percent-sequences", labels.some((l) => l.indexOf("\uD83C\uDFB5") >= 0));
  const weirdRow = rows().find((r) => r.dataset.path.indexOf("Bad%zz") >= 0);
  check("invalid %-run still decodes partially", !!weirdRow &&
    weirdRow.querySelector(".row-name").textContent.indexOf("Bad%zz Mix") >= 0,
    weirdRow && weirdRow.querySelector(".row-name").textContent);

  /* ================= list / grid view ================= */
  console.log("\n── list / grid view ──");
  check("view toggle exists", !!$("btnViewList") && !!$("btnViewGrid"));
  check("list view is default", !$("soundList").classList.contains("grid-view"));
  click($("btnViewGrid"));
  check("grid view applied", $("soundList").classList.contains("grid-view"));
  check("grid button active", $("btnViewGrid").classList.contains("active") &&
    !$("btnViewList").classList.contains("active"));
  check("grid view persisted", JSON.parse(window.localStorage.getItem("sfxm.v1")).viewMode === "grid",
    JSON.parse(window.localStorage.getItem("sfxm.v1")).viewMode);
  check("grid keeps sound rows", rows().length > 5, "rows=" + rows().length);
  click($("btnViewList"));
  check("list view restored", !$("soundList").classList.contains("grid-view") &&
    JSON.parse(window.localStorage.getItem("sfxm.v1")).viewMode === "list");

  /* ================= host support (AE + Premiere Pro) ================= */
  const B = window.Bridge;
  const AE = window.AudioEngine;
  console.log("\n── host support (AE / Premiere Pro) ──");
  const manifestXml = fs.readFileSync(path.join(EXT, "CSXS/manifest.xml"), "utf8");
  check("manifest targets After Effects (AEFT)", /Host Name="AEFT"/.test(manifestXml));
  check("manifest targets Premiere Pro (PPRO)", /Host Name="PPRO"/.test(manifestXml));
  const hostSrc = fs.readFileSync(path.join(EXT, "jsx/hostscript.jsx"), "utf8");
  check("hostscript detects Premiere", hostSrc.indexOf("function isPremiere") >= 0);
  check("hostscript places clips via overwriteClip", hostSrc.indexOf("overwriteClip") >= 0);
  check("hostscript reads Premiere playhead", hostSrc.indexOf("getPlayerPosition") >= 0);

  const realEvalHost = B.evalHost;
  B.evalHost = function (fn, args, cb) {
    if (fn === "sfxm_getState") {
      cb({ ok: true, host: "PPRO", hasComp: false, comp: "", time: 0, fps: 24, timecode: "00:00:00:00" });
    } else realEvalHost(fn, args, cb);
  };
  await sleep(700);
  check("PPRO: no-sequence status", $("aeState").textContent === "No sequence open",
    $("aeState").textContent);
  B.evalHost = function (fn, args, cb) {
    if (fn === "sfxm_getState") {
      cb({ ok: true, host: "PPRO", hasComp: true, comp: "Main Sequence",
           time: 10, fps: 24, timecode: "00:00:10:00" });
    } else realEvalHost(fn, args, cb);
  };
  await sleep(700);
  check("PPRO: playhead + sequence in status bar",
    $("aeState").textContent === "Playhead 00:00:10:00  \u00b7  Main Sequence",
    JSON.stringify($("aeState").textContent));
  check("PPRO: playhead chip", $("playheadChip").textContent === "00:00:10:00",
    $("playheadChip").textContent);
  B.evalHost = realEvalHost;
  await sleep(700);

  /* ================= WAV fallback decoder ================= */
  console.log("\n── WAV fallback decoder ──");

  function makeWav(opts) {
    const tag = opts.tag, ch = opts.ch, rate = opts.rate, bits = opts.bits;
    const data = opts.data;
    const blockAlign = opts.blockAlign || Math.max(1, ch * Math.ceil((bits || 8) / 8));
    const byteRate = opts.byteRate || rate * blockAlign;
    const extra = opts.extra || new Uint8Array(0);
    const fmtSize = 16 + extra.length;
    const out = new Uint8Array(12 + 8 + fmtSize + 8 + data.length);
    const o = new DataView(out.buffer);
    out.set([0x52, 0x49, 0x46, 0x46], 0);            // RIFF
    o.setUint32(4, out.length - 8, true);
    out.set([0x57, 0x41, 0x56, 0x45], 8);            // WAVE
    out.set([0x66, 0x6d, 0x74, 0x20], 12);           // "fmt "
    o.setUint32(16, fmtSize, true);
    const dv2 = new DataView(out.buffer, 20, fmtSize);
    dv2.setUint16(0, tag, true);
    dv2.setUint16(2, ch, true);
    dv2.setUint32(4, rate, true);
    dv2.setUint32(8, byteRate, true);
    dv2.setUint16(12, blockAlign, true);
    dv2.setUint16(14, bits, true);
    out.set(extra, 20 + 16);
    const dataOff = 20 + fmtSize;
    out.set([0x64, 0x61, 0x74, 0x61], dataOff);      // "data"
    o.setUint32(dataOff + 4, data.length, true);
    out.set(data, dataOff + 8);
    return out.buffer;
  }
  const approx = (a, b, eps) => Math.abs(a - b) <= (eps || 0.01);

  // PCM16 stereo
  const pcm16data = new Uint8Array(8);
  {
    const dv = new DataView(pcm16data.buffer);
    dv.setInt16(0, 16384, true);   // +0.5
    dv.setInt16(2, -16384, true);  // -0.5
    dv.setInt16(4, 0, true);
    dv.setInt16(6, -32768, true);  // -1.0
  }
  let r = AE.parseWav(makeWav({ tag: 1, ch: 2, rate: 44100, bits: 16, data: pcm16data }));
  check("PCM16 parses", !!r && r.frames === 2 && r.channels.length === 2, r && r.formatName);
  check("PCM16 samples", !!r && approx(r.channels[0][0], 0.5, 0.001) &&
    approx(r.channels[1][0], -0.5, 0.001) && approx(r.channels[1][1], -1, 0.001));

  // PCM8
  r = AE.parseWav(makeWav({ tag: 1, ch: 1, rate: 8000, bits: 8,
    data: new Uint8Array([128, 255, 0]) }));
  check("PCM8 parses", !!r && r.frames === 3, r && r.frames);
  check("PCM8 samples", !!r && approx(r.channels[0][0], 0, 0.01) &&
    approx(r.channels[0][1], 127 / 128, 0.01) && approx(r.channels[0][2], -1, 0.01));

  // PCM24
  const pcm24 = new Uint8Array(6);
  pcm24[2] = 0x40; pcm24[5] = 0xc0;
  r = AE.parseWav(makeWav({ tag: 1, ch: 1, rate: 48000, bits: 24, data: pcm24 }));
  check("PCM24 parses", !!r && r.frames === 2, r && r.frames);
  check("PCM24 samples", !!r && approx(r.channels[0][0], 0.5, 0.001) &&
    approx(r.channels[0][1], -0.5, 0.001));

  // float32
  const f32 = new Uint8Array(8);
  new DataView(f32.buffer).setFloat32(0, 0.25, true);
  new DataView(f32.buffer).setFloat32(4, -0.75, true);
  r = AE.parseWav(makeWav({ tag: 3, ch: 1, rate: 44100, bits: 32, data: f32 }));
  check("float32 parses", !!r && approx(r.channels[0][0], 0.25, 0.0001) &&
    approx(r.channels[0][1], -0.75, 0.0001));

  // µ-law — the classic "silent preview" codec Chromium refuses
  r = AE.parseWav(makeWav({ tag: 6, ch: 1, rate: 8000, bits: 8,
    data: new Uint8Array([0xff, 0x7f, 0x80, 0x00]) }));
  check("µ-law parses (Chromium can't)", !!r && r.frames === 4, r && r.formatName);
  check("µ-law zero codes → 0", !!r && approx(r.channels[0][0], 0, 0.0001) &&
    approx(r.channels[0][1], 0, 0.0001));
  check("µ-law peak ≈ +0.98", !!r && approx(r.channels[0][2], 32124 / 32768, 0.005),
    r && r.channels[0][2]);
  check("µ-law trough ≈ -0.98", !!r && approx(r.channels[0][3], -32124 / 32768, 0.005));

  // A-law
  r = AE.parseWav(makeWav({ tag: 7, ch: 1, rate: 8000, bits: 8,
    data: new Uint8Array([0xd5, 0x2a]) }));
  check("A-law parses", !!r && r.frames === 2, r && r.frames);
  check("A-law near-zero + peak", !!r && Math.abs(r.channels[0][0]) < 0.001 &&
    approx(r.channels[0][1], -32256 / 32768, 0.01), r && r.channels[0][1]);

  // WAVE_FORMAT_EXTENSIBLE wrapping PCM16
  const guidPcm = new Uint8Array([
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);
  const extExtra = new Uint8Array(24);
  new DataView(extExtra.buffer).setUint16(0, 22, true);  // cbSize
  new DataView(extExtra.buffer).setUint16(2, 16, true);  // validBits
  new DataView(extExtra.buffer).setUint32(4, 3, true);   // channelMask
  extExtra.set(guidPcm, 8);
  const extData = new Uint8Array(4);
  new DataView(extData.buffer).setInt16(0, 8192, true);
  new DataView(extData.buffer).setInt16(2, -8192, true);
  r = AE.parseWav(makeWav({ tag: 0xfffe, ch: 1, rate: 44100, bits: 16,
    data: extData, extra: extExtra }));
  check("EXTENSIBLE→PCM16 parses", !!r && approx(r.channels[0][0], 0.25, 0.001),
    r && r.formatName);

  // IMA-ADPCM: header sample 0 / index 0, data byte 0x0F → low nibble 0xF
  // sign-magnitude: mag 7, step 7 → diff = 1+3+7 = 11 → −11 (sign set)
  const imaData = new Uint8Array(6);
  imaData[4] = 0x0f;
  r = AE.parseWav(makeWav({ tag: 0x11, ch: 1, rate: 44100, bits: 4,
    data: imaData, blockAlign: 6 }));
  check("IMA-ADPCM parses", !!r && r.frames === 5, r && (r ? r.frames : null));
  check("IMA header sample → 0", !!r && approx(r.channels[0][0], 0, 0.0001));
  check("IMA vector 0xF → -11/32768", !!r && approx(r.channels[0][1], -11 / 32768, 0.0001),
    r && r.channels[0][1]);

  // MS-ADPCM with the 7 standard coefficient pairs
  const msCoefs = [256, 0, 512, -256, 0, 0, 192, 64, 240, 0, 460, -208, 392, -232];
  const msExtra = new Uint8Array(6 + msCoefs.length * 2);
  {
    const dv = new DataView(msExtra.buffer);
    dv.setUint16(0, 18, true);   // cbSize = spb(2)+nCoef(2)+coefs(14)
    dv.setUint16(2, 10, true);   // samplesPerBlock (decoder derives its own)
    dv.setUint16(4, 7, true);    // numCoef
    for (let i = 0; i < msCoefs.length; i++) dv.setInt16(6 + i * 2, msCoefs[i], true);
  }
  const msData = new Uint8Array(8); // bpred=0, idelta=16, samp1=0, samp2=0, +1 data byte
  msData[1] = 16;
  r = AE.parseWav(makeWav({ tag: 2, ch: 1, rate: 44100, bits: 4,
    data: msData, blockAlign: 8, extra: msExtra }));
  check("MS-ADPCM parses", !!r, r && r.formatName);
  check("MS-ADPCM frames", !!r && r.frames === 4, r && r.frames);
  check("MS-ADPCM header samples → 0", !!r &&
    approx(r.channels[0][0], 0, 0.0001) && approx(r.channels[0][1], 0, 0.0001));

  // safety: garbage / truncation never throws
  check("garbage → null", AE.parseWav(new Uint8Array(128).fill(0x42).buffer) === null);
  check("tiny buffer → null", AE.parseWav(new ArrayBuffer(10)) === null);
  const trunc = makeWav({ tag: 1, ch: 1, rate: 44100, bits: 16,
    data: new Uint8Array(4) });
  new DataView(trunc).setUint32(40, 1000, true); // data size lies (1000 > actual)
  const tr = AE.parseWav(trunc);
  check("truncated data clamps (no crash)", !!tr && tr.frames === 2, tr && tr.frames);
  check("non-WAV → null", AE.parseWav(
    new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]).buffer) === null);

  // the reported failing file: 24-bit / 96 kHz / mono PCM WAV
  const pcm24m = new Uint8Array(300); // 100 frames × 3 bytes
  for (let i = 0; i < 100; i++) { pcm24m[i * 3 + 2] = 0x40; } // +0.5 all frames
  const wav24 = makeWav({ tag: 1, ch: 1, rate: 96000, bits: 24, data: pcm24m });
  r = AE.parseWav(wav24);
  check("24-bit/96k mono PCM parses", !!r && r.frames === 100 && r.sampleRate === 96000,
    r && (r.frames + "@" + r.sampleRate));
  check("24-bit/96k mono sample value", !!r && approx(r.channels[0][0], 0.5, 0.001));

  // full E2E: native decodeAudioData throws a codec error → fallback decode
  // → context refuses 96 kHz → linear resample → playable buffer
  const TEST24 = "/SFX Library/Risers/24bit96k Mono Test.wav";
  const origRead = window.Mock.readFileBuffer;
  window.Mock.readFileBuffer = function (p, cb) {
    if (p === TEST24) { setTimeout(function () { cb(null, wav24.slice(0)); }, 5); return; }
    origRead(p, cb);
  };
  window.__forceNativeFail = true;
  window.__forceHiRateReject = true;
  try {
    const rec24 = await AE.load(TEST24, "24bit96k Mono Test.wav");
    check("24/96 codec-error → fallback decode (E2E)",
      !!rec24 && rec24.duration > 0.0009 && rec24.duration < 0.0012,
      rec24 && rec24.duration);
    check("96k resampled to context rate", !!rec24 && rec24.buffer.sampleRate === 44100,
      rec24 && rec24.buffer.sampleRate);
  } catch (e24) {
    check("24/96 codec-error → fallback decode (E2E)", false, String(e24));
    check("96k resampled to context rate", false, String(e24));
  }

  // plain native-fail fallback at normal rate (no resample needed)
  const T2 = "/SFX Library/Transitions/Logo Reveal Sting.wav";
  AE.invalidate(T2);
  try {
    const rec2 = await AE.load(T2, "Logo Reveal Sting.wav");
    check("native codec-error → WAV fallback (E2E)", !!rec2 && rec2.duration > 0,
      rec2 && rec2.duration);
  } catch (e2) {
    check("native codec-error → WAV fallback (E2E)", false, String(e2));
  }
  window.__forceNativeFail = false;
  window.__forceHiRateReject = false;
  window.Mock.readFileBuffer = origRead;

  // explicit single-call pipeline API: AudioContext → ArrayBuffer →
  // decodeAudioData → destination
  check("playLocalFile exported", typeof AE.playLocalFile === "function");
  const T3 = "/SFX Library/Impacts/Metal Slam.wav";
  AE.invalidate(T3);
  try {
    const rec3 = await AE.playLocalFile(T3, "Metal Slam.wav");
    check("playLocalFile decodes & plays", !!rec3 && rec3.duration > 0, rec3 && rec3.duration);
  } catch (e3) {
    check("playLocalFile decodes & plays", false, String(e3));
  }

  // ── broken/streaming headers (the user's 24-bit file shows Duration 0) ──
  const zw = makeWav({ tag: 1, ch: 1, rate: 44100, bits: 16, data: new Uint8Array(8) });
  new DataView(zw).setUint32(40, 0, true); // data chunk size = 0 (streaming)
  const zr = AE.parseWav(zw);
  check("data-size 0 (streaming) still decodes", !!zr && zr.frames === 4, zr && zr.frames);

  // RF64: data size 0xFFFFFFFF → real size from the ds64 table
  const rf = new Uint8Array(76 + 8);
  {
    const dv = new DataView(rf.buffer);
    rf.set([0x52, 0x46, 0x36, 0x34], 0);          // "RF64"
    dv.setUint32(4, rf.length - 8, true);
    rf.set([0x57, 0x41, 0x56, 0x45], 8);           // "WAVE"
    rf.set([0x64, 0x73, 0x36, 0x34], 12);          // "ds64"
    dv.setUint32(16, 24, true);                    // body:24 bytes
    dv.setUint32(20, rf.length - 8, true);         // riffSize64 lo
    dv.setUint32(28, 8, true);                     // dataSize64 lo = 8
    rf.set([0x66, 0x6d, 0x74, 0x20], 44);          // "fmt "
    dv.setUint32(48, 16, true);
    dv.setUint16(52, 1, true);                     // PCM
    dv.setUint16(54, 1, true);                     // mono
    dv.setUint32(56, 44100, true);
    dv.setUint32(60, 88200, true);
    dv.setUint16(64, 2, true);
    dv.setUint16(66, 16, true);
    rf.set([0x64, 0x61, 0x74, 0x61], 68);          // "data"
    dv.setUint32(72, 0xffffffff, true);            // size = -1 → ds64
  }
  const rr = AE.parseWav(rf.buffer);
  check("RF64 (ds64 size) decodes", !!rr && rr.frames === 4, rr && rr.frames);

  // data chunk before fmt
  const df = new Uint8Array(12 + 16 + 24);
  {
    const dv = new DataView(df.buffer);
    df.set([0x52, 0x49, 0x46, 0x46], 0);
    dv.setUint32(4, df.length - 8, true);
    df.set([0x57, 0x41, 0x56, 0x45], 8);
    df.set([0x64, 0x61, 0x74, 0x61], 12);          // "data" FIRST
    dv.setUint32(16, 8, true);
    df.set([0x66, 0x6d, 0x74, 0x20], 28);          // "fmt " second
    dv.setUint32(32, 16, true);
    dv.setUint16(36, 1, true);
    dv.setUint16(38, 1, true);
    dv.setUint32(40, 44100, true);
    dv.setUint32(44, 88200, true);
    dv.setUint16(48, 2, true);
    dv.setUint16(50, 16, true);
  }
  const dfr = AE.parseWav(df.buffer);
  check("data-before-fmt layout decodes", !!dfr && dfr.frames === 4, dfr && dfr.frames);

  // diagnostic reasons for the error toast
  AE.parseWav(new Uint8Array(64).fill(0x01).buffer);
  check("reason: not RIFF", AE.parseWav.lastReason === "not a RIFF/WAVE file", AE.parseWav.lastReason);
  const mp3w = makeWav({ tag: 0x55, ch: 2, rate: 44100, bits: 0,
    data: new Uint8Array(16), blockAlign: 1 });
  AE.parseWav(mp3w);
  check("reason: unsupported tag exposed", /format tag 85/.test(AE.parseWav.lastReason),
    AE.parseWav.lastReason);

  // read/preview failures surface the real reason (no more mystery toast)
  const badPath = "/SFX Library/Whooshes/Unreadable.wav";
  const origRead2 = window.Mock.readFileBuffer;
  window.Mock.readFileBuffer = function (p, cb) {
    if (p === badPath) { setTimeout(function () { cb("disk I/O error 42"); }, 5); return; }
    origRead2(p, cb);
  };
  try { await AE.select(badPath, "Unreadable.wav"); } catch (eBad) { /* expected */ }
  await sleep(80);
  window.Mock.readFileBuffer = origRead2;
  check("failure reason shown in toast", toasts().some((t) => t.indexOf("disk I/O error 42") >= 0),
    JSON.stringify(toasts()));

  /* ================= drag payload ================= */
  console.log("\n── drag & drop payload ──");
  let dragData = null;
  const row = rows()[2];
  const dte = new window.Event("dragstart", { bubbles: true, cancelable: true });
  dte.dataTransfer = {
    _d: {},
    effectAllowed: "",
    setData(k, v) { this._d[k] = v; },
    getData(k) { return this._d[k]; },
    setDragImage() {}
  };
  row.dispatchEvent(dte);
  dragData = dte.dataTransfer._d;
  check("drag sets CEP dnd format", dragData["com.adobe.cep.dnd.file.0"] === row.dataset.path,
    JSON.stringify(dragData));
  check("drag sets text/plain path", dragData["text/plain"] === row.dataset.path);
  check("drag sets uri-list", /^file:\/\//.test(dragData["text/uri-list"] || ""),
    dragData["text/uri-list"]);
  await sleep(50);
  check("drag hint shown", !$("dragHint").classList.contains("hidden"));
  row.dispatchEvent(new window.Event("dragend", { bubbles: true }));
  await sleep(50);
  check("drag hint hidden after dragend", $("dragHint").classList.contains("hidden"));

  /* ---------------- summary ---------------- */
  await sleep(300);
  const realErrors = jsdomErrors.filter((e) => !/Could not parse CSS|Not implemented/.test(e));
  check("no runtime errors", realErrors.length === 0, realErrors.join(" | "));

  console.log("\n══════════════════════════════════");
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("  Failures:");
    failures.forEach((f) => console.log("   • " + f));
  }
  console.log("══════════════════════════════════\n");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("TEST CRASHED:", e);
  process.exit(1);
});

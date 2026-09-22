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
    decodeAudioData(ab, ok) {
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
  console.log("\n── add at playhead ──");
  check("add button enabled after selection", !$("btnAdd").disabled);
  click($("btnAdd"));
  await sleep(300);
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

  /* ================= modals & theme ================= */
  console.log("\n── modals, about, theme ──");
  click($("btnAbout"));
  check("about modal opens", !$("aboutOverlay").classList.contains("hidden"));
  check("about shows the name", $("aboutOverlay").textContent.indexOf("Anamoul Houqe Nadim") >= 0);
  check("about shows instagram handle", $("aboutOverlay").textContent.indexOf("instagram.com/nadim.3x") >= 0);
  click($("aboutOverlay").querySelector("[data-close]"));
  check("about modal closes", $("aboutOverlay").classList.contains("hidden"));

  key("?");
  check("? opens shortcuts", !$("helpOverlay").classList.contains("hidden"));
  key("Escape");
  check("esc closes shortcuts", $("helpOverlay").classList.contains("hidden"));

  click($("btnTheme"));
  check("theme → light", document.documentElement.getAttribute("data-theme") === "light");
  click($("btnTheme"));
  check("theme → dark", document.documentElement.getAttribute("data-theme") === "dark");

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

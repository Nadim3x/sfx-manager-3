#!/usr/bin/env node
/**
 * shoot.js — screenshot the REAL SFX Manager panel in headless Chromium
 * (npm-bundled @sparticuz/chromium) at 335×568 @2x — the vertical dock size.
 * Output: gumroad/shot-<state>.png (670×1136)
 *
 * Run: LD_LIBRARY_PATH=/tmp/al2023/lib node tools/shoot.js
 */
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const ROOT_DIR = path.join(__dirname, "..");
const PANEL = "file://" + path.join(ROOT_DIR, "SFXManager", "index.html");
const OUT_DIR = path.join(ROOT_DIR, "gumroad");

function fontFace() {
  const dir = path.join(ROOT_DIR, "node_modules", "@fontsource", "inter", "files");
  const b64 = (n) => fs.readFileSync(path.join(dir, n)).toString("base64");
  const w4 = b64("inter-latin-400-normal.woff2");
  const w6 = b64("inter-latin-600-normal.woff2");
  // The panel asks for "SF Pro Display" first — alias it to Inter so the
  // screenshots carry the intended typography.
  const face = (fam, w, data) =>
    `@font-face{font-family:'${fam}';font-weight:${w};font-style:normal;` +
    `src:url(data:font/woff2;base64,${data}) format('woff2');}`;
  return [face("SF Pro Display", 400, w4), face("SF Pro Display", 600, w6),
          face("Inter", 400, w4), face("Inter", 600, w6)].join("\n");
}

const STATES = [
  {
    name: "list-dark",
    store: { root: "/SFX Library", lastFolder: "", theme: "dark", viewMode: "list" },
    after: async (page) => {
      await page.waitForSelector(".sound-row", { timeout: 10000 });
      await page.evaluate(() => {
        const l = document.getElementById("soundList");
        if (l) l.scrollTop = 420; // bring section dividers into view
      });
      await sleep(350);
      // select a sound → auto-preview fills the player + waveform
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".sound-row")];
        const row = rows.find((r) => (r.textContent || "").indexOf("Whoosh Fast 01") >= 0) || rows[2];
        if (row) row.click();
      });
      await sleep(1100);
    },
  },
  {
    name: "grid-light",
    store: { root: "/SFX Library", lastFolder: "", theme: "light", viewMode: "grid" },
    after: async (page) => {
      await page.waitForSelector(".sound-row", { timeout: 10000 });
      await page.evaluate(() => {
        const l = document.getElementById("soundList");
        if (l) l.scrollTop = 260;
      });
      await sleep(400);
    },
  },
  {
    name: "settings-dark",
    store: { root: "/SFX Library", lastFolder: "", theme: "dark", viewMode: "list" },
    after: async (page) => {
      await page.waitForSelector(".sound-row", { timeout: 10000 });
      await page.click("#btnSettings");
      await sleep(500);
      await page.evaluate(() => {
        const ov = document.getElementById("settingsOverlay");
        const sc = [...(ov ? ov.querySelectorAll("*") : [])].find(
          (e) => e.scrollHeight > e.clientHeight + 40);
        if (sc) sc.scrollTop = 160; // theme + accent swatch rows
      });
      await sleep(300);
    },
  },
  {
    name: "list-light-player",
    store: { root: "/SFX Library", lastFolder: "", theme: "light", viewMode: "list" },
    after: async (page) => {
      await page.waitForSelector(".sound-row", { timeout: 10000 });
      await page.evaluate(() => {
        const l = document.getElementById("soundList");
        if (l) l.scrollTop = 420;
        const rows = [...document.querySelectorAll(".sound-row")];
        const row = rows.find((r) => (r.textContent || "").indexOf("Deep Impact 01") >= 0) || rows[1];
        if (row) row.click();
      });
      await sleep(1100);
    },
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chromium = require("@sparticuz/chromium").default;
  const browser = await puppeteer.launch({
    args: [...chromium.args, "--allow-file-access-from-files",
           "--autoplay-policy=no-user-gesture-required", "--disable-gpu"],
    executablePath: await chromium.executablePath(),
    headless: "shell",
    defaultViewport: { width: 335, height: 568, deviceScaleFactor: 2 },
  });

  const css = fontFace();
  for (const st of STATES) {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument((store, faceCss) => {
      try { localStorage.setItem("sfxm.v1", JSON.stringify(store)); } catch (e) {}
      try {
        const el = document.createElement("style");
        el.textContent = faceCss;
        document.documentElement.appendChild(el);
      } catch (e) {}
    }, st.store, css);

    await page.goto(PANEL, { waitUntil: "load", timeout: 20000 });
    await st.after(page);
    // remove any transient toasts so no error chrome lands in the shot
    await page.evaluate(() => {
      document.querySelectorAll(".toast, .ae-error").forEach((t) => t.remove());
    });
    await sleep(150);
    const facts = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute("data-theme"),
      rows: document.querySelectorAll(".sound-row").length,
      dividers: document.querySelectorAll(".list-group").length,
      grid: document.getElementById("soundList").classList.contains("grid-view"),
      settings: !document.getElementById("settingsOverlay").classList.contains("hidden"),
      font: document.fonts.check('600 16px "SF Pro Display"'),
      scroll: (document.getElementById("soundList") || {}).scrollTop,
      body: document.body.innerText.replace(/\s+/g, " ").slice(0, 90),
      toasts: document.querySelectorAll(".toast").length,
    }));
    const out = path.join(OUT_DIR, `shot-${st.name}.png`);
    await page.screenshot({ path: out });
    console.log(st.name, "→", out, JSON.stringify(facts));
    await page.close();
  }

  await browser.close();
  console.log("done");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });

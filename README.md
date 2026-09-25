# 🎛 SFX Manager — for Adobe After Effects

A fully-featured, premium **sound-effects panel** for After Effects with a polished
macOS-style interface and a blue `#066CE7` accent.

> **Why a panel (.jsx alone can't do this)** — real waveform decoding, in-panel audio
> playback with volume/speed, animated Apple-style UI and drag-to-timeline all require
> a CEP panel (HTML/CSS/JS + ExtendScript). It installs with **one double-click** and
> shows up in **Window ▸ SFX Manager**, exactly like a dockable script panel.

---

## ✨ Features

| You asked for | How it works |
|---|---|
| **Folder tree = my real SFX folder** | Pick your SFX folder once — the sidebar mirrors its exact folder tree, lazily expanded |
| **Add** | Blue **＋ Add** button (or `⏎`, or double-click a row) imports the sound and places it starting exactly at the current time |
| **List / grid views** | Segmented toggle above the list — compact rows or a card grid; remembered per user |
| **Panel tones** | Settings → Tone: **Default** palette or flat ink **#0B0B0D** (glow gradients off); remembered per user |
| **Settings — flat redesign** | 340px card: **ACCENT COLOR** + **BACKGROUND COLOR** — 8 square swatches each (white active ring), raw hex fields (no #), colour dots, hints, footer + **Apply changes** CTA; bright backgrounds auto-flip text for contrast |
| **Flat main UI (Linear/Notion style)** | 38px header with22px accent logo + inline search, ghost icon buttons, 196px sidebar, 34px rows, section dividers in All Sounds, flat waveform with accent tint, full-width **Add to timeline** button, thin playhead status strip; light mode palette matched |
| **Waveform preview** | Real decoded waveform on canvas — click to scrub, playhead line follows playback |
| **Playback preview** | Web Audio engine — and it **auto-plays the moment you select a sound**, no play button needed |
| **Premium Apple UI** | Frosted-glass bars, hairline borders, springy hover states, staggered list animations, light/dark themes |
| **Blue accent `#066ce7`** | Used across buttons, glows, active states and the waveform itself |
| **Drag onto timeline** | Drag a row onto the comp timeline (Adobe's `com.adobe.cep.dnd.file.0` payload) — the Add button is the always-works fallback |
| **Favorites** | Star any sound (`F`), dedicated ★ Favorites view |
| **Waveform zoom** | `+` / `−` buttons or `⌘/Ctrl + scroll`, horizontal pan when zoomed |
| **Category / colour tags** | 6 colour tags via right-click or keys `1–6`, plus colour-chip filters |
| **Keyboard shortcuts** | Full scheme, on-screen reference with `?` |
| **Recently used** | Every preview/add is remembered — Recently Used view |
| **Preview volume & speed** | Sliders for volume (0–100%) and speed (0.5×–2.0×), loop toggle |
| **Settings (gear button)** | Accent-colour picker (default `#066CE7`, presets + custom) — applied live across the panel and waveform — with **Anamoul Houqe Nadim** + an **Instagram** button (opens your default browser, e.g. Chrome) at the bottom |
| **Pure Web Audio playback** | No `<audio>` tag: `AudioContext` → `ArrayBuffer` → `decodeAudioData` → destination, with a built-in WAV fallback that also resamples exotic rates (24-bit/96 kHz mono plays) |

Also included: instant search across the whole library (`⌘/Ctrl+F`), folder & file
durations parsed straight from WAV/AIFF headers, live playhead timecode readout from
After Effects, undo-grouped imports (one `⌘Z` reverts an add), toast notifications,
context menu with reveal/copy-path.

---

## 📦 Install

### Option A — ZXP package (recommended, signed)

The repo ships a signed **`SFXManager-1.1.2.zzp`** (UCF + W3C XML-DSig,
cert: *Anamoul Houqe Nadim · valid to 2126*).

1. Install any ZXP installer once:
   [Anastasiy’s Extension Manager](https://install.anastasiy.com/) (mac/win) or
   [ZXP Installer by aescripts](https://aescripts.com/learn/zxp-installer/)
2. Drop **`SFXManager-1.1.2.zzp`** onto it
   (self-signed cert → the installer asks you to confirm “unknown publisher” — expected)
3. Restart After Effects → **Window ▸ SFX Manager**

CLI alternative: `ExManCmd --install SFXManager-1.1.2.zzp`

### Option B — one-click folder install
**macOS:** double-click **`install_mac.command`** · **Windows:** double-click **`install_win.bat`**
(then fully quit & reopen AE → **Window ▸ SFX Manager**)

> The installers copy the panel into your CEP extensions folder and enable Adobe's
> `PlayerDebugMode` (required for community panels — safe and reversible).

### Option C — manual install
Copy the `SFXManager/` folder to:

- **macOS** → `~/Library/Application Support/Adobe/CEP/extensions/com.nadim.sfxmanager`
- **Windows** → `%APPDATA%\Adobe\CEP\extensions\com.nadim.sfxmanager`

…then enable PlayerDebugMode (the installers do this for CSXS 7–12) and restart AE.

**Requirements:** After Effects **2021 or newer** (18.0+), macOS or Windows.

### Re-signing after changes (maintainers)
```bash
python3 tools/zxp.py sign  SFXManager  SFXManager-1.1.2.zzp  \
        certs/SFXManager-signing.key.pem  certs/SFXManager-signing.cert.pem
python3 tools/zxp.py verify SFXManager-1.1.2.zzp     # ← always run this
```
The identity lives in `certs/SFXManager-signing.p12` (password `nadim.3x`, git-ignored —
keep a backup). With it you can also re-create packages with Adobe’s official
`ZXPSignCmd -sign … cert.p12 <password>` on macOS/Windows.

---

## 🕹 Keyboard shortcuts

| Action | Keys |
|---|---|
| Move selection (auto-previews) | `↑` `↓` |
| **Add** | `⏎` |
| Play / pause preview | `Space` |
| Stop preview | `Esc` |
| Seek ±0.1s / ±1s | `←` `→` / `⇧←` `⇧→` |
| Waveform zoom | `+` `−` (or `⌘/Ctrl + scroll`) |
| Toggle loop | `L` |
| Toggle favorite | `F` |
| Colour tag 1–6 (0 = clear) | `1 … 6` |
| Search | `⌘/Ctrl + F` |
| Context menu | right-click (or `⌘/Ctrl + ⏎`) |
| Shortcuts reference | `?` |

---

## 🧪 Try the UI in your browser (no After Effects needed)

```bash
npm run preview     # → http://localhost:8756
```

The panel runs against a demo SFX library with synthesized audio — real waveform,
real playback, every animation and view fully interactive.

```bash
npm test            # 72-check headless integration test of the whole UI
```

---

## 🧩 How it works

```
SFXManager/
├── CSXS/manifest.xml      CEP manifest (panel registration, Node.js enabled)
├── index.html             panel UI
├── css/styles.css         macOS-style design system (dark + light, #066CE7)
├── js/
│   ├── app.js             controller: tree, list, search, tags, shortcuts, DnD
│   ├── audio.js           Web Audio playback + waveform decode/render (zoom/scrub)
│   ├── bridge.js          CEP ⇄ ExtendScript ⇄ Node-fs communication layer
│   ├── store.js           settings, favorites, recents, colour tags (persisted)
│   └── mock.js            browser-preview environment (demo library)
└── jsx/hostscript.jsx     ExtendScript: playhead readout, import + place at time
```

- **Timeline placement** runs as one undo group: reuses an already-imported file when
  possible, adds the layer at `comp.time`, enables its audio and selects it.
- **Waveforms** are decoded with Web Audio (`decodeAudioData`); durations for WAV/AIFF
  show instantly from the file header while the list is still loading.
- **Preview** never touches your project — sounds audition in the panel only.

---

## 🔧 Troubleshooting

| Symptom | Fix |
|---|---|
| Panel not in the Window menu | Re-run the installer (PlayerDebugMode), fully quit & reopen AE |
| “No composition open” | Select/open a comp in After Effects |
| A codec won't preview | Some exotic codecs can't play in-panel — **Add** still works (AE decodes everything) |
| Drag onto timeline ignored by your OS/CCP build | Use **＋ Add** / `⏎` — identical result, zero placement errors |
| macOS can't read your SFX folder | System Settings ▸ Privacy & Security ▸ **Full Disk Access** ▸ enable After Effects |
| Preview feels late | Lower folder depth first-load — the tree loads lazily by design |

---

## 👤 About me

**Anamoul Houqe Nadim** — creator of SFX Manager

- Instagram: [instagram.com/nadim.3x](https://instagram.com/nadim.3x)

Use the **AN avatar** in the panel's top-right corner anytime for this info.

---

*Built with a blue accent `#066CE7`.*

# sfx-manager-3

A high-fidelity SFX manager panel designed to sit natively alongside professional design and editing workspaces.

## Design direction

- **Negative space** — wide 20px grid gaps and generous 18px card padding keep the library calm instead of compressed.
- **Typography & truncation** — track names use a light 400 weight; names clamp to one line and smoothly expand to two on hover (full name also in the native tooltip).
- **Decluttered player** — the "click to scrub" instruction is a subtle hover tooltip over the waveform that fades out permanently after the first scrub; transport, time, volume and speed form a single perfectly centered control cluster.
- **Balanced palette** — categorical tag dots use muted, desaturated fills with a faint glow, so they stay readable without clashing with the single confident blue reserved for primary actions.
- **Subtle depth** — a deep `#0a0b0e` base with slightly lighter card (`#151820`) and player (`#101319`) surfaces creates elevation through tone steps and soft shadows rather than harsh borders.

## Run

```bash
python3 -m http.server 4173
```

Open http://localhost:4173.

## Notes

- All library sounds are synthesized in-browser via Web Audio (no binary assets); "Import sounds" decodes and adds any local audio files you pick.
- Shortcuts: `/` search · `Space` play/pause · `←` / `→` seek ±5s (±0.5s on the waveform slider).

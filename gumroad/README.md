# Gumroad listing kit — SFX Manager

All images are exact size @ 72 DPI, ready for Gumroad's upload validators.

| File | Spec | Where it goes |
|---|---|---|
| `cover-1280x720.png` | 1280×720, 72 DPI | Product **cover** (Gumroad → product → cover image) |
| `thumb-600x600.png` | 600×600, 72 DPI | Product **thumbnail** (shown in your product list — the logo as the list logo) |
| `logo-512.png` | 512×512, transparent | Upload to an image host → paste its URL as `LOGO_URL` in `description.html` |
| `logo-1024.png` | 1024×1024, transparent | Master mark (store listing, socials, favicons) |
| `description.html` | paste-ready | Product **Description** (open the `<>` code view, paste) |
| `summary.txt` | — | Product **Summary** field (pick one of the two variants) |

## Steps

1. Gumroad → your product → **Cover**: upload `cover-1280x720.png`.
2. **Thumbnail / product list image**: upload `thumb-600x600.png`.
3. Upload `logo-512.png` to an image host (e.g. Imgur → *Copy image address*),
   open `description.html`, replace `LOGO_URL` with that link, then paste the
   whole file into the Description's `<>` code view.
4. Paste one variant from `summary.txt` into **Summary**.
5. Preview the product page — the logo now heads the list block, and the
   thumbnail is the logo in your Gumroad product list.

Regenerate any time: `python3 tools/make_gumroad.py`.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development

No build step required. Open `index.html` directly in a browser or use a local server:

```bash
# Quick local server (any of these work)
npx serve .
npx http-server .
```

Deployed on Vercel — push to `main` triggers auto-deploy.

## Architecture

Single self-contained file: `index.html` (~37 KB). All CSS, JavaScript, and content live in this one file.

**Sections** (navigated via `showSection(sectionId)` in JS):
- `#home` — hero landing
- `#about` — bio
- `#projects` — project cards (visibility controlled by DEV MODE)
- `#apps` — user-customizable app links (persisted in `localStorage` under `avner_custom_apps`)
- `#privacy` — privacy policy

**Key JavaScript systems:**
- **i18n**: `translations` object (English/Hebrew/Russian), `setLanguage(lang)` applies `data-i18n` attributes. Hebrew sets `dir="rtl"` on `<html>`.
- **DEV MODE**: Password-protected toggle that controls which project cards are visible (`[data-dev-only]` elements). Password stored hashed in the script.
- **Custom Apps modal**: Add/remove apps via modal UI, stored in `localStorage`.

**Theme**: CSS custom properties (`--bg`, `--accent` orange `#ff8c00`, `--accent2` cyan `#00c8ff`). Fonts: Orbitron (headings), Rajdhani (body) via Google Fonts.

## Assets

- `AVNERMANICO.png` — profile photo used in hero and about sections
- `SalsaFlowDj.png` — project thumbnail

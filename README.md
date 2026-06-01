# Optimized TikTok Scraper

Direct TypeScript CLI for scraping TikTok search results. This folder is standalone and does not use NestJS.

## Install

```bash
cd optimized
npm install
```

## Run

```bash
npm run scrape -- --search "science fact" --keyword "body" --max 10
```

By default Chrome opens visibly so TikTok login, captcha, and page behavior can be inspected. The `scrape` script compiles TypeScript first, then runs the compiled CLI to avoid browser-evaluation issues from runtime TS transpilers.

## Smoke Test

```bash
npm run scrape -- --search "science fact" --keyword "body" --max 2 --comments 5
```

## Open TikTok Only

Use this when you want to inspect TikTok login, captcha, search rendering, or account state without scraping:

```bash
npm run scrape -- --open-only
npm run scrape -- --open-only --search "curanmor"
```

With `--search`, this opens TikTok's video search route: `https://www.tiktok.com/search/video?q=<query>`.

Chrome stays open until you stop the terminal with `Ctrl+C`.

## CLI Flags

- `--search <text>`: required search query.
- `--keyword <text>`: optional keyword used for `keywordMentioned`.
- `--max <number>`: videos to scrape, default `10`.
- `--comments <number>`: comments per video, default `50`.
- `--headless`: run Chrome headless.
- `--keep-browser-open`: leave Chrome open after the run.
- `--output <path>`: custom JSON output path.
- `--open-only`: open TikTok or a TikTok video search page and do not scrape.

Results are written to `output/tiktok-scrape-YYYYMMDD-HHmmss.json` unless `--output` is provided.

## Scripts

```bash
npm run scrape -- --search "your query"
npm run build
```

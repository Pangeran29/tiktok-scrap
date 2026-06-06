# Optimized TikTok Scraper

Direct TypeScript CLI for scraping TikTok search results. This folder is standalone and does not use NestJS.

## Install

```bash
cd optimized
npm install
```

## Run

```bash
npm run scrape -- --search "science fact" --max 10 --comments 50 --keyword "body"
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
- `--max <number>`: required number of videos to scrape.
- `--comments <number>`: required number of comments per video; use `0` to disable comments.
- `--keyword <text>`: optional keyword used for `keywordMentioned`.
- `--headless`: run Chrome headless.
- `--keep-browser-open`: leave Chrome open after the run.
- `--output <path>`: custom JSON output path.
- `--open-only`: open TikTok or a TikTok video search page and do not scrape.
- `--download-video`: save each scraped video to `downloads/` when TikTok exposes a playable video URL.
- `--registry <path>`: choose the scraped-video ID JSON file, default `data/scraped-video-ids.json`.
- `--skip-existing`: skip video IDs already recorded in the local registry and save newly scraped IDs.

Downloaded items include `videoDownloadUrl` (the resolved TikTok CDN URL) and `videoFile` (the local saved path). TikTok CDN URLs are signed and may expire.

Results are written to `output/tiktok-scrape-YYYYMMDD-HHmmss.json` unless `--output` is provided.

By default, the registry is not used and matching videos may be scraped again. Add `--skip-existing` to load `data/scraped-video-ids.json`, exclude recorded IDs, and save newly scraped IDs. The entire `data/` directory is ignored by Git.

Example with a custom local registry:

```bash
npm run scrape -- --search "curanmor" --max 20 --comments 50 --skip-existing --registry data/curanmor-ids.json
```

## Scripts

```bash
npm run scrape -- --search "your query" --max 10 --comments 50
npm run build
```

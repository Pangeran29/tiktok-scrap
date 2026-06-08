# Optimized TikTok Scraper

Direct TypeScript CLI for scraping TikTok video search results. It does not use NestJS.

## Install

```bash
npm install
```

## Basic Usage

Every scrape requires `--search`, `--max`, and `--comments`:

```bash
npm run scrape -- --search "curanmor" --max 5 --comments 50
```

Use `--comments 0` when comments are not needed:

```bash
npm run scrape -- --search "curanmor" --max 5 --comments 0
```

By default Chrome is visible, videos are not downloaded, and previously scraped IDs are not skipped.

## CLI Reference

### Required For Scraping

| Option | Description |
|---|---|
| `--search <text>` | TikTok video-search query. |
| `--max <number>` | Number of new video results to scrape. |
| `--comments <number>` | Maximum comments per video. Use `0` to disable comment scraping. |

### Optional

| Option | Default | Description |
|---|---:|---|
| `--keyword <text>` | None | Sets `keywordMentioned` when found in the caption or scraped comments. |
| `--headless` | Off | Runs Chrome without a visible window. Visible mode is generally more reliable for TikTok. |
| `--keep-browser-open` | Off | Keeps the Puppeteer Chrome process open after completion. |
| `--download-video` | Off | Downloads each available video into `downloads/`. |
| `--skip-existing` | Off | Skips IDs already present in the registry and records successfully scraped IDs. |
| `--registry <path>` | `data/scraped-video-ids.json` | Selects the local ID registry used with `--skip-existing`. |
| `--output <path>` | Timestamped JSON | Selects the scrape result JSON path. |
| `--open-only` | Off | Opens TikTok for inspection without scraping. With `--search`, opens the video-search page. |

`--open-only` does not require `--max` or `--comments`:

```bash
npm run scrape -- --open-only
npm run scrape -- --open-only --search "curanmor"
```

Chrome stays open until you stop the terminal with `Ctrl+C`.

## Common Commands

Scrape five videos with comments:

```bash
npm run scrape -- --search "curanmor" --max 5 --comments 50
```

Scrape five unique videos and download them:

```bash
npm run scrape -- \
  --search "curanmor" \
  --max 5 \
  --comments 50 \
  --skip-existing \
  --download-video
```

Use a separate registry for one query:

```bash
npm run scrape -- \
  --search "curanmor" \
  --max 20 \
  --comments 0 \
  --skip-existing \
  --registry data/curanmor-ids.json
```

Write results to a custom file:

```bash
npm run scrape -- \
  --search "curanmor" \
  --max 5 \
  --comments 10 \
  --output output/curanmor.json
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HEADLESS` | `0` | Set to `1` or `true` to enable headless mode. The `--headless` flag also enables it. |
| `KEEP_BROWSER_OPEN` | `0` | Set to `1` to keep Chrome open after scraping. |
| `CHROME_USER_DATA_DIR` | `.chrome-profile` | Persistent Chrome profile directory. |
| `VIDEO_REGISTRY_PATH` | `data/scraped-video-ids.json` | Default registry path when `--registry` is omitted. |

## Generated Files

- `output/tiktok-scrape-YYYYMMDD-HHmmss.json`: scrape results.
- `downloads/*.mp4`: downloaded videos when `--download-video` is enabled.
- `data/scraped-video-ids.json`: local deduplication registry when `--skip-existing` is enabled.
- `.chrome-profile/`: persistent TikTok browser session.

These runtime directories are ignored by Git.

Each downloaded item includes:

- `videoDownloadUrl`: resolved signed TikTok CDN URL. It may expire.
- `videoFile`: local downloaded file path.
- `downloadError`: present when downloading fails.

## Scripts

```bash
npm run build
npm run scrape -- --search "curanmor" --max 5 --comments 50
```

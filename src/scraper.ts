import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer';

import { extractComments } from './comments';
import type { ScrapeOptions, ScrapeResult, ScrapedVideo, VideoStats } from './types';
import { buildSearchUrl, isKeywordMentioned, normalizeVideoUrl, nowIso, sleep } from './utils';
import { loadScrapedVideoIds, saveScrapedVideoId } from './video-registry';

puppeteer.use(StealthPlugin());

type OEmbed = {
  title?: string;
  author_name?: string;
  author_url?: string;
};

async function fetchOEmbed(videoUrl: string): Promise<OEmbed | null> {
  try {
    const response = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!response.ok) return null;
    return (await response.json()) as OEmbed;
  } catch {
    return null;
  }
}

async function collectVideoUrlsFromSearch(
  page: Page,
  search: string,
  maxVideos: number,
  existingVideoIds: Set<string>,
): Promise<{ urls: string[]; skippedExisting: number }> {
  const searchUrl = buildSearchUrl(search);
  console.log(`Opening search page: ${searchUrl}`);

  const response = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await assertTikTokAccess(page, response?.status() ?? null);
  await Promise.race([
    page.waitForSelector('a[href*="/video/"]', { timeout: 10_000 }).catch(() => null),
    page.waitForSelector('[data-e2e="search-video-item"]', { timeout: 10_000 }).catch(() => null),
  ]);
  await sleep(1000);

  const urls = new Set<string>();
  const skippedIds = new Set<string>();
  const seenIds = new Set<string>();
  const maxScrolls = Math.max(40, maxVideos * 5);
  const maxStagnantScrolls = 6;
  let stagnantScrolls = 0;

  for (let attempt = 0; attempt < maxScrolls && urls.size < maxVideos; attempt += 1) {
    const seenBefore = seenIds.size;
    const hrefs = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/video/"]')) as HTMLAnchorElement[];
      return anchors.map((anchor) => anchor.href || anchor.getAttribute('href') || '').filter(Boolean);
    });

    for (const href of hrefs) {
      const normalized = normalizeVideoUrl(href.startsWith('http') ? href : `https://www.tiktok.com${href}`);
      const videoId = normalized?.match(/\/video\/(\d+)/)?.[1];
      if (normalized && videoId) {
        seenIds.add(videoId);
        if (existingVideoIds.has(videoId)) {
          skippedIds.add(videoId);
        } else {
          urls.add(normalized);
        }
      }
      if (urls.size >= maxVideos) break;
    }

    if (urls.size >= maxVideos) break;

    if (seenIds.size === seenBefore) {
      stagnantScrolls += 1;
    } else {
      stagnantScrolls = 0;
      console.log(`Found ${urls.size}/${maxVideos} new video URL(s); ${skippedIds.size} already scraped.`);
    }

    if (stagnantScrolls >= maxStagnantScrolls) break;

    const scrolled = await page
      .evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('*'))
          .filter((element) => {
            const htmlElement = element as HTMLElement;
            const style = getComputedStyle(htmlElement);
            return (
              (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
              htmlElement.scrollHeight > htmlElement.clientHeight
            );
          })
          .sort((a, b) => (b as HTMLElement).scrollHeight - (a as HTMLElement).scrollHeight);

        const container = candidates[0] as HTMLElement | undefined;
        if (!container) return false;

        container.scrollTop = container.scrollHeight;
        container.dispatchEvent(new Event('scroll', { bubbles: true }));
        return true;
      })
      .catch(() => false);

    if (!scrolled) {
      await page.mouse.wheel({ deltaY: 2400 }).catch(() => undefined);
    }
    await sleep(1500);
  }

  if (urls.size === 0 && skippedIds.size === 0) {
    throw new Error('Failed to find TikTok video links on the search page.');
  }

  const collected = Array.from(urls).slice(0, maxVideos);
  console.log(`Collected ${collected.length} new video URL(s) from search results.`);
  if (skippedIds.size > 0) console.log(`Skipped ${skippedIds.size} previously scraped video(s).`);
  return { urls: collected, skippedExisting: skippedIds.size };
}

async function assertTikTokAccess(page: Page, status: number | null): Promise<void> {
  const blocked = await page
    .evaluate(() => {
      const text = `${document.title} ${document.body?.innerText || ''}`.toLowerCase();
      return (
        text.includes('access to www.tiktok.com was denied') ||
        text.includes("you don't have authorization to view this page") ||
        text.includes('http error 403')
      );
    })
    .catch(() => false);

  if (status === 403 || blocked) {
    throw new Error(
      'TikTok returned HTTP 403 before scraping. Close other scraper browsers and retry later. ' +
        'TikTok may be temporarily blocking the current session or network/IP.',
    );
  }
}

export async function openTikTokForDebug(search: string | null, headless: boolean): Promise<void> {
  const browser = await puppeteer.launch({
    headless,
    userDataDir: process.env.CHROME_USER_DATA_DIR || '.chrome-profile',
    defaultViewport: null,
    devtools: !headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--lang=en-US,en;q=0.9',
    ],
  });

  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  await closeExtraPages(browser, page);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setViewport({ width: 1366, height: 850, deviceScaleFactor: 1 });

  const url = search ? buildSearchUrl(search) : 'https://www.tiktok.com/';
  console.log(`Opening TikTok debug page: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  console.log('Chrome will stay open. Press Ctrl+C in this terminal when done.');

  await new Promise<void>(() => undefined);
}

async function openVideo(page: Page, videoUrl: string): Promise<void> {
  await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);

  const openedVideo = await Promise.race([
    page.waitForFunction(() => location.href.includes('/video/'), { timeout: 8000 }).then(() => true).catch(() => false),
    page.waitForSelector('video', { timeout: 8000 }).then(() => true).catch(() => false),
    page.waitForSelector('[data-e2e="video-desc"]', { timeout: 8000 }).then(() => true).catch(() => false),
  ]);

  if (!openedVideo) throw new Error(`Failed to open TikTok video: ${videoUrl}`);

  await sleep(400);
}

async function closeExtraPages(browser: Browser, mainPage: Page): Promise<void> {
  const pages = await browser.pages();
  await Promise.all(
    pages.map(async (candidate) => {
      if (candidate === mainPage || candidate.isClosed()) return;
      await candidate.close().catch(() => undefined);
    }),
  );
}

async function extractVideo(page: Page, keyword: string | null, commentsLimit: number): Promise<ScrapedVideo> {
  const currentUrl = page.url();
  const normalizedUrl = normalizeVideoUrl(currentUrl);
  const oembed = await fetchOEmbed(normalizedUrl ?? currentUrl);

  let usernameFromUrl: string | null = null;
  const usernameMatch = currentUrl.match(/tiktok\.com\/@([^/]+)/);
  if (usernameMatch) usernameFromUrl = usernameMatch[1];

  const domData = await page.evaluate(() => {
    const findText = (selectors: string[]): string | null => {
      for (const selector of selectors) {
        const element = document.querySelector(selector) as HTMLElement | null;
        const text = (element?.textContent || '').trim();
        if (text) return text;
      }
      return null;
    };

    const caption = findText([
      '[data-e2e="video-desc"]',
      '.video-desc',
      'h1[class*="share-title"]',
      'div[data-testid="desc"]',
      '.tt-video-meta__desc',
    ]);

    let username: string | null = null;
    let authorUrl: string | null = null;

    for (const selector of [
      'a[href^="/@"]',
      '[data-e2e="browse-username"]',
      '[data-e2e="user-title"] a',
      '.video-owner a',
      '.share-title-container a',
    ]) {
      const element = document.querySelector(selector) as HTMLAnchorElement | null;
      if (!element) continue;

      const text = (element.textContent || '').trim();
      if (text && !/^profile$/i.test(text)) username = text.replace(/^@/, '');

      const href = element.getAttribute('href') || '';
      if (href) authorUrl = href.startsWith('http') ? href : `https://www.tiktok.com${href}`;
      break;
    }

    return {
      caption,
      username,
      authorUrl,
      videoSrc: (document.querySelector('video') as HTMLVideoElement | null)?.currentSrc ?? null,
      ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? document.title ?? null,
      metaDesc:
        document.querySelector('meta[property="og:description"]')?.getAttribute('content') ??
        document.querySelector('meta[name="description"]')?.getAttribute('content') ??
        null,
      url: location.href,
    };
  });

  const caption = oembed?.title ?? domData.caption ?? domData.metaDesc ?? null;
  const username =
    (oembed?.author_name ? oembed.author_name.replace(/^@/, '') : null) ??
    usernameFromUrl ??
    (domData.username ? domData.username.replace(/^@/, '') : null) ??
    null;
  const authorUrl = oembed?.author_url ?? (username ? `https://www.tiktok.com/@${username}` : null) ?? domData.authorUrl;
  let stats = await extractVideoStats(page);
  const comments = await extractComments(page, commentsLimit);
  if (isEmptyStats(stats)) {
    stats = await extractVideoStats(page);
  }

  return {
    videoId: (normalizedUrl ?? currentUrl).match(/\/video\/(\d+)/)?.[1] ?? null,
    url: normalizedUrl ?? domData.url ?? currentUrl,
    title: domData.ogTitle ?? caption ?? normalizedUrl ?? currentUrl,
    caption,
    description: caption,
    username,
    authorUrl,
    videoSrc: domData.videoSrc,
    videoDownloadUrl: null,
    videoFile: null,
    stats,
    keywordMentioned: isKeywordMentioned(caption, comments, keyword),
    comments,
  };
}

async function extractVideoStats(page: Page): Promise<VideoStats> {
  const jsonStats = await extractVideoStatsFromPageJson(page);
  if (!isEmptyStats(jsonStats)) return jsonStats;

  await page
    .waitForFunction(
      () =>
        ['like-count', 'comment-count', 'favorite-count', 'share-count'].some((e2e) =>
          document.querySelector(`[data-e2e="${e2e}"]`),
        ) ||
        Array.from(document.querySelectorAll('button')).some((element) => {
          const aria = element.getAttribute('aria-label') || '';
          return /like video|read or add comments|favorites?|share video/i.test(aria);
        }),
      { timeout: 8_000 },
    )
    .catch(() => undefined);

  const raw = await page.evaluate(() => {
    const readCounter = (selector: string, ariaPattern: RegExp): string | null => {
      const direct = (document.querySelector(selector)?.textContent || '').replace(/\s+/g, ' ').trim();
      if (direct) return direct;

      const button = Array.from(document.querySelectorAll('button')).find((element) =>
        ariaPattern.test(element.getAttribute('aria-label') || ''),
      );
      const aria = button?.getAttribute('aria-label') || '';
      const match = aria.match(/([\d.,]+)\s*([KMB])?/i);
      return match ? `${match[1]}${match[2] || ''}` : null;
    };

    return {
      likes: readCounter('[data-e2e="like-count"]', /like video/i),
      comments: readCounter('[data-e2e="comment-count"]', /read or add comments/i),
      saved: readCounter('[data-e2e="favorite-count"]', /favorites?/i),
      shares: readCounter('[data-e2e="share-count"]', /share video/i),
    };
  });

  return {
    likes: parseMetricCount(raw.likes),
    comments: parseMetricCount(raw.comments),
    saved: parseMetricCount(raw.saved),
    shares: parseMetricCount(raw.shares),
    raw,
  };
}

async function extractVideoStatsFromPageJson(page: Page): Promise<VideoStats> {
  const raw = await page.evaluate(() => {
    const videoId = location.pathname.match(/\/video\/(\d+)/)?.[1] || '';
    const html = document.documentElement.innerHTML;
    const searchStart = videoId ? Math.max(0, html.indexOf(videoId) - 500) : 0;
    const searchArea = html.slice(searchStart, videoId ? searchStart + 30_000 : 80_000);
    const statsMatch = searchArea.match(/"stats":\{([^{}]+)\}/);
    const statsV2Match = searchArea.match(/"statsV2":\{([^{}]+)\}/);
    const source = statsV2Match?.[1] || statsMatch?.[1] || '';

    const readJsonCounter = (key: string): string | null => {
      const match = source.match(new RegExp(`"${key}":(?:"([^"]+)"|(\\d+(?:\\.\\d+)?))`));
      return match?.[1] || match?.[2] || null;
    };

    return {
      likes: readJsonCounter('diggCount'),
      comments: readJsonCounter('commentCount'),
      saved: readJsonCounter('collectCount'),
      shares: readJsonCounter('shareCount'),
    };
  });

  return {
    likes: parseMetricCount(raw.likes),
    comments: parseMetricCount(raw.comments),
    saved: parseMetricCount(raw.saved),
    shares: parseMetricCount(raw.shares),
    raw,
  };
}

function isEmptyStats(stats: VideoStats): boolean {
  return stats.likes === null && stats.comments === null && stats.saved === null && stats.shares === null;
}

function parseMetricCount(value: string | null): number | null {
  if (!value) return null;

  const normalized = value.trim().replace(/,/g, '');
  const match = normalized.match(/^([\d.]+)\s*([KMB])?$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : 1;
  return Math.round(amount * multiplier);
}

async function downloadVideo(
  page: Page,
  video: ScrapedVideo,
): Promise<{ filePath: string | null; downloadUrl: string | null; error?: string }> {
  try {
    const downloadUrl = await resolveVideoDownloadUrl(page, video.videoSrc);
    if (!downloadUrl) {
      throw new Error('Could not resolve the underlying TikTok CDN video URL.');
    }

    const videoId = video.url.match(/\/video\/(\d+)/)?.[1] || String(Date.now());
    const username = sanitizeFilename(video.username || 'tiktok');
    const relativePath = path.join('downloads', `${username}-${videoId}.mp4`);
    const absolutePath = path.resolve(relativePath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });

    const cookies = await page.cookies();
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => 'Mozilla/5.0');
    const response = await fetch(downloadUrl, {
      headers: {
        Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
        Referer: video.url,
        'User-Agent': userAgent,
        Accept: 'video/mp4,video/*,*/*',
      },
    });

    if (!response.ok || !response.body) {
      throw new Error(`Download request failed with HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    if (contentType.startsWith('image/') || contentType.includes('text/html')) {
      throw new Error(`Resolved URL was not a video (${contentType || 'unknown content type'}).`);
    }

    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(absolutePath));
    console.log(`Downloaded video: ${relativePath}`);

    return { filePath: relativePath, downloadUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Video download failed for ${video.url}: ${message}`);
    return { filePath: null, downloadUrl: null, error: message };
  }
}

async function resolveVideoDownloadUrl(page: Page, videoSrc: string | null): Promise<string | null> {
  if (videoSrc?.startsWith('http')) return videoSrc;

  await sleep(1000);

  return page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    for (const key of ['playAddr', 'downloadAddr']) {
      const match = html.match(new RegExp(`"${key}":"([^"]+)"`));
      if (!match?.[1]) continue;

      const decoded = match[1]
        .replace(/\\u002F/g, '/')
        .replace(/\\u0026/g, '&')
        .replace(/\\\//g, '/');
      if (decoded.startsWith('http')) return decoded;
    }

    const resourceUrls = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => {
        if (!url.startsWith('http')) return false;
        const lower = url.toLowerCase();
        return (
          lower.includes('mime_type=video') ||
          lower.includes('/video/tos/') ||
          lower.includes('/obj/tos-') ||
          lower.includes('.mp4')
        );
      });

    if (resourceUrls.length > 0) return resourceUrls[resourceUrls.length - 1];

    return null;
  });
}

function sanitizeFilename(value: string): string {
  const sanitized = value
    .trim()
    .replace(/^@/, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '');

  return sanitized || 'tiktok';
}

async function detectCaptcha(page: Page): Promise<boolean> {
  const challenge = await page
    .$('iframe[src*="challenge"], iframe[title*="captcha"], div:has(> iframe[title*="captcha"])')
    .catch(() => null);
  return Boolean(challenge);
}

export async function scrapeTikTok(options: ScrapeOptions): Promise<ScrapeResult> {
  const startedAt = nowIso();
  const startMs = Date.now();
  let browser: Browser | null = null;
  const scrapedVideoIds = options.skipExisting
    ? await loadScrapedVideoIds(options.registryPath)
    : new Set<string>();
  if (options.skipExisting) {
    console.log(`Loaded ${scrapedVideoIds.size} scraped video ID(s) from ${path.resolve(options.registryPath)}.`);
  }

  const result: ScrapeResult = {
    query: options.search,
    keyword: options.keyword,
    startedAt,
    endedAt: '',
    durationMs: 0,
    settings: {
      maxVideos: options.maxVideos,
      commentsPerVideo: options.commentsPerVideo,
      headless: options.headless,
      downloadVideo: options.downloadVideo,
      skipExisting: options.skipExisting,
      registryPath: options.registryPath,
    },
    metrics: {
      videosTargeted: options.maxVideos,
      videosScraped: 0,
      videosSkippedExisting: 0,
      totalComments: 0,
      navFailures: 0,
      captchasDetected: 0,
    },
    items: [],
  };

  try {
    browser = await puppeteer.launch({
      headless: options.headless,
      userDataDir: process.env.CHROME_USER_DATA_DIR || '.chrome-profile',
      defaultViewport: null,
      devtools: !options.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--lang=en-US,en;q=0.9',
      ],
    });

    const existingPages = await browser.pages();
    const page = existingPages[0] ?? (await browser.newPage());
    await closeExtraPages(browser, page);

    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setViewport({ width: 1366, height: 850, deviceScaleFactor: 1 });
    await page.setDefaultNavigationTimeout(0);
    await page.setDefaultTimeout(30_000);

    const discovery = await collectVideoUrlsFromSearch(page, options.search, options.maxVideos, scrapedVideoIds);
    const videoUrls = discovery.urls;
    result.metrics.videosSkippedExisting = discovery.skippedExisting;
    await closeExtraPages(browser, page);

    for (let index = 0; index < videoUrls.length; index += 1) {
      const videoUrl = videoUrls[index];
      await openVideo(page, videoUrl);
      await closeExtraPages(browser, page);

      if (await detectCaptcha(page)) {
        result.metrics.captchasDetected += 1;
        console.warn('Captcha detected. Solve it in Chrome, then press Enter here.');
        await new Promise<void>((resolve) => {
          process.stdin.resume();
          process.stdin.once('data', () => {
            process.stdin.pause();
            resolve();
          });
        });
      }

      console.log(`Scraping video ${index + 1}/${options.maxVideos}: ${page.url()}`);
      const video = await extractVideo(page, options.keyword, options.commentsPerVideo);

      if (options.downloadVideo) {
        const download = await downloadVideo(page, video);
        video.videoFile = download.filePath;
        video.videoDownloadUrl = download.downloadUrl;
        if (download.error) video.downloadError = download.error;
      }

      result.items.push(video);
      result.metrics.videosScraped = result.items.length;
      result.metrics.totalComments += video.comments.length;
      if (video.videoId && options.skipExisting) {
        await saveScrapedVideoId(scrapedVideoIds, video.videoId, options.registryPath);
      }

      await sleep(600);
    }
  } finally {
    result.endedAt = nowIso();
    result.durationMs = Date.now() - startMs;

    if (browser && !options.keepBrowserOpen) {
      await browser.close().catch(() => undefined);
    }
  }

  return result;
}

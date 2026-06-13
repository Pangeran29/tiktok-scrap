import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, HTTPResponse, Page } from 'puppeteer';

import { extractComments } from './comments';
import type { ScrapeOptions, ScrapeResult, ScrapedVideo, VideoStats } from './types';
import {
  buildSearchUrl,
  normalizeVideoUrl,
  nowIso,
  randomInteger,
  sleep,
  timestampForFile,
} from './utils';
import { loadScrapedVideoIds, saveScrapedVideoId } from './video-registry';

puppeteer.use(StealthPlugin());

type OEmbed = {
  title?: string;
  author_name?: string;
  author_url?: string;
};

const V2_TIMING = {
  homepageSettle: [1_200, 2_200],
  typingDelay: [55, 145],
  searchSettle: [1_500, 2_800],
  tabSettle: [1_000, 2_000],
  viewerDwell: [700, 1_400],
  transitionSettle: [900, 1_800],
} as const;

const V2_MAX_VIEWER_POSITIONS_FACTOR = 8;
const V2_MAX_REPEATED_IDS = 3;
const execFileAsync = promisify(execFile);
const mediaResponsesByPage = new WeakMap<Page, string[]>();

function trackMediaResponses(page: Page): void {
  mediaResponsesByPage.set(page, []);
  page.on('response', (response: HTTPResponse) => {
    const url = response.url();
    const contentType = response.headers()['content-type']?.toLowerCase() || '';
    const lower = url.toLowerCase();
    if (
      !url.startsWith('http') ||
      (!contentType.startsWith('video/') &&
        !lower.includes('mime_type=video') &&
        !lower.includes('/video/tos/') &&
        !lower.includes('/obj/tos-') &&
        !lower.includes('.mp4'))
    ) {
      return;
    }
    const urls = mediaResponsesByPage.get(page);
    if (urls && !urls.includes(url)) urls.push(url);
  });
}

async function resetMediaResponses(page: Page): Promise<void> {
  mediaResponsesByPage.set(page, []);
  await page.evaluate(() => performance.clearResourceTimings()).catch(() => undefined);
}

export function videoIdFromUrl(url: string): string | null {
  return url.match(/\/video\/(\d+)/)?.[1] ?? null;
}

export function didVideoChange(previousUrl: string, currentUrl: string): boolean {
  const previousId = videoIdFromUrl(previousUrl);
  const currentId = videoIdFromUrl(currentUrl);
  return Boolean(previousId && currentId && previousId !== currentId);
}

async function randomSleep(range: readonly [number, number]): Promise<void> {
  await sleep(randomInteger(range[0], range[1]));
}

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

async function extractVideo(page: Page, commentsLimit: number): Promise<ScrapedVideo> {
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

    const visibleVideos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const activeVideo =
      visibleVideos
        .filter((video) => {
          const rect = video.getBoundingClientRect();
          const style = getComputedStyle(video);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        })
        .sort((a, b) => {
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          const aScore = (a.paused ? 0 : 1_000_000_000) + aRect.width * aRect.height;
          const bScore = (b.paused ? 0 : 1_000_000_000) + bRect.width * bRect.height;
          return bScore - aScore;
        })[0] ?? null;

    return {
      caption,
      username,
      authorUrl,
      videoSrc: activeVideo?.currentSrc || activeVideo?.src || null,
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
    caption,
    username,
    authorUrl,
    videoSrc: domData.videoSrc,
    videoDownloadUrl: null,
    videoFile: null,
    stats,
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
    const videoId = video.url.match(/\/video\/(\d+)/)?.[1] || String(Date.now());
    const username = sanitizeFilename(video.username || 'tiktok');
    const relativePath = path.join('downloads', `${username}-${videoId}.mp4`);
    const absolutePath = path.resolve(relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });

    if (video.videoSrc?.startsWith('blob:')) {
      try {
        await streamBlobVideo(page, video.videoSrc, absolutePath);
        console.log(`Downloaded active viewer video: ${relativePath}`);
        return { filePath: relativePath, downloadUrl: video.videoSrc };
      } catch {
        // TikTok commonly uses a MediaSource blob that cannot be fetched directly.
      }
    }

    const cookies = await page.cookies();
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => 'Mozilla/5.0');
    const requestHeaders = {
      Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
      Referer: video.url,
      'User-Agent': userAgent,
    };
    const downloadUrl =
      (await resolveVideoUrlFromItemApi(page, videoId)) ??
      (await resolveVideoUrlFromCanonicalPage(video.url, requestHeaders)) ??
      (await resolveVideoUrlByDuration(page, requestHeaders)) ??
      (await resolveVideoDownloadUrl(page, video.videoSrc));
    if (!downloadUrl) {
      throw new Error('Could not resolve the underlying TikTok CDN video URL.');
    }

    const response = await fetch(downloadUrl, {
      headers: {
        ...requestHeaders,
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

async function resolveVideoUrlByDuration(page: Page, headers: Record<string, string>): Promise<string | null> {
  const candidates = mediaResponsesByPage.get(page) ?? [];
  if (candidates.length === 0) return null;

  const activeDuration = await page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const active = videos
      .filter((video) => {
        const rect = video.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && Number.isFinite(video.duration) && video.duration > 0;
      })
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        const aScore = (a.paused ? 0 : 1_000_000_000) + aRect.width * aRect.height;
        const bScore = (b.paused ? 0 : 1_000_000_000) + bRect.width * bRect.height;
        return bScore - aScore;
      })[0];
    return active?.duration ?? null;
  });
  if (!activeDuration) return null;

  const headerText = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('');
  let best: { url: string; difference: number } | null = null;

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-headers',
          headerText,
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          candidate,
        ],
        { timeout: 15_000, maxBuffer: 1024 * 1024 },
      );
      const duration = Number(stdout.trim());
      if (!Number.isFinite(duration)) continue;
      const difference = Math.abs(duration - activeDuration);
      if (!best || difference < best.difference) best = { url: candidate, difference };
    } catch {
      // Ignore candidates that cannot be probed.
    }
  }

  return best && best.difference <= 1.5 ? best.url : null;
}

async function resolveVideoUrlFromItemApi(page: Page, videoId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    try {
      const response = await fetch(`/api/item/detail/?itemId=${encodeURIComponent(id)}`, {
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*' },
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as {
        itemInfo?: {
          itemStruct?: {
            id?: string;
            video?: {
              playAddr?: string;
              downloadAddr?: string;
              playApi?: string;
            };
          };
        };
      };
      const item = payload.itemInfo?.itemStruct;
      if (item?.id !== id) return null;
      return item.video?.playAddr ?? item.video?.downloadAddr ?? item.video?.playApi ?? null;
    } catch {
      return null;
    }
  }, videoId);
}

async function streamBlobVideo(page: Page, blobUrl: string, absolutePath: string): Promise<void> {
  const callbackName = `__writeVideoChunk_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const output = createWriteStream(absolutePath);

  await page.exposeFunction(callbackName, async (base64Chunk: string) => {
    const chunk = Buffer.from(base64Chunk, 'base64');
    if (!output.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        output.once('drain', resolve);
        output.once('error', reject);
      });
    }
  });

  try {
    await page.evaluate(
      async ({ source, callback }) => {
        const response = await fetch(source);
        if (!response.ok || !response.body) {
          throw new Error(`Failed to read active video blob: HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          let binary = '';
          const blockSize = 0x8000;
          for (let offset = 0; offset < value.length; offset += blockSize) {
            binary += String.fromCharCode(...value.subarray(offset, offset + blockSize));
          }
          await (window as unknown as Record<string, (chunk: string) => Promise<void>>)[callback](btoa(binary));
        }
      },
      { source: blobUrl, callback: callbackName },
    );

    await new Promise<void>((resolve, reject) => {
      output.end(resolve);
      output.once('error', reject);
    });
  } catch (error) {
    output.destroy();
    await fs.rm(absolutePath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await page.removeExposedFunction(callbackName).catch(() => undefined);
  }
}

function readVideoAddress(value: unknown): string | null {
  if (typeof value === 'string') return value.startsWith('http') ? value : null;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const address = readVideoAddress(candidate);
      if (address) return address;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  for (const key of ['urlList', 'url_list', 'urls', 'url']) {
    const address = readVideoAddress(record[key]);
    if (address) return address;
  }
  return null;
}

function findVideoAddressById(root: unknown, videoId: string): string | null {
  const pending: unknown[] = [root];
  const visited = new Set<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);

    if (!Array.isArray(current)) {
      const record = current as Record<string, unknown>;
      const currentId = String(
        record.id ?? record.itemId ?? record.videoId ?? record.aweme_id ?? record.awemeId ?? '',
      );
      if (currentId === videoId) {
        const video =
          record.video && typeof record.video === 'object'
            ? (record.video as Record<string, unknown>)
            : record;
        for (const key of ['playAddr', 'downloadAddr', 'playApi', 'play_addr', 'download_addr']) {
          const address = readVideoAddress(video[key]);
          if (address) return address.replace(/\\u002F/g, '/').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
        }
      }
    }

    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return null;
}

async function resolveVideoUrlFromCanonicalPage(
  videoUrl: string,
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const videoId = videoIdFromUrl(videoUrl);
    if (!videoId) return null;

    const response = await fetch(videoUrl, { headers });
    if (!response.ok) return null;
    const html = await response.text();

    const scriptPattern = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
    for (const match of html.matchAll(scriptPattern)) {
      const content = match[1]?.trim();
      if (!content || !content.includes(videoId)) continue;
      try {
        const address = findVideoAddressById(JSON.parse(content), videoId);
        if (address) return address;
      } catch {
        // Ignore non-standard JSON script payloads.
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveVideoDownloadUrl(page: Page, videoSrc: string | null): Promise<string | null> {
  if (videoSrc?.startsWith('http')) return videoSrc;

  await sleep(1000);

  const pageUrl = await page.evaluate(() => {
    const videoId = location.pathname.match(/\/video\/(\d+)/)?.[1] || '';

    const decodeVideoUrl = (value: string) =>
      value
        .replace(/\\u002F/g, '/')
        .replace(/\\u0026/g, '&')
        .replace(/\\\//g, '/');

    const readAddress = (value: unknown): string | null => {
      if (typeof value === 'string') return value.startsWith('http') ? decodeVideoUrl(value) : null;
      if (!Array.isArray(value)) return null;
      const address = value.find((candidate): candidate is string => typeof candidate === 'string' && candidate.startsWith('http'));
      return address ? decodeVideoUrl(address) : null;
    };

    const findMatchingVideo = (root: unknown): string | null => {
      const pending: unknown[] = [root];
      const visited = new Set<object>();

      while (pending.length > 0) {
        const current = pending.pop();
        if (!current || typeof current !== 'object') continue;
        if (visited.has(current)) continue;
        visited.add(current);

        if (!Array.isArray(current)) {
          const record = current as Record<string, unknown>;
          const currentId = String(record.id ?? record.itemId ?? record.videoId ?? '');
          if (currentId === videoId) {
            const video = record.video && typeof record.video === 'object'
              ? (record.video as Record<string, unknown>)
              : record;
            for (const key of ['playAddr', 'downloadAddr', 'playApi']) {
              const address = readAddress(video[key]);
              if (address) return address;
            }
          }
        }

        for (const child of Array.isArray(current) ? current : Object.values(current)) {
          if (child && typeof child === 'object') pending.push(child);
        }
      }
      return null;
    };

    const jsonScripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
    for (const script of jsonScripts) {
      const content = script.textContent?.trim();
      if (!content || !content.includes(videoId)) continue;
      try {
        const address = findMatchingVideo(JSON.parse(content));
        if (address) return address;
      } catch {
        // Some application/json scripts contain non-standard payloads.
      }
    }

    const visibleVideos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const activeVideo = visibleVideos
      .filter((video) => {
        const rect = video.getBoundingClientRect();
        const style = getComputedStyle(video);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      })
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        const aScore = (a.paused ? 0 : 1_000_000_000) + aRect.width * aRect.height;
        const bScore = (b.paused ? 0 : 1_000_000_000) + bRect.width * bRect.height;
        return bScore - aScore;
      })[0];
    const activeSrc = activeVideo?.currentSrc || activeVideo?.src || '';
    if (activeSrc.startsWith('http')) return activeSrc;

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

    if (resourceUrls.length === 1) return resourceUrls[0];

    return null;
  });
  if (pageUrl) return pageUrl;

  return null;
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

async function saveDebugArtifacts(page: Page, stage: string): Promise<void> {
  const safeStage = stage.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'failure';
  const directory = path.resolve('debug', `${timestampForFile()}-${safeStage}`);

  try {
    await fs.mkdir(directory, { recursive: true });
    await Promise.all([
      page.screenshot({ path: path.join(directory, 'page.png'), fullPage: true }),
      fs.writeFile(path.join(directory, 'page.html'), await page.content(), 'utf8'),
      fs.writeFile(
        path.join(directory, 'context.json'),
        `${JSON.stringify({ stage, url: page.url(), capturedAt: nowIso() }, null, 2)}\n`,
        'utf8',
      ),
    ]);
    console.error(`Debug artifacts: ${directory}`);
  } catch (error) {
    console.warn(`Failed to save debug artifacts: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForSearchResults(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      location.pathname.startsWith('/search') &&
      (document.querySelectorAll('a[href*="/video/"]').length > 0 ||
        Boolean(document.querySelector('[data-e2e="search-video-item"]'))),
    { timeout: 30_000 },
  );
}

async function performHomepageSearch(page: Page, search: string): Promise<void> {
  console.log('Opening TikTok homepage for v2 search.');
  const navSearchSelector = 'button[data-e2e="nav-search"], [data-e2e="nav-search"]';
  let navSearch = null;
  for (let attempt = 1; attempt <= 2 && !navSearch; attempt += 1) {
    const response = await page.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await assertTikTokAccess(page, response?.status() ?? null);
    await randomSleep(V2_TIMING.homepageSettle);
    await page
      .waitForFunction(
        (selector) =>
          Array.from(document.querySelectorAll(selector)).some((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && !element.hasAttribute('disabled');
          }),
        { timeout: 30_000 },
        navSearchSelector,
      )
      .catch(() => undefined);

    const navSearchCandidates = await page.$$(navSearchSelector);
    for (const candidate of navSearchCandidates) {
      const visible = await candidate.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !element.hasAttribute('disabled');
      });
      if (visible) {
        navSearch = candidate;
        break;
      }
    }
    if (!navSearch && attempt === 1) {
      console.warn('TikTok homepage search did not render; reloading once.');
      await randomSleep([1_000, 2_000]);
    }
  }
  if (!navSearch) throw new Error('V2 could not locate the TikTok navigation search button.');

  const searchSelector = 'form[data-e2e="search-box"] input[data-e2e="search-user-input"]';
  const visibleSearchInput = (timeout: number) =>
    page
      .waitForFunction(
        (selector) =>
          Array.from(document.querySelectorAll(selector)).some((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && !element.hasAttribute('disabled');
          }),
        { timeout },
        searchSelector,
      )
      .then(() => true)
      .catch(() => false);

  await navSearch.click();
  await randomSleep([350, 800]);
  let searchOpened = await visibleSearchInput(4_000);

  if (!searchOpened) {
    const box = await navSearch.boundingBox();
    if (!box) throw new Error('V2 navigation search button was not clickable.');
    console.warn('TikTok ignored the first Search click; retrying with a coordinate click.');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await randomSleep([500, 1_000]);
    searchOpened = await visibleSearchInput(10_000);
  }

  if (!searchOpened) throw new Error('V2 Search button did not open the search input.');

  const searchInputs = await page.$$(searchSelector);
  let input = null;
  for (const candidate of searchInputs) {
    const visible = await candidate.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !element.hasAttribute('disabled');
    });
    if (visible) {
      input = candidate;
      break;
    }
  }
  if (!input) throw new Error('V2 could not locate the opened TikTok search input.');
  let typedValue = '';
  for (let attempt = 1; attempt <= 2 && typedValue.trim() !== search; attempt += 1) {
    await input.click({ clickCount: 3 });
    const selectModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(selectModifier);
    await page.keyboard.press('A');
    await page.keyboard.up(selectModifier);
    await page.keyboard.press('Backspace');
    await input.type(search, { delay: randomInteger(V2_TIMING.typingDelay[0], V2_TIMING.typingDelay[1]) });
    await randomSleep([250, 650]);
    typedValue = await input.evaluate((element) => (element as HTMLInputElement).value);
    if (typedValue.trim() !== search && attempt === 1) {
      console.warn('TikTok search input lost focus while typing; retrying once.');
    }
  }

  if (typedValue.trim() !== search) {
    throw new Error(`V2 search input did not receive the expected query "${search}" (received "${typedValue}").`);
  }

  await page.keyboard.press('Enter');
  await waitForSearchResults(page);
  await randomSleep(V2_TIMING.searchSettle);
}

async function selectVideosTab(page: Page): Promise<void> {
  const candidates = await page.$$('[role="tab"], a, button');
  let videosTab = null;
  for (const candidate of candidates) {
    const isVideosTab = await candidate.evaluate((element) => {
      const htmlElement = element as HTMLElement;
      const text = (htmlElement.innerText || htmlElement.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const rect = htmlElement.getBoundingClientRect();
      return text === 'videos' && rect.width > 0 && rect.height > 0;
    });
    if (isVideosTab) {
      videosTab = candidate;
      break;
    }
  }
  if (!videosTab) throw new Error('V2 could not locate the Videos search tab.');

  await videosTab.click();
  await page.waitForFunction(() => location.pathname === '/search/video', { timeout: 15_000 });
  const loaded = await waitForSearchResults(page)
    .then(() => true)
    .catch(() => false);
  if (!loaded) {
    console.warn('TikTok Videos tab was active but results stayed blank; reloading the same tab once.');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForSearchResults(page);
  }
  await randomSleep(V2_TIMING.tabSettle);
  console.log(`Videos tab active: ${page.url()}`);
}

async function openFirstVideoFromResults(page: Page): Promise<void> {
  if (new URL(page.url()).pathname !== '/search/video') {
    throw new Error(`V2 refused to open a result before the Videos tab was active: ${page.url()}`);
  }

  const links = await page.$$('a[href*="/video/"]');
  for (const link of links) {
    const visible = await link
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .catch(() => false);
    if (!visible) continue;

    await resetMediaResponses(page);
    await link.click();
    await page.waitForFunction(
      () =>
        /\/video\/\d+/.test(location.href) &&
        (Boolean(document.querySelector('video')) || Boolean(document.querySelector('[data-e2e="video-desc"]'))),
      { timeout: 20_000 },
    );
    await randomSleep(V2_TIMING.viewerDwell);
    return;
  }
  throw new Error('V2 could not find a visible video result to open.');
}

async function clickNextVideoControl(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
    const control = candidates.find((element) => {
      const aria = (element.getAttribute('aria-label') || '').toLowerCase();
      const title = (element.getAttribute('title') || '').toLowerCase();
      const testId = (element.getAttribute('data-e2e') || '').toLowerCase();
      const combined = `${aria} ${title} ${testId}`;
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        (/next|down/.test(combined) || /arrow-down|arrowdown/.test(element.innerHTML.toLowerCase()))
      );
    });
    control?.click();
    return Boolean(control);
  });
}

async function waitForVideoChange(page: Page, previousUrl: string, timeout: number): Promise<boolean> {
  return page
    .waitForFunction(
      (previous) => {
        const previousId = previous.match(/\/video\/(\d+)/)?.[1];
        const currentId = location.href.match(/\/video\/(\d+)/)?.[1];
        return Boolean(previousId && currentId && previousId !== currentId);
      },
      { timeout },
      previousUrl,
    )
    .then(() => true)
    .catch(() => false);
}

async function advanceViewer(page: Page): Promise<void> {
  const previousUrl = page.url();
  await resetMediaResponses(page);
  await page.keyboard.press('ArrowDown');
  let changed = await waitForVideoChange(page, previousUrl, 5_000);

  if (!changed) {
    const clicked = await clickNextVideoControl(page);
    if (!clicked) throw new Error('V2 could not locate a next/down viewer control after ArrowDown failed.');
    changed = await waitForVideoChange(page, previousUrl, 8_000);
  }

  if (!changed || !didVideoChange(previousUrl, page.url())) {
    throw new Error(`V2 viewer did not advance from ${previousUrl}.`);
  }
  await randomSleep(V2_TIMING.transitionSettle);
}

async function handleCaptcha(page: Page, result: ScrapeResult): Promise<void> {
  if (!(await detectCaptcha(page))) return;

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

async function appendCurrentVideo(
  page: Page,
  options: ScrapeOptions,
  result: ScrapeResult,
  scrapedVideoIds: Set<string>,
  useViewerPacing = false,
): Promise<void> {
  console.log(`Scraping video ${result.items.length + 1}/${options.maxVideos}: ${page.url()}`);
  if (useViewerPacing) await randomSleep(V2_TIMING.viewerDwell);
  const video = await extractVideo(page, options.commentsPerVideo);

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
}

async function scrapeWithV1(
  browser: Browser,
  page: Page,
  options: ScrapeOptions,
  result: ScrapeResult,
  scrapedVideoIds: Set<string>,
): Promise<void> {
  const discovery = await collectVideoUrlsFromSearch(page, options.search, options.maxVideos, scrapedVideoIds);
  result.metrics.videosSkippedExisting = discovery.skippedExisting;
  await closeExtraPages(browser, page);

  for (const videoUrl of discovery.urls) {
    await resetMediaResponses(page);
    await openVideo(page, videoUrl);
    await closeExtraPages(browser, page);
    await handleCaptcha(page, result);
    await appendCurrentVideo(page, options, result, scrapedVideoIds);
    await sleep(600);
  }
}

async function scrapeWithV2(
  browser: Browser,
  page: Page,
  options: ScrapeOptions,
  result: ScrapeResult,
  scrapedVideoIds: Set<string>,
): Promise<void> {
  await performHomepageSearch(page, options.search);
  await selectVideosTab(page);
  await openFirstVideoFromResults(page);
  await closeExtraPages(browser, page);

  const seenPositions = new Set<string>();
  let repeatedPositions = 0;
  const maxPositions = Math.max(20, options.maxVideos * V2_MAX_VIEWER_POSITIONS_FACTOR);

  for (let position = 0; position < maxPositions && result.items.length < options.maxVideos; position += 1) {
    await handleCaptcha(page, result);
    const videoId = videoIdFromUrl(page.url());
    if (!videoId) throw new Error(`V2 viewer URL does not contain a video ID: ${page.url()}`);

    if (seenPositions.has(videoId)) {
      repeatedPositions += 1;
      if (repeatedPositions >= V2_MAX_REPEATED_IDS) {
        throw new Error(`V2 viewer repeated video ${videoId} too many times.`);
      }
    } else {
      seenPositions.add(videoId);
      repeatedPositions = 0;
      if (options.skipExisting && scrapedVideoIds.has(videoId)) {
        result.metrics.videosSkippedExisting += 1;
        console.log(`Skipping previously scraped video ${videoId}.`);
      } else {
        await appendCurrentVideo(page, options, result, scrapedVideoIds, true);
      }
    }

    if (result.items.length < options.maxVideos) await advanceViewer(page);
  }

  if (result.items.length < options.maxVideos) {
    throw new Error(`V2 exhausted ${maxPositions} viewer positions before scraping ${options.maxVideos} new videos.`);
  }
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
      flow: options.flow,
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
      defaultViewport: { width: 1366, height: 850, deviceScaleFactor: 1 },
      devtools: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--lang=en-US,en;q=0.9',
        '--window-size=1440,1000',
      ],
    });

    const existingPages = await browser.pages();
    const page = existingPages[0] ?? (await browser.newPage());
    await closeExtraPages(browser, page);
    trackMediaResponses(page);

    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setViewport({ width: 1366, height: 850, deviceScaleFactor: 1 });
    await page.setDefaultNavigationTimeout(0);
    await page.setDefaultTimeout(30_000);

    if (options.flow === 'v1') {
      await scrapeWithV1(browser, page, options, result, scrapedVideoIds);
    } else {
      await scrapeWithV2(browser, page, options, result, scrapedVideoIds);
    }
  } catch (error) {
    result.metrics.navFailures += 1;
    const pages = browser ? await browser.pages().catch(() => []) : [];
    const activePage = pages.find((candidate) => !candidate.isClosed());
    if (activePage) await saveDebugArtifacts(activePage, `${options.flow}-navigation`);
    throw error;
  } finally {
    result.endedAt = nowIso();
    result.durationMs = Date.now() - startMs;

    if (browser && !options.keepBrowserOpen) {
      await browser.close().catch(() => undefined);
    }
  }

  return result;
}

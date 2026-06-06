import fs from 'node:fs/promises';
import path from 'node:path';

import type { CliOptions } from './types';
import { openTikTokForDebug, scrapeTikTok } from './scraper';
import { defaultOutputPath, parsePositiveInteger } from './utils';

function readFlag(args: string[], name: string): string | undefined {
  const eqPrefix = `--${name}=`;
  const eqMatch = args.find((arg) => arg.startsWith(eqPrefix));
  if (eqMatch) return eqMatch.slice(eqPrefix.length);

  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;

  const value = args[index + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

export function parseCliArgs(args: string[], env = process.env): CliOptions {
  const search = readFlag(args, 'search')?.trim();
  if (!search) throw new Error('--search is required');

  return {
    search,
    keyword: readFlag(args, 'keyword')?.trim() || null,
    maxVideos: parsePositiveInteger(readFlag(args, 'max') ?? env.MAX_VIDEOS, 10, 'max'),
    commentsPerVideo: parsePositiveInteger(readFlag(args, 'comments') ?? env.COMMENTS_PER_VIDEO, 50, 'comments'),
    headless: hasFlag(args, 'headless') || env.HEADLESS === '1' || env.HEADLESS?.toLowerCase() === 'true',
    keepBrowserOpen: hasFlag(args, 'keep-browser-open') || env.KEEP_BROWSER_OPEN === '1',
    downloadVideo: hasFlag(args, 'download-video'),
    output: readFlag(args, 'output') || null,
  };
}

async function main() {
  if (hasFlag(process.argv.slice(2), 'open-only')) {
    const args = process.argv.slice(2);
    const search = readFlag(args, 'search')?.trim() || null;
    const headless = hasFlag(args, 'headless') || process.env.HEADLESS === '1' || process.env.HEADLESS?.toLowerCase() === 'true';
    await openTikTokForDebug(search, headless);
    return;
  }

  const options = parseCliArgs(process.argv.slice(2));
  const outputPath = path.resolve(options.output ?? defaultOutputPath());

  console.log(`Search: ${options.search}`);
  if (options.keyword) console.log(`Keyword: ${options.keyword}`);
  console.log(`Max videos: ${options.maxVideos}`);
  console.log(`Comments per video: ${options.commentsPerVideo}`);
  console.log(`Headless: ${options.headless}`);
  console.log(`Download video: ${options.downloadVideo}`);

  const result = await scrapeTikTok(options);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log(`Scraped ${result.metrics.videosScraped}/${result.metrics.videosTargeted} videos.`);
  console.log(`Collected ${result.metrics.totalComments} comments.`);
  console.log(`Output: ${outputPath}`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Scrape failed: ${message}`);
    process.exitCode = 1;
  });
}

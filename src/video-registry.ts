import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_REGISTRY_PATH = path.join('data', 'scraped-video-ids.json');

export async function loadScrapedVideoIds(registryPath: string): Promise<Set<string>> {
  const absolutePath = path.resolve(registryPath);

  try {
    const content = await fs.readFile(absolutePath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error('Registry must contain a JSON array.');

    return new Set(parsed.filter((value): value is string => typeof value === 'string' && value.length > 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return new Set();
    throw new Error(`Failed to read ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveScrapedVideoId(ids: Set<string>, videoId: string, registryPath: string): Promise<void> {
  if (ids.has(videoId)) return;

  const absolutePath = path.resolve(registryPath);
  ids.add(videoId);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  const temporaryPath = `${absolutePath}.tmp`;
  const sortedIds = Array.from(ids).sort();
  await fs.writeFile(temporaryPath, `${JSON.stringify(sortedIds, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, absolutePath);
}

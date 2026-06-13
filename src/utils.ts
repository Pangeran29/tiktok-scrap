import path from 'node:path';

import type { ScrapedComment } from './types';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomInteger(min: number, max: number, random = Math.random): number {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
    throw new Error('Invalid random integer range');
  }
  return Math.floor(random() * (max - min + 1)) + min;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function timestampForFile(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

export function defaultOutputPath(cwd = process.cwd(), date = new Date()): string {
  return path.join(cwd, 'output', `tiktok-scrape-${timestampForFile(date)}.json`);
}

export function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

export function containsKeyword(value: string | null | undefined, keyword: string | null | undefined): boolean {
  const normalizedKeyword = normalizeText(keyword).trim();
  return normalizedKeyword.length > 0 && normalizeText(value).includes(normalizedKeyword);
}

export function isKeywordMentioned(
  description: string | null | undefined,
  comments: ScrapedComment[],
  keyword: string | null | undefined,
): boolean {
  return containsKeyword(description, keyword) || comments.some((comment) => containsKeyword(comment.text, keyword));
}

export function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }

  return parsed;
}

export function normalizeVideoUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const match = url.pathname.match(/\/@([^/]+)\/video\/(\d+)/);
    if (!match) return null;
    return `https://www.tiktok.com/@${match[1]}/video/${match[2]}`;
  } catch {
    return null;
  }
}

export function buildSearchUrl(search: string): string {
  const trimmed = search.trim();
  if (!trimmed) throw new Error('--search is required');

  return `https://www.tiktok.com/search/video?q=${encodeURIComponent(trimmed)}`;
}

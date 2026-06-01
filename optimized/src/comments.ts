import type { Page } from 'puppeteer';

import type { ScrapedComment } from './types';
import { sleep } from './utils';

export async function extractComments(
  page: Page,
  limit: number,
  hardTimeoutMs = 12_000,
): Promise<ScrapedComment[]> {
  if (limit <= 0) return [];

  await openCommentsPanel(page);

  await Promise.race([
    page.waitForSelector('[data-e2e="comment-level-1"]', { timeout: 8000 }).catch(() => null),
    page.waitForSelector('[data-e2e="comment-text"]', { timeout: 8000 }).catch(() => null),
    page.waitForSelector('[data-e2e="comment-list"]', { timeout: 8000 }).catch(() => null),
    page.waitForSelector('[data-e2e="browse-comment-viewport"]', { timeout: 8000 }).catch(() => null),
  ]);

  const containerSelector = await page.evaluate(() => {
    const firstText =
      document.querySelector('[data-e2e="comment-level-1"]') ||
      document.querySelector('[data-e2e="comment-text"]');

    function isScrollable(el: HTMLElement) {
      const style = getComputedStyle(el);
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
    }

    if (firstText) {
      let current = firstText.parentElement;
      for (let i = 0; current && i < 8 && current !== document.body; i += 1) {
        if (isScrollable(current)) {
          if (current.dataset?.e2e) return `[data-e2e="${current.dataset.e2e}"]`;
          const className = current.getAttribute('class');
          if (className) return `div.${className.split(' ').join('.')}`;
          return 'div';
        }
        current = current.parentElement;
      }
    }

    const known =
      document.querySelector('[data-e2e="comment-list"]') ||
      document.querySelector('[data-e2e="browse-comment-viewport"]') ||
      document.querySelector('div[class*="CommentList"]') ||
      document.querySelector('div[class*="commentList"]');

    if (!known) return null;
    if ((known as HTMLElement).dataset?.e2e) return `[data-e2e="${(known as HTMLElement).dataset.e2e}"]`;

    const className = known.getAttribute('class');
    return className ? `div.${className.split(' ').join('.')}` : 'div';
  });

  const initialCount = await countComments(page);
  if (!containerSelector && initialCount === 0) {
    console.warn('Comment panel was not available for this video; skipping page-level scroll to avoid related-video tabs.');
    return [];
  }

  const deadline = Date.now() + hardTimeoutMs;
  let lastCount = initialCount;

  while (Date.now() < deadline) {
    if (containerSelector) {
      await page
        .evaluate((selector) => {
          const el = document.querySelector(selector) as HTMLElement | null;
          if (el) el.scrollTop += el.clientHeight || 800;
        }, containerSelector)
        .catch(() => undefined);
    } else {
      break;
    }

    await sleep(350);

    const count = await countComments(page);

    if (count >= limit) break;

    if (count > 0 && count === lastCount && containerSelector) {
      await page
        .evaluate((selector) => {
          const el = document.querySelector(selector) as HTMLElement | null;
          if (el) el.scrollTop = el.scrollHeight;
        }, containerSelector)
        .catch(() => undefined);
      await sleep(300);
    }

    lastCount = count;
  }

  return page.evaluate((max) => {
    const textNodes = Array.from(
      document.querySelectorAll('[data-e2e="comment-level-1"], [data-e2e="comment-text"]'),
    ) as HTMLElement[];

    function findHandleFrom(el: Element | null): string | null {
      if (!el) return null;

      const container =
        (el.closest('div[class*="CommentContentContainer"]') as HTMLElement | null) ||
        (el.closest('div[class*="DivCommentContentContainer"]') as HTMLElement | null) ||
        (el.closest('div[class*="ContentContainer"]') as HTMLElement | null) ||
        (el.parentElement as HTMLElement | null);

      const anchors = Array.from(
        container?.querySelectorAll('a[href^="/@"], a[href*="tiktok.com/@"]') ?? [],
      ) as HTMLAnchorElement[];

      for (const anchor of anchors) {
        const match = (anchor.getAttribute('href') || '').match(/\/@([^/?#]+)/);
        if (match?.[1]) return match[1];
      }

      return null;
    }

    const results: ScrapedComment[] = [];

    for (const textNode of textNodes) {
      const text = (textNode.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;

      const wrapper =
        (textNode.closest('div[id][class*="CommentItemContainer"]') as HTMLElement | null) ||
        (textNode.closest('[data-e2e="comment-item"]') as HTMLElement | null) ||
        (textNode.parentElement as HTMLElement | null);

      const likesText = (wrapper?.querySelector('[data-e2e="comment-like-count"]')?.textContent || '').trim();
      const likes = likesText ? Number(likesText.replace(/[^\d]/g, '')) : undefined;

      results.push({
        username: findHandleFrom(textNode) || 'unknown',
        text,
        time: (wrapper?.querySelector('[data-e2e^="comment-time"]')?.textContent || '').trim() || undefined,
        likes: Number.isFinite(likes) ? likes : undefined,
      });

      if (results.length >= max) break;
    }

    return results;
  }, limit);
}

async function openCommentsPanel(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll('button, [role="tab"]')).some((element) => {
          const text = (element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const aria = (element.getAttribute('aria-label') || '').toLowerCase();
          return aria.includes('read or add comments') || text === 'comments' || text.startsWith('comments ');
        }),
      { timeout: 10_000 },
    )
    .catch(() => undefined);

  const clickedCommentCount = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const button = buttons.find((element) => /read or add comments/i.test(element.getAttribute('aria-label') || ''));
    button?.click();
    return Boolean(button);
  });

  if (clickedCommentCount) {
    await sleep(1200);
    await clickCommentsTab(page);
    await sleep(1000);
    if ((await countComments(page)) > 0) return;
  }

  const clickedTab = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('[role="tab"], button')) as HTMLElement[];
    const commentsTab = candidates.find((element) => {
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = element.getAttribute('aria-label') || '';
      const combined = `${text} ${aria}`.toLowerCase();

      if (!combined.includes('comment')) return false;
      if (combined.includes('you may like') || combined.includes('related')) return false;

      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    commentsTab?.click();
    return Boolean(commentsTab);
  });

  if (clickedTab) {
    await sleep(1000);
    if ((await countComments(page)) > 0) return;
  }

  const openSelectors = [
    '[data-e2e="browse-comment-icon"]',
    '[data-e2e="comment-icon"]',
    '[data-e2e="comment-tab"]',
    'button[aria-label*="comment" i]',
  ];

  for (const selector of openSelectors) {
    const button = await page.$(selector);
    if (!button) continue;

    await button.click().catch(() => undefined);
    await sleep(1000);
    await clickCommentsTab(page);
    await sleep(700);
    if ((await countComments(page)) > 0) return;
  }
}

async function clickCommentsTab(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"], button')) as HTMLElement[];
      const commentsTab = tabs.find((element) => {
        const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const aria = (element.getAttribute('aria-label') || '').toLowerCase();
        const combined = `${text} ${aria}`;

        if (combined.includes('you may like') || combined.includes('related')) return false;
        return text === 'comments' || text.startsWith('comments ') || aria.includes('comments');
      });
      commentsTab?.click();
    })
    .catch(() => undefined);
}

async function countComments(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll('[data-e2e="comment-level-1"], [data-e2e="comment-text"]').length,
  );
}

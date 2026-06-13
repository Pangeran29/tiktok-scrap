import assert from 'node:assert/strict';
import test from 'node:test';

import { didVideoChange, videoIdFromUrl } from './scraper';
import { randomInteger } from './utils';

test('randomInteger includes both bounds', () => {
  assert.equal(randomInteger(10, 20, () => 0), 10);
  assert.equal(randomInteger(10, 20, () => 0.999999), 20);
});

test('randomInteger rejects invalid ranges', () => {
  assert.throws(() => randomInteger(20, 10), /Invalid random integer range/);
});

test('video transition helpers require distinct valid video IDs', () => {
  const first = 'https://www.tiktok.com/@one/video/123';
  const second = 'https://www.tiktok.com/@two/video/456';

  assert.equal(videoIdFromUrl(first), '123');
  assert.equal(videoIdFromUrl('https://www.tiktok.com/search?q=x'), null);
  assert.equal(didVideoChange(first, second), true);
  assert.equal(didVideoChange(first, `${first}?lang=en`), false);
  assert.equal(didVideoChange(first, 'https://www.tiktok.com/search?q=x'), false);
});

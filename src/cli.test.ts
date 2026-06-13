import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCliArgs } from './cli';

const requiredArgs = ['--search', 'curanmor', '--max', '5', '--comments', '10'];

test('parseCliArgs defaults to v2', () => {
  assert.equal(parseCliArgs(requiredArgs, {}).flow, 'v2');
});

test('parseCliArgs accepts explicit v1 and v2', () => {
  assert.equal(parseCliArgs(['--flow', 'v1', ...requiredArgs], {}).flow, 'v1');
  assert.equal(parseCliArgs(['--flow=v2', ...requiredArgs], {}).flow, 'v2');
});

test('parseCliArgs rejects invalid flows', () => {
  assert.throws(() => parseCliArgs(['--flow', 'v3', ...requiredArgs], {}), /v1 or v2/);
});

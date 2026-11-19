import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test('the bundled Pi entry exposes a callable factory to native ESM import', async () => {
  const entry = pathToFileURL(path.resolve('dist/pi.cjs')).href;
  const imported = await import(entry);
  assert.equal(typeof imported.default, 'function');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../src/modules/storage');
const { createImages } = require('../src/modules/images');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('removing an image releases its persisted blob', async () => {
  const storage = createStorage({ prefix: `image-lifecycle-${Date.now()}-${Math.random()}` });
  const images = createImages({ storage });
  const added = images.add({ bytes: Buffer.from([1, 2, 3]), filename: 'one.bin', mime: 'application/octet-stream' });

  await wait(0);
  assert.ok(await storage.getBlob(`image:${added.id}`));

  assert.equal(images.remove(added.id), true);
  assert.equal(await storage.getBlob(`image:${added.id}`), null);
});

test('clearing images releases every persisted blob', async () => {
  const storage = createStorage({ prefix: `image-clear-${Date.now()}-${Math.random()}` });
  const images = createImages({ storage });
  const first = images.add({ bytes: Buffer.from([1]), filename: 'one.bin' });
  const second = images.add({ bytes: Buffer.from([2]), filename: 'two.bin' });

  await wait(0);
  assert.ok(await storage.getBlob(`image:${first.id}`));
  assert.ok(await storage.getBlob(`image:${second.id}`));

  images.clear();
  assert.equal(await storage.getBlob(`image:${first.id}`), null);
  assert.equal(await storage.getBlob(`image:${second.id}`), null);
});

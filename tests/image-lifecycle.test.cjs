'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorage } = require('../src/modules/storage');
const { createImages } = require('../src/modules/images');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const action of ['remove', 'clear']) test(`${action} immediately after add leaves no late blob`, async () => {
  const storage = createStorage();
  const images = createImages({ storage });
  const item = images.add({ bytes: Buffer.from([1, 2, 3]), filename: 'immediate.bin' });
  if (action === 'remove') images.remove(item.id); else images.clear();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(images.get(item.id), null);
  assert.equal(await storage.getBlob(item.blobId), null);
});

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

test('restores image metadata without loading original bytes or exposing a Base64 payload', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-lazy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storage = createStorage({ prefix: `image-lazy-${Date.now()}-${Math.random()}` });
  const imageDir = path.join(root, 'rewrite-images'); fs.mkdirSync(imageDir, { recursive: true });
  const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  const id = 'img-lazy';
  fs.writeFileSync(path.join(imageDir, `${id}.bin`), bytes);
  storage.set('images_index', [{ id, filename: 'lazy.png', displayName: 'Lazy', mime: 'image/png', source: 'upload', width: 1, height: 1, status: 'ready', collections: [], dataUrl: '', thumbnailDataUrl: 'data:image/png;base64,AA==' }]);
  const images = createImages({ storage, imageDir });
  const meta = images.getMeta(id);
  assert.equal(meta.imageId, id);
  assert.equal(meta.hasThumbnail, true);
  assert.equal(images.get(id).dataUrl, '');
  assert.equal(images.get(id).bytes, undefined);
  assert.match(images.preview(id).dataUrl, /^data:image\/png;base64/, 'preview reads original bytes on demand');
  assert.deepEqual(await images.getBytes(id), bytes);
  const thumbnail = images.getThumbnail(id);
  assert.equal(thumbnail.dataUrl, 'data:image/png;base64,AA==');
});

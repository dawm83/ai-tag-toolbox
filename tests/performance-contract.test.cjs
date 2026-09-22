'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runProbe } = require('../scripts/performance/local-probe.cjs');

function makeProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tag-probe-source-'));
  const namespace = path.join(root, 'ai-tag-toolbox-rewrite');
  fs.mkdirSync(path.join(namespace, 'debug'), { recursive: true });
  fs.mkdirSync(path.join(namespace, 'rewrite-images'), { recursive: true });
  fs.writeFileSync(path.join(namespace, 'rewrite-storage.json'), JSON.stringify({
    'ai-tag-toolbox-rewrite:app:images_index': JSON.stringify([
      { id: 'img_probe', filename: 'probe.png', displayName: 'Probe', mime: 'image/png', source: 'fixture', width: 1, height: 1, status: 'ready', collections: [], dataUrl: '', thumbnailDataUrl: 'data:image/png;base64,AA==' }
    ]),
    'ai-tag-toolbox-rewrite:app:gallery_refs': JSON.stringify([{ imageId: 'img_probe', displayOrder: 1 }]),
    'ai-tag-toolbox-rewrite:app:conversation_image_refs': JSON.stringify([])
  }));
  fs.writeFileSync(path.join(namespace, 'debug', 'ai-calls.json'), JSON.stringify([{ request: 'keep-source-untouched' }]));
  fs.writeFileSync(path.join(namespace, 'rewrite-images', 'img_probe.bin'), Buffer.from([137, 80, 78, 71]));
  const sentinel = path.join(root, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'source profile must remain read-only');
  return { root, sentinel };
}

function assertShape(result, scenario) {
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.scenario, scenario);
  assert.equal(typeof result.profile?.isolated, 'boolean');
  assert.equal(result.profile.isolated, true);
  assert.equal(typeof result.times, 'object');
  assert.equal(typeof result.times.totalMs, 'number');
  assert.equal(typeof result.payloadSizes, 'object');
  assert(Array.isArray(result.calls));
  assert.equal(typeof result.memory?.rss, 'number');
}

test('local probe runs startup in an isolated profile and returns stable measurement sections', async () => {
  const source = makeProfile();
  const before = fs.readFileSync(source.sentinel, 'utf8');
  const result = await runProbe({ profile: source.root, scenario: 'startup' });
  assertShape(result, 'startup');
  assert.equal(result.measurement.mode, 'node-domain');
  assert.equal(result.times.readyToShow, null);
  assert.equal(result.times.domReady, null);
  assert.equal(typeof result.times.tagUsable, 'number');
  assert.equal(result.calls.find(row => row.name === 'callMonitor.list')?.count, 1);
  assert.equal(result.profile.source, path.resolve(source.root));
  assert.equal(result.profile.sourceWriteDetected, false);
  assert.equal(fs.readFileSync(source.sentinel, 'utf8'), before);
  fs.rmSync(source.root, { recursive: true, force: true });
});

test('gallery scenario records a list call and payload sizes after startup restoration', async () => {
  const source = makeProfile();
  const result = await runProbe({ profile: source.root, scenario: 'gallery' });
  assertShape(result, 'gallery');
  assert.equal(result.payloadSizes.galleryItems, 1);
  assert.equal(typeof result.payloadSizes.galleryOriginalChars, 'number');
  assert(result.payloadSizes.galleryThumbnailChars > 0);
  assert.equal(result.calls.find(row => row.name === 'imageRepository.listGallery')?.count, 1);
  fs.rmSync(source.root, { recursive: true, force: true });
});

test('translation and selection scenarios expose logical calls and persistence counts', async () => {
  const translation = await runProbe({ scenario: 'translation' });
  assertShape(translation, 'translation');
  assert.equal(translation.calls.find(row => row.name === 'translation.references')?.count, 2);
  assert.equal(typeof translation.payloadSizes.translationReferences, 'number');
  assert(translation.payloadSizes.translationReferences > 0);

  const selection = await runProbe({ scenario: 'selection' });
  assertShape(selection, 'selection');
  assert.equal(selection.calls.find(row => row.name === 'library.execute.select')?.count, 1);
  assert.equal(selection.payloadSizes.selectionPersisted, true);
});

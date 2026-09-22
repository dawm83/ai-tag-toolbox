'use strict';

/**
 * Small, repeatable performance probe for the local data path.
 *
 * The probe deliberately stages only the relevant profile files in a temporary
 * directory. It never opens or writes the user's real profile, and it does not
 * belong to the Electron runtime package.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const ROOT = path.resolve(__dirname, '../..');
const SCENARIOS = new Set(['startup', 'gallery', 'translation', 'selection']);
const PROFILE_NAMESPACE = 'ai-tag-toolbox-rewrite';

function number(value) {
  return Number(Number(value).toFixed(2));
}

function exists(value) {
  try { return fs.existsSync(value); } catch { return false; }
}

function fileSignature(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
}

function walkSignature(root) {
  const output = {};
  if (!exists(root)) return output;
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else output[path.relative(root, file)] = fileSignature(file);
    }
  };
  visit(root);
  return output;
}

function sameSignature(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].every(key => before[key] === after[key]);
}

function copyIfPresent(source, destination) {
  if (!exists(source)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return true;
}

function copyDirectory(source, destination) {
  if (!exists(source)) return false;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
  return true;
}

function sourceNamespace(profile) {
  if (!profile) return null;
  const resolved = path.resolve(String(profile));
  const nested = path.join(resolved, PROFILE_NAMESPACE);
  return exists(nested) ? nested : resolved;
}

function stageProfile(profile) {
  const sourceInput = profile ? path.resolve(String(profile)) : null;
  const source = sourceNamespace(profile);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tag-toolbox-probe-'));
  const namespace = path.join(temporaryRoot, PROFILE_NAMESPACE);
  fs.mkdirSync(namespace, { recursive: true });
  const before = sourceInput ? walkSignature(sourceInput) : {};
  const copied = [];
  if (source) {
    const files = ['rewrite-storage.json', 'tag-library-v2.json'];
    for (const file of files) if (copyIfPresent(path.join(source, file), path.join(namespace, file))) copied.push(file);
    if (copyDirectory(path.join(source, 'debug'), path.join(namespace, 'debug'))) copied.push('debug');
    if (copyDirectory(path.join(source, 'rewrite-images'), path.join(namespace, 'rewrite-images'))) copied.push('rewrite-images');
  }
  return {
    source: sourceInput,
    sourceRoot: source,
    sourceBefore: before,
    temporaryRoot,
    namespace,
    copied,
    cleanup() {
      const after = sourceInput ? walkSignature(sourceInput) : {};
      const sourceWriteDetected = sourceInput ? !sameSignature(before, after) : false;
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      return sourceWriteDetected;
    }
  };
}

function createRecorder() {
  const rows = new Map();
  const record = (name, elapsed) => {
    const row = rows.get(name) || { name, count: 0, totalMs: 0, maxMs: 0 };
    row.count += 1;
    row.totalMs += elapsed;
    row.maxMs = Math.max(row.maxMs, elapsed);
    rows.set(name, row);
  };
  const call = async (name, fn) => {
    const started = performance.now();
    try { return await fn(); } finally { record(name, performance.now() - started); }
  };
  const sync = (name, fn) => {
    const started = performance.now();
    try { return fn(); } finally { record(name, performance.now() - started); }
  };
  return {
    call,
    sync,
    rows: () => [...rows.values()].map(row => ({ ...row, totalMs: number(row.totalMs), maxMs: number(row.maxMs) }))
  };
}

function profileRepository(namespace) {
  const filename = path.join(namespace, 'tag-library-v2.json');
  let document = exists(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null;
  let saveCount = 0;
  return {
    async read() { return document ? structuredClone(document) : null; },
    async save(value) {
      document = structuredClone(value);
      fs.writeFileSync(filename, JSON.stringify(document));
      saveCount += 1;
    },
    get saveCount() { return saveCount; },
    get document() { return document ? structuredClone(document) : null; }
  };
}

function fileBytes(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function profileSizes(namespace, storage) {
  const index = storage.get('images_index', []);
  return {
    storageBytes: fileBytes(path.join(namespace, 'rewrite-storage.json')),
    imageIndexBytes: Buffer.byteLength(JSON.stringify(Array.isArray(index) ? index : [])),
    imageIndexEntries: Array.isArray(index) ? index.length : 0,
    callLogBytes: fileBytes(path.join(namespace, 'debug', 'ai-calls.json')),
    callSummaryBytes: fileBytes(path.join(namespace, 'debug', 'ai-call-summary.json')),
    imageFiles: exists(path.join(namespace, 'rewrite-images'))
      ? fs.readdirSync(path.join(namespace, 'rewrite-images')).filter(file => file.endsWith('.bin')).length
      : 0
  };
}

async function createContext(staged, times) {
  const { createStorage } = require(path.join(ROOT, 'src/modules/storage'));
  const { createImages } = require(path.join(ROOT, 'src/modules/images'));
  const { createImageRepository } = require(path.join(ROOT, 'src/modules/image-repository'));
  const { createCallMonitor } = require(path.join(ROOT, 'src/modules/call-monitor'));
  const tagLibrary = require(path.join(ROOT, 'src/modules/tag-library'));
  const { createTranslation } = require(path.join(ROOT, 'src/modules/translation'));
  const { createTagAdapter } = require(path.join(ROOT, 'src/modules/tag-library/tag-adapter'));

  const storage = createStorage({
    prefix: PROFILE_NAMESPACE,
    filePath: path.join(staged.namespace, 'rewrite-storage.json')
  });
  times.storageReady = number(performance.now() - times._started);

  const callMonitor = createCallMonitor({ filePath: path.join(staged.namespace, 'debug', 'ai-call-summary.json') });
  times.callMonitorReady = number(performance.now() - times._started);

  const baseResult = tagLibrary.loadBundledBase({ shared: true });
  if (!baseResult.ok) throw new Error(`标签库基础数据不可用: ${baseResult.error || 'unknown error'}`);
  const base = baseResult.data;
  times.catalogReady = number(performance.now() - times._started);

  const images = createImages({ storage, imageDir: path.join(staged.namespace, 'rewrite-images') });
  times.imageIndexReady = number(performance.now() - times._started);
  const sessions = [];
  const imageRepository = createImageRepository({ images, storage, sessions });

  const repository = profileRepository(staged.namespace);
  const library = tagLibrary.createTagLibrary({ base, baseUpdates: baseResult.baseUpdates, repository });
  const ready = await library.ready();
  if (!ready.ok) throw new Error(`标签库用户数据不可用: ${ready.error?.code || 'unknown error'}`);
  const tags = createTagAdapter({ library, metadataById: base.metadataById, storage });
  const translation = createTranslation({ tags });
  times.applicationReady = number(performance.now() - times._started);
  times.tagUsable = times.applicationReady;
  return { storage, base, images, imageRepository, repository, library, tags, translation, callMonitor };
}

function galleryPayload(rows) {
  const items = Array.isArray(rows?.items) ? rows.items : [];
  return {
    galleryItems: items.length,
    galleryOriginalChars: items.reduce((total, item) => total + String(item?.dataUrl || '').length, 0),
    galleryThumbnailChars: items.reduce((total, item) => total + String(item?.thumbnailDataUrl || '').length, 0),
    galleryJsonBytes: Buffer.byteLength(JSON.stringify(rows || {}))
  };
}

async function runProbe(options = {}) {
  const scenario = String(options.scenario || process.env.PERF_SCENARIO || 'startup').trim().toLowerCase();
  if (!SCENARIOS.has(scenario)) throw new Error(`Unsupported performance scenario: ${scenario}`);
  const staged = stageProfile(options.profile || process.env.PERF_PROFILE || '');
  const recorder = createRecorder();
  const started = performance.now();
  const times = { processStart: 0, readyToShow: null, domReady: null, _started: started };
  let context;
  let result;
  try {
    context = await createContext(staged, times);
    await recorder.call('callMonitor.list', () => context.callMonitor.list());
    const payloadSizes = profileSizes(staged.namespace, context.storage);
    if (scenario === 'gallery') {
      const gallery = await recorder.call('imageRepository.listGallery', () => context.imageRepository.listGallery({ order: 'oldest' }));
      Object.assign(payloadSizes, galleryPayload(gallery));
    } else if (scenario === 'translation') {
      const input = 'blue_hair, long_hair, standing, looking_at_viewer';
      const first = await recorder.call('translation.references', () => context.translation.references(input));
      await recorder.call('translation.references', () => context.translation.references(input));
      payloadSizes.translationInputChars = input.length;
      payloadSizes.translationReferences = Array.isArray(first) ? first.length : 0;
    } else if (scenario === 'selection') {
      const target = context.base.tags.find(tag => tag.id === 'blue_hair') || context.base.tags[0];
      const before = context.repository.saveCount;
      await recorder.call('library.execute.select', () => context.library.execute({
        type: 'select', value: { kind: 'tag', tagId: target.id }, selected: true
      }, { operationId: 'local-probe-select' }));
      payloadSizes.selectionPersisted = context.repository.saveCount > before;
      payloadSizes.selectionCount = context.repository.document?.selection?.length || 0;
      payloadSizes.selectionJsonBytes = Buffer.byteLength(JSON.stringify(context.repository.document?.selection || []));
    }
    times.totalMs = number(performance.now() - started);
    delete times._started;
    result = {
      schemaVersion: 1,
      scenario,
      measurement: { mode: 'node-domain', cache: 'process module cache may be warm; filesystem cache is not controlled', limitations: ['Electron window lifecycle and screen presentation are not measured', 'No network, AI model or ComfyUI requests are made'] },
      profile: {
        source: staged.source,
        isolated: true,
        copied: staged.copied,
        sourceWriteDetected: false
      },
      times,
      payloadSizes,
      calls: recorder.rows(),
      memory: Object.fromEntries(Object.entries(process.memoryUsage()).map(([key, value]) => [key, Number(value)]))
    };
    return result;
  } finally {
    try { await context?.translation?.dispose?.(); } catch { /* probe cleanup */ }
    try { context?.tags?.dispose?.(); } catch { /* probe cleanup */ }
    try { await context?.library?.dispose?.(); } catch { /* probe cleanup */ }
    try { await context?.callMonitor?.flush?.(); } catch { /* probe cleanup */ }
    try { await context?.storage?.flush?.(); } catch { /* probe cleanup */ }
    const sourceWriteDetected = staged.cleanup();
    if (result) result.profile.sourceWriteDetected = sourceWriteDetected;
  }
}

function parseArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile' || arg === '--scenario' || arg === '--output') output[arg.slice(2)] = argv[++index];
    else if (arg.startsWith('--profile=')) output.profile = arg.slice('--profile='.length);
    else if (arg.startsWith('--scenario=')) output.scenario = arg.slice('--scenario='.length);
    else if (arg.startsWith('--output=')) output.output = arg.slice('--output='.length);
  }
  return output;
}

if (require.main === module) {
  runProbe(parseArgs(process.argv.slice(2)))
    .then(result => {
      const text = JSON.stringify(result, null, 2);
      if (process.argv.includes('--output') || process.argv.some(arg => arg.startsWith('--output='))) {
        const output = parseArgs(process.argv.slice(2)).output;
        if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(path.resolve(output), text); }
      }
      process.stdout.write(`${text}\n`);
    })
    .catch(error => {
      process.stderr.write(`${String(error?.stack || error)}\n`);
      process.exitCode = 1;
    });
}

module.exports = { runProbe, parseArgs, stageProfile };

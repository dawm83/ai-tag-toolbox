'use strict';
/* Renders shared settings and owns generation controls. API form events stay
 * with the composer, which handles model loading and independent Vision drafts. */
(function installSettingsView(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AppViews = root.AppViews || {};
  root.AppViews.settings = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createFactory() {
  const number = (value, fallback, min, max) => { const n = Number(value); if (!Number.isFinite(n)) return fallback; return Math.max(min, Math.min(max, n)); };
  const fields = {
    base: ['#aiBase', 'value'], model: ['#aiModel', 'value'], key: ['#aiKey', 'value'],
    visionInheritPrimary: ['#visionInheritPrimary', 'checked'], visionBase: ['#visionBase', 'value'], visionModel: ['#visionModel', 'value'], visionKey: ['#visionKey', 'value'],
    imagesPerRound: ['#imagesPerRound', 'value'], maxAutoRounds: ['#maxAutoRounds', 'value'], generationAutoRun: ['#generationAutoRun', 'checked']
  };
  const generationFields = ['imagesPerRound', 'maxAutoRounds', 'generationAutoRun'];
  function createSettingsView({ document, api, notify, onChange, autoBind = true } = {}) {
    const doc = document || (typeof globalThis !== 'undefined' ? globalThis.document : null);
    const q = selector => doc?.querySelector?.(selector);
    const read = () => { try { return api?.getSettings?.() || {}; } catch { return {}; } };
    const write = patch => { try { return api?.setSettings?.(patch) || patch; } catch (error) { notify?.(error.message || String(error)); return patch; } };
    function readField(key, current) {
      const config = fields[key]; const el = config && q(config[0]); if (!el) return current;
      if (config[1] === 'checked') return Boolean(el.checked);
      return el.value;
    }
    function render(snapshot = read()) {
      const value = snapshot || {};
      Object.entries(fields).forEach(([key, config]) => { const el = q(config[0]); if (!el) return; if (config[1] === 'checked') el.checked = value[key] === true; else if (value[key] != null) el.value = String(value[key]); });
      return value;
    }
    function collect() {
      const current = read();
      return {
        imagesPerRound: number(readField('imagesPerRound', current.imagesPerRound), Number(current.imagesPerRound) || 1, 1, 10),
        maxAutoRounds: number(readField('maxAutoRounds', current.maxAutoRounds), Number(current.maxAutoRounds) || 3, 1, 10),
        generationAutoRun: Boolean(readField('generationAutoRun', current.generationAutoRun !== false))
      };
    }
    function update(patch = collect()) { const value = write(patch); onChange?.(value); return value; }
    function bind() {
      generationFields.forEach(key => q(fields[key][0])?.addEventListener('change', () => update()));
    }
    if (autoBind) bind();
    return { render, collect, update, bind, get: read, set: write, fields };
  }
  return { createSettingsView, fields };
});

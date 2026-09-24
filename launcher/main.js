'use strict';

const { app } = require('electron');
const path = require('node:path');
const { launchActiveVersion } = require('../src/modules/version-launcher');

function installRoot() { return path.dirname(process.execPath); }
async function main() {
  const result = await launchActiveVersion({ rootDir: installRoot() });
  if (result?.legacy) app.quit();
}

app.whenReady().then(main).catch(() => app.quit());

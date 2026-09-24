'use strict';

const { app } = require('electron');
const path = require('node:path');
const { launchActiveVersion } = require('../src/modules/version-launcher');

function installRoot() { return path.dirname(process.execPath); }
async function main() {
  await launchActiveVersion({ rootDir: installRoot() });
  app.quit();
}

app.whenReady().then(main).catch(() => app.quit());

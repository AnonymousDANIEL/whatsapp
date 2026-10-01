'use strict';
// Browser archives are never downloaded or extracted by this application.
// Chromium is installed by the OS package manager in Dockerfile.worker.
module.exports = async function disabledArchiveExtraction() {
  throw new Error('Browser archive extraction is disabled. Use the system Chromium executable.');
};

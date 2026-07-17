const { join } = require('path');

/**
 * Puppeteer downloads Chrome to $HOME/.cache/puppeteer by default. On managed
 * hosts that directory lives outside the deployed application, so it is either
 * never written (install scripts disabled) or discarded between the build and
 * runtime containers — Chrome is then missing at launch.
 *
 * Pinning the cache inside the project makes the browser part of the deployed
 * artifact, and makes the download and the lookup agree regardless of $HOME.
 */
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};

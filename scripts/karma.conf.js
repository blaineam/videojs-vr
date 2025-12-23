const generate = require('videojs-generate-karma-config');

module.exports = function(config) {

  // see https://github.com/videojs/videojs-generate-karma-config
  // for options
  const options = {};

  config = generate(config, options);

  // Configure Chrome for CI environments
  config.customLaunchers = {
    ChromeHeadlessCI: {
      base: 'ChromeHeadless',
      flags: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    }
  };

  // Use only ChromeHeadlessCI in CI environments (disable browser detection)
  if (process.env.CI) {
    config.browsers = ['ChromeHeadlessCI'];
    // Remove detect-browsers framework to prevent auto-detection
    config.frameworks = config.frameworks.filter(f => f !== 'detectBrowsers');
    delete config.detectBrowsers;
  }
};


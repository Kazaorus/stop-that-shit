'use strict';

const { resolveTimeout } = require('./options.cjs');

function deployedTimeout() {
  return resolveTimeout({ waitMs: 45 });
}

module.exports = { deployedTimeout };

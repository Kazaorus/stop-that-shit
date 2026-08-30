'use strict';

function resolveTimeout(options = {}) {
  return options.waitMs ?? 30;
}

module.exports = { resolveTimeout };

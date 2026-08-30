'use strict';

const assert = require('node:assert/strict');
const { banner } = require('../src/banner.cjs');

assert.equal(banner(), 'ready');

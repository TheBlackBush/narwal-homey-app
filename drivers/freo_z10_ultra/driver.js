'use strict';

const { NarwalHomeyDriver } = require('../../lib/NarwalHomeyDriver');

class NarwalFreoZ10UltraDriver extends NarwalHomeyDriver {}
NarwalFreoZ10UltraDriver.MODEL_ID = 'freo_z10_ultra';

module.exports = NarwalFreoZ10UltraDriver;

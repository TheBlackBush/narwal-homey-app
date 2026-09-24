'use strict';

const { NarwalHomeyDriver } = require('../../lib/NarwalHomeyDriver');

class NarwalFreoZ10ProTurboDriver extends NarwalHomeyDriver {}
NarwalFreoZ10ProTurboDriver.MODEL_ID = 'freo_z10_pro_turbo';

module.exports = NarwalFreoZ10ProTurboDriver;

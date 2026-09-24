'use strict';

const { NarwalHomeyDriver } = require('../../lib/NarwalHomeyDriver');

class NarwalFreoX10ProDriver extends NarwalHomeyDriver {}
NarwalFreoX10ProDriver.MODEL_ID = 'freo_x10_pro';

module.exports = NarwalFreoX10ProDriver;

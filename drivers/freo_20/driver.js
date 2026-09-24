'use strict';

const { NarwalHomeyDriver } = require('../../lib/NarwalHomeyDriver');

class NarwalFreo20Driver extends NarwalHomeyDriver {}
NarwalFreo20Driver.MODEL_ID = 'freo_20';

module.exports = NarwalFreo20Driver;

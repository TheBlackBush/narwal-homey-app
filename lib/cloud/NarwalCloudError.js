'use strict';

class NarwalCloudError extends Error {
  constructor(message, code = 'CLOUD_ERROR') {
    super(message);
    this.name = 'NarwalCloudError';
    this.code = code;
  }
}

module.exports = { NarwalCloudError };

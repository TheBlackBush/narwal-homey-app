'use strict';

module.exports = {
  root: true,
  extends: ['athom'],
  env: {
    node: true,
    es2021: true,
  },
  parserOptions: {
    ecmaVersion: 2021,
  },
  rules: {
    'no-console': 'off',
  },
  overrides: [
    {
      files: ['lib/**/*.js', 'test/**/*.js', 'scripts/**/*.js'],
      rules: {
        strict: 'off',
        'import/extensions': 'off',
        'no-use-before-define': 'off',
        'no-return-await': 'off',
        'no-constant-condition': 'off',
        'node/no-unsupported-features/es-builtins': 'off',
        'node/no-unsupported-features/es-syntax': 'off',
      },
    },
  ],
};

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { resolveCleanOptions, cleanSettingsToPersist, DEVICE_SETTING } = require('../lib/CleanOptions');
const { WorkMode } = require('../lib/NarwalBinaryProtocol');
const { FanSpeed } = require('../lib/constants');

test('missing settings resolve to the defaults the app has always sent', () => {
  assert.deepStrictEqual(resolveCleanOptions({}), {
    workMode: WorkMode.VACUUM_AND_MOP,
    water: 2,
    mopStrength: 1,
    passes: 1,
  });
});

test('device settings map to protocol values', () => {
  const options = resolveCleanOptions({
    clean_work_mode: 'mop',
    clean_water: 'wet',
    clean_mop_strength: 'high',
    clean_passes: '3',
    clean_route: 'meticulous',
  });

  assert.deepStrictEqual(options, {
    workMode: WorkMode.MOP,
    water: 3,
    mopStrength: 2,
    passes: 3,
    route: 2,
  });
});

test('Flow card values override device settings for one run', () => {
  const settings = { clean_work_mode: 'vacuum', clean_water: 'dry', clean_passes: '2' };

  const options = resolveCleanOptions(settings, {
    work_mode: 'vacuum_then_mop',
    water: DEVICE_SETTING,
    mop_strength: 'high',
    passes: DEVICE_SETTING,
    route: 'standard',
    suction: FanSpeed.ULTRA,
  });

  assert.deepStrictEqual(options, {
    workMode: WorkMode.VACUUM_THEN_MOP,
    water: 1,
    mopStrength: 2,
    passes: 2,
    route: 1,
    fanSpeed: FanSpeed.ULTRA,
  });
});

test('unknown values fall back instead of sending garbage to the robot', () => {
  const options = resolveCleanOptions({ clean_work_mode: 'turbo', clean_passes: '9' }, { suction: 'loud' });

  assert.strictEqual(options.workMode, WorkMode.VACUUM_AND_MOP);
  assert.strictEqual(options.passes, 1);
  assert.strictEqual(options.fanSpeed, undefined);
});

test('clean settings to persist keep valid values and fill the rest with defaults', () => {
  assert.deepStrictEqual(cleanSettingsToPersist({ clean_water: 'wet', clean_passes: '7', ip: '1.2.3.4' }), {
    clean_work_mode: 'vacuum_and_mop',
    clean_water: 'wet',
    clean_mop_strength: 'normal',
    clean_passes: '1',
    clean_route: 'robot',
  });
});

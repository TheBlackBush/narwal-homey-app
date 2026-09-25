'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  buildCloudPayload, splitCloudPayload, buildCorrelationData, toLocalFrame, isDeviceTopic, apiHostForCountry,
} = require('../lib/cloud/cloudFrame');
const { NarwalBinaryProtocol, decodeProto, buildFrame } = require('../lib/NarwalBinaryProtocol');

const UUID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PRODUCT = 'QxMSPG6VSO';
const DEVICE = '0123456789abcdef0123456789abcdef';

test('cloud payload wraps the body behind a user header with the account uuid twice', () => {
  const body = Buffer.from([0x08, 0x01]);
  const payload = buildCloudPayload(UUID, body);

  assert.strictEqual(payload[0], 0x01);
  const { header, body: rest } = splitCloudPayload(payload);
  assert.deepStrictEqual(decodeProto(header), { 1: UUID, 2: UUID });
  assert.deepStrictEqual(rest, body);
});

test('splitting a payload without the cloud frame returns it unchanged', () => {
  const raw = Buffer.from([0x08, 0x02]);
  assert.deepStrictEqual(splitCloudPayload(raw), { header: null, body: raw });
});

test('correlation data carries the request id, a zero and the time', () => {
  const decoded = decodeProto(buildCorrelationData('req-1', 1790000000000));
  assert.deepStrictEqual(decoded, { 1: 'req-1', 3: 0, 4: 1790000000000 });
});

test('cloud messages become local frames the existing parser understands', () => {
  const protocol = new NarwalBinaryProtocol({ productKey: PRODUCT, deviceId: DEVICE });
  const status = Buffer.concat([Buffer.from([0x1a, 0x02, 0x08, 0x0a]), Buffer.from([0x58, 0x03])]); // {3:{1:10}, 11:3}

  const broadcast = protocol.parse(toLocalFrame(`/${PRODUCT}/${DEVICE}/status/robot_base_status`, status));
  assert.strictEqual(broadcast.type, 'broadcast');
  assert.strictEqual(broadcast.shortTopic, 'status/robot_base_status');
  assert.strictEqual(protocol.normalizeStatus(broadcast.decoded).docked, true);

  const response = protocol.parse(toLocalFrame(`/${PRODUCT}/${DEVICE}/common/yell/response`, Buffer.from([0x08, 0x01])));
  assert.strictEqual(response.type, 'response');
  assert.strictEqual(response.shortTopic, 'common/yell');
  assert.deepStrictEqual(response.decoded, { 1: 1 });
});

test('a local frame round-trips through a cloud payload body', () => {
  const frame = buildFrame(`/${PRODUCT}/${DEVICE}/common/yell`, Buffer.from([0x08, 0x01]));
  const back = new NarwalBinaryProtocol({ productKey: PRODUCT, deviceId: DEVICE }).parse(toLocalFrame(`/${PRODUCT}/${DEVICE}/common/yell`, Buffer.from([0x08, 0x01])));
  assert.strictEqual(back.topic, `/${PRODUCT}/${DEVICE}/common/yell`);
  assert.ok(frame.length > 0);
});

test('only the paired robot\'s topics may be published to the cloud', () => {
  assert.strictEqual(isDeviceTopic(`/${PRODUCT}/${DEVICE}/common/yell`, PRODUCT, DEVICE), true);
  assert.strictEqual(isDeviceTopic('//common/get_device_info', PRODUCT, DEVICE), false);
  assert.strictEqual(isDeviceTopic(`/QoEsI5qYXO/${DEVICE}/common/get_device_info`, PRODUCT, DEVICE), false);
  assert.strictEqual(isDeviceTopic(`/${PRODUCT}/other/common/yell`, PRODUCT, DEVICE), false);
});

test('the API host follows the account country', () => {
  assert.strictEqual(apiHostForCountry('IL'), 'https://il-app.narwaltech.com');
  assert.strictEqual(apiHostForCountry('us'), 'https://us-app.narwaltech.com');
  assert.strictEqual(apiHostForCountry('CN'), 'https://cn-app.narwaltech.com');
  assert.strictEqual(apiHostForCountry('KR'), 'https://kr-app.narwaltech.com');
  assert.strictEqual(apiHostForCountry('DE'), 'https://eu-app.narwaltech.com');
  assert.strictEqual(apiHostForCountry(''), 'https://us-app.narwaltech.com');
});

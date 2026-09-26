'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  buildCloudPayload, splitCloudPayload, buildCorrelationData, toLocalFrame, isDeviceTopic, apiHostForCountry,
} = require('../lib/cloud/cloudFrame');
const { NarwalBinaryProtocol, decodeProto, buildFrame } = require('../lib/NarwalBinaryProtocol');

const UUID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
// Header field 5 is a nested message; the generic decoder reads it as text.
function headerFields(header) {
  const { readFields } = require('../lib/NarwalMapCodec'); // eslint-disable-line global-require
  const f = readFields(header);
  const text = (x) => x.value.toString('utf8');
  const out = { 1: text(f[1][0]), 2: text(f[2][0]) };
  if (f[5]) out[5] = { 1: text(readFields(f[5][0].value)[1][0]) };
  return out;
}

const PRODUCT = 'QxMSPG6VSO';
const DEVICE = '0123456789abcdef0123456789abcdef';

test('cloud payload wraps the body behind the official header: account uuid twice and the reply address', () => {
  const body = Buffer.from([0x08, 0x01]);
  const responseTopic = `/${PRODUCT}/${DEVICE}/common/yell/response`;
  const payload = buildCloudPayload(UUID, body, responseTopic);

  assert.strictEqual(payload[0], 0x01);
  const { header, body: rest } = splitCloudPayload(payload);
  // Header {1 extendedString, 2 uuid, 5 properties {1 responseUrl}}; without
  // the reply address the robot does not answer over the cloud.
  assert.deepStrictEqual(headerFields(header), { 1: UUID, 2: UUID, 5: { 1: responseTopic } });
  assert.deepStrictEqual(rest, body);
  assert.deepStrictEqual(decodeProto(splitCloudPayload(buildCloudPayload(UUID, body)).header), { 1: UUID, 2: UUID });
});

test('splitting a payload without the cloud frame returns it unchanged', () => {
  const raw = Buffer.from([0x08, 0x02]);
  assert.deepStrictEqual(splitCloudPayload(raw), { header: null, body: raw });
});

test('correlation data is the official AppMessageMark: request id and the time in microseconds', () => {
  const decoded = decodeProto(buildCorrelationData('req-1', 1790000000000));
  assert.deepStrictEqual(decoded, { 1: 'req-1', 3: 1790000000000000 });
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

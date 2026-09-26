'use strict';

const { buildFrame, FIELD_RESPONSE } = require('../NarwalBinaryProtocol');

/**
 * Pure helpers for the Narwal cloud (MQTT) message format. The cloud carries
 * the same topics and protobuf bodies as the local WebSocket; each payload is
 * prefixed with a user header: 0x01 + varint(len) + {1: uuid, 2: uuid}.
 */

function encodeVarint(value) {
  const out = [];
  let n = Number(value);
  while (n > 0x7f) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return Buffer.from(out);
}

function stringField(field, value) {
  const bytes = Buffer.from(String(value), 'utf8');
  return Buffer.concat([Buffer.from([(field << 3) | 2]), encodeVarint(bytes.length), bytes]);
}

function varintField(field, value) {
  return Buffer.concat([Buffer.from([field << 3]), encodeVarint(value)]);
}

// Header {1 extendedString, 2 uuid, 5 properties {1 responseUrl}}, as the
// official app builds it (NrPbHeaderCodec): the account uuid in both id
// fields and, for a request, its reply address. Without the reply address
// the robot does not answer over the cloud.
function buildCloudPayload(uuid, body = Buffer.alloc(0), responseTopic = '') {
  const properties = responseTopic ? stringField(1, responseTopic) : null;
  const header = Buffer.concat([
    stringField(1, uuid),
    stringField(2, uuid),
    ...(properties ? [Buffer.concat([Buffer.from([(5 << 3) | 2]), encodeVarint(properties.length), properties])] : []),
  ]);
  return Buffer.concat([Buffer.from([0x01]), encodeVarint(header.length), header, Buffer.from(body)]);
}

function splitCloudPayload(payload) {
  const buf = Buffer.from(payload);
  if (buf.length < 2 || buf[0] !== 0x01) return { header: null, body: buf };
  let length = 0;
  let multiplier = 1;
  let i = 1;
  while (i < buf.length) {
    const byte = buf[i];
    i += 1;
    length += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) break;
    multiplier *= 0x80;
  }
  if (i + length > buf.length) return { header: null, body: buf };
  return { header: buf.subarray(i, i + length), body: buf.subarray(i + length) };
}

// MQTT 5 CorrelationData as the official app sends it: AppMessageMark
// {1 messageId, 3 debugMsgId = epoch microseconds}.
function buildCorrelationData(requestId, nowMs = Date.now()) {
  return Buffer.concat([stringField(1, requestId), varintField(3, nowMs * 1000)]);
}

// Rebuilds a cloud message as a local WebSocket frame, so the existing
// parser handles it: '<topic>/response' becomes a response frame for <topic>.
function toLocalFrame(topic, body) {
  const isResponse = topic.endsWith('/response');
  const frame = buildFrame(isResponse ? topic.slice(0, -'/response'.length) : topic, body);
  if (isResponse) frame[2] = FIELD_RESPONSE;
  return frame;
}

// The broker only allows the account's own robots; publishing elsewhere
// (for example local discovery probes) must be skipped.
function isDeviceTopic(topic, productId, deviceId) {
  return Boolean(productId && deviceId) && String(topic).startsWith(`/${productId}/${deviceId}/`);
}

const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE',
  'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'UK',
]);

function apiHostForCountry(country) {
  const code = String(country || '').trim().toUpperCase();
  const prefix = {
    IL: 'il', US: 'us', CN: 'cn', KR: 'kr',
  }[code] || (EU_COUNTRIES.has(code) ? 'eu' : 'us');
  return `https://${prefix}-app.narwaltech.com`;
}

module.exports = {
  buildCloudPayload,
  splitCloudPayload,
  buildCorrelationData,
  toLocalFrame,
  isDeviceTopic,
  apiHostForCountry,
};

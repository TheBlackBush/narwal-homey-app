'use strict';

const WebSocket = require('ws');

const host = process.argv[2] || process.env.NARWAL_HOST;
if (!host) {
  throw new Error('Usage: node scripts/probe-narwal-local.js <robot-ip> [port] [timeoutMs]');
}
const port = Number(process.argv[3]) || 9002;
const timeoutMs = Number(process.argv[4]) || 20000;

const productKeys = [
  'QxMSPG6VSO', // Narwal Flow 2
  'QoEsI5qYXO',
  'DrzDKQ0MU8',
  'CNbforyZWI',
];

const broadcastTopics = [
  'status/robot_base_status',
  'status/working_status',
  'upgrade/upgrade_status',
  'status/download_status',
  'map/display_map',
  'status/time_line_status',
  'status/point_navi_plan_traj',
  'developer/planning_debug_info',
];

function encodeVarint(value) {
  let n = Number(value);
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

function encodeFieldKey(field, wireType) {
  return encodeVarint((field << 3) | wireType);
}

function encodeVarintField(field, value) {
  return Buffer.concat([encodeFieldKey(field, 0), encodeVarint(value)]);
}

function encodeBytesField(field, value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return Buffer.concat([encodeFieldKey(field, 2), encodeVarint(buf.length), buf]);
}

function encodeStringField(field, value) {
  return encodeBytesField(field, Buffer.from(String(value), 'utf8'));
}

function buildTopicSubscription(duration = 600) {
  return Buffer.concat(broadcastTopics.map((topic) => {
    const inner = Buffer.concat([
      encodeStringField(1, topic),
      encodeVarintField(2, duration),
    ]);
    return encodeBytesField(1, inner);
  }));
}

function buildFrame(topic, payload = Buffer.alloc(0)) {
  const topicBuf = Buffer.from(topic, 'utf8');
  return Buffer.concat([
    Buffer.from([0x01, (topicBuf.length + 2) & 0xff, 0x22, topicBuf.length]),
    topicBuf,
    payload,
  ]);
}

function parseFrame(data) {
  const buf = Buffer.from(data);
  if (buf.length < 4 || buf[0] !== 0x01 || (buf[2] !== 0x22 && buf[2] !== 0x2a)) return null;
  const topicLength = buf[3];
  const topicEnd = 4 + topicLength;
  if (buf.length < topicEnd) return null;
  return {
    fieldTag: buf[2],
    topic: buf.slice(4, topicEnd).toString('utf8'),
    payload: buf.slice(topicEnd),
    rawLength: buf.length,
  };
}

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i];
    result += (byte & 0x7f) * (2 ** shift);
    i += 1;
    if ((byte & 0x80) === 0) return { value: result, offset: i };
    shift += 7;
    if (shift > 56) break;
  }
  throw new Error('unterminated varint');
}

function looksText(buf) {
  if (!buf.length) return false;
  let printable = 0;
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) printable += 1;
  }
  return printable / buf.length > 0.85;
}

function decodeProto(buf, depth = 0) {
  const out = {};
  let offset = 0;
  while (offset < buf.length) {
    const key = readVarint(buf, offset);
    offset = key.offset;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    let value;
    if (wire === 0) {
      const v = readVarint(buf, offset);
      offset = v.offset;
      value = v.value;
    } else if (wire === 2) {
      const len = readVarint(buf, offset);
      offset = len.offset;
      const bytes = buf.slice(offset, offset + len.value);
      offset += len.value;
      if (looksText(bytes)) value = bytes.toString('utf8').replace(/\0+$/g, '');
      else if (depth < 2) {
        try {
          value = decodeProto(bytes, depth + 1);
        } catch (_) {
          value = `0x${bytes.toString('hex').slice(0, 80)}${bytes.length > 40 ? '...' : ''}`;
        }
      } else {
        value = `0x${bytes.toString('hex').slice(0, 80)}${bytes.length > 40 ? '...' : ''}`;
      }
    } else if (wire === 5) {
      value = buf.readUInt32LE(offset);
      offset += 4;
    } else if (wire === 1) {
      value = Number(buf.readBigUInt64LE(offset));
      offset += 8;
    } else {
      value = `unsupported-wire-${wire}`;
      break;
    }
    const keyName = String(field);
    if (out[keyName] === undefined) out[keyName] = value;
    else if (Array.isArray(out[keyName])) out[keyName].push(value);
    else out[keyName] = [out[keyName], value];
  }
  return out;
}

function shortTopic(topic) {
  const parts = topic.split('/');
  return parts.length >= 4 ? parts.slice(3).join('/') : topic;
}

function send(ws, topic, payload, label) {
  const frame = buildFrame(topic, payload);
  ws.send(frame);
  console.log(`sent ${label}: ${topic} (${frame.length} bytes)`);
}

const url = `ws://${host}:${port}`;
console.log(`connecting to ${url}`);

const ws = new WebSocket(url, { handshakeTimeout: 10000, perMessageDeflate: false });
const seen = [];
let settled = false;
let deviceId = '';
let topicPrefix = '/QxMSPG6VSO';

function finish(code) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try {
    ws.close();
  } catch (_) {}
  console.log(`summary: ${seen.length} Narwal frame(s), device_id=${deviceId || 'unknown'}, prefix=${topicPrefix || 'unknown'}`);
  process.exitCode = code;
  try {
    ws.close();
  } catch (_) { /* ignore */ }
  setTimeout(() => {}, 0);
}

const timer = setTimeout(() => {
  console.error(`timed out after ${timeoutMs}ms waiting for Narwal binary/protobuf response`);
  finish(seen.length ? 0 : 1);
}, timeoutMs);

ws.on('open', () => {
  console.log('websocket opened');
  const discoveryTopics = [
    '//common/get_device_info',
    ...productKeys.map((key) => `/${key}//common/get_device_info`),
  ];
  discoveryTopics.forEach((topic) => send(ws, topic, Buffer.alloc(0), 'discovery'));

  const full = (topic) => `${topicPrefix}/${deviceId}/${topic}`;
  setTimeout(() => {
    send(ws, full('common/notify_app_event'), encodeVarintField(1, 1), 'wake notify');
    send(ws, full('common/active_robot_publish'), buildTopicSubscription(600), 'topic subscription');
    send(ws, full('common/active_robot_publish'), encodeVarintField(1, 600), 'active duration');
    send(ws, full('status/app_status_heartbeat'), encodeVarintField(1, 1), 'heartbeat');
    send(ws, full('status/get_device_base_status'), Buffer.alloc(0), 'base status');
  }, 1500);
});

ws.on('message', (data) => {
  const msg = parseFrame(data);
  if (!msg) {
    console.log(`received non-Narwal frame (${Buffer.byteLength(data)} bytes)`);
    return;
  }
  seen.push(msg);
  const parts = msg.topic.split('/');
  if (parts.length >= 4 && parts[1]) topicPrefix = `/${parts[1]}`;
  if (parts.length >= 4 && parts[2]) deviceId = parts[2];

  let decoded = {};
  try {
    decoded = decodeProto(msg.payload);
  } catch (err) {
    decoded = { decode_error: err.message };
  }

  if (msg.fieldTag === 0x2a && decoded['2'] && !deviceId) deviceId = String(decoded['2']).trim();
  if (msg.fieldTag === 0x2a && decoded['1'] && String(decoded['1']).length <= 20) topicPrefix = `/${decoded['1']}`;

  console.log(JSON.stringify({
    field: `0x${msg.fieldTag.toString(16)}`,
    topic: msg.topic,
    short_topic: shortTopic(msg.topic),
    payload_bytes: msg.payload.length,
    decoded,
  }, null, 2));

  if (deviceId && seen.length >= 2) finish(0);
});

ws.on('error', (err) => {
  console.error(`websocket error: ${err.message}`);
});

ws.on('close', (code, reason) => {
  console.log(`websocket closed: ${code} ${reason || ''}`);
  finish(seen.length ? 0 : 1);
});

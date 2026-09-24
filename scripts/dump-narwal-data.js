'use strict';

/* eslint-disable no-console, no-process-exit */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const C = require('../lib/constants');
const {
  NarwalBinaryProtocol,
  parseCommandResponse,
  toFloat32,
} = require('../lib/NarwalBinaryProtocol');

const host = process.argv[2] || process.env.NARWAL_HOST;
if (!host) {
  console.error('Usage: node scripts/dump-narwal-data.js <robot-ip> [port] [durationMs]');
  process.exit(1);
}
const port = Number(process.argv[3] || C.DEFAULT_PORT);
const durationMs = Number(process.argv[4] || 60000);
const productKey = process.env.NARWAL_PRODUCT_KEY || 'QxMSPG6VSO';
const deviceId = process.env.NARWAL_DEVICE_ID || '';

const protocol = new NarwalBinaryProtocol({ productKey, deviceId });
const startedAt = new Date();
const url = `ws://${host}:${port}`;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isoStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function mask(value) {
  const text = String(value || '');
  if (text.length <= 8) return text;
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function summarizeValue(value, depth = 0) {
  if (Buffer.isBuffer(value)) {
    return {
      type: 'buffer',
      bytes: value.length,
      hexSample: value.toString('hex').slice(0, 240),
    };
  }
  if (typeof value === 'string') {
    if (/^0x[0-9a-f]+$/i.test(value) && value.length > 242) {
      return {
        type: 'hex',
        bytes: Math.floor((value.length - 2) / 2),
        hexSample: value.slice(0, 242),
      };
    }
    return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  if (!value || typeof value !== 'object') return value;
  if (depth > 5) return '[depth-limit]';
  if (Array.isArray(value)) return value.map((item) => summarizeValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, summarizeValue(item, depth + 1)]));
}

function countTopics(frames) {
  return frames.reduce((acc, frame) => {
    const key = frame.shortTopic || frame.topic || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function firstObject(value) {
  if (Array.isArray(value)) return value.find((item) => item && typeof item === 'object') || null;
  return value && typeof value === 'object' ? value : null;
}

function analyzeMapResponse(decoded) {
  const payload = decoded && decoded['2'];
  if (!payload || typeof payload !== 'object') return null;
  const roomsRaw = payload['12'];
  let roomsList = [];
  if (Array.isArray(roomsRaw)) roomsList = roomsRaw;
  else if (roomsRaw) roomsList = [roomsRaw];
  const rooms = roomsList
    .filter((room) => room && typeof room === 'object')
    .map((room) => ({
      id: Number(room['1'] || 0),
      name: String(room['3'] || ''),
      subtype: Number(room['2'] || 0),
      category: Number(room['4'] || 0),
      instanceIndex: Number(room['8'] || 0),
    }))
    .filter((room) => room.id || room.name);

  const compressed = payload['17'];
  let compressedBytes = 0;
  if (Buffer.isBuffer(compressed)) compressedBytes = compressed.length;
  else if (typeof compressed === 'string' && compressed.startsWith('0x')) compressedBytes = Math.floor((compressed.length - 2) / 2);
  else if (typeof compressed === 'string') compressedBytes = Buffer.byteLength(compressed);

  const field6 = payload['6'] && typeof payload['6'] === 'object' ? payload['6'] : {};
  const dockField = payload['8'] && typeof payload['8'] === 'object' ? payload['8'] : {};
  const dockPos = dockField['1'] && typeof dockField['1'] === 'object' ? dockField['1'] : {};

  return {
    width: Number(payload['4'] || 0),
    height: Number(payload['5'] || 0),
    resolution: Number(payload['3'] || 0),
    area: Number(payload['33'] || 0),
    createdAt: Number(payload['34'] || 0),
    origin: {
      x: Number(field6['3'] || 0),
      y: Number(field6['1'] || 0),
    },
    dock: {
      x: toFloat32(dockPos['1']),
      y: toFloat32(dockPos['2']),
    },
    rooms,
    compressedMapBytes: compressedBytes,
    obstacleRecords: payload['32'] ? 1 : 0,
    payloadKeys: Object.keys(payload).sort((a, b) => Number(a) - Number(b)),
  };
}

function analyzeDisplayMap(decoded) {
  const field1 = firstObject(decoded && decoded['1']);
  const pos = field1 && firstObject(field1['1']);
  const dock = firstObject(decoded && decoded['5']);
  const dockPos = dock && firstObject(dock['1']);
  const grid = firstObject(decoded && decoded['7']);
  return {
    robot: pos ? {
      x: toFloat32(pos['1']),
      y: toFloat32(pos['2']),
      heading: toFloat32(field1['2']),
    } : null,
    dock: dockPos ? {
      x: toFloat32(dockPos['1']),
      y: toFloat32(dockPos['2']),
    } : null,
    overlayGrid: grid ? {
      width: Number(grid['1'] || 0),
      height: Number(grid['2'] || 0),
      bytes: typeof grid['3'] === 'string' && grid['3'].startsWith('0x') ? Math.floor((grid['3'].length - 2) / 2) : 0,
    } : null,
    timestamp: Number((decoded && decoded['10']) || 0),
    activeRoomFieldPresent: Boolean(decoded && decoded['12']),
    keys: Object.keys(decoded || {}).sort((a, b) => Number(a) - Number(b)),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const diagnosticsDir = path.join(process.cwd(), 'diagnostics');
  ensureDir(diagnosticsDir);
  const outPath = path.join(diagnosticsDir, `narwal-data-dump-${isoStamp(startedAt)}.json`);

  const dump = {
    meta: {
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      url,
      host,
      port,
      productKey,
      deviceId,
      durationMs,
      note: 'Local read-only Narwal diagnostic dump. Payload hex is kept for protocol analysis.',
    },
    commands: [],
    frames: [],
    summary: {},
  };

  const pendingCommands = [];

  const ws = new WebSocket(url, C.WEBSOCKET_OPTIONS);

  ws.on('message', (raw) => {
    const rawBuffer = Buffer.from(raw);
    const parsed = protocol.parse(rawBuffer);
    if (!parsed) {
      dump.frames.push({
        ts: new Date().toISOString(),
        type: 'unparsed',
        bytes: rawBuffer.length,
        rawHex: rawBuffer.toString('hex'),
      });
      return;
    }

    const record = {
      ts: new Date().toISOString(),
      type: parsed.type,
      fieldTag: parsed.fieldTag,
      topic: parsed.topic,
      shortTopic: parsed.shortTopic,
      payloadBytes: parsed.payload.length,
      payloadHex: parsed.payload.toString('hex'),
      decoded: parsed.decoded,
      decodedSummary: summarizeValue(parsed.decoded),
    };

    if (parsed.shortTopic && parsed.shortTopic.startsWith('status/')) {
      try {
        record.normalizedStatus = protocol.normalizeStatus(parsed.decoded, parsed.shortTopic);
      } catch (err) {
        record.normalizedStatusError = err.message;
      }
    }
    if (parsed.type === 'response' && !parsed.shortTopic && pendingCommands.length) {
      record.probableCommand = pendingCommands.shift();
    }
    const effectiveTopic = parsed.shortTopic || (record.probableCommand && record.probableCommand.topic) || '';

    if (effectiveTopic === 'map/display_map') record.mapDisplayAnalysis = analyzeDisplayMap(parsed.decoded);
    if (effectiveTopic === 'map/get_map') {
      record.commandResponse = parseCommandResponse(parsed.decoded, parsed.payload);
      record.mapResponseAnalysis = analyzeMapResponse(parsed.decoded);
    }
    if (effectiveTopic === 'map/get_all_reduced_maps') {
      record.commandResponse = parseCommandResponse(parsed.decoded, parsed.payload);
    }

    dump.frames.push(record);
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${url}`)), C.CONNECT_TIMEOUT_MS);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const readOnlyTopics = [
    'status/get_device_base_status',
    'clean/current_clean_task/get',
    'map/get_map',
    'map/get_all_reduced_maps',
  ];

  function sendFrame(label, frame) {
    ws.send(frame);
    dump.commands.push({
      ts: new Date().toISOString(),
      label,
      bytes: frame.length,
    });
    if (readOnlyTopics.includes(label)) pendingCommands.push({ ts: new Date().toISOString(), topic: label });
  }

  protocol.buildDiscoveryFrames(C.KNOWN_PRODUCT_KEYS).forEach((frame, index) => sendFrame(`discovery_${index + 1}`, frame));
  await sleep(1500);
  protocol.buildWakeFrames().forEach((frame, index) => sendFrame(`wake_${index + 1}`, frame));
  await sleep(2000);

  for (const topic of readOnlyTopics) {
    sendFrame(topic, protocol.buildCommandFrame(topic));
    await sleep(topic.startsWith('map/') ? 9000 : 2500);
  }

  const remaining = Math.max(0, durationMs - (Date.now() - startedAt.getTime()));
  if (remaining) await sleep(Math.min(remaining, 15000));

  ws.close();
  dump.meta.finishedAt = new Date().toISOString();
  dump.summary = {
    totalFrames: dump.frames.length,
    topics: countTopics(dump.frames),
    normalizedStatuses: dump.frames
      .filter((frame) => frame.normalizedStatus)
      .map((frame) => ({
        ts: frame.ts,
        topic: frame.shortTopic,
        state: frame.normalizedStatus.state,
        homeyState: frame.normalizedStatus.homeyState,
        battery: frame.normalizedStatus.battery,
        charging: frame.normalizedStatus.charging,
        docked: frame.normalizedStatus.docked,
        fanSpeed: frame.normalizedStatus.fanSpeed,
        cleanArea: frame.normalizedStatus.cleanArea,
        cleanTime: frame.normalizedStatus.cleanTime,
        firmware: frame.normalizedStatus.firmware,
        error: frame.normalizedStatus.error,
      })),
    mapResponses: dump.frames
      .filter((frame) => frame.mapResponseAnalysis)
      .map((frame) => frame.mapResponseAnalysis),
    displayMapSamples: dump.frames
      .filter((frame) => frame.mapDisplayAnalysis)
      .slice(-5)
      .map((frame) => frame.mapDisplayAnalysis),
    commandResponses: dump.frames
      .filter((frame) => frame.commandResponse)
      .map((frame) => ({
        ts: frame.ts,
        topic: frame.shortTopic || (frame.probableCommand && frame.probableCommand.topic) || '',
        ok: frame.commandResponse.ok,
        resultCode: frame.commandResponse.resultCode,
        label: frame.commandResponse.label,
      })),
    identity: {
      productKey,
      deviceIdMasked: mask(deviceId),
    },
  };

  fs.writeFileSync(outPath, `${JSON.stringify(dump, null, 2)}\n`);
  console.log(JSON.stringify({
    dumpFile: outPath,
    summary: {
      ...dump.summary,
      normalizedStatuses: dump.summary.normalizedStatuses.slice(-5),
      displayMapSamples: dump.summary.displayMapSamples.slice(-2),
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

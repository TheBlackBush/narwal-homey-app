'use strict';

const zlib = require('zlib');

/**
 * Decodes Narwal map messages from their raw protobuf bytes, following the
 * official app's message definitions:
 * - `map/get_map` response: GetMap.Response {2: StaticMapPayload}
 * - `map/display_map` broadcast: DisplayMap (robot pose, trail, map updates)
 *
 * Pure, no Homey. Field numbers are listed where they are read.
 */

// ---- Raw protobuf reading ------------------------------------------------

function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const byte = buf[pos];
    pos += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7n;
    if (shift > 63n) throw new Error('varint too long');
  }
  return { value, offset: pos };
}

// Fields by number; each entry is a list of {wire, value}. Varints stay
// BigInt until the caller picks int32/uint32; length-delimited values are
// Buffers.
function readFields(buf) {
  const fields = {};
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    pos = key.offset;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    let value;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.offset;
      value = v.value;
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      pos = len.offset;
      const end = pos + Number(len.value);
      if (end > buf.length) throw new Error(`truncated field ${field}`);
      value = buf.subarray(pos, end);
      pos = end;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new Error(`truncated field ${field}`);
      value = buf.readFloatLE(pos);
      pos += 4;
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new Error(`truncated field ${field}`);
      value = buf.readDoubleLE(pos);
      pos += 8;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
    (fields[field] = fields[field] || []).push({ wire, value });
  }
  return fields;
}

const first = (fields, n) => (fields[n] ? fields[n][0] : null);
const all = (fields, n) => fields[n] || [];

function int(fields, n, fallback = 0) {
  const f = first(fields, n);
  if (!f || f.wire !== 0) return fallback;
  return Number(BigInt.asIntN(64, f.value));
}

function uint(fields, n, fallback = 0) {
  const f = first(fields, n);
  if (!f || f.wire !== 0) return fallback;
  return Number(BigInt.asUintN(64, f.value));
}

function bool(fields, n) {
  return uint(fields, n, 0) !== 0;
}

function float(fields, n, fallback = null) {
  const f = first(fields, n);
  if (!f) return fallback;
  if (f.wire === 5 || f.wire === 1) return f.value;
  return fallback;
}

function bytes(fields, n) {
  const f = first(fields, n);
  return f && f.wire === 2 ? f.value : null;
}

function message(fields, n) {
  const b = bytes(fields, n);
  return b ? readFields(b) : null;
}

function text(fields, n) {
  const b = bytes(fields, n);
  return b ? b.toString('utf8').replace(/\0+$/g, '').trim() : '';
}

// Repeated scalars: packed (one length-delimited field) or not.
function packedVarints(fields, n) {
  const out = [];
  for (const f of all(fields, n)) {
    if (f.wire === 0) {
      out.push(Number(BigInt.asUintN(32, f.value)));
    } else if (f.wire === 2) {
      let pos = 0;
      while (pos < f.value.length) {
        const v = readVarint(f.value, pos);
        pos = v.offset;
        out.push(Number(BigInt.asUintN(32, v.value)));
      }
    }
  }
  return out;
}

function packedFloats(fields, n) {
  const out = [];
  for (const f of all(fields, n)) {
    if (f.wire === 5) out.push(f.value);
    else if (f.wire === 2) {
      for (let pos = 0; pos + 4 <= f.value.length; pos += 4) out.push(f.value.readFloatLE(pos));
    }
  }
  return out;
}

// ---- Shared message types ------------------------------------------------

// Point {1 x float, 2 y float}
function decodePoint(fields) {
  if (!fields) return null;
  const x = float(fields, 1, 0);
  const y = float(fields, 2, 0);
  return { x, y };
}

// PoseData {1 location Point, 2 theta float (rad)}
function decodePose(fields) {
  if (!fields) return null;
  const location = decodePoint(message(fields, 1));
  if (!location) return null;
  return { x: location.x, y: location.y, theta: float(fields, 2, 0) };
}

// RobotTrajectory {1 xs float[], 2 ys float[]}
function decodeTrajectory(fields) {
  if (!fields) return [];
  const xs = packedFloats(fields, 1);
  const ys = packedFloats(fields, 2);
  const points = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i += 1) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) points.push({ x: xs[i], y: ys[i] });
  }
  return points;
}

// gzip (1f 8b) or zlib (78 ..); anything else is taken as already inflated.
function inflate(buf) {
  if (!buf || !buf.length) return Buffer.alloc(0);
  if (buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  if (buf[0] === 0x78) return zlib.inflateSync(buf);
  return buf;
}

// ---- Rooms ----------------------------------------------------------------

// RoomType names in type order, as the official app's
// MapEnginei18nConfiger.roomTypei18nKey maps them.
const ROOM_TYPE_NAMES = [
  'Room', 'Master Bedroom', 'Secondary Bedroom', 'Living Room', 'Kitchen', 'Bathroom', 'Toilet',
  'Balcony', 'Dining Room', 'Closet', 'Corridor', 'Study', "Kids' Room", 'Entertainment Room',
  'Storage Room', 'Other',
];

// RoomInfo {1 roomId, 2 type, 3 customName, 4 texture, 6 default heavy-dirt
// room, 8 roomTypeId, 9 color}
function decodeRoom(fields) {
  return {
    id: uint(fields, 1),
    type: uint(fields, 2),
    customName: text(fields, 3),
    texture: uint(fields, 4),
    heavyDirt: bool(fields, 6) || bool(fields, 7),
    roomTypeId: uint(fields, 8),
    color: uint(fields, 9),
  };
}

/**
 * Display names as the official app builds them (MapEngineDataUtil
 * .parseRoomName): a custom name wins; otherwise rooms are grouped by type,
 * a type that occurs once is just the type name, and every room of a type
 * that occurs more than once gets a number with no separator ("Toilet1"):
 * its roomTypeId, or its position in the group.
 */
function roomDisplayNames(rooms, typeNames = ROOM_TYPE_NAMES) {
  const names = new Map();
  const groups = new Map();
  for (const room of rooms) {
    if (room.customName) {
      names.set(room.id, room.customName);
    } else {
      if (!groups.has(room.type)) groups.set(room.type, []);
      groups.get(room.type).push(room);
    }
  }
  for (const [type, group] of groups) {
    const base = typeNames[type] || typeNames[0];
    if (group.length === 1) {
      names.set(group[0].id, base);
      continue;
    }
    group.forEach((room, index) => {
      names.set(room.id, `${base}${room.roomTypeId || index + 1}`);
    });
  }
  return names;
}

// ---- Grid cells ------------------------------------------------------------

/**
 * One map cell, as the official app reads it:
 * - 0x20: wall (one cell thick, outside any room)
 * - (v >> 8) & 0xff: room id, 0 = no room
 * - 0x10: room edge cell
 * - 0x04: already cleaned
 * - 0x01: floor when the map has no rooms
 * - bits 16-19 clean level, 20-23 dirt level
 */
function classifyCell(value) {
  if (!value) return { kind: 'outside' };
  if (value & 0x20) return { kind: 'wall' };
  const roomId = (value >> 8) & 0xff;
  let kind = 'outside';
  if (roomId) kind = 'room';
  else if (value & 0x01) kind = 'floor';
  return {
    kind,
    roomId,
    edge: Boolean(value & 0x10),
    cleaned: Boolean(value & 0x04),
    cleanLevel: (value >> 16) & 0xf,
    dirtLevel: (value >> 20) & 0xf,
  };
}

// MapData {1 grids uint32[] packed}
function decodeGrid(fields, width, height) {
  const expected = width * height;
  let grid = null;
  const mapData = message(fields, 16);
  if (mapData) grid = packedVarints(mapData, 1);
  if (!grid || !grid.length) {
    const compressed = bytes(fields, 17);
    if (compressed) grid = packedVarints(readFields(inflate(compressed)), 1);
  }
  if (!grid || !grid.length) return null;
  if (grid.length !== expected) {
    throw new Error(`map grid has ${grid.length} cells, expected ${width} x ${height}`);
  }
  return grid;
}

// ---- Static map --------------------------------------------------------------

/**
 * StaticMapPayload. Coordinates of poses and trails are in cells relative to
 * the border: column = x - left, row (from the bottom) = y - bottom.
 */
function decodeStaticMap(buf) {
  const f = readFields(buf);
  const width = int(f, 4);
  const height = int(f, 5);
  const borderFields = message(f, 6);
  const border = borderFields ? {
    bottom: int(borderFields, 1), top: int(borderFields, 2), left: int(borderFields, 3), right: int(borderFields, 4),
  } : null;
  const rooms = all(f, 12).filter((x) => x.wire === 2).map((x) => decodeRoom(readFields(x.value)));
  const names = roomDisplayNames(rooms);
  const toCell = (point) => (point && border ? { ...point, x: point.x - border.left, y: point.y - border.bottom } : point);

  return {
    mapId: int(f, 1),
    mapVersion: uint(f, 2),
    resolution: int(f, 3),
    width,
    height,
    border,
    station: toCell(decodePose(message(f, 8))),
    rooms: rooms.map((room) => ({ ...room, name: names.get(room.id) })),
    trail: decodeTrajectory(message(f, 13)).map(toCell),
    grid: width > 0 && height > 0 ? decodeGrid(f, width, height) : null,
    isBuildingMap: bool(f, 19),
    seqId: uint(f, 22),
    robot: toCell(decodePose(message(f, 24))),
    rotateAngle: int(f, 25),
    editVersion: uint(f, 33),
    generatedAt: uint(f, 34),
    isTempMap: bool(f, 37),
  };
}

// GetMap.Response {1 result, 2 map StaticMapPayload, 3 robotHasMap}
function decodeGetMapResponse(buf) {
  const f = readFields(buf);
  const map = bytes(f, 2);
  if (!map) return null;
  const decoded = decodeStaticMap(map);
  return decoded.width > 0 && decoded.height > 0 ? decoded : null;
}

// ---- Live map (display_map) -----------------------------------------------------

const DISPLAY_MAP_TYPE = { UNSPECIFIED: 0, BUILDING: 1, CLEAN: 2 };

/**
 * DisplayMap: 1 robot pose, 2 trail window, 4 current zone, 5 station,
 * 6 map type, 7 incremental map data, 10 pose time (ms). Coordinates are raw;
 * convert with the static map's border.
 */
function decodeDisplayMap(buf) {
  const f = readFields(buf);
  const robot = decodePose(message(f, 1));
  const poseTime = uint(f, 10);
  let incremental = null;
  const inc = message(f, 7);
  if (inc) {
    const compressed = bytes(inc, 3);
    let cells = [];
    if (compressed && compressed.length) {
      const grid = readFields(inflate(compressed)); // GridData {1 indexes, 2 values}
      const indexes = packedVarints(grid, 1);
      const values = packedVarints(grid, 2);
      cells = indexes.map((index, i) => [index, values[i] || 0]);
    }
    incremental = { startSeqId: uint(inc, 1), currentSeqId: uint(inc, 2), cells };
  }
  return {
    robot,
    // (0, 0) with no pose time: the robot has lost its position on the map.
    lostPosition: Boolean(robot && robot.x === 0 && robot.y === 0 && !poseTime),
    trail: decodeTrajectory(message(f, 2)),
    currentZoneId: uint(f, 4),
    station: decodePose(message(f, 5)),
    mapType: uint(f, 6),
    incremental,
    poseTime,
  };
}

/**
 * Applies a display_map update to a static map's grid, by the official
 * app's rule. Returns 'applied', 'stale' (drop, nothing to do), or 'gap'
 * (drop and fetch the static map again).
 */
function applyIncrementalUpdate(staticMap, incremental) {
  if (!staticMap || !staticMap.grid) return 'gap';
  if (!incremental) return 'stale';
  const current = staticMap.seqId || 0;
  if (current + 1 < incremental.startSeqId) return 'gap';
  if (current >= incremental.currentSeqId) return 'stale';
  for (const [index, value] of incremental.cells) {
    if (index >= 0 && index < staticMap.grid.length) staticMap.grid[index] = value;
  }
  staticMap.seqId = incremental.currentSeqId;
  return 'applied';
}

module.exports = {
  readFields,
  decodeStaticMap,
  decodeGetMapResponse,
  decodeDisplayMap,
  applyIncrementalUpdate,
  roomDisplayNames,
  classifyCell,
  ROOM_TYPE_NAMES,
  DISPLAY_MAP_TYPE,
};

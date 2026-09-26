'use strict';

const zlib = require('zlib');
const { classifyCell } = require('./NarwalMapCodec');

/**
 * MapParser
 *
 * Pure, dependency-free parser for the robot's map payload. It extracts the
 * structured pieces the app cares about (rooms, robot/dock position, cleaning
 * trail and obstacles) and can render a lightweight SVG snapshot.
 *
 * Map rendering is intentionally optional: room discovery is the primary
 * feature and never depends on rendering succeeding. The renderer is best
 * effort and guarded by callers.
 */

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstArray(...candidates) {
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function pickPoint(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const x = toNumber(obj.x ?? obj.X ?? obj[0]);
  const y = toNumber(obj.y ?? obj.Y ?? obj[1]);
  if (x === null || y === null) return null;
  return { x, y };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function toFloat32(value) {
  if (typeof value === 'number' && !Number.isInteger(value)) return value;
  if (!Number.isFinite(Number(value))) return null;
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(Number(value) >>> 0, 0);
  return buf.readFloatLE(0);
}

function narwalText(value) {
  if (value === undefined || value === null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8').replace(/\0+$/g, '').trim();
  return String(value).replace(/^b['"]|['"]$/g, '').replace(/\0+$/g, '').trim();
}

// Room type (field 2) names from the official app. One table is shared by
// every model.
const NARWAL_ROOM_TYPE_NAMES = {
  0: 'Room',
  1: 'Master Bedroom',
  2: 'Secondary Bedroom',
  3: 'Living Room',
  4: 'Kitchen',
  5: 'Bathroom',
  6: 'Toilet',
  7: 'Balcony',
  8: 'Dining Room',
  9: 'Closet',
  10: 'Corridor',
  11: 'Study',
  12: "Kids' Room",
  13: 'Entertainment Room',
  14: 'Storage Room',
  15: 'Other',
};

function narwalRoomName(room, id) {
  const customName = narwalText(room && room['3']);
  if (customName) return customName;

  const subtype = toNumber(room && room['2'], 0) || 0;
  const instanceIndex = toNumber(room && room['8'], 0) || 0;
  const base = NARWAL_ROOM_TYPE_NAMES[subtype] || 'Room';
  if (instanceIndex > 1) return `${base} ${instanceIndex}`;
  return base || `Room ${id}`;
}

function hexByteLength(value) {
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === 'string' && /^0x[0-9a-f]*$/i.test(value)) return Math.floor((value.length - 2) / 2);
  if (typeof value === 'string') return Buffer.byteLength(value);
  return 0;
}

function toBuffer(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
  if (typeof value === 'string' && /^0x[0-9a-f]*$/i.test(value)) return Buffer.from(value.slice(2), 'hex');
  if (typeof value === 'string') return Buffer.from(value, 'latin1');
  return null;
}

const NARWAL_ROOM_COLORS = [
  [100, 149, 237], [144, 238, 144], [255, 182, 193], [255, 218, 185],
  [221, 160, 221], [176, 224, 230], [255, 255, 150], [188, 143, 143],
  [152, 251, 152], [135, 206, 250], [240, 128, 128], [216, 191, 216],
  [250, 250, 210], [173, 216, 230], [244, 164, 96], [245, 222, 179],
  [127, 255, 212], [255, 160, 122], [186, 218, 160], [255, 228, 196],
  [200, 162, 200], [174, 198, 207],
];

const COLOR_UNASSIGNED_FLOOR = [200, 200, 200, 255];
const COLOR_WALL = [50, 59, 108, 255]; // #323B6C, the official wall colour
const COLOR_FALLBACK = [180, 180, 180, 255];
const COLOR_TRANSPARENT = [0, 0, 0, 0];

function roomColor(roomId) {
  const base = NARWAL_ROOM_COLORS[roomId - 1] || COLOR_FALLBACK;
  return [base[0], base[1], base[2], 255];
}

function decodePackedVarints(data) {
  if (!data || !data.length) return [];
  let pos = 0;
  if (data[0] === 0x0a) {
    pos = 1;
    while (pos < data.length && (data[pos] & 0x80)) pos += 1;
    if (pos < data.length) pos += 1;
  }

  const values = [];
  while (pos < data.length) {
    let value = 0;
    let shift = 0;
    while (pos < data.length) {
      const byte = data[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7;
      if (shift > 28) break;
    }
    values.push(value >>> 0);
  }
  return values;
}

function decompressMap(compressed) {
  const buffer = toBuffer(compressed);
  if (!buffer || !buffer.length) return null;
  const attempts = [
    () => zlib.inflateSync(buffer),
    () => zlib.inflateSync(buffer, { windowBits: 47 }),
    () => zlib.inflateRawSync(buffer),
  ];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (err) {
      if (err && err.message) {
        // Try the next compatible zlib mode.
      }
    }
  }
  return null;
}

// The centroid of a room's cells, moved onto the nearest cell of that room
// when it falls outside (an L-shaped room), so the label sits in the room.
function labelPoint(cells, cx, cy) {
  const x = Math.round(cx);
  const y = Math.round(cy);
  let best = null;
  let bestDistance = Infinity;
  for (let i = 0; i < cells.length; i += 2) {
    if (cells[i] === x && cells[i + 1] === y) return { x, y };
    const distance = (cells[i] - cx) ** 2 + (cells[i + 1] - cy) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { x: cells[i], y: cells[i + 1] };
    }
  }
  return best || { x, y };
}

class MapParser {
  /**
   * Parse a raw map payload into a normalized structure. Returns null if the
   * payload contains nothing usable (e.g. robot has no map yet).
   *
   * Normalized shape:
   * {
   *   rooms: [{ id, name, color }],
   *   robot: { x, y } | null,
   *   dock:  { x, y } | null,
   *   trail: [{ x, y }],
   *   obstacles: [{ x, y, type }],
   *   bounds: { minX, minY, maxX, maxY },
   *   updatedAt: number
   * }
   */
  static parse(payload, now = 0, options = {}) {
    if (!payload || typeof payload !== 'object') return null;
    const data = payload.map || payload.data || payload;

    if ((data['2'] && typeof data['2'] === 'object' && (data['2']['12'] || data['2']['17']))
      || data['12'] || data['17']) {
      return MapParser.parseNarwalMapResponse(data, now, options.productKey || '');
    }

    const rooms = MapParser.parseRooms(data);
    const robot = pickPoint(data.robot || data.robotPos || data.position || data.pose);
    const dock = pickPoint(data.dock || data.dockPos || data.charger || data.chargerPos);
    const trail = firstArray(data.trail, data.path, data.track, data.cleanPath)
      .map(pickPoint)
      .filter(Boolean);
    const obstacles = firstArray(data.obstacles, data.furniture, data.objects)
      .map((o) => {
        const p = pickPoint(o);
        if (!p) return null;
        return { ...p, type: String(o.type ?? o.kind ?? 'object') };
      })
      .filter(Boolean);

    const hasContent = rooms.length || robot || dock || trail.length || obstacles.length;
    if (!hasContent) return null;

    return {
      rooms,
      robot,
      dock,
      trail,
      obstacles,
      bounds: MapParser.computeBounds([
        robot, dock, ...trail, ...obstacles,
        ...rooms.flatMap((r) => r.outline || []),
      ].filter(Boolean)),
      updatedAt: now,
    };
  }

  /**
   * Extract just the room list (the part the app exposes first). Always returns
   * an array; each entry has a string id and a human-friendly name.
   */
  static parseRooms(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const data = payload.map || payload.data || payload;
    const raw = firstArray(data.rooms, data.areas, data.regions, data.segments);

    return raw
      .map((room, index) => {
        if (room === null || room === undefined) return null;
        const id = room.id ?? room.roomId ?? room.segmentId ?? room.no ?? index;
        const name = room.name ?? room.roomName ?? room.label ?? room.tag ?? `Room ${id}`;
        const outline = firstArray(room.outline, room.points, room.vertices)
          .map(pickPoint)
          .filter(Boolean);
        return {
          id: String(id),
          name: String(name),
          color: room.color ? String(room.color) : null,
          outline,
        };
      })
      .filter(Boolean);
  }

  static parseNarwalMapResponse(decoded, now = 0, productKey = '') {
    if (!decoded || typeof decoded !== 'object') return null;
    const payload = decoded['2'] && typeof decoded['2'] === 'object' ? decoded['2'] : decoded;
    if (!payload || typeof payload !== 'object') return null;

    const roomsField = payload['12'];
    const hasRoomList = Array.isArray(roomsField) || (roomsField && typeof roomsField === 'object');
    const width = toNumber(payload['4'], 0) || 0;
    const height = toNumber(payload['5'], 0) || 0;
    const resolution = toNumber(payload['3'], 0) || 0;
    const hasCompressedMap = payload['17'] !== undefined;
    const hasMapDimensions = width > 10 && height > 10 && resolution > 0;
    if (!hasRoomList && !hasCompressedMap && !hasMapDimensions) return null;

    const rooms = asArray(roomsField)
      .filter((room) => room && typeof room === 'object')
      .map((room, index) => {
        const id = String(room['1'] !== undefined ? room['1'] : index + 1);
        return {
          id,
          name: narwalRoomName(room, id),
          subtype: toNumber(room['2'], 0),
          category: toNumber(room['4'], 0),
          instanceIndex: toNumber(room['8'], 0),
          color: null,
          outline: [],
        };
      })
      .filter((room) => room.id);

    const field6 = payload['6'] && typeof payload['6'] === 'object' ? payload['6'] : {};
    const origin = {
      x: toNumber(field6['3'], 0) || 0,
      y: toNumber(field6['1'], 0) || 0,
    };

    let dock = null;
    const field8 = payload['8'] && typeof payload['8'] === 'object' ? payload['8'] : {};
    const dockPos = field8['1'] && typeof field8['1'] === 'object' ? field8['1'] : null;
    if (dockPos) {
      const x = toFloat32(dockPos['1']);
      const y = toFloat32(dockPos['2']);
      if (x !== null && y !== null) dock = { x: x - origin.x, y: y - origin.y };
    }

    const hasContent = rooms.length || width || height || dock;
    if (!hasContent) return null;

    return {
      rooms,
      robot: null,
      dock,
      trail: [],
      obstacles: [],
      bounds: MapParser.computeBounds([
        dock,
        width || height ? { x: 0, y: 0 } : null,
        width || height ? { x: width || 1, y: height || 1 } : null,
      ].filter(Boolean)),
      updatedAt: now,
      meta: {
        source: 'narwal:get_map',
        productKey,
        mapId: toNumber(payload['1'], 0) || 0,
        width,
        height,
        resolution,
        origin,
        area: toNumber(payload['33'], 0) || 0,
        createdAt: toNumber(payload['34'], 0) || 0,
        compressedMapBytes: hexByteLength(payload['17']),
        compressedMap: payload['17'] || null,
        hasAnnotations: Boolean(payload['32']),
        payloadKeys: Object.keys(payload).sort((a, b) => Number(a) - Number(b)),
      },
    };
  }

  /**
   * The app's map object from a decoded StaticMapPayload (NarwalMapCodec).
   * Rooms carry their official display names; the dock and grid are in cells.
   */
  static fromStaticMap(staticMap, now = 0, productKey = '') {
    if (!staticMap) return null;
    const { width, height } = staticMap;
    return {
      rooms: staticMap.rooms.map((room) => ({
        id: String(room.id),
        name: room.name,
        type: room.type,
        texture: room.texture,
        roomTypeId: room.roomTypeId,
        color: null,
        outline: [],
      })),
      robot: null,
      dock: staticMap.station || null,
      trail: [],
      obstacles: [],
      grid: staticMap.grid,
      bounds: MapParser.computeBounds([{ x: 0, y: 0 }, { x: width || 1, y: height || 1 }]),
      updatedAt: now,
      meta: {
        source: 'narwal:get_map',
        productKey,
        mapId: staticMap.mapId,
        mapVersion: staticMap.mapVersion,
        editVersion: staticMap.editVersion,
        seqId: staticMap.seqId,
        width,
        height,
        resolution: staticMap.resolution,
        border: staticMap.border,
        rotateAngle: staticMap.rotateAngle,
        createdAt: staticMap.generatedAt,
      },
    };
  }

  static decodeNarwalPixelMap(map) {
    if (map && Array.isArray(map.grid) && map.meta && map.meta.width && map.meta.height) {
      return {
        width: map.meta.width, height: map.meta.height, pixels: map.grid, decompressedBytes: 0,
      };
    }
    if (!map || !map.meta || !map.meta.compressedMap) return null;
    const width = toNumber(map.meta.width, 0) || 0;
    const height = toNumber(map.meta.height, 0) || 0;
    if (width <= 0 || height <= 0) return null;

    const decompressed = decompressMap(map.meta.compressedMap);
    if (!decompressed) return null;

    const expected = width * height;
    const pixels = decodePackedVarints(decompressed);
    if (pixels.length < expected) {
      while (pixels.length < expected) pixels.push(0);
    } else if (pixels.length > expected) {
      pixels.splice(expected);
    }

    return {
      width,
      height,
      pixels,
      decompressedBytes: decompressed.length,
    };
  }

  static toRenderData(map, options = {}) {
    const decoded = MapParser.decodeNarwalPixelMap(map);
    if (!decoded) return null;

    const { width, height, pixels } = decoded;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let i = 0; i < pixels.length; i += 1) {
      const value = pixels[i] || 0;
      if (!value) continue;
      const sourceY = Math.floor(i / width);
      const x = i % width;
      const y = height - 1 - sourceY;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    const hasContentBounds = maxX >= minX && maxY >= minY;
    const cropPadding = Number.isFinite(options.cropPadding) ? Math.max(0, options.cropPadding) : 8;
    const crop = hasContentBounds ? {
      x: Math.max(0, minX - cropPadding),
      y: Math.max(0, minY - cropPadding),
      maxX: Math.min(width - 1, maxX + cropPadding),
      maxY: Math.min(height - 1, maxY + cropPadding),
    } : {
      x: 0,
      y: 0,
      maxX: width - 1,
      maxY: height - 1,
    };
    const renderWidth = crop.maxX - crop.x + 1;
    const renderHeight = crop.maxY - crop.y + 1;
    const rgba = Buffer.alloc(renderWidth * renderHeight * 4);
    const roomStats = {};
    const roomCells = {};

    for (let i = 0; i < pixels.length; i += 1) {
      const sourceY = Math.floor(i / width);
      const x = i % width;
      const y = height - 1 - sourceY;
      if (x < crop.x || x > crop.maxX || y < crop.y || y > crop.maxY) continue;
      const renderX = x - crop.x;
      const renderY = y - crop.y;
      const out = (renderY * renderWidth + renderX) * 4;
      const value = pixels[i] || 0;
      let color = COLOR_TRANSPARENT;

      // Cells as the official app reads them (NarwalMapCodec.classifyCell).
      const cell = classifyCell(value);
      if (cell.kind === 'wall') {
        color = COLOR_WALL;
      } else if (cell.kind === 'floor') {
        color = COLOR_UNASSIGNED_FLOOR;
      } else if (cell.kind === 'room') {
        const { roomId } = cell;
        color = roomColor(roomId);
        const key = String(roomId);
        if (!roomStats[key]) {
          roomStats[key] = {
            roomId,
            count: 0,
            x: 0,
            y: 0,
          };
        }
        roomStats[key].count += 1;
        roomStats[key].x += renderX;
        roomStats[key].y += renderY;
        (roomCells[key] = roomCells[key] || []).push(renderX, renderY);
      }

      rgba[out] = color[0];
      rgba[out + 1] = color[1];
      rgba[out + 2] = color[2];
      rgba[out + 3] = color[3];
    }

    const roomNameById = new Map((map.rooms || []).map((room) => [String(room.id), room.name]));
    const roomLabels = Object.values(roomStats)
      .filter((stat) => stat.count > 0 && roomNameById.has(String(stat.roomId)))
      .map((stat) => {
        const point = labelPoint(roomCells[String(stat.roomId)], stat.x / stat.count, stat.y / stat.count);
        return {
          id: String(stat.roomId),
          name: roomNameById.get(String(stat.roomId)),
          x: point.x,
          y: point.y,
        };
      });

    return {
      type: 'narwal-map',
      version: 1,
      format: 'rgba',
      width: renderWidth,
      height: renderHeight,
      pixels: rgba.toString('base64'),
      roomLabels,
      rooms: (map.rooms || []).map((room) => ({ id: String(room.id), name: room.name })),
      chargerPos: map.dock ? {
        x: Math.round(map.dock.x) - crop.x,
        y: height - 1 - Math.round(map.dock.y) - crop.y,
      } : null,
      robotPos: map.robot ? {
        x: Math.round(map.robot.x) - crop.x,
        y: height - 1 - Math.round(map.robot.y) - crop.y,
      } : null,
      updatedAt: map.updatedAt || Date.now(),
      meta: {
        resolution: map.meta && map.meta.resolution ? map.meta.resolution : 0,
        area: map.meta && map.meta.area ? map.meta.area : 0,
        renderedAt: options.now || Date.now(),
        decompressedBytes: decoded.decompressedBytes,
        crop: {
          x: crop.x,
          y: crop.y,
          width: renderWidth,
          height: renderHeight,
          sourceWidth: width,
          sourceHeight: height,
        },
      },
    };
  }

  static computeBounds(points) {
    if (!points.length) {
      return {
        minX: 0, minY: 0, maxX: 0, maxY: 0,
      };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return {
      minX, minY, maxX, maxY,
    };
  }

  /**
   * Render a minimal SVG snapshot of a parsed map. Returns an SVG string.
   * Deliberately simple: a backdrop, room outlines, the cleaning trail, dock
   * and robot markers. Safe to skip: never throws on partial data.
   */
  static toSVG(map, options = {}) {
    const width = options.width || 640;
    const height = options.height || 640;
    const pad = 24;
    const bg = options.background || '#0f1420';

    if (!map) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
        + `<rect width="100%" height="100%" fill="${bg}"/>`
        + '<text x="50%" y="50%" fill="#8a93a6" font-family="sans-serif" font-size="20" '
        + 'text-anchor="middle">No map available</text></svg>';
    }

    const {
      minX, minY, maxX, maxY,
    } = map.bounds;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
    const tx = (x) => pad + (x - minX) * scale;
    const ty = (y) => pad + (y - minY) * scale;

    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
    parts.push(`<rect width="100%" height="100%" fill="${bg}"/>`);

    const palette = ['#683df5', '#2f6fed', '#27ae60', '#e67e22', '#9b59b6', '#16a085', '#c0392b', '#2980b9'];
    let drewRooms = false;
    map.rooms.forEach((room, i) => {
      if (!room.outline || room.outline.length < 3) return;
      drewRooms = true;
      const pts = room.outline.map((p) => `${tx(p.x).toFixed(1)},${ty(p.y).toFixed(1)}`).join(' ');
      // Room colours end up in SVG attributes; accept hex colours only.
      const fill = /^#[0-9a-f]{3,8}$/i.test(room.color || '') ? room.color : palette[i % palette.length];
      parts.push(`<polygon points="${pts}" fill="${fill}" fill-opacity="0.35" stroke="${fill}" stroke-width="1.5"/>`);
      const cx = room.outline.reduce((s, p) => s + tx(p.x), 0) / room.outline.length;
      const cy = room.outline.reduce((s, p) => s + ty(p.y), 0) / room.outline.length;
      parts.push(`<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" fill="#fff" font-family="sans-serif" `
        + `font-size="13" text-anchor="middle">${MapParser.escape(room.name)}</text>`);
    });

    if (!drewRooms && map.rooms && map.rooms.length) {
      const heading = MapParser.escape((map.meta && map.meta.width && map.meta.height)
        ? (`Map ${map.meta.width}×${map.meta.height}`)
        : 'Discovered rooms');
      parts.push('<rect x="34" y="34" width="572" height="572" rx="28" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.14)"/>');
      parts.push(`<text x="320" y="78" fill="#fff" font-family="sans-serif" font-size="22" font-weight="700" text-anchor="middle">${heading}</text>`);
      map.rooms.slice(0, 16).forEach((room, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = 68 + col * 258;
        const y = 112 + row * 54;
        const fill = palette[i % palette.length];
        parts.push(`<rect x="${x}" y="${y}" width="224" height="38" rx="19" fill="${fill}" fill-opacity="0.22" stroke="${fill}" stroke-opacity="0.45"/>`);
        parts.push(`<text x="${x + 20}" y="${y + 25}" fill="#fff" font-family="sans-serif" font-size="14">${MapParser.escape(room.name)}</text>`);
      });
    }

    if (map.trail && map.trail.length > 1) {
      const d = map.trail.map((p, i) => `${i === 0 ? 'M' : 'L'}${tx(p.x).toFixed(1)} ${ty(p.y).toFixed(1)}`).join(' ');
      parts.push(`<path d="${d}" fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="1.5"/>`);
    }

    for (const o of map.obstacles || []) {
      parts.push(`<circle cx="${tx(o.x).toFixed(1)}" cy="${ty(o.y).toFixed(1)}" r="3" fill="#e74c3c"/>`);
    }

    if (map.dock) {
      parts.push(`<rect x="${(tx(map.dock.x) - 7).toFixed(1)}" y="${(ty(map.dock.y) - 7).toFixed(1)}" `
        + 'width="14" height="14" rx="3" fill="#f1c40f"/>');
    }
    if (map.robot) {
      parts.push(`<circle cx="${tx(map.robot.x).toFixed(1)}" cy="${ty(map.robot.y).toFixed(1)}" `
        + 'r="8" fill="#1abc9c" stroke="#fff" stroke-width="2"/>');
    }

    parts.push('</svg>');
    return parts.join('');
  }

  static escape(str) {
    return String(str).replace(/[<>&'"]/g, (c) => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
    }[c]));
  }
}

module.exports = {
  MapParser,
  NARWAL_ROOM_TYPE_NAMES,
};

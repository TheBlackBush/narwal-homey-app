'use strict';

const EventEmitter = require('events');

/**
 * MockSocket
 *
 * A drop-in stand-in for a `ws` WebSocket that emulates a Narwal robot using
 * canned data. It lets the app (and the test suite) run end to end without a
 * real robot. Enable it with NARWAL_MOCK=1 during local development
 * or the NARWAL_MOCK environment variable.
 *
 * It mirrors the small subset of the ws API the client uses: readyState,
 * send(), ping(), close(), terminate() and the 'open'/'message'/'close'/'pong'
 * events. Replies are generated from the same protocol the client speaks.
 */

const OPEN = 1;
const CLOSED = 3;

function buildMockStatus(state) {
  return {
    mode: state.mode,
    battery: state.battery,
    charging: state.charging,
    docked: state.docked,
    fanLevel: state.fanLevel,
    cleanArea: state.cleanArea,
    cleanTime: state.cleanTime,
    firmware: '1.0.0-mock',
    error: 0,
  };
}

function buildMockMap() {
  return {
    rooms: [
      { id: 1, name: 'Living Room', outline: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }] },
      { id: 2, name: 'Kitchen', outline: [{ x: 100, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 80 }, { x: 100, y: 80 }] },
      { id: 3, name: 'Bedroom', outline: [{ x: 0, y: 80 }, { x: 90, y: 80 }, { x: 90, y: 160 }, { x: 0, y: 160 }] },
    ],
    robot: { x: 40, y: 40 },
    dock: { x: 5, y: 5 },
    trail: [{ x: 5, y: 5 }, { x: 20, y: 20 }, { x: 40, y: 40 }],
    obstacles: [{ x: 70, y: 60, type: 'chair' }],
  };
}

class MockSocket extends EventEmitter {
  constructor({ protocol } = {}) {
    super();
    this.protocol = protocol;
    this.readyState = 1; // CONNECTING-ish; flips to OPEN on next tick
    this._state = {
      mode: 'docked',
      battery: 100,
      charging: true,
      docked: true,
      fanLevel: 1,
      cleanArea: 0,
      cleanTime: 0,
    };
    setImmediate(() => {
      this.readyState = OPEN;
      this.emit('open');
    });
  }

  ping() {
    setImmediate(() => this.emit('pong'));
  }

  send(payload) {
    let frame;
    try {
      frame = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (_) {
      return;
    }
    const reply = this._handle(frame);
    if (reply) {
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify(reply), 'utf8')));
    }
  }

  _handle(frame) {
    const cmd = String(frame.cmd || '');
    const { id } = frame;
    const ok = (result) => ({
      cmd, id, code: 0, result,
    });

    // Mutate the mock robot so behaviour is observable.
    if (/start/i.test(cmd)) Object.assign(this._state, { mode: 'cleaning', charging: false, docked: false });
    else if (/pause/i.test(cmd)) this._state.mode = 'paused';
    else if (/resume/i.test(cmd)) this._state.mode = 'cleaning';
    else if (/stop/i.test(cmd)) this._state.mode = 'idle';
    else if (/dock|home/i.test(cmd)) Object.assign(this._state, { mode: 'returning', docked: false });
    else if (/setfan|fanlevel/i.test(cmd)) this._state.fanLevel = Number(frame.params?.level ?? this._state.fanLevel);

    if (/getmap/i.test(cmd)) return ok(buildMockMap());
    if (/getrooms/i.test(cmd)) return ok({ rooms: buildMockMap().rooms.map(({ id: rid, name }) => ({ id: rid, name })) });
    if (/getstatus/i.test(cmd)) return ok(buildMockStatus(this._state));
    if (/find|locate/i.test(cmd)) return ok({ ok: true });

    // Default acknowledgement plus a follow-up status push.
    setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ event: 'status', data: buildMockStatus(this._state) }), 'utf8')));
    return ok({ ok: true });
  }

  close() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    setImmediate(() => this.emit('close', 1000));
  }

  terminate() {
    this.close();
  }
}

module.exports = { MockSocket, buildMockStatus, buildMockMap };

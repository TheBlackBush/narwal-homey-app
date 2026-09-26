'use strict';

/**
 * The path of the current clean, built from the robot's live broadcasts.
 * Each broadcast carries only the last ~30 points, overlapping the previous
 * one; the trail keeps each point once. Points are in widget display cells.
 */
class LiveTrail {
  constructor({ max = 5000 } = {}) {
    this._max = max;
    this._points = [];
    this._dropped = 0; // points cut from the front by the cap
  }

  get points() {
    return this._points;
  }

  // Total points ever added this session; a sequence number for pushes.
  get length() {
    return this._dropped + this._points.length;
  }

  add(window = []) {
    if (!window.length) return;
    // Continue after the last point we already have, if the window has it.
    const last = this._points[this._points.length - 1];
    let start = 0;
    if (last) {
      for (let i = window.length - 1; i >= 0; i -= 1) {
        if (window[i].x === last.x && window[i].y === last.y) {
          start = i + 1;
          break;
        }
      }
    }
    for (let i = start; i < window.length; i += 1) this._points.push(window[i]);
    const over = this._points.length - this._max;
    if (over > 0) {
      this._points.splice(0, over);
      this._dropped += over;
    }
  }

  /** Points added after sequence number `seq`, or everything if unknown. */
  since(seq) {
    if (!Number.isInteger(seq) || seq < this._dropped || seq > this.length) {
      return { from: 0, points: this._points };
    }
    return { from: seq, points: this._points.slice(seq - this._dropped) };
  }

  reset() {
    this._points = [];
    this._dropped = 0;
  }
}

module.exports = { LiveTrail };

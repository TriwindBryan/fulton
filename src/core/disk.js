// Free disk space: checked before anything big is written, so a full drive gets a plain message instead of a
// half-finished install or a ROM scan that silently stops.
'use strict';
const fsp = require('fs').promises;
const path = require('path');

const GB = 1e9;
const fmt = (n) => (n >= GB ? `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

/** "C:" on Windows, otherwise the mount's name ("the drive" when there's nothing better). */
function driveName(dir) {
  const root = path.parse(path.resolve(dir)).root;
  if (/^[a-z]:\\?$/i.test(root)) return `${root.slice(0, 2).toUpperCase()} drive`;
  if (/^\/Volumes\/[^/]+/.test(dir)) return `"${dir.split('/')[2]}" drive`;
  return 'drive';
}

/** Free bytes on the drive holding dir (walks up to a folder that exists). null when it can't be read. */
async function freeBytes(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    try {
      const s = await fsp.statfs(d);
      return Number(s.bavail) * Number(s.bsize);
    } catch (e) {
      const up = path.dirname(d);
      if (up === d || e.code !== 'ENOENT') return null;
      d = up;
    }
  }
  return null;
}

/** Free and total bytes on the drive holding dir ({ free, total }; nulls when it can't be read). */
async function space(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    try {
      const s = await fsp.statfs(d);
      return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
    } catch (e) {
      const up = path.dirname(d);
      if (up === d || e.code !== 'ENOENT') return { free: null, total: null };
      d = up;
    }
  }
  return { free: null, total: null };
}

/** An error that tells the player which drive is full and how much is needed. */
function spaceError(dir, need, free) {
  const e = new Error(need
    ? `Your ${driveName(dir)} is too full: this needs about ${fmt(need)} free${free != null ? ` and there's ${fmt(free)}` : ''}. Free up some space and try again.`
    : `Your ${driveName(dir)} is full. Free up some space and try again.`);
  e.code = 'ENOSPC';
  e.friendly = true;
  return e;
}

/** Throws a friendly error when dir's drive has less than `need` bytes free (unknown free space: carry on). */
async function ensureSpace(dir, need) {
  const free = await freeBytes(dir);
  if (free != null && free < need) throw spaceError(dir, need, free);
  return free;
}

/** Turn a raw "no space left on device" into the friendly message (other errors pass through). */
function friendly(e, dir) {
  if (e && e.code === 'ENOSPC' && !e.friendly) return spaceError(dir, 0, null);
  return e;
}

module.exports = { GB, fmt, driveName, freeBytes, space, ensureSpace, spaceError, friendly };

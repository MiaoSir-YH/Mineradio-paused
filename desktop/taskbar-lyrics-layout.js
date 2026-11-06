'use strict';

// All coordinates in this module are Electron device-independent pixels.
function intersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function taskbarForDisplay(display, taskbars) {
  if (!display || !display.bounds || !Array.isArray(taskbars)) return null;
  const bar = taskbars.find((entry) => entry && String(entry.displayId) === String(display.id)
    && entry.bounds && Number.isFinite(entry.bounds.x) && Number.isFinite(entry.bounds.y)
    && Number.isFinite(entry.bounds.width) && Number.isFinite(entry.bounds.height)
    && entry.bounds.width > entry.bounds.height && entry.bounds.height > 0);
  if (!bar) return null;
  const bounds = bar.bounds;
  const visibleBounds = intersection(bounds, display.bounds);
  if (bar.visible === false) visibleBounds.height = 0;
  const midpoint = bounds.y + bounds.height / 2;
  const edge = midpoint < display.bounds.y + display.bounds.height / 2 ? 'top' : 'bottom';
  return { bounds, visibleBounds, edge };
}

function resolveTaskbarLyricsLayout(displays, taskbars, options = {}) {
  if (!Array.isArray(displays) || !displays.length) return null;
  const byId = (id) => displays.find((display) => String(display.id) === String(id));
  const preferred = options.displayId === '' || options.displayId == null ? null : byId(options.displayId);
  const primary = byId(options.primaryDisplayId);
  // The selected monitor remains authoritative while it exists, even if its
  // taskbar is temporarily hidden or missing from an Explorer snapshot.
  const display = preferred || primary || displays[0];
  const taskbar = taskbarForDisplay(display, taskbars);
  if (!taskbar || taskbar.visibleBounds.height < 12 || taskbar.visibleBounds.width < 1) return null;
  const available = taskbar.visibleBounds;
  const width = Math.min(available.width, 600, Math.max(220, Math.round(available.width * 0.35)));
  const position = options.position == null || (typeof options.position === 'string' && !options.position.trim())
    ? NaN : Number(options.position);
  const ratio = Number.isFinite(position) ? Math.max(0, Math.min(1, position)) : 0.15;
  return {
    displayId: String(display.id),
    taskbarBounds: { ...taskbar.bounds },
    bounds: {
      x: Math.round(available.x + (available.width - width) * ratio),
      y: Math.round(available.y),
      width: Math.round(width),
      height: Math.round(available.height),
    },
    edge: taskbar.edge,
  };
}

function taskbarLyricsPositionForX(displays, taskbars, options, x) {
  if (!Number.isFinite(Number(x))) return null;
  const left = resolveTaskbarLyricsLayout(displays, taskbars, { ...options, position: 0 });
  const right = resolveTaskbarLyricsLayout(displays, taskbars, { ...options, position: 1 });
  if (!left || !right || left.displayId !== right.displayId) return null;
  const travel = right.bounds.x - left.bounds.x;
  const position = travel > 0 ? Math.max(0, Math.min(1, (Number(x) - left.bounds.x) / travel)) : 0;
  return { position, displayId: left.displayId };
}

module.exports = { taskbarForDisplay, resolveTaskbarLyricsLayout, taskbarLyricsPositionForX };

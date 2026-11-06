'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTaskbarLyricsLayout, taskbarForDisplay, taskbarLyricsPositionForX } = require('../desktop/taskbar-lyrics-layout');

const primary = {
  id: 101, scaleFactor: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const secondary = {
  id: 202, scaleFactor: 1.5,
  bounds: { x: -1280, y: -100, width: 1280, height: 1024 },
  workArea: { x: -1280, y: -100, width: 1280, height: 984 },
};
const bottomBars = [
  { displayId: '101', bounds: { x: 0, y: 1040, width: 1920, height: 40 } },
  { displayId: '202', bounds: { x: -1280, y: 884, width: 1280, height: 40 } },
];

function layout(displays, bars, displayId, position, primaryDisplayId = '101') {
  return resolveTaskbarLyricsLayout(displays, bars, { displayId, primaryDisplayId, position });
}

test('horizontal extremes and midpoint stay within a negative-coordinate high-DPI display', () => {
  const left = layout([primary, secondary], bottomBars, '202', 0);
  const middle = layout([primary, secondary], bottomBars, '202', 0.5);
  const right = layout([primary, secondary], bottomBars, '202', 1);
  for (const result of [left, middle, right]) {
    assert.equal(String(result.displayId), '202');
    assert.equal(result.edge, 'bottom');
    assert.deepEqual(result.taskbarBounds, bottomBars[1].bounds);
    assert.equal(result.bounds.width, 448);
    assert.equal(result.bounds.y, 884);
    assert.equal(result.bounds.height, 40);
  }
  assert.equal(left.bounds.x, -1280);
  assert.equal(middle.bounds.x, -864);
  assert.equal(right.bounds.x, -448);

  const dpiChanged = { ...secondary, scaleFactor: 2 };
  assert.deepEqual(layout([primary, dpiChanged], bottomBars, '202', 0.5).bounds, middle.bounds,
    'Electron display and taskbar rectangles are already in DIP and must not be scaled again');
});

test('a physically missing selected display falls back to primary, then an available display', () => {
  let result = layout([primary], [bottomBars[0]], '202', 0.5);
  assert.equal(String(result.displayId), '101');
  assert.equal(result.bounds.x + result.bounds.width / 2, 960);
  result = layout([secondary], [bottomBars[1]], '101', 0.5);
  assert.equal(String(result.displayId), '202');
  assert.equal(result.bounds.x + result.bounds.width / 2, -640);
  assert.equal(layout([primary], [], '101', 0.5), null);
});

test('a present selected display never falls back when its taskbar snapshot disappears', () => {
  assert.equal(layout([primary, secondary], [bottomBars[0]], '202', 0.5), null,
    'a missing secondary taskbar must not move lyrics to the primary screen');
  assert.equal(layout([primary, secondary], [bottomBars[1]], '101', 0.5), null,
    'a missing primary taskbar must not move lyrics to the secondary screen');
  assert.equal(layout([primary, secondary], [bottomBars[1]], '', 0.5), null,
    'automatic display selection stays on the primary screen while its taskbar is missing');
  assert.equal(layout([primary, secondary], bottomBars, '202', 0.5).displayId, '202',
    'lyrics return to the same display once its taskbar reappears');
});

test('an auto-hidden selected taskbar does not silently move lyrics to another display', () => {
  const collapsed = { displayId: '202', bounds: { x: -1280, y: 922, width: 1280, height: 2 } };
  assert.equal(layout([primary, secondary], [bottomBars[0], collapsed], '202', 0.5), null);
  const hidden = { ...bottomBars[1], visible: false };
  assert.equal(layout([primary, secondary], [bottomBars[0], hidden], '202', 0.5), null,
    'an existing but invisible taskbar must not trigger a fallback to another display');
  assert.equal(layout([primary, secondary], [bottomBars[0], { ...hidden, visible: true }], '202', 0.5).displayId, '202');
});

test('supports a top taskbar and ignores a vertical taskbar', () => {
  const top = { displayId: '202', bounds: { x: -1280, y: -100, width: 1280, height: 48 } };
  const result = layout([primary, secondary], [bottomBars[0], top], '202', 0.5);
  assert.equal(result.edge, 'top');
  assert.equal(result.bounds.y, -100);
  assert.equal(result.bounds.height, 48);

  const vertical = { displayId: '202', bounds: { x: -1280, y: -100, width: 48, height: 1024 } };
  assert.equal(taskbarForDisplay(secondary, [vertical]), null);
  assert.equal(layout([primary, secondary], [bottomBars[0], vertical], '202', 0.5), null,
    'an unsupported vertical taskbar does not move lyrics to another display');
});

test('coordinates are clamped for out-of-range positions', () => {
  const low = layout([primary], [bottomBars[0]], '101', -10);
  const high = layout([primary], [bottomBars[0]], '101', 10);
  assert.equal(low.bounds.x, primary.bounds.x);
  assert.equal(high.bounds.x + high.bounds.width, primary.bounds.x + primary.bounds.width);
});

test('missing or invalid taskbar position falls back to 15 percent', () => {
  const expected = layout([primary], [bottomBars[0]], '101', 0.15);
  for (const position of [undefined, null, '', '   ', 'invalid']) {
    assert.equal(layout([primary], [bottomBars[0]], '101', position).bounds.x, expected.bounds.x);
  }
  assert.equal(layout([primary], [bottomBars[0]], '101', 0).bounds.x, primary.bounds.x);
});

test('drag x maps to the selected taskbar position in DIP and clamps at both edges', () => {
  const options = { displayId: '202', primaryDisplayId: '101' };
  assert.equal(taskbarLyricsPositionForX([primary, secondary], bottomBars, options, -2000).position, 0);
  assert.equal(taskbarLyricsPositionForX([primary, secondary], bottomBars, options, -864).position, 0.5);
  assert.equal(taskbarLyricsPositionForX([primary, secondary], bottomBars, options, 2000).position, 1);
  assert.equal(taskbarLyricsPositionForX([primary, secondary], bottomBars, options, -864).displayId, '202');
  assert.equal(taskbarLyricsPositionForX([primary, secondary], bottomBars, options, NaN), null);
  assert.equal(taskbarLyricsPositionForX([primary, secondary], [bottomBars[0], { ...bottomBars[1], visible: false }], options, -864), null);
});

test('Skyline gap expands the native slot without moving the lyric anchor, including at both edges', () => {
  const displays=[primary,secondary],bars=bottomBars;
  for(const position of [0,0.15,0.5,1]) {
    const options={displayId:'202',primaryDisplayId:'101',position,skyline:true};
    const original=resolveTaskbarLyricsLayout(displays,bars,{...options,skylineSpacing:0.5});
    const wide=resolveTaskbarLyricsLayout(displays,bars,{...options,skylineSpacing:1});
    const restored=resolveTaskbarLyricsLayout(displays,bars,{...options,skylineSpacing:0.5});
    assert.equal(original.bounds.width,448);
    assert.equal(wide.bounds.width,627);
    assert.equal(wide.referenceWidth,448);
    assert.ok(Number.isFinite(wide.anchorX) && wide.anchorX>=0 && wide.anchorX<=wide.bounds.width);
    assert.ok(Math.abs((wide.bounds.x+wide.anchorX)-(original.bounds.x+original.bounds.width/2))<=0.5,
      `spacing change moved the screen anchor at position ${position}`);
    assert.deepEqual(restored.bounds,original.bounds,'reducing the gap must restore the original window bounds');
    assert.equal(wide.bounds.y,original.bounds.y);assert.equal(wide.bounds.height,original.bounds.height);
    assert.equal(wide.displayId,'202');
  }
  const normal=resolveTaskbarLyricsLayout([primary],[bottomBars[0]],
    {displayId:'101',primaryDisplayId:'101',position:0.15,skyline:false,skylineSpacing:1});
  assert.equal(normal.bounds.width,600,'ordinary lyric slots do not grow with the Skyline gap');
});

test('expanded Skyline slot is capped to a narrow taskbar without moving the anchor', () => {
  const display={id:303,scaleFactor:1,bounds:{x:-230,y:0,width:230,height:500}};
  const bars=[{displayId:'303',bounds:{x:-230,y:460,width:230,height:40}}];
  for(const position of [0,0.5,1]) {
    const options={displayId:'303',primaryDisplayId:'303',position,skyline:true};
    const base=resolveTaskbarLyricsLayout([display],bars,{...options,skylineSpacing:0.5});
    const wide=resolveTaskbarLyricsLayout([display],bars,{...options,skylineSpacing:1});
    assert.equal(base.bounds.width,220);assert.equal(wide.bounds.width,230);
    assert.equal(wide.bounds.x,-230);assert.equal(wide.bounds.x+wide.bounds.width,0);
    assert.ok(Math.abs(wide.bounds.x+wide.anchorX-(base.bounds.x+base.bounds.width/2))<=0.5);
  }
});

test('dragging an expanded slot persists a position relative to the original lyric anchor', () => {
  const options={displayId:'202',primaryDisplayId:'101',position:0.15,skyline:true,skylineSpacing:1};
  const wide=resolveTaskbarLyricsLayout([primary,secondary],bottomBars,options);
  const reference=resolveTaskbarLyricsLayout([primary,secondary],bottomBars,{...options,skylineSpacing:0.5});
  const travel=secondary.bounds.width-reference.bounds.width;
  const before=taskbarLyricsPositionForX([primary,secondary],bottomBars,options,wide.bounds.x);
  const after=taskbarLyricsPositionForX([primary,secondary],bottomBars,options,wide.bounds.x+60);
  assert.ok(Math.abs(before.position-options.position)<=1/travel);
  assert.ok(Math.abs(after.position-(options.position+60/travel))<=1/travel);
  assert.equal(taskbarLyricsPositionForX([primary,secondary],bottomBars,options,-10000).position,0);
  assert.equal(taskbarLyricsPositionForX([primary,secondary],bottomBars,options,10000).position,1);
});

'use strict';

const { execFile, spawn } = require('child_process');
const { gzipSync } = require('zlib');

// Explorer exposes one top-level window per taskbar. Query physical pixels in
// a per-monitor DPI-aware thread; Electron performs the conversion to DIP.
const QUERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
using System.Threading;

public static class MineradioTaskbarQuery {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO {
    public int size; public RECT monitor; public RECT work; public uint flags;
  }
  public class Bar {
    public int x, y, width, height;
    public int monitorX, monitorY, monitorWidth, monitorHeight;
    public string handle;
    public uint pid;
    public bool visible;
  }
  private delegate bool EnumProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string name, string title);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int length);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  private static Dictionary<long,Bar> known = new Dictionary<long,Bar>();

  public static void Init() {
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
  }
  public static Bar[] Snapshot() {
    var bars = new List<Bar>();
    var found = new HashSet<long>();
    var current = new Dictionary<long,Bar>();
    EnumWindows(delegate(IntPtr window, IntPtr data) {
      Collect(window, null, bars, found, current);
      return true;
    }, IntPtr.Zero);
    foreach (string name in new string[] { "Shell_TrayWnd", "Shell_SecondaryTrayWnd" }) {
      IntPtr after=IntPtr.Zero;
      var visited=new HashSet<long>();
      for (int count=0;count<64;count++) {
        IntPtr window=FindWindowEx(IntPtr.Zero,after,name,null);
        if (window==IntPtr.Zero || !visited.Add(window.ToInt64())) break;
        Collect(window, null, bars, found, current);
        after=window;
      }
    }
    foreach (var item in known) Collect(new IntPtr(item.Key), item.Value, bars, found, current);
    known=current;
    return bars.ToArray();
  }
  private static void Collect(IntPtr window, Bar previous, List<Bar> bars, HashSet<long> found, Dictionary<long,Bar> current) {
    long key=window.ToInt64();
    if (key==0 || found.Contains(key) || !IsWindow(window)) return;
    var name=new StringBuilder(128); GetClassName(window,name,name.Capacity);
    string className=name.ToString();
    if (className!="Shell_TrayWnd" && className!="Shell_SecondaryTrayWnd") return;
    uint pid=GetProcessId(window);
    if (pid==0 || (previous!=null && previous.pid!=pid) || !IsExplorer(pid)) return;
    RECT rect;
    if (!GetWindowRect(window,out rect) || rect.right<=rect.left || rect.bottom<=rect.top) return;
    var info=new MONITORINFO(); info.size=Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(MonitorFromWindow(window,2),ref info) || GetProcessId(window)!=pid) return;
    if (previous!=null && (previous.monitorX!=info.monitor.left || previous.monitorY!=info.monitor.top
        || previous.monitorWidth!=info.monitor.right-info.monitor.left || previous.monitorHeight!=info.monitor.bottom-info.monitor.top)) return;
    var bar=new Bar {
      x=rect.left, y=rect.top, width=rect.right-rect.left, height=rect.bottom-rect.top,
      monitorX=info.monitor.left, monitorY=info.monitor.top,
      monitorWidth=info.monitor.right-info.monitor.left, monitorHeight=info.monitor.bottom-info.monitor.top,
      handle=key.ToString(), pid=pid, visible=IsWindowVisible(window)
    };
    found.Add(key); current[key]=bar; bars.Add(bar);
  }
  private static bool IsExplorer(uint pid) { try { using (var process=Process.GetProcessById((int)pid)) return String.Equals(process.ProcessName,"explorer",StringComparison.OrdinalIgnoreCase); } catch { return false; } }
  private static uint GetProcessId(IntPtr window) { uint id; GetWindowThreadProcessId(window, out id); return id; }
}

public static class MineradioTaskbarZOrderGuard {
  public class Status {
    public string kind = "guard", taskbarHandle = "", token = "", error = "";
    public bool targetAlive, ready, hooksActive, mouseHookActive, zOrderBlocked, cleaned;
    public int zOrderCorrections;
  }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public UIntPtr extraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public POINT point; public uint privateData; }
  delegate void WinEventProc(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  delegate IntPtr MouseHookProc(int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint command);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder name, int size);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder name, int size);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool SetProp(IntPtr h, string name, IntPtr value);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetProp(IntPtr h, string name);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr RemoveProp(IntPtr h, string name);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint pid, uint thread, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG message, IntPtr h, uint min, uint max, uint remove);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG message);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG message);
  [DllImport("user32.dll")] static extern uint MsgWaitForMultipleObjectsEx(uint count, IntPtr handles, uint timeout, uint wakeMask, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int hook, MouseHookProc callback, IntPtr module, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  static IntPtr target, selected, reorderHook, foregroundHook, mouseHook;
  static uint targetPid, selectedPid;
  static string token = "";
  static bool initialized, changing, zOrderBlocked;
  static int zOrderCorrections;
  static WinEventProc callback = OnEvent;
  static MouseHookProc mouseCallback = OnMouse;
  const string mouseActivateProperty = "Chrome.IgnoreMouseActivate";
  static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  static string ClassName(IntPtr h) { var value=new StringBuilder(128); GetClassName(h,value,value.Capacity); return value.ToString(); }
  static bool IsTaskbar(IntPtr h, uint pid) {
    if (h==IntPtr.Zero || !IsWindow(h) || Pid(h)!=pid) return false;
    string name=ClassName(h);
    if (name!="Shell_TrayWnd" && name!="Shell_SecondaryTrayWnd") return false;
    return true;
  }
  static bool IsExplorer(uint pid) { try { using (var process=Process.GetProcessById((int)pid)) return String.Equals(process.ProcessName,"explorer",StringComparison.OrdinalIgnoreCase); } catch { return false; } }
  static bool IsTarget() { return initialized && IsWindow(target) && Pid(target)==targetPid && GetProp(target,token)==new IntPtr(1); }
  public static Status Init(long hwnd, uint pid, string property, bool requireExistingToken) {
    target=new IntPtr(hwnd); targetPid=pid; token=property;
    var title=new StringBuilder(256); GetWindowText(target,title,title.Capacity);
    if (!IsWindow(target) || Pid(target)!=pid || ClassName(target)!="Chrome_WidgetWin_1" || title.ToString()!="Mineradio Desktop Lyrics" || String.IsNullOrEmpty(token)) return new Status { token=property, error="INVALID_TARGET" };
    if (requireExistingToken && GetProp(target,token)!=new IntPtr(1)) return new Status { token=property, error="TOKEN_MISSING" };
    if (!SetProp(target,token,new IntPtr(1))) return new Status { token=property, error="TOKEN_FAILED" };
    initialized=true;
    // SHOW/HIDE/REORDER and foreground changes wake the helper immediately.
    reorderHook=SetWinEventHook(0x8002,0x8004,IntPtr.Zero,callback,0,0,0);
    foregroundHook=SetWinEventHook(3,3,IntPtr.Zero,callback,0,0,0);
    if (!requireExistingToken) mouseHook=SetWindowsHookEx(14,mouseCallback,IntPtr.Zero,0);
    return Current(false, "");
  }
  static Status Current(bool ready,string error) { return new Status { targetAlive=IsTarget(), ready=ready, hooksActive=reorderHook!=IntPtr.Zero && foregroundHook!=IntPtr.Zero, mouseHookActive=mouseHook!=IntPtr.Zero, zOrderBlocked=zOrderBlocked, zOrderCorrections=zOrderCorrections, taskbarHandle=selected==IntPtr.Zero ? "" : selected.ToInt64().ToString(), token=token, error=error }; }
  static void OnEvent(IntPtr hook,uint evt,IntPtr hwnd,int obj,int child,uint thread,uint time) {
    if (!changing && evt==0x8004 && hwnd==selected) zOrderBlocked=false;
    Protect();
  }
  static IntPtr OnMouse(int code,IntPtr wParam,IntPtr lParam) {
    try {
      if (code>=0 && wParam.ToInt64()==0x0201 && lParam!=IntPtr.Zero && !MineradioTaskbarStopSignal.Closed && IsTarget() && IsWindowVisible(target)) {
        var info=(MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam,typeof(MSLLHOOKSTRUCT));
        IntPtr hit=WindowFromPoint(info.pt);
        if (GetAncestor(hit,2)==target && GetProp(target,mouseActivateProperty)==IntPtr.Zero) {
          // Chromium 148 consumes this property once and returns MA_NOACTIVATE,
          // delivering the click without activating the non-focusable window.
          SetProp(target,mouseActivateProperty,target);
        }
      }
    } catch { }
    try { return CallNextHookEx(mouseHook,code,wParam,lParam); } catch { return IntPtr.Zero; }
  }
  public static void Pump() { MSG msg; int count=0; while(count++<64 && PeekMessage(out msg,IntPtr.Zero,0,0,1)) { TranslateMessage(ref msg); DispatchMessage(ref msg); } }
  public static void Wait() { MsgWaitForMultipleObjectsEx(0,IntPtr.Zero,100,0x04FF,0x0004); }
  public static Status Sync(MineradioTaskbarQuery.Bar[] bars) {
    if (!IsTarget()) return Current(false,"TARGET_LOST");
    IntPtr monitor=MonitorFromWindow(target,2); IntPtr next=IntPtr.Zero; uint nextPid=0;
    foreach (var bar in bars) { long value; if (!Int64.TryParse(bar.handle,out value)) continue; var h=new IntPtr(value); if (IsTaskbar(h,bar.pid) && MonitorFromWindow(h,2)==monitor && (h==selected && bar.pid==selectedPid || IsExplorer(bar.pid))) { next=h; nextPid=bar.pid; break; } }
    if (next==IntPtr.Zero) { selected=IntPtr.Zero; selectedPid=0; zOrderBlocked=false; return Current(false,"NO_TASKBAR"); }
    if (selected!=next || selectedPid!=nextPid) zOrderBlocked=false;
    selected=next; selectedPid=nextPid;
    Protect(true); return Current(true,"");
  }
  public static void Protect() { Protect(false); }
  static bool IsTaskbarAboveTarget() {
    IntPtr cursor=target; int count=0;
    while ((cursor=GetWindow(cursor,3))!=IntPtr.Zero && count++<3000) if (cursor==selected) return true;
    // Explorer may omit a taskbar from the target's reverse chain while the
    // taskbar's forward chain still unambiguously contains the target.
    cursor=selected; count=0;
    while ((cursor=GetWindow(cursor,2))!=IntPtr.Zero && count++<3000) if (cursor==target) return true;
    return false;
  }
  static void Protect(bool allowHidden) {
    if (changing || MineradioTaskbarStopSignal.Closed || !IsTarget() || (!allowHidden && !IsWindowVisible(target)) || !IsWindowVisible(selected) || !IsTaskbar(selected,selectedPid)) return;
    if (!IsTaskbarAboveTarget()) { zOrderBlocked=false; return; }
    if (zOrderBlocked) return;
    changing=true;
    try {
      zOrderCorrections++;
      bool moved=SetWindowPos(target,new IntPtr(-1),0,0,0,0,0x13);
      zOrderBlocked=!moved || IsTaskbarAboveTarget();
    } finally { changing=false; }
  }
  public static Status Cleanup() {
    bool alive=IsTarget(), cleaned=!alive;
    if (mouseHook!=IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook=IntPtr.Zero; }
    if (alive) {
      if (GetProp(target,mouseActivateProperty)==target) RemoveProp(target,mouseActivateProperty);
      RemoveProp(target,token); cleaned=GetProp(target,token)==IntPtr.Zero;
    }
    if (reorderHook!=IntPtr.Zero) UnhookWinEvent(reorderHook);
    if (foregroundHook!=IntPtr.Zero) UnhookWinEvent(foregroundHook);
    initialized=false;
    return new Status { kind="cleanup", targetAlive=alive, cleaned=cleaned, token=token, error=cleaned ? "" : "TOKEN_CLEANUP_FAILED" };
  }
}
public static class MineradioTaskbarStopSignal {
  public static volatile bool Closed;
  public static void Start() {
    var thread = new Thread(delegate() { try { while (Console.In.ReadLine() != null) {} } catch {} Closed=true; });
    thread.IsBackground=true;
    thread.Start();
  }
}
'@
[MineradioTaskbarQuery]::Init()
$watch = $env:MINERADIO_TASKBAR_WATCH -eq '1'
$guardReady = $false
$lastBars = ''
$lastGuard = ''
$bars = @()
$clock = [Diagnostics.Stopwatch]::StartNew()
$nextBars = 0
$nextGuard = 0
try {
  if ($env:MINERADIO_TASKBAR_CLEANUP -eq '1') {
    $status = [MineradioTaskbarZOrderGuard]::Init([long]$env:MINERADIO_TASKBAR_LYRICS_HWND, [uint32]$env:MINERADIO_TASKBAR_LYRICS_PID, $env:MINERADIO_TASKBAR_LYRICS_TOKEN, $true)
    if ($status.targetAlive) { $status = [MineradioTaskbarZOrderGuard]::Cleanup() }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $status -Compress -Depth 5))
    exit
  }
  if ($watch -and $env:MINERADIO_TASKBAR_LYRICS_HWND) {
    $status = [MineradioTaskbarZOrderGuard]::Init([long]$env:MINERADIO_TASKBAR_LYRICS_HWND, [uint32]$env:MINERADIO_TASKBAR_LYRICS_PID, $env:MINERADIO_TASKBAR_LYRICS_TOKEN, $false)
    $guardReady = $status.targetAlive
    $lastGuard = ConvertTo-Json -InputObject $status -Compress -Depth 5
    [Console]::Out.WriteLine($lastGuard)
    [Console]::Out.Flush()
  }
  if ($watch) { [MineradioTaskbarStopSignal]::Start() }
  do {
    if ($guardReady) { [MineradioTaskbarZOrderGuard]::Pump() }
    if ($watch -and [MineradioTaskbarStopSignal]::Closed) { break }
    if ($clock.ElapsedMilliseconds -ge $nextBars) {
      $bars = @([MineradioTaskbarQuery]::Snapshot() | Sort-Object monitorX,monitorY,x,y)
      $json = ConvertTo-Json -InputObject $bars -Compress -Depth 5
      if ($json -ne $lastBars) {
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()
        $lastBars = $json
      }
      $nextBars = $clock.ElapsedMilliseconds + 500
    }
    if ($guardReady -and $clock.ElapsedMilliseconds -ge $nextGuard) {
      $status = [MineradioTaskbarZOrderGuard]::Sync($bars)
      $json = ConvertTo-Json -InputObject $status -Compress -Depth 5
      if ($json -ne $lastGuard) {
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()
        $lastGuard = $json
      }
      $nextGuard = $clock.ElapsedMilliseconds + 100
    }
    if (-not $watch) { break }
    if ($guardReady) { [MineradioTaskbarZOrderGuard]::Wait() }
    else { Start-Sleep -Milliseconds 100 }
  } while ($true)
} finally {
  if ($guardReady) {
    $status = [MineradioTaskbarZOrderGuard]::Cleanup()
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $status -Compress -Depth 5))
    [Console]::Out.Flush()
  }
}
`;

function argumentsForQuery() {
  // Keep the native helper below Windows' command-line length limit.
  const compressed = gzipSync(Buffer.from(QUERY_SCRIPT, 'utf8')).toString('base64');
  const bootstrap = `$m=[IO.MemoryStream]::new([Convert]::FromBase64String('${compressed}')); $g=[IO.Compression.GzipStream]::new($m,[IO.Compression.CompressionMode]::Decompress); $r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8); Invoke-Expression ($r.ReadToEnd())`;
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')];
}

function parseSnapshot(line) {
  try {
    const result = JSON.parse(line);
    return Array.isArray(result) || (result && (result.kind === 'guard' || result.kind === 'cleanup')) ? result : null;
  } catch (_) {
    return null;
  }
}

function readWindowsTaskbars() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('powershell.exe', argumentsForQuery(), {
      windowsHide: true, timeout: 6000, maxBuffer: 1024 * 1024,
      env: { ...process.env, MINERADIO_TASKBAR_WATCH: '0' },
    }, (error, stdout) => {
      if (error) return resolve([]);
      const lines = String(stdout || '').trim().split(/\r?\n/);
      resolve(parseSnapshot(lines[0]) || []);
    });
  });
}

function watchWindowsTaskbars(onSnapshot, options = {}) {
  if (process.platform !== 'win32') return null;
  const child = spawn('powershell.exe', argumentsForQuery(), {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env, MINERADIO_TASKBAR_WATCH: '1',
      MINERADIO_TASKBAR_LYRICS_HWND: String(options.handle || ''),
      MINERADIO_TASKBAR_LYRICS_PID: String(options.pid || 0),
      MINERADIO_TASKBAR_LYRICS_TOKEN: String(options.token || ''),
    },
  });
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const snapshot = parseSnapshot(line);
      if (Array.isArray(snapshot)) onSnapshot(snapshot);
      else if (snapshot && snapshot.kind === 'cleanup' && typeof options.onCleanupStatus === 'function') options.onCleanupStatus(snapshot);
      else if (snapshot && typeof options.onGuardStatus === 'function') options.onGuardStatus(snapshot);
    }
  });
  // Missing PowerShell or a terminated shell is handled by the caller; the
  // overlay stays hidden instead of appearing somewhere outside a taskbar.
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stderr.on('data', () => {});
  return child;
}

function cleanupWindowsTaskbarGuard(options = {}) {
  if (process.platform !== 'win32' || !options.handle || !options.token) return Promise.resolve({ ok: false });
  return new Promise((resolve) => {
    execFile('powershell.exe', argumentsForQuery(), {
      windowsHide: true, timeout: 6000, maxBuffer: 1024 * 1024,
      env: {
        ...process.env, MINERADIO_TASKBAR_WATCH: '0', MINERADIO_TASKBAR_CLEANUP: '1',
        MINERADIO_TASKBAR_LYRICS_HWND: String(options.handle), MINERADIO_TASKBAR_LYRICS_PID: String(options.pid || 0),
        MINERADIO_TASKBAR_LYRICS_TOKEN: String(options.token),
      },
    }, (error, stdout) => {
      if (error) return resolve({ ok: false });
      const status = parseSnapshot(String(stdout || '').trim());
      resolve({ ok: !!status && status.kind === 'cleanup' && status.cleaned === true, status });
    });
  });
}

module.exports = { readWindowsTaskbars, watchWindowsTaskbars, cleanupWindowsTaskbarGuard };

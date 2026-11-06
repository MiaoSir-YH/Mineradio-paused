param(
  [ValidateSet('probe', 'drag', 'focus', 'focus-drag', 'focus-tray')][string]$Action = 'probe',
  [Parameter(Mandatory = $true)][long]$HostHwnd,
  [Parameter(Mandatory = $true)][int]$HostPid,
  [Parameter(Mandatory = $true)][long]$TaskbarHwnd,
  [Parameter(Mandatory = $true)][int]$PointX,
  [Parameter(Mandatory = $true)][int]$PointY,
  [int]$DeltaX = -90,
  [long]$FocusHwnd = 0,
  [int]$FocusPid = 0,
  [int]$TaskbarPid = 0,
  [string]$BeforeImage = '',
  [int]$FocusX = 240,
  [int]$FocusY = 170
)

# Explicit, isolated Windows QA only. No press is sent until the live window,
# process, parent, cursor position and hit-test ancestry all match the fixture.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MineradioChildQa {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo {
    public uint Size, Flags; public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret; public Rect CaretRect;
  }
  [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public InputUnion Union; }

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll", EntryPoint="GetWindowBand")] static extern bool GetWindowBand(IntPtr hwnd, out uint band);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);

  public sealed class Result {
    public bool Ok, HostExists, HostVisible, TaskbarExists, HitHost, ButtonDown;
    public int DpiAwareness;
    public string Reason = "", HostClass = "", TaskbarClass = "";
    public long Host, Parent, Taskbar, Hit, CaptureHwnd, ForegroundBefore, ForegroundAfter;
    public long ForegroundAfterDown, ForegroundBeforeUp, ForegroundAfterUp, ForegroundAfter500, ForegroundAfter2000;
    public long DownAt, UpAt;
    public uint HostPid, HostBand, TaskbarBand, ForegroundPidBefore, ForegroundPidAfter, MoveCount, DownCount, UpCount;
    public int SetError, DownError, UpError, PointX, PointY, ActualX, ActualY, ExpectedX, ExpectedY;
    public Rect Before, After;
  }

  static string ClassName(IntPtr hwnd) {
    var name = new StringBuilder(256); GetClassName(hwnd, name, name.Capacity); return name.ToString();
  }
  static uint Pid(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd, out pid); return pid; }
  static bool IsDescendantOrSelf(IntPtr hit, IntPtr target) {
    for (int i = 0; i < 64 && hit != IntPtr.Zero; i++, hit = GetParent(hit)) if (hit == target) return true;
    return false;
  }
  static IntPtr CaptureFor(IntPtr hwnd) {
    uint pid; uint thread = GetWindowThreadProcessId(hwnd, out pid);
    var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo)) };
    return GetGUIThreadInfo(thread, ref info) ? info.Capture : IntPtr.Zero;
  }
  static uint Move(int x, int y, out int error) {
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
    var input = new Input { Type = 0, Union = new InputUnion { Mouse = new MouseInput {
      X = (int)Math.Round((x-left)*65535.0/(width-1)), Y = (int)Math.Round((y-top)*65535.0/(height-1)), Flags = 0xC001 } } };
    uint result = SendInput(1, new Input[] { input }, Marshal.SizeOf(typeof(Input))); error = Marshal.GetLastWin32Error(); return result;
  }
  static uint Button(uint flag, out int error) {
    var input = new Input { Type = 0, Union = new InputUnion { Mouse = new MouseInput { Flags = flag } } };
    uint result = SendInput(1, new Input[] { input }, Marshal.SizeOf(typeof(Input))); error = Marshal.GetLastWin32Error(); return result;
  }
  static void After(Result result, IntPtr hwnd) {
    Rect rect; GetWindowRect(hwnd, out rect); result.After = rect;
    var foreground = GetForegroundWindow(); result.ForegroundAfter = foreground.ToInt64(); result.ForegroundPidAfter = Pid(foreground);
  }
  public static bool WindowOwned(long handle,int pid) { var h=new IntPtr(handle); return IsWindow(h) && Pid(h)==pid; }

  public static Result Run(string action, long hostValue, int expectedPid, long trayValue, int x, int y, int dx) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    var result = new Result { Host = hostValue, Taskbar = trayValue, PointX = x, PointY = y };
    result.DpiAwareness = GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext());
    if (result.DpiAwareness != 2) { result.Reason = "DPI_AWARENESS_UNAVAILABLE"; return result; }
    var hwnd = new IntPtr(hostValue); var tray = new IntPtr(trayValue);
    result.HostExists = IsWindow(hwnd); result.TaskbarExists = action == "focus" || IsWindow(tray);
    if (!result.HostExists || !result.TaskbarExists) { result.Reason = "WINDOW_MISSING"; return result; }
    result.HostVisible = IsWindowVisible(hwnd); result.HostPid = Pid(hwnd);
    try { uint hostBand, trayBand; if(GetWindowBand(hwnd,out hostBand)) result.HostBand=hostBand; if(GetWindowBand(tray,out trayBand)) result.TaskbarBand=trayBand; } catch(EntryPointNotFoundException) { }
    result.Parent = GetParent(hwnd).ToInt64(); result.HostClass = ClassName(hwnd); result.TaskbarClass = ClassName(tray);
    Rect rect; GetWindowRect(hwnd, out rect); result.Before = rect; result.After = rect;
    var foreground = GetForegroundWindow(); result.ForegroundBefore = foreground.ToInt64(); result.ForegroundPidBefore = Pid(foreground);
    result.ForegroundAfter = result.ForegroundBefore; result.ForegroundPidAfter = result.ForegroundPidBefore;
    var hit = WindowFromPoint(new Point { X = x, Y = y }); result.Hit = hit.ToInt64(); result.HitHost = IsDescendantOrSelf(hit, hwnd);
    if (result.HostPid != expectedPid || !result.HostVisible || (action != "focus" && (
        (action == "tray" ? hostValue != trayValue : result.Parent != trayValue) ||
        (result.TaskbarClass != "Shell_TrayWnd" && result.TaskbarClass != "Shell_SecondaryTrayWnd")))) {
      result.Reason = "FIXTURE_IDENTITY_MISMATCH"; return result;
    }
    if (x < rect.Left || x >= rect.Right || y < rect.Top || y >= rect.Bottom) { result.Reason = "POINT_OUTSIDE_HOST"; return result; }
    if (action == "probe") { result.Ok = true; return result; }
    if (result.ForegroundPidBefore == expectedPid) { result.Reason = "HOST_ALREADY_FOREGROUND"; return result; }
    Point old; if (!GetCursorPos(out old)) { result.Reason = "CURSOR_UNAVAILABLE"; return result; }
    bool down = false, restore = true;
    try {
      Point actual;
      if (GetAsyncKeyState(1) < 0 || GetAsyncKeyState(2) < 0) {
        restore = false; result.Reason = "BUTTON_ACTIVE"; return result;
      }
      int error; uint sent = Move(x, y, out error); result.MoveCount = sent; result.SetError = error; Thread.Sleep(30); GetCursorPos(out actual);
      result.ActualX = actual.X; result.ActualY = actual.Y;
      if (sent != 1 || Math.Abs(actual.X-x) > 1 || Math.Abs(actual.Y-y) > 1) {
        restore = false; result.Reason = "CURSOR_MOVED"; return result;
      }
      hit = WindowFromPoint(actual); result.Hit = hit.ToInt64(); result.HitHost = IsDescendantOrSelf(hit, hwnd);
      if (!result.HitHost || (action == "tray" && hit != tray) || Pid(hwnd) != expectedPid || (action != "focus" && action != "tray" && GetParent(hwnd) != tray) || GetAsyncKeyState(1) < 0 || GetAsyncKeyState(2) < 0) {
        result.Reason = "TARGET_CHANGED"; return result;
      }
      int downError; result.DownAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); result.DownCount = Button(2, out downError); result.DownError = downError; down = result.DownCount == 1;
      Thread.Sleep(140); result.ButtonDown = GetAsyncKeyState(1) < 0;
      result.ForegroundAfterDown=GetForegroundWindow().ToInt64();
      if (!down) { result.Reason = "DOWN_FAILED"; return result; }
      if (action == "focus") {
        int clickUpError; result.UpCount = Button(4, out clickUpError); result.UpError = clickUpError; down = result.UpCount != 1;
        Thread.Sleep(200); After(result, hwnd);
        result.Ok = result.UpCount == 1 && result.ForegroundAfter == hostValue;
        result.Reason = result.Ok ? "" : "FOCUS_NOT_OBTAINED"; return result;
      }
      if (action == "tray") {
        result.ForegroundBeforeUp=GetForegroundWindow().ToInt64();
        int clickUpError; result.UpAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();result.UpCount=Button(4,out clickUpError);result.UpError=clickUpError;down=result.UpCount!=1;
        result.ForegroundAfterUp=GetForegroundWindow().ToInt64();
        Thread.Sleep(150);After(result,hwnd);Thread.Sleep(350);result.ForegroundAfter500=GetForegroundWindow().ToInt64();
        Thread.Sleep(1500);result.ForegroundAfter2000=GetForegroundWindow().ToInt64();
        GetCursorPos(out actual);if(Math.Abs(actual.X-x)>1 || Math.Abs(actual.Y-y)>1)restore=false;
        result.Ok=result.UpCount==1;result.Reason=result.Ok?"":"UP_FAILED";return result;
      }
      IntPtr capture = CaptureFor(hwnd); result.CaptureHwnd = capture.ToInt64();
      if (!IsDescendantOrSelf(capture, hwnd)) { result.Reason = "CAPTURE_NOT_OWNED"; return result; }
      int priorX = x, priorY = y;
      for (int index = 1; index <= 8; index++) {
        capture = CaptureFor(hwnd); result.CaptureHwnd = capture.ToInt64();
        if (!IsDescendantOrSelf(capture, hwnd)) { result.Reason = "CAPTURE_LOST"; return result; }
        GetCursorPos(out actual);
        result.ActualX=actual.X; result.ActualY=actual.Y; result.ExpectedX=priorX; result.ExpectedY=priorY;
        if (Math.Abs(actual.X-priorX) > 1 || Math.Abs(actual.Y-priorY) > 1) {
          restore = false; result.Reason = "CURSOR_MOVED_DURING_DRAG"; return result;
        }
        priorX = x + dx*index/8; int stepError;
        if (Move(priorX, priorY, out stepError) != 1) { result.Reason = "MOVE_FAILED"; return result; }
        Thread.Sleep(65);
      }
      result.ForegroundBeforeUp=GetForegroundWindow().ToInt64();
      int upError; result.UpAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); result.UpCount = Button(4, out upError); result.UpError = upError; down = result.UpCount != 1;
      result.ForegroundAfterUp=GetForegroundWindow().ToInt64();
      Thread.Sleep(150); After(result, hwnd);
      Thread.Sleep(350);result.ForegroundAfter500=GetForegroundWindow().ToInt64();
      Thread.Sleep(1500);result.ForegroundAfter2000=GetForegroundWindow().ToInt64();
      GetCursorPos(out actual); if(Math.Abs(actual.X-priorX)>1 || Math.Abs(actual.Y-priorY)>1) restore=false;
      result.Ok = result.UpCount == 1; result.Reason = result.Ok ? "" : "UP_FAILED";
      return result;
    } finally {
      if (down) { int error; result.UpCount=Button(4, out error); result.UpError=error; }
      if (restore) { int ignored; Move(old.X, old.Y, out ignored); }
    }
  }
}
'@
if ($Action -eq 'focus-drag' -or $Action -eq 'focus-tray') {
  if (!$FocusHwnd -or !$FocusPid) { throw 'Focus dummy identity is required.' }
  if($Action -eq 'focus-tray') {
    if(!$TaskbarPid -or !$BeforeImage -or !(Test-Path -LiteralPath $BeforeImage)) { throw 'Tray identity and a fresh visual capture are required.' }
    if(((Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $BeforeImage).LastWriteTimeUtc).TotalSeconds -gt 30){throw 'Tray capture is stale.'}
  }
  $focus=$null;$focusAttempts=0
  do {
    $focusAttempts++
    $focus=[MineradioChildQa]::Run('focus',$FocusHwnd,$FocusPid,0,$FocusX,$FocusY,0)
    if($focus.Reason -eq 'BUTTON_ACTIVE' -and $focus.DownCount -eq 0 -and $focusAttempts -lt 3){Start-Sleep -Milliseconds 350}
    else {break}
  } while($focusAttempts -lt 3)
  $drag=$null
  $dragAttempts=0
  if ($focus.Ok) {
    do {
      $dragAttempts++
      if($Action -eq 'focus-tray'){$drag=[MineradioChildQa]::Run('tray',$TaskbarHwnd,$TaskbarPid,$TaskbarHwnd,$PointX,$PointY,0)}
      else{$drag=[MineradioChildQa]::Run('drag',$HostHwnd,$HostPid,$TaskbarHwnd,$PointX,$PointY,$DeltaX)}
      if($drag.Reason -eq 'BUTTON_ACTIVE' -and $drag.DownCount -eq 0 -and $drag.ForegroundBefore -eq $FocusHwnd -and $dragAttempts -lt 3){Start-Sleep -Milliseconds 350}
      else {break}
    } while($dragAttempts -lt 3)
  }
  @{focus=$focus;drag=$drag;focusAttempts=$focusAttempts;dragAttempts=$dragAttempts;dummyAliveAfter=[MineradioChildQa]::WindowOwned($FocusHwnd,$FocusPid)} | ConvertTo-Json -Depth 6 -Compress
} else {
  [MineradioChildQa]::Run($Action, $HostHwnd, $HostPid, $TaskbarHwnd, $PointX, $PointY, $DeltaX) | ConvertTo-Json -Depth 5 -Compress
}

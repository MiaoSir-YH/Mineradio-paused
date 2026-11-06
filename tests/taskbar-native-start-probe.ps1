param(
  [Parameter(Mandatory = $true)][long]$TaskbarHwnd,
  [Parameter(Mandatory = $true)][int]$PointX,
  [Parameter(Mandatory = $true)][int]$PointY,
  [Parameter(Mandatory = $true)][string]$BeforeImage,
  [Parameter(Mandatory = $true)][string]$OutputImage
)

# The caller must visually identify Start in a fresh real-screen capture first.
$ErrorActionPreference = 'Stop'
$age = ((Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $BeforeImage).LastWriteTimeUtc).TotalSeconds
if ($age -gt 30) { throw 'The visual Start capture is stale.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class QaNativeStart {
 [StructLayout(LayoutKind.Sequential)] public struct P {public int X,Y;}
 [StructLayout(LayoutKind.Sequential)] public struct R {public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)] struct M {public int X,Y;public uint Data,Flags,Time;public UIntPtr Extra;}
 [StructLayout(LayoutKind.Explicit)] struct U {[FieldOffset(0)]public M Mouse;}
 [StructLayout(LayoutKind.Sequential)] struct I {public uint Type;public U Union;}
 [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out R r);
 [DllImport("user32.dll")] static extern bool GetCursorPos(out P p);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(P p);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint n,I[] input,int size);
 [DllImport("user32.dll")] static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);
 static uint Button(uint flags){var v=new I{Type=0,Union=new U{Mouse=new M{Flags=flags}}};return SendInput(1,new I[]{v},Marshal.SizeOf(typeof(I)));}
 public sealed class Result {public bool Ok; public string Reason="";public long ForegroundBefore,ForegroundAfter,Bar,Hit,HitWindow,At;public uint ForegroundPidAfter,HitPid,BarPid,Down,Up;}
 public static Result Click(long barValue,int x,int y){
   try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch{}
   var result=new Result{Bar=barValue};var bar=new IntPtr(barValue);R r;
   if(!IsWindowVisible(bar)||!GetWindowRect(bar,out r)||x<r.Left||x>=r.Right||y<r.Top||y>=r.Bottom){result.Reason="TASKBAR_CHANGED";return result;}
   P old;GetCursorPos(out old);Thread.Sleep(80);P p;GetCursorPos(out p);
   if(p.X!=old.X||p.Y!=old.Y||GetAsyncKeyState(1)<0||GetAsyncKeyState(2)<0){result.Reason="CURSOR_ACTIVE";return result;}
   result.ForegroundBefore=GetForegroundWindow().ToInt64();
   if(!SetCursorPos(x,y)){result.Reason="MOVE_FAILED";return result;}
   Thread.Sleep(50);GetCursorPos(out p);
   if(p.X!=x||p.Y!=y){result.Reason="CURSOR_MOVED";return result;}
   var hitWindow=WindowFromPoint(p);var hit=GetAncestor(hitWindow,2);result.Hit=hit.ToInt64();result.HitWindow=hitWindow.ToInt64();
   uint hitPid,barPid;GetWindowThreadProcessId(hitWindow,out hitPid);GetWindowThreadProcessId(bar,out barPid);result.HitPid=hitPid;result.BarPid=barPid;
   if(hit!=bar||hitPid!=barPid){SetCursorPos(old.X,old.Y);result.Reason="TARGET_CHANGED";return result;}
   result.At=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();result.Down=Button(2);result.Up=Button(4);
   if(result.Down==1 && result.Up!=1)Button(4);
   IntPtr fg=IntPtr.Zero;for(int i=0;i<15;i++){Thread.Sleep(40);fg=GetForegroundWindow();if(fg!=IntPtr.Zero && fg.ToInt64()!=result.ForegroundBefore)break;}
   result.ForegroundAfter=fg.ToInt64();uint pid;GetWindowThreadProcessId(fg,out pid);result.ForegroundPidAfter=pid;
   GetCursorPos(out p);if(p.X==x&&p.Y==y)SetCursorPos(old.X,old.Y);
   result.Ok=result.Down==1&&result.Up==1;return result;
 }
 public static bool EscapeIfForeground(long hwnd,uint pid){
   var fg=GetForegroundWindow();uint current;GetWindowThreadProcessId(fg,out current);
   if(fg.ToInt64()!=hwnd||current!=pid)return false;
   keybd_event(27,0,0,UIntPtr.Zero);keybd_event(27,0,2,UIntPtr.Zero);return true;
 }
}
'@
Add-Type -AssemblyName System.Drawing
$result=[QaNativeStart]::Click($TaskbarHwnd,$PointX,$PointY)
if ($result.Ok) {
  $bmp=[System.Drawing.Bitmap]::new(2560,1040)
  $graphics=[System.Drawing.Graphics]::FromImage($bmp)
  try { $graphics.CopyFromScreen(2560,400,0,0,$bmp.Size);$bmp.Save($OutputImage,[System.Drawing.Imaging.ImageFormat]::Png) }
  finally { $graphics.Dispose();$bmp.Dispose() }
  $process=Get-Process -Id $result.ForegroundPidAfter -ErrorAction SilentlyContinue
  $escaped=$false
  if ($result.ForegroundAfter -ne $result.ForegroundBefore -and $process.ProcessName -in @('StartMenuExperienceHost','ShellExperienceHost','SearchHost')) {
    $escaped=[QaNativeStart]::EscapeIfForeground($result.ForegroundAfter,$result.ForegroundPidAfter)
  }
  @{input=$result;foregroundName=$process.ProcessName;screenshot=$OutputImage;escapeSent=$escaped} | ConvertTo-Json -Depth 5 -Compress
} else { @{input=$result;escapeSent=$false} | ConvertTo-Json -Depth 5 -Compress }

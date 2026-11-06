using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

// A separate STA owns the taskbar child. Pipe I/O never runs on its window thread.
internal static class TaskbarLyricsHost {
  const uint Magic = 0x31524c4d; // MLR1, little endian.
  const uint FrameMessage = 1, LayoutMessage = 2, CloseMessage = 3;
  const uint ApplyLayout = 0x8001, ApplyFrame = 0x8002;
  const int HeaderSize = 48, MaxFrameBytes = 32 * 1024 * 1024;
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; public uint extra; }
  [StructLayout(LayoutKind.Sequential)] struct BITMAPINFOHEADER { public uint size; public int width, height; public ushort planes, bits; public uint compression, imageSize; public int xppm, yppm; public uint colors, important; }
  [StructLayout(LayoutKind.Sequential)] struct BITMAPINFO { public BITMAPINFOHEADER header; public uint colors; }
  [StructLayout(LayoutKind.Sequential, Pack=1)] struct BLENDFUNCTION { public byte op, flags, alpha, format; }
  delegate IntPtr WindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct WNDCLASSEX {
    public uint size, style; public WindowProc proc; public int clsExtra, wndExtra;
    public IntPtr instance, icon, cursor, background; public string menu, className; public IntPtr iconSmall;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern ushort RegisterClassEx(ref WNDCLASSEX cls);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateWindowEx(uint ex, string cls, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, System.Text.StringBuilder name, int size);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr window, ref POINT point);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref POINT point);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int index, uint dpi);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] static extern int GetMessageTime();
  [DllImport("user32.dll")] static extern IntPtr SetCapture(IntPtr window);
  [DllImport("user32.dll")] static extern bool ReleaseCapture();
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
  [DllImport("user32.dll", SetLastError=true)] static extern bool UpdateLayeredWindow(IntPtr window, IntPtr dst, IntPtr destPoint, ref SIZE size, IntPtr src, ref POINT sourcePoint, uint key, ref BLENDFUNCTION blend, uint flags);
  [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr window, UIntPtr id, uint elapsed, IntPtr callback);
  [DllImport("user32.dll")] static extern bool KillTimer(IntPtr window, UIntPtr id);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr window, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern void PostQuitMessage(int code);
  [DllImport("user32.dll")] static extern uint GetQueueStatus(uint flags);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll", SetLastError=true)] static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFO info, uint usage, out IntPtr bits, IntPtr section, uint offset);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();

  sealed class Layout { public int x, y, width, height, minX, maxX, generation, threshold; }
  sealed class Frame { public int sequence, width, height, left, top, right, bottom, opacity, generation; public byte[] pixels; }
  static readonly BlockingCollection<string> output = new BlockingCollection<string>(new ConcurrentQueue<string>(), 64);
  static WindowProc proc = WindowMessage;
  static IntPtr child, tray, screenDc, memoryDc, bitmap, oldBitmap, bitmapBits;
  static Layout layout, pendingLayout;
  static Frame pendingFrame;
  static int layoutNotification, frameNotification, received, dropped, drawn, dragStartX, dragStartMouseX;
  static POINT clickStartPoint;
  static bool dragging, dragMoved;
  static string closeReason = "input-closed";
  static readonly TaskbarLyricsClickSequence clicks = new TaskbarLyricsClickSequence();

  static void Emit(string value) { output.TryAdd(value); }
  static void OutputLoop() {
    try { foreach (string value in output.GetConsumingEnumerable()) { Console.WriteLine(value); Console.Out.Flush(); } } catch { }
  }
  static bool IsExplorerTaskbar(IntPtr window, uint expectedPid) {
    if (!IsWindow(window)) return false;
    uint pid; GetWindowThreadProcessId(window,out pid);
    if (pid==0 || pid!=expectedPid) return false;
    var name=new System.Text.StringBuilder(128); GetClassName(window,name,name.Capacity);
    if (name.ToString()!="Shell_TrayWnd" && name.ToString()!="Shell_SecondaryTrayWnd") return false;
    try { using(var process=Process.GetProcessById((int)pid)) return String.Equals(process.ProcessName,"explorer",StringComparison.OrdinalIgnoreCase); } catch { return false; }
  }
  static bool ReadExact(Stream stream,byte[] bytes) {
    int offset=0;while(offset<bytes.Length){int count=stream.Read(bytes,offset,bytes.Length-offset);if(count<=0)return false;offset+=count;}return true;
  }
  static void InputLoop() {
    try {
      Stream input=Console.OpenStandardInput(); byte[] header=new byte[HeaderSize];
      while(ReadExact(input,header)) {
        if(BitConverter.ToUInt32(header,0)!=Magic) { closeReason="invalid-protocol"; break; }
        uint kind=BitConverter.ToUInt32(header,4); int sequence=BitConverter.ToInt32(header,8), length=BitConverter.ToInt32(header,12);
        int[] p=new int[8];for(int i=0;i<8;i++)p[i]=BitConverter.ToInt32(header,16+i*4);
        if(kind==CloseMessage && length==0) { closeReason="requested"; break; }
        if(kind==LayoutMessage && length==0) {
          var next=new Layout {x=p[0],y=p[1],width=p[2],height=p[3],minX=p[4],maxX=p[5],generation=p[6],threshold=Math.Max(1,Math.Min(64,p[7]>0?p[7]:4))};
          Interlocked.Exchange(ref pendingLayout,next);
          if(Interlocked.Exchange(ref layoutNotification,1)==0) PostMessage(child,ApplyLayout,IntPtr.Zero,IntPtr.Zero);
          continue;
        }
        if(kind!=FrameMessage || length<=0 || length>MaxFrameBytes || p[0]<=0 || p[1]<=0
            || (long)p[0]*p[1]*4!=length) { closeReason="invalid-frame"; break; }
        var frame=new Frame {sequence=sequence,width=p[0],height=p[1],left=p[2],top=p[3],right=p[4],bottom=p[5],opacity=p[6],generation=p[7],pixels=new byte[length]};
        if(!ReadExact(input,frame.pixels)) break;
        Interlocked.Increment(ref received);
        if(Interlocked.Exchange(ref pendingFrame,frame)!=null) Interlocked.Increment(ref dropped);
        if(Interlocked.Exchange(ref frameNotification,1)==0) PostMessage(child,ApplyFrame,IntPtr.Zero,IntPtr.Zero);
      }
    } catch { closeReason="input-error"; }
    PostMessage(child,0x10,IntPtr.Zero,IntPtr.Zero);
  }
  static void ReleaseBitmap() {
    if(oldBitmap!=IntPtr.Zero) { SelectObject(memoryDc,oldBitmap); oldBitmap=IntPtr.Zero; }
    if(bitmap!=IntPtr.Zero) { DeleteObject(bitmap); bitmap=IntPtr.Zero; }
    bitmapBits=IntPtr.Zero;
  }
  static bool CreateBitmap(int width,int height) {
    if(width<=0 || height<=0 || (long)width*height*4>MaxFrameBytes) return false;
    ReleaseBitmap();
    BITMAPINFO info=new BITMAPINFO();info.header.size=(uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));info.header.width=width;info.header.height=-height;info.header.planes=1;info.header.bits=32;
    bitmap=CreateDIBSection(screenDc,ref info,0,out bitmapBits,IntPtr.Zero,0);
    if(bitmap==IntPtr.Zero || bitmapBits==IntPtr.Zero) return false;
    oldBitmap=SelectObject(memoryDc,bitmap);return true;
  }
  static void CancelClicks() { KillTimer(child,new UIntPtr(2)); clicks.Cancel(); }
  static void ArmClickTimer() {
    KillTimer(child,new UIntPtr(2));
    int wait=clicks.WaitMilliseconds(GetTickCount());
    if(wait>=0) SetTimer(child,new UIntPtr(2),(uint)Math.Max(10,wait),IntPtr.Zero);
  }
  static void EmitClickAction(string action) {
    if(layout==null || (action!="next" && action!="previous")) return;
    Emit("{\"kind\":\"click-action\",\"action\":\""+action+"\",\"generation\":"+layout.generation+"}");
  }
  static int DoubleClickMetric(int index) {
    try { uint dpi=GetDpiForWindow(child); int value=GetSystemMetricsForDpi(index,dpi==0?96u:dpi); if(value>0)return value; }
    catch(EntryPointNotFoundException) { }
    return Math.Max(1,GetSystemMetrics(index));
  }
  static POINT MouseMessageScreenPoint(IntPtr window,IntPtr param) {
    long value=param.ToInt64();
    POINT point=new POINT {x=unchecked((short)(value&0xffff)),y=unchecked((short)((value>>16)&0xffff))};
    ClientToScreen(window,ref point);return point;
  }
  static void ApplyPendingLayout() {
    Interlocked.Exchange(ref layoutNotification,0);
    Layout next=Interlocked.Exchange(ref pendingLayout,null);
    if(next==null) return;
    if(next.width<=0 || next.height<=0 || next.maxX<next.minX || next.generation<=0 || (long)next.width*next.height*4>MaxFrameBytes) return;
    if(layout!=null && (layout.generation!=next.generation || (!dragging && (layout.x!=next.x || layout.y!=next.y || layout.width!=next.width || layout.height!=next.height)))) CancelClicks();
    if(dragging) {
      if(layout==null || layout.generation!=next.generation) { dragging=false; dragMoved=false; ReleaseCapture(); }
      else { RECT current; if(GetWindowRect(child,out current)) next.x=Math.Max(next.minX,Math.Min(next.maxX,current.left)); }
    }
    if(layout==null || layout.width!=next.width || layout.height!=next.height) {
      if(!CreateBitmap(next.width,next.height)) { Emit("{\"kind\":\"error\",\"error\":\"BITMAP_FAILED\"}"); return; }
    }
    layout=next;
    POINT point=new POINT {x=next.x,y=next.y}; ScreenToClient(tray,ref point);
    SetWindowPos(child,IntPtr.Zero,point.x,point.y,next.width,next.height,0x0014);
  }
  static void CancelDrag(bool release) {
    if(!dragging) return;
    dragging=false; dragMoved=false;
    if(release) ReleaseCapture();
    if(layout==null) return;
    POINT point=new POINT {x=Math.Max(layout.minX,Math.Min(layout.maxX,dragStartX)),y=layout.y};
    ScreenToClient(tray,ref point);
    SetWindowPos(child,IntPtr.Zero,point.x,point.y,0,0,0x0015);
  }
  static void DrawLatest() {
    Frame frame=Interlocked.Exchange(ref pendingFrame,null);
    if(frame==null || layout==null || frame.generation!=layout.generation || frame.width!=layout.width || frame.height!=layout.height || bitmapBits==IntPtr.Zero) return;
    int left=Math.Max(0,Math.Min(frame.width,frame.left)),right=Math.Max(0,Math.Min(frame.width,frame.right));
    int top=Math.Max(0,Math.Min(frame.height,frame.top)),bottom=Math.Max(0,Math.Min(frame.height,frame.bottom));
    // Keep text gaps draggable while leaving the rest of the layered child fully transparent.
    byte hitAlpha=(byte)Math.Max(1, (255+Math.Max(1,frame.opacity)-1)/Math.Max(1,frame.opacity));
    for(int y=top;y<bottom;y++)for(int x=left;x<right;x++){int i=(y*frame.width+x)*4;if(frame.pixels[i+3]<hitAlpha)frame.pixels[i+3]=hitAlpha;}
    Marshal.Copy(frame.pixels,0,bitmapBits,frame.pixels.Length);
    SIZE size=new SIZE {cx=frame.width,cy=frame.height};POINT src=new POINT();
    BLENDFUNCTION blend=new BLENDFUNCTION {alpha=(byte)Math.Max(0,Math.Min(255,frame.opacity)),format=1};
    if(!UpdateLayeredWindow(child,screenDc,IntPtr.Zero,ref size,memoryDc,ref src,0,ref blend,2)) {
      Emit("{\"kind\":\"error\",\"error\":\"DRAW_FAILED\",\"code\":"+Marshal.GetLastWin32Error()+"}");return;
    }
    drawn++;
  }
  static IntPtr WindowMessage(IntPtr window,uint msg,IntPtr wp,IntPtr lp) {
    if(msg==0x21) return new IntPtr(3); // MA_NOACTIVATE: do not focus, do deliver the click.
    if(msg==0x201 && layout!=null) {
      POINT p;RECT r;GetCursorPos(out p);GetWindowRect(window,out r);
      dragStartMouseX=p.x;dragStartX=r.left;dragging=true;dragMoved=false;
      POINT down=MouseMessageScreenPoint(window,lp);
      clickStartPoint=down;
      KillTimer(child,new UIntPtr(2));
      clicks.Press(unchecked((uint)GetMessageTime()),down.x,down.y,layout.generation,GetDoubleClickTime(),DoubleClickMetric(36),DoubleClickMetric(37));
      SetCapture(window);return IntPtr.Zero;
    }
    if(msg==0x200 && dragging && layout!=null) {
      POINT p;GetCursorPos(out p);int delta=p.x-dragStartMouseX;
      POINT move=MouseMessageScreenPoint(window,lp);
      if(Math.Abs((long)move.x-clickStartPoint.x)>layout.threshold || Math.Abs((long)move.y-clickStartPoint.y)>layout.threshold) CancelClicks();
      if(!dragMoved && Math.Abs((long)delta)<=layout.threshold) return IntPtr.Zero;
      if(!dragMoved) CancelClicks();
      dragMoved=true; int next=Math.Max(layout.minX,Math.Min(layout.maxX,dragStartX+delta));
      POINT client=new POINT {x=next,y=layout.y};ScreenToClient(tray,ref client);
      SetWindowPos(window,IntPtr.Zero,client.x,client.y,0,0,0x0015);return IntPtr.Zero;
    }
    if(msg==0x202 && dragging) {
      POINT up=MouseMessageScreenPoint(window,lp);
      bool clickCancelled=dragMoved || layout==null || Math.Abs((long)up.x-clickStartPoint.x)>layout.threshold
        || Math.Abs((long)up.y-clickStartPoint.y)>layout.threshold;
      bool moved=dragMoved; dragging=false;dragMoved=false;ReleaseCapture();RECT r;GetWindowRect(window,out r);
      if(moved && r.left!=dragStartX) Emit("{\"kind\":\"drag-end\",\"x\":"+r.left+",\"generation\":"+(layout==null?0:layout.generation)+"}");
      EmitClickAction(clicks.Release(clickCancelled));ArmClickTimer();return IntPtr.Zero;
    }
    if(msg==0x215) { if(dragging){CancelClicks();CancelDrag(false);}return IntPtr.Zero; } // WM_CAPTURECHANGED
    if(msg==0x1f) { CancelClicks();CancelDrag(true);return IntPtr.Zero; } // WM_CANCELMODE
    if(msg==ApplyLayout) { ApplyPendingLayout();return IntPtr.Zero; }
    if(msg==ApplyFrame) {
      Interlocked.Exchange(ref frameNotification,0);
      // Posted frame notifications must yield to queued mouse, keyboard and pointer input.
      if((GetQueueStatus(0x1c07)&0xffff0000)==0) DrawLatest();
      return IntPtr.Zero;
    }
    if(msg==0x113) {
      if(wp.ToInt64()==2) { KillTimer(window,new UIntPtr(2));EmitClickAction(clicks.Expire(GetTickCount()));ArmClickTimer();return IntPtr.Zero; }
      if(!IsWindow(tray)) { closeReason="parent-destroyed";DestroyWindow(window); } else DrawLatest();return IntPtr.Zero;
    }
    if(msg==0x10) { DestroyWindow(window);return IntPtr.Zero; }
    if(msg==0x2) { CancelClicks();KillTimer(window,new UIntPtr(1));PostQuitMessage(0);return IntPtr.Zero; }
    return DefWindowProc(window,msg,wp,lp);
  }
  [STAThread] static int Main(string[] args) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    var writer=new Thread(OutputLoop);writer.IsBackground=true;writer.Start();
    long handle;uint pid;
    if(args.Length<2 || !Int64.TryParse(args[0],out handle) || !UInt32.TryParse(args[1],out pid)) { Emit("{\"kind\":\"error\",\"error\":\"INVALID_ARGUMENTS\"}");output.CompleteAdding();writer.Join(1000);return 2; }
    tray=new IntPtr(handle);
    if(!IsExplorerTaskbar(tray,pid)) { Emit("{\"kind\":\"error\",\"error\":\"INVALID_TASKBAR\"}");output.CompleteAdding();writer.Join(1000);return 2; }
    IntPtr instance=GetModuleHandle(null);string cls="MineradioTaskbarLyricsHost_"+Process.GetCurrentProcess().Id;
    WNDCLASSEX wc=new WNDCLASSEX {size=(uint)Marshal.SizeOf(typeof(WNDCLASSEX)),proc=proc,instance=instance,className=cls};
    if(RegisterClassEx(ref wc)==0) { Emit("{\"kind\":\"error\",\"error\":\"REGISTER_FAILED\",\"code\":"+Marshal.GetLastWin32Error()+"}");output.CompleteAdding();writer.Join(1000);return 2; }
    child=CreateWindowEx(0x08080080,cls,"Mineradio Taskbar Lyrics",0x54000000,0,0,1,1,tray,IntPtr.Zero,instance,IntPtr.Zero);
    if(child==IntPtr.Zero) { Emit("{\"kind\":\"error\",\"error\":\"CREATE_FAILED\",\"code\":"+Marshal.GetLastWin32Error()+"}");output.CompleteAdding();writer.Join(1000);return 2; }
    try {
      screenDc=GetDC(IntPtr.Zero);memoryDc=CreateCompatibleDC(screenDc);
      if(screenDc==IntPtr.Zero || memoryDc==IntPtr.Zero) { Emit("{\"kind\":\"error\",\"error\":\"DC_FAILED\"}");return 2; }
      SetWindowPos(child,IntPtr.Zero,0,0,0,0,0x0053);
      Emit("{\"kind\":\"ready\",\"hwnd\":\""+child.ToInt64()+"\",\"parent\":\""+tray.ToInt64()+"\"}");
      SetTimer(child,new UIntPtr(1),10,IntPtr.Zero);
      var input=new Thread(InputLoop);input.IsBackground=true;input.Start();
      MSG msg;while(GetMessage(out msg,IntPtr.Zero,0,0)>0){TranslateMessage(ref msg);DispatchMessage(ref msg);}
      Emit("{\"kind\":\"closed\",\"reason\":\""+closeReason+"\",\"received\":"+received+",\"drawn\":"+drawn+",\"dropped\":"+dropped+"}");
      return 0;
    } finally {
      if(child!=IntPtr.Zero && IsWindow(child))DestroyWindow(child);
      ReleaseBitmap();if(memoryDc!=IntPtr.Zero)DeleteDC(memoryDc);if(screenDc!=IntPtr.Zero)ReleaseDC(IntPtr.Zero,screenDc);
      output.CompleteAdding();writer.Join(1000);
    }
  }
}

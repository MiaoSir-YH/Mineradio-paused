using System;

// Pure click classification; Windows input and its one-shot timer are owned by the host.
internal sealed class TaskbarLyricsClickSequence {
  int completed, generation, lastX, lastY, pressX, pressY, pressGeneration;
  uint lastTick, pressTick, interval, pressInterval;
  bool pressed, continues;

  public void Press(uint tick, int x, int y, int nextGeneration, uint nextInterval, int width, int height) {
    if (pressed || (completed > 0 && generation != nextGeneration)) Cancel();
    uint window = nextInterval == 0 ? 1u : nextInterval;
    continues = completed > 0 && unchecked(tick - lastTick) <= interval
      && Math.Abs((long)x - lastX) * 2 <= Math.Max(1, width)
      && Math.Abs((long)y - lastY) * 2 <= Math.Max(1, height);
    pressed = true;
    pressTick = tick; pressX = x; pressY = y; pressGeneration = nextGeneration; pressInterval = window;
  }

  public string Release(bool cancelled) {
    if (!pressed) return null;
    pressed = false;
    if (cancelled) { Cancel(); return null; }
    string previousAction = completed == 2 && !continues ? "next" : null;
    completed = continues ? completed + 1 : 1;
    generation = pressGeneration; lastTick = pressTick; lastX = pressX; lastY = pressY; interval = pressInterval;
    if (completed >= 3) { Cancel(); return "previous"; }
    return previousAction;
  }

  public string Expire(uint tick) {
    if (pressed || completed == 0 || unchecked(tick - lastTick) <= interval) return null;
    string action = completed == 2 ? "next" : null;
    Cancel();
    return action;
  }

  public int WaitMilliseconds(uint tick) {
    if (pressed || completed == 0) return -1;
    uint elapsed = unchecked(tick - lastTick);
    if (elapsed > interval) return 0;
    return (int)Math.Min((uint)Int32.MaxValue, interval - elapsed + 1u);
  }

  public void Cancel() {
    completed = 0; generation = 0; pressed = false; continues = false;
  }
}

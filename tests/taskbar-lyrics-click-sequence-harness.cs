using System;

static class TaskbarLyricsClickSequenceHarness {
  static int checks;
  static void Equal(string expected, string actual, string label) {
    checks++;
    if (expected != actual) throw new Exception(label + ": expected " + (expected ?? "null") + ", got " + (actual ?? "null"));
  }
  static void True(bool value, string label) { checks++; if (!value) throw new Exception(label); }
  static void Press(TaskbarLyricsClickSequence sequence, uint tick, int x, int generation) {
    sequence.Press(tick, x, 50, generation, 500, 8, 8);
  }
  static void Click(TaskbarLyricsClickSequence sequence, uint tick, int x, int generation) {
    Press(sequence, tick, x, generation);
    Equal(null, sequence.Release(false), "ordinary release");
  }
  static void Main() {
    var one = new TaskbarLyricsClickSequence();
    Click(one,100,100,1);
    Equal(null,one.Expire(2000),"single click does not switch songs");

    var two = new TaskbarLyricsClickSequence();
    Click(two,100,100,1); Click(two,200,100,1);
    True(two.WaitMilliseconds(210)>0,"double click must wait for a possible third click");
    Equal(null,two.Expire(700),"deadline is inclusive");
    Equal("next",two.Expire(701),"double click eventually goes to next song");
    Equal(null,two.Expire(2000),"double click fires once");

    var three = new TaskbarLyricsClickSequence();
    Click(three,100,100,1); Click(three,200,100,1);
    Press(three,700,100,1);
    Equal(null,three.Expire(1500),"third press pauses the pending next action");
    Equal("previous",three.Release(false),"third release goes to previous song");
    Equal(null,three.Expire(3000),"triple click must never emit an extra next");

    var cancelled = new TaskbarLyricsClickSequence();
    Click(cancelled,100,100,1); Click(cancelled,200,100,1);
    Press(cancelled,250,100,1);
    Equal(null,cancelled.Release(true),"drag or lost capture cancels the gesture");
    Equal(null,cancelled.Expire(2000),"cancelled third gesture cannot emit pending next");
    Click(cancelled,2100,100,1); Click(cancelled,2200,100,1);
    cancelled.Cancel();
    Equal(null,cancelled.Expire(4000),"window close or mode switch cancels pending clicks");

    var moved = new TaskbarLyricsClickSequence();
    Click(moved,100,100,1); Click(moved,200,1000,1);
    Equal(null,moved.Expire(1000),"far-apart clicks are not a double click");

    var generation = new TaskbarLyricsClickSequence();
    Click(generation,100,100,1); Click(generation,200,100,1);
    Click(generation,250,100,2);
    Equal(null,generation.Expire(2000),"a new layout cannot dispatch the old generation");

    var wrap = new TaskbarLyricsClickSequence();
    Click(wrap,unchecked(uint.MaxValue-255),100,1); Click(wrap,50,100,1);
    Equal(null,wrap.Expire(550),"deadline survives uint timer wrap");
    Equal("next",wrap.Expire(551),"wrapped timer delivers the next action once");
    Console.WriteLine("CLICK_SEQUENCE_QA:"+checks);
  }
}

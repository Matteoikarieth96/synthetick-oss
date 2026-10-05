// SyntheTick whiteboard video. One builder per scene id in script.json.
// Board is 1920x1080. Keep content above H - 150 (caption strip) and titles around y = 150.

// Labelled hand-drawn box. Draws the outline at `at`, then writes the label.
function box(cx, cy, w, h, label, size, at, o = {}) {
  P(rect(cx - w / 2, cy - h / 2, w, h), at, o.dur || .45, { c: o.c || INK, fill: o.c || INK, fillOp: o.fillOp ?? .08 });
  return T(label, cx, cy + size * .33, size, at + (o.dur || .45) * .7, .4, { c: o.tc || INK });
}
const TITLE = (s, A, W) => T(s, W / 2, 150, 100, A(0, 0), .7);

window.SCENES = {
  hook(A, { W, H }) {
    TITLE('Idea in, assets out', A, W);
    const bx = W * .25, by = 520, r = 105;
    P(circ(bx, by, r) + line(bx - 42, by + r + 28, bx + 42, by + r + 28, 1) + line(bx - 28, by + r + 58, bx + 28, by + r + 58, 1),
      A(0, .55), .7, { c: GOLD, fill: GOLD, fillOp: .2 });
    T('your idea', bx, by + r + 160, 64, A(0, .85), .45);
    P(arrow(bx + 190, by, W * .52, by), A(1, 0), .4, { c: BLUE });
    [0, 1, 2].forEach((i) => {
      const at = A(1, .18 + i * .24), cx = W * .62 + i * 190;
      P(rect(cx - 70, by - 70, 140, 140), at, .28, { c: GRAY, fill: GRAY, fillOp: .08 });
      T('?', cx, by + 35, 110, at + .26, .18, { c: RED });
    });
  },

  input(A, { W, H }) {
    TITLE('Paste your idea', A, W);
    const y = 400, xs = [.2, .4, .6, .8].map((f) => W * f);
    // thesis: page with lines
    P(rect(xs[0] - 90, y - 90, 180, 180) + line(xs[0] - 55, y - 40, xs[0] + 55, y - 40, 1) + line(xs[0] - 55, y, xs[0] + 55, y, 1) + line(xs[0] - 55, y + 40, xs[0] + 20, y + 40, 1), A(0, 0), .5);
    T('thesis', xs[0], y + 160, 52, A(0, .12), .3);
    // article: title bar + two columns
    P(rect(xs[1] - 90, y - 90, 180, 180) + line(xs[1] - 60, y - 50, xs[1] + 60, y - 50, 1) + line(xs[1] - 60, y - 5, xs[1] - 5, y - 5, 1) + line(xs[1] + 5, y - 5, xs[1] + 60, y - 5, 1) + line(xs[1] - 60, y + 40, xs[1] - 5, y + 40, 1) + line(xs[1] + 5, y + 40, xs[1] + 60, y + 40, 1), A(0, .27), .5);
    T('article', xs[1], y + 160, 52, A(0, .4), .3);
    // tweet: speech bubble
    P(icon.bubble(xs[2], y - 5, 200, 140), A(0, .52), .5, { c: BLUE, fill: BLUE, fillOp: .1 });
    T('tweet', xs[2], y + 160, 52, A(0, .65), .3);
    // pdf: page with red label
    P(rect(xs[3] - 90, y - 90, 180, 180), A(0, .77), .4);
    T('PDF', xs[3], y + 20, 70, A(0, .85), .3, { c: RED });
    T('PDF', xs[3], y + 160, 52, A(0, .93), .3, { c: INK });
    // arrow down to the extracted idea + rules
    P(arrow(W / 2, y + 205, W / 2, 640), A(1, 0), .45, { c: BLUE });
    T('the idea + your rules', W / 2, 720, 70, A(1, .12), .9);
    const chips = [['only crypto', 340], ['only European ETFs', 540], ['no defense', 320]];
    let x = W / 2 - (340 + 540 + 320 + 120) / 2;
    chips.forEach(([label, w], i) => {
      const cx = x + w / 2, at = A(1, .35 + i * .22);
      P(rect(cx - w / 2, 770, w, 100), at, .4, { c: GREEN, fill: GREEN, fillOp: .12 });
      T(label, cx, 770 + 66, 52, at + .35, .5);
      x += w + 60;
    });
  },

  match(A, { W, H }) {
    TITLE('Search the universe', A, W);
    const row = [['stocks', .17], ['ETFs', .39], ['bond funds', .61], ['crypto', .83]];
    row.forEach(([label, f], i) => box(W * f, 380, 330, 150, label, 60, A(0, i * .24), { c: BLUE, dur: .4 }));
    // funnel = the SQL hard filter
    P(poly([[W / 2 - 520, 560], [W / 2 + 520, 560], [W / 2 + 110, 740], [W / 2 - 110, 740]], true, 2), A(1, 0), .9, { c: GOLD, fill: GOLD, fillOp: .15 });
    T('hard filter in SQL', W / 2, 640, 64, A(1, .35), .8);
    P(icon.tick(W / 2, 830, 52), A(1, .7), .5, { c: GREEN, fill: GREEN, fillOp: .15 });
  },

  rank(A, { W, H }) {
    TITLE('Ranked, with reasons', A, W);
    const x0 = W * .1, base = 840;
    P(icon.bars(x0, base, [100, 93, 86, 79, 72, 64, 56, 47, 38, 30], 62, 24, 400), A(0, .02), 1.5, { c: BLUE, fill: BLUE, fillOp: .12 });
    T('up to ten picks', x0 + 430, 905, 50, A(0, .75), .6);
    const cx = W * .76;
    T('87', cx, 470, 230, A(1, 0), .6, { c: GOLD });
    T('score, 0 to 100', cx, 560, 56, A(1, .22), .6);
    P(rect(cx - 290, 620, 580, 170) + wave(cx - 230, cx + 230, 670, 6, 90) + wave(cx - 230, cx + 230, 720, 6, 90) + wave(cx - 230, cx + 90, 765, 6, 90), A(1, .5), 1.0, { c: INK, w: 6 });
    T('a clear reason', cx, 865, 54, A(1, .8), .6);
  },

  audit(A, { W, H }) {
    TITLE('Audited twice', A, W);
    const y = 440;
    box(W * .17, y, 300, 150, 'picks', 62, A(0, 0), { c: BLUE, dur: .4 });
    P(arrow(W * .17 + 160, y, W * .47 - 230, y), A(0, .22), .35, { c: GRAY });
    box(W * .47, y, 420, 150, 'code audit', 62, A(0, .32), { c: GREEN });
    P(arrow(W * .47 + 220, y, W * .77 - 240, y), A(0, .62), .35, { c: GRAY });
    box(W * .77, y, 440, 150, 'your words', 62, A(0, .7), { c: GREEN });
    P(icon.cross(W * .3, 720, 58), A(1, 0), .5, { c: RED, fill: RED, fillOp: .15 });
    T('dropped, and you see why', W * .3 + 100, 742, 62, A(1, .25), 1.2, { anchor: 'start', c: RED });
  },

  honest(A, { W, H }) {
    TITLE('No made-up numbers', A, W);
    P(rect(W / 2 - 600, 270, 1200, 140), A(0, .05), .55, { c: GRAY, fill: GRAY, fillOp: .08 });
    T('Nothing matched your requirements', W / 2, 358, 62, A(0, .35), 1.2);
    P(rect(W / 2 - 600, 480, 1200, 150), A(1, 0), .5, { c: GRAY, fill: GRAY, fillOp: .08 });
    T('Price', W / 2 - 480, 575, 66, A(1, .2), .4, { anchor: 'start' });
    P(line(W / 2 + 280, 560, W / 2 + 440, 560, 1), A(1, .5), .35, { c: GRAY, w: 12 });
    const b = T('Nothing is invented.', W / 2, 820, 110, A(2, 0), 1.0);
    P(wave(b.x + 20, b.x + b.width - 20, b.y + b.height + 12, 7, 110), A(2, .6), .4, { c: GOLD, w: 9 });
  },

  open(A, { W, H }) {
    TITLE('Now open source', A, W);
    const m = T('MIT', W / 2, 470, 240, A(0, .05), .9, { c: GOLD });
    P(wave(m.x, m.x + m.width, m.y + m.height + 14, 8, 120), A(0, .55), .5, { c: GOLD, w: 10 });
    T('free to use, change and share', W / 2, 610, 60, A(0, .75), 1.0);
    const chips = [['pipeline', 330], ['data jobs', 350], ['public API', 400], ['MCP server', 430]];
    const total = chips.reduce((s, c) => s + c[1], 0) + 3 * 50;
    let x = W / 2 - total / 2;
    chips.forEach(([label, w], i) => {
      const cx = x + w / 2, at = A(1, .08 + i * .22);
      P(rect(cx - w / 2, 740, w, 110), at, .4, { c: BLUE, fill: BLUE, fillOp: .1 });
      T(label, cx, 740 + 72, 56, at + .3, .5);
      x += w + 50;
    });
  },

  join(A, { W, H }) {
    TITLE('Come build it', A, W);
    const y = 400, steps = [['clone', .2, 300], ['run', .5, 260], ['pull request', .8, 500]];
    steps.forEach(([label, f, w], i) => {
      box(W * f, y, w, 130, label, 62, A(0, i * .3), { c: GREEN, dur: .45 });
      if (i < 2) P(arrow(W * f + w / 2 + 20, y, W * steps[i + 1][1] - steps[i + 1][2] / 2 - 20, y), A(0, i * .3 + .17), .3, { c: GRAY });
    });
    T('code and issues on GitHub', W / 2, 650, 64, A(1, 0), 1.0);
    const u = T('synthetick.org', W / 2, 810, 130, A(1, .5), 1.0, { c: BLUE });
    P(wave(u.x + 10, u.x + u.width - 10, u.y + u.height + 12, 7, 110), A(1, .85), .4, { c: GOLD, w: 9 });
  },
};

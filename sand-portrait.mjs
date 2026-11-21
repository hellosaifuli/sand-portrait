/*! sand-portrait v1.0.0 · MIT · Saiful Islam · https://github.com/hellosaifuli/sand-portrait
 *
 * Redraws an image (a portrait, a logo, a wordmark) as halftone dots on a <canvas>.
 * The dots start as a pile of sand on the floor, rise into the image, and can scatter
 * away from the cursor and spring back. No dependencies, under 6 KB gzipped.
 *
 *   const sand = SandPortrait(canvas, { src: 'me.png' });
 *   sand.replay(); sand.setImage('other.png'); sand.set({ on: 'dark' }); sand.destroy();
 */
const SandPortrait = (function () {
  'use strict';

  var DEFAULTS = {
    src: null,            // image URL. Transparent pixels are left empty, so cut-out photos work best
    source: null,         // or a ready <img>, <canvas> or ImageBitmap (see SandPortrait.text)
    on: 'light',          // 'light': dark dots on a light page; 'dark': light dots on a dark page
    color: null,          // dot colour; defaults to the canvas's CSS `color`
    accent: '#F26A1B',    // colour of dots that are moving, under the lens or in a ripple
    gap: 6,               // px between dot centres; bigger = fewer, chunkier dots
    flat: 0,              // > 0 gives every dot the same size (as a share of gap). Good for text and logos
    skipBackground: true, // leave a plain photo background empty (detected from the corners)
    fit: 'cover',         // 'cover' fills the canvas (crops); 'contain' shows all of it (logos, wordmarks)
    posX: 0.5, posY: 0.5, // object-position inside the canvas, as with CSS object-position
    intro: true,          // rise from a sand pile on first draw
    introOnView: false,   // wait until the canvas scrolls into view before the intro starts
    hold: 450,            // ms to wait before the intro starts
    duration: 1500,       // ms for each dot's rise
    interactive: true,    // dots scatter away from the pointer and spring back
    radius: 70,           // px reach of the pointer's push
    lens: 90,             // px radius of the hover lens that swells dots (0 to turn off)
    ripples: true,        // click or tap sends a ripple out from that point
    loop: false,          // send a gentle ripple every few seconds while the cursor is idle
    reducedMotion: 'auto',// 'auto' honours prefers-reduced-motion (no intro, no interaction); 'ignore' doesn't
    autoResize: true,     // rebuild when the canvas changes size
    onReady: null,        // called after each build
    onDone: null,         // called once, when the intro finishes (or straight away with no intro)
    onError: null         // called if the image fails to load
  };

  function SandPortrait(canvas, options) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in options || {}) o[k] = options[k];

    var ctx = canvas.getContext('2d');
    if (o.reducedMotion === 'auto' && window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      o.intro = false; o.interactive = false; o.loop = false; o.ripples = false;
    }
    var K = 0.06, DAMP = 0.8;
    var WAVE_SPEED = 0.55, WAVE_W = 32, WAVE_LIFE = 2600, WAVE_AMP = 4;
    var ink, accent, light, GAP;
    var dots = [], W = 0, H = 0, mx = -9999, my = -9999, lmx = null, lmy = null, speed = 0;
    var running = false, raf = 0, introStart = 0, doneFired = false, doneCalled = false, img = null, alive = true;
    var ripples = [], lastMove = 0, visible = true, nextAuto = 0, sleepT = 0, seen = !o.introOnView;
    var listeners = [], observers = [];

    function readColors() {
      ink = o.color || getComputedStyle(canvas).color || '#111';
      accent = o.accent || ink;
      light = o.on !== 'dark';
      GAP = Math.max(2, o.gap);
    }
    /* positive image either way: on light pages darker pixels get bigger dots, on dark pages lighter ones do */
    function radius(l) {
      if (o.flat) return GAP * o.flat;
      return light ? GAP * 0.48 * Math.pow(1 - l * 0.85, 0.8) : GAP * 0.42 * Math.pow(l, 0.9);
    }
    /* a plain studio or wall background: the four corners agree on one colour */
    function cornerColor(px, cols, rows) {
      var n = Math.max(2, Math.round(Math.min(cols, rows) * 0.06)), sum = [0, 0, 0], sq = [0, 0, 0], c = 0;
      [[0, 0], [cols - n, 0], [0, rows - n], [cols - n, rows - n]].forEach(function (s) {
        for (var y = s[1]; y < s[1] + n; y++) for (var x = s[0]; x < s[0] + n; x++) {
          var i = (y * cols + x) * 4;
          if (px[i + 3] < 128) continue;
          for (var ch = 0; ch < 3; ch++) { sum[ch] += px[i + ch]; sq[ch] += px[i + ch] * px[i + ch]; }
          c++;
        }
      });
      if (c < n * n * 2) return null; /* mostly transparent corners: already a cut-out */
      var mean = sum.map(function (v) { return v / c; });
      var spread = Math.max.apply(null, sq.map(function (v, ch) { return Math.sqrt(Math.max(0, v / c - mean[ch] * mean[ch])); }));
      return spread < 20 ? mean : null;
    }
    function on(target, type, fn, opts) { target.addEventListener(type, fn, opts); listeners.push([target, type, fn, opts]); }

    function ripple(x, y) { ripples.push({ x: x, y: y, t0: performance.now() }); kick(); }
    function autoRipple() {
      /* start on the subject, never on empty background */
      for (var n = 0; n < 12; n++) {
        var d = dots[(Math.random() * dots.length) | 0];
        if (d && d.hy < H * 0.6 && d.l > 0.4) return ripple(d.hx, d.hy);
      }
      if (dots.length) ripple(W * 0.5, H * 0.4);
    }

    function build() {
      if (!alive || !img) return;
      readColors();
      var r = canvas.getBoundingClientRect();
      W = Math.round(r.width); H = Math.round(r.height);
      if (!W || !H) return;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var cols = Math.ceil(W / GAP), rows = Math.ceil(H / GAP);
      var off = document.createElement('canvas'); off.width = cols; off.height = rows;
      var octx = off.getContext('2d');
      var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      var sc = (o.fit === 'contain' ? Math.min : Math.max)(W / iw, H / ih), dw = iw * sc, dh = ih * sc;
      octx.drawImage(img, (W - dw) * o.posX / GAP, (H - dh) * o.posY / GAP, dw / GAP, dh / GAP);
      var px = octx.getImageData(0, 0, cols, rows).data;
      var bg = o.skipBackground && !o.flat ? cornerColor(px, cols, rows) : null;
      var intro = !dots.length && o.intro;
      dots = []; doneFired = !intro;
      for (var y = 0; y < rows; y++) for (var x = 0; x < cols; x++) {
        var i = (y * cols + x) * 4;
        if (px[i + 3] < 128) continue;
        var l = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
        l = Math.min(1, Math.max(0, (l * 1.3 - 0.5) * 1.05 + 0.5));
        if (!o.flat && (light ? l > 0.97 : l < 0.1)) continue;
        if (bg) { var cr = px[i] - bg[0], cg = px[i + 1] - bg[1], cb = px[i + 2] - bg[2]; if (cr * cr + cg * cg + cb * cb < 1800) continue; }
        var hx = x * GAP + GAP / 2, hy = y * GAP + GAP / 2, sx = hx, sy = hy;
        if (intro) {
          /* sand pile: denser in the middle, a low mound along the floor */
          var u = (Math.random() + Math.random() + Math.random()) / 3;
          sx = W * (0.05 + u * 0.9);
          var mound = 1 - Math.abs(u - 0.5) * 2;
          sy = H - 3 - Math.pow(Math.random(), 1.6) * (H * 0.02 + mound * H * 0.07);
        }
        dots.push({ hx: hx, hy: hy, l: l, r: radius(l), x: sx, y: sy, sx: sx, sy: sy, vx: 0, vy: 0, intro: intro,
          delay: (1 - hy / H) * o.duration * 0.43 + Math.random() * o.duration * 0.3, lift: H * (0.04 + Math.random() * 0.14) });
      }
      if (intro) introStart = seen ? performance.now() + o.hold : Infinity;
      if (o.onReady) o.onReady();
      if (!intro && !doneCalled) { doneCalled = true; if (o.onDone) o.onDone(); }
      kick();
    }

    function step() {
      raf = 0;
      if (!alive) return;
      var r = canvas.getBoundingClientRect();
      var lx = mx - r.left, ly = my - r.top;
      var force = 1.2 + Math.min(speed, 40) * 0.06;
      speed *= 0.9;
      var R2 = o.radius * o.radius, LENS = o.lens, L2 = LENS * LENS, moving = 0, introLeft = 0, now = performance.now();
      ctx.clearRect(0, 0, W, H);
      for (var q = ripples.length - 1; q >= 0; q--) if (now - ripples[q].t0 > WAVE_LIFE) ripples.splice(q, 1);
      var idle = now - lastMove > 1800;
      if (o.loop && visible && doneFired && idle && now > nextAuto) { autoRipple(); nextAuto = now + 2600 + Math.random() * 1800; }
      var nr = ripples.length, hovering = o.interactive && LENS > 0 && now - lastMove < 2500;
      var calm = new Path2D(), hot = new Path2D();
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        if (d.intro) {
          var t = (now - introStart - d.delay) / o.duration;
          if (t >= 1) { d.intro = false; d.x = d.hx; d.y = d.hy; }
          else {
            var e = t <= 0 ? 0 : (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
            d.x = d.sx + (d.hx - d.sx) * e;
            d.y = d.sy + (d.hy - d.sy) * e - Math.sin(Math.PI * e) * d.lift;
            moving++; introLeft++;
            calm.moveTo(d.x + d.r, d.y); calm.arc(d.x, d.y, t <= 0 ? d.r * 0.6 : d.r, 0, 6.2832);
            continue;
          }
        }
        if (o.interactive) {
          var dx = d.x - lx, dy = d.y - ly, d2 = dx * dx + dy * dy;
          if (d2 < R2 && d2 > 0.01) {
            var dist = Math.sqrt(d2), fall = 1 - dist / o.radius, f = fall * fall * force;
            d.vx += dx / dist * f; d.vy += dy / dist * f;
          }
          d.vx = (d.vx + (d.hx - d.x) * K) * DAMP;
          d.vy = (d.vy + (d.hy - d.y) * K) * DAMP;
          d.x += d.vx; d.y += d.vy;
        }
        var offset = Math.abs(d.x - d.hx) + Math.abs(d.y - d.hy);
        if (offset > 0.3 || Math.abs(d.vx) + Math.abs(d.vy) > 0.05) moving++;
        var rx = d.x, ry = d.y, rr = d.r, glow = 0;
        /* ripple: a travelling ring that pushes dots outward and swells them */
        for (var w = 0; w < nr; w++) {
          var rp = ripples[w], age = now - rp.t0, wx = d.hx - rp.x, wy = d.hy - rp.y;
          var wd = Math.sqrt(wx * wx + wy * wy) || 1, band = (wd - age * WAVE_SPEED) / WAVE_W;
          if (band > -2.5 && band < 2.5) {
            var amp = Math.exp(-band * band) * (1 - age / WAVE_LIFE);
            rx += wx / wd * amp * WAVE_AMP; ry += wy / wd * amp * WAVE_AMP;
            rr += d.r * amp * 0.6 + amp * 0.7; glow = Math.max(glow, amp);
          }
        }
        /* hover lens: dots under the cursor grow */
        if (hovering) {
          var hx2 = d.hx - lx, hy2 = d.hy - ly, h2 = hx2 * hx2 + hy2 * hy2;
          if (h2 < L2) { var lf = 1 - Math.sqrt(h2) / LENS; rr += d.r * lf * lf * 0.5 + lf * 0.6; glow = Math.max(glow, lf * lf); }
        }
        /* cap growth so neighbouring dots never merge into a blob */
        if (rr > d.r) rr = Math.min(rr, Math.max(d.r, GAP * 0.58));
        var p = offset > 2.5 || glow > 0.5 ? hot : calm;
        p.moveTo(rx + rr, ry); p.arc(rx, ry, rr, 0, 6.2832);
      }
      ctx.fillStyle = ink; ctx.fill(calm);
      ctx.fillStyle = accent; ctx.fill(hot);
      if (introStart === Infinity) { introLeft = 1; moving = 0; }
      if (!introLeft && !doneFired) { doneFired = true; if (o.onDone && !doneCalled) { doneCalled = true; o.onDone(); } }
      var inside = o.interactive && lx > -LENS && lx < W + LENS && ly > -LENS && ly < H + LENS;
      /* keep drawing while dots move, ripples run or the pointer is near; otherwise sleep */
      if (visible && (moving || nr || (inside && (speed > 0.5 || now - lastMove < 2500)))) raf = requestAnimationFrame(step);
      else {
        running = false;
        if (o.loop && visible && doneFired) { clearTimeout(sleepT); sleepT = setTimeout(kick, Math.max(120, Math.min(nextAuto - now, idle ? 1e9 : 1900))); }
      }
    }
    function kick() { if (alive && !running) { running = true; raf = requestAnimationFrame(step); } }

    if (o.interactive) {
      on(window, 'pointermove', function (e) {
        if (lmx !== null) speed += Math.hypot(e.clientX - lmx, e.clientY - lmy);
        lmx = mx = e.clientX; lmy = my = e.clientY; lastMove = performance.now();
        var cr = canvas.getBoundingClientRect();
        if (cr.bottom > 0 && cr.top < window.innerHeight) kick();
      }, { passive: true });
      on(document, 'pointerleave', function () { mx = my = -9999; lmx = lmy = null; });
    }
    if (o.ripples) {
      on(window, 'pointerdown', function (e) {
        var r = canvas.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) ripple(e.clientX - r.left, e.clientY - r.top);
      });
    }
    if ('IntersectionObserver' in window) {
      /* pause when off screen; optionally hold the intro until the canvas is seen */
      var io = new IntersectionObserver(function (en) {
        visible = en[0].isIntersecting;
        if (visible && !seen && en[0].intersectionRatio >= 0.35) {
          seen = true;
          if (introStart === Infinity) introStart = performance.now() + o.hold;
        }
        if (visible) kick();
      }, { threshold: [0, 0.35] });
      io.observe(canvas); observers.push(io);
    } else seen = true;
    on(document, 'visibilitychange', function () { visible = !document.hidden; if (visible) kick(); });
    if (o.autoResize && 'ResizeObserver' in window) {
      var lastW = 0, lastH = 0, rt = 0;
      var ro = new ResizeObserver(function (en) {
        var cr = en[0].contentRect;
        if (Math.round(cr.width) === lastW && Math.round(cr.height) === lastH) return;
        var first = !lastW; lastW = Math.round(cr.width); lastH = Math.round(cr.height);
        if (!first) { clearTimeout(rt); rt = setTimeout(build, 150); }
      });
      ro.observe(canvas); observers.push(ro);
    }

    function load(src) {
      if (src && typeof src !== 'string') { img = src; setTimeout(build, 0); return; }
      var im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = function () { img = im; build(); };
      im.onerror = function () { if (o.onError) o.onError(); };
      im.src = src;
    }
    load(o.source || o.src);

    return {
      /** Play the sand-pile intro again. */
      replay: function () { dots = []; o.intro = true; doneCalled = false; build(); },
      /** Swap the image (URL, <img>, <canvas> or ImageBitmap). Plays the intro if `intro` is on. */
      setImage: function (src) { dots = []; doneCalled = false; load(src); },
      /** Change options live, e.g. set({ on: 'dark', color: '#fff', gap: 8 }). */
      set: function (next) {
        var rebuild = false;
        for (var key in next) { if (key === 'gap' || key === 'flat' || key === 'fit' || key === 'skipBackground' || key === 'posX' || key === 'posY') rebuild = true; o[key] = next[key]; }
        readColors();
        if (rebuild) build(); else { for (var i = 0; i < dots.length; i++) dots[i].r = radius(dots[i].l); kick(); }
      },
      /** Redraw at the current size (normally automatic). */
      rebuild: build,
      /** Stop drawing and remove every listener and observer. */
      destroy: function () {
        alive = false; cancelAnimationFrame(raf); clearTimeout(sleepT);
        listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
        observers.forEach(function (ob) { ob.disconnect(); });
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
  }

  /**
   * Draw text into a canvas you can pass as `source`, for sand wordmarks and logos.
   * Pair it with `flat` (for example 0.42) so every letter gets even dots.
   * SandPortrait.text('saiful.', { font: '800 160px "Bricolage Grotesque"', width: 600, height: 220 })
   */
  SandPortrait.text = function (text, opts) {
    opts = opts || {};
    var c = document.createElement('canvas'), x = c.getContext('2d');
    x.font = opts.font || '800 120px sans-serif';
    var m = x.measureText(text), size = parseFloat((/(\d+(?:\.\d+)?)px/.exec(x.font) || [])[1]) || 120;
    var asc = m.actualBoundingBoxAscent || size * 0.8, desc = m.actualBoundingBoxDescent || 0;
    var pad = opts.padding != null ? opts.padding : size * 0.12;
    c.width = Math.ceil(opts.width || m.width + pad * 2);
    c.height = Math.ceil(opts.height || asc + desc + pad * 2);
    x.font = opts.font || '800 120px sans-serif';
    if (opts.letterSpacing && 'letterSpacing' in x) x.letterSpacing = opts.letterSpacing;
    x.fillStyle = '#000';
    x.textBaseline = 'alphabetic';
    x.fillText(text, opts.x != null ? opts.x : (c.width - m.width) / 2, opts.y != null ? opts.y : (c.height + asc - desc) / 2);
    return c;
  };

  SandPortrait.version = '1.0.0';
  return SandPortrait;
})();
export default SandPortrait;
export { SandPortrait };

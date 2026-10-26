/* ==========================================================================
   WhiteNoise · 背景场景
   三种内置环境音各有一套 canvas 动画：白噪音漂浮颗粒、雨丝、海浪。
   自定义音频使用实时频谱画跳动的像素方块，带峰值回落。
   跟随播放状态和音量变化；切声音时交叉淡化。
   页面隐藏时暂停绘制，prefers-reduced-motion 时只画静态一帧。
   ========================================================================== */

(function (global) {
  'use strict';

  var VALID = { white: true, rain: true, ocean: true, custom: true };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function create(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;

    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var width = 0;
    var height = 0;
    var dpr = 1;
    var scene = 'white';
    var previous = null;
    var mix = 1;
    var mixStart = 0;
    var playing = false;
    var volume = 50;
    var energy = 0.2;
    var time = 0;
    var raf = null;
    var last = 0;
    var reduced = false;
    var destroyed = false;
    var resizeTimer = null;
    var whiteDots = [];
    var rainDrops = [];
    var analyserNode = null;
    var freqBytes = null;
    var MAX_BARS = 160;
    var spectrum = new Float32Array(MAX_BARS);
    var spectrumTarget = new Float32Array(MAX_BARS);
    var spectrumTemp = new Float32Array(MAX_BARS);
    var peaks = new Float32Array(MAX_BARS);
    var pulseLevel = 0;
    var motionQuery = null;
    var BAR_STEPS = 32;
    var barPalette = [];

    for (var paletteIndex = 0; paletteIndex < BAR_STEPS; paletteIndex++) {
      var paletteT = paletteIndex / (BAR_STEPS - 1);
      var paletteR = Math.round(22 + (150 - 22) * paletteT);
      var paletteG = Math.round(66 + (226 - 66) * paletteT);
      var paletteB = Math.round(86 + (238 - 86) * paletteT);
      barPalette.push('rgb(' + paletteR + ',' + paletteG + ',' + paletteB + ')');
    }

    try {
      motionQuery = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
    } catch (err) {
      motionQuery = null;
    }
    reduced = !!(motionQuery && motionQuery.matches);

    function random(min, max) {
      return min + Math.random() * (max - min);
    }

    function buildWhite() {
      var area = (global.innerWidth || 375) * (global.innerHeight || 812);
      var count = Math.round(clamp(area / 3800, 60, 150));
      var dots = [];
      for (var i = 0; i < count; i++) {
        dots.push({
          x: Math.random(),
          y: Math.random(),
          r: random(1, 3),
          vx: random(-0.006, 0.006),
          vy: random(-0.028, -0.008),
          a: random(0.22, 0.62),
          phase: Math.random() * Math.PI * 2
        });
      }
      return dots;
    }

    function buildRain() {
      var area = (global.innerWidth || 375) * (global.innerHeight || 812);
      var count = Math.round(clamp(area / 1900, 90, 210));
      var drops = [];
      for (var i = 0; i < count; i++) {
        drops.push({
          x: Math.random() * 1.12,
          y: Math.random(),
          len: random(10, 30),
          speed: random(0.55, 1.15),
          w: random(0.8, 1.8),
          a: random(0.18, 0.5)
        });
      }
      return drops;
    }

    function drawWhite(alpha, dt, t) {
      var speed = 0.25 + 0.75 * energy;
      var shade = 0.45 + 0.55 * energy;

      ctx.fillStyle = '#c8f2ff';
      for (var i = 0; i < whiteDots.length; i++) {
        var p = whiteDots[i];
        p.x += p.vx * dt * speed;
        p.y += p.vy * dt * speed;

        if (p.y < -0.04) {
          p.y = 1.04;
          p.x = Math.random();
        }
        if (p.x < -0.04) p.x = 1.04;
        if (p.x > 1.04) p.x = -0.04;

        var px = p.x * width + Math.sin(t * 0.45 + p.phase) * 2.5;
        var py = p.y * height + Math.cos(t * 0.32 + p.phase) * 2;

        if (p.r > 1.7) {
          ctx.globalAlpha = p.a * alpha * shade * 0.16;
          ctx.beginPath();
          ctx.arc(px, py, p.r * 4.2, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.globalAlpha = p.a * alpha * shade;
        ctx.beginPath();
        ctx.arc(px, py, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function drawRain(alpha, dt) {
      var speed = 0.3 + 0.7 * energy;
      var shade = 0.4 + 0.6 * energy;

      ctx.strokeStyle = '#b9ecff';
      ctx.lineCap = 'round';

      for (var i = 0; i < rainDrops.length; i++) {
        var d = rainDrops[i];
        d.y += d.speed * dt * speed;
        d.x += d.speed * dt * speed * 0.16;

        if (d.y > 1.08) {
          d.y = -0.08;
          d.x = Math.random() * 1.12;
        }
        if (d.x > 1.14) d.x -= 1.28;

        var len = d.len * (0.75 + 0.35 * energy);
        var px = d.x * width;
        var py = d.y * height;

        ctx.globalAlpha = d.a * alpha * shade;
        ctx.lineWidth = d.w;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - len * 0.18, py - len);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    function drawOcean(alpha, dt) {
      var ampScale = 0.55 + 0.45 * energy;
      var layers = [
        { base: 0.58, amp: 0.026, freq: 0.012, speed: 0.55, phase: 0.0, top: '90,190,235', bottom: '20,70,130', a: 0.16 },
        { base: 0.68, amp: 0.032, freq: 0.009, speed: 0.42, phase: 1.7, top: '80,180,230', bottom: '16,58,110', a: 0.19 },
        { base: 0.79, amp: 0.038, freq: 0.007, speed: 0.33, phase: 3.1, top: '70,170,220', bottom: '12,45,90', a: 0.22 },
        { base: 0.9, amp: 0.044, freq: 0.0055, speed: 0.26, phase: 4.4, top: '60,155,205', bottom: '8,35,70', a: 0.26 }
      ];

      for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        var baseY = height * layer.base;
        var amp = height * layer.amp * ampScale;

        ctx.beginPath();
        ctx.moveTo(0, height);
        for (var x = 0; x <= width + 10; x += 10) {
          var y = baseY +
            Math.sin(x * layer.freq + time * layer.speed + layer.phase) * amp +
            Math.sin(x * layer.freq * 2.3 - time * layer.speed * 0.7 + layer.phase) * amp * 0.35;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(width, height);
        ctx.closePath();

        var grad = ctx.createLinearGradient(0, baseY - amp, 0, height);
        grad.addColorStop(0, 'rgba(' + layer.top + ',' + layer.a * alpha + ')');
        grad.addColorStop(1, 'rgba(' + layer.bottom + ',0)');
        ctx.fillStyle = grad;
        ctx.fill();
      }
    }

    function softKnee(value) {
      var threshold = 0.55;
      var ceiling = 0.9;
      if (value <= threshold) return value;
      var t = (value - threshold) / (1 - threshold);
      return threshold + (ceiling - threshold) * t / (1 + 0.8 * t);
    }

    function drawCustom(alpha, dt) {
      var barCount = Math.round(clamp(width / 6, 32, MAX_BARS));
      var gapX = width >= 768 ? 3 : 2;
      var barWidth = (width - gapX * (barCount - 1)) / barCount;
      var blockH = clamp(Math.round(barWidth), 3, 6);
      var gapY = 1;
      var maxBlocks = Math.max(16, Math.floor((height * 0.94) / (blockH + gapY)));
      var maxHeightBlocks = Math.max(1, maxBlocks - 2);
      var baseY = height * 0.99;
      var level = 0;

      if (analyserNode && freqBytes) {
        analyserNode.getByteFrequencyData(freqBytes);

        var bins = freqBytes.length;
        var nyquist = (analyserNode.context && analyserNode.context.sampleRate)
          ? analyserNode.context.sampleRate / 2
          : 22050;
        var fMin = 35;
        var fMax = 12000;
        var logRange = Math.log(fMax / fMin);

        for (var i = 0; i < barCount; i++) {
          var t0 = i / barCount;
          var t1 = (i + 1) / barCount;
          var f0 = fMin * Math.exp(logRange * t0);
          var f1 = fMin * Math.exp(logRange * t1);
          var a = Math.floor((f0 / nyquist) * (bins - 1));
          var b = Math.ceil((f1 / nyquist) * (bins - 1));
          if (a < 1) a = 1;
          if (b <= a) b = a + 1;
          if (b > bins) b = bins;

          var peak = 0;
          for (var j = a; j < b; j++) {
            if (freqBytes[j] > peak) peak = freqBytes[j];
          }

          var value = Math.min(1, (peak / 255) * 1.1);
          var tilt = 1 + 0.5 * t0;
          spectrumTarget[i] = softKnee(Math.min(1, value * tilt));
        }

        // 很轻的相邻平滑，保留每根柱子的独立跳动
        for (var m = 0; m < barCount; m++) {
          var prev = spectrumTarget[m > 0 ? m - 1 : 0];
          var next = spectrumTarget[m < barCount - 1 ? m + 1 : barCount - 1];
          spectrumTemp[m] = spectrumTarget[m] * 0.7 + (prev + next) * 0.15;
        }
        for (var m2 = 0; m2 < barCount; m2++) spectrumTarget[m2] = spectrumTemp[m2];

        for (var k = 0; k < barCount; k++) {
          var target = spectrumTarget[k];
          var rate = target > spectrum[k] ? Math.min(1, dt * 16) : Math.min(1, dt * 6);
          spectrum[k] += (target - spectrum[k]) * rate;
        }

        for (var q = 0; q < barCount; q++) {
          var blocks = Math.min(maxHeightBlocks, Math.round(spectrum[q] * maxBlocks));
          if (blocks > peaks[q]) peaks[q] = blocks;
          else peaks[q] = Math.max(0, peaks[q] - dt * maxBlocks * 0.5);
          level += blocks;
        }
        level = level / Math.max(1, barCount * maxBlocks);
        pulseLevel += (level - pulseLevel) * Math.min(1, dt * 4);
      } else {
        for (var z = 0; z < barCount; z++) {
          spectrum[z] += (0 - spectrum[z]) * Math.min(1, dt * 4);
          peaks[z] = Math.max(0, peaks[z] - dt * maxBlocks * 0.5);
        }
        pulseLevel += (0 - pulseLevel) * Math.min(1, dt * 2);
      }

      // 底部很弱的光晕
      var glow = ctx.createLinearGradient(0, height * 0.7, 0, height);
      glow.addColorStop(0, 'rgba(111,230,255,0)');
      glow.addColorStop(1, 'rgba(111,230,255,' + (0.005 + pulseLevel * 0.04) * alpha + ')');
      ctx.fillStyle = glow;
      ctx.fillRect(0, height * 0.7, width, height * 0.3);

      // 基线：暂停时底部仍有一排暗方块
      var baseBlockH = Math.max(2, Math.round(blockH * 0.55));
      ctx.fillStyle = barPalette[0];
      ctx.globalAlpha = 0.06 * alpha;
      for (var b0 = 0; b0 < barCount; b0++) {
        ctx.fillRect(b0 * (barWidth + gapX), baseY - baseBlockH, barWidth, baseBlockH);
      }

      for (var bar = 0; bar < barCount; bar++) {
        var heightBlocks = Math.min(maxHeightBlocks, Math.round(spectrum[bar] * maxBlocks));
        var x = bar * (barWidth + gapX);

        for (var row = 0; row < heightBlocks; row++) {
          var y = baseY - (row + 1) * (blockH + gapY);
          if (y < 0) break;
          var ratio = row / Math.max(1, maxBlocks - 1);
          var paletteIdx = Math.min(BAR_STEPS - 1, Math.floor(ratio * BAR_STEPS));
          ctx.globalAlpha = (0.13 + 0.33 * ratio) * alpha;
          ctx.fillStyle = barPalette[paletteIdx];
          ctx.fillRect(x, y, barWidth, blockH);
        }

        var peak = Math.min(maxHeightBlocks, Math.round(peaks[bar]));
        if (peak > heightBlocks) {
          var peakY = baseY - peak * (blockH + gapY);
          if (peakY >= 0) {
            ctx.globalAlpha = 0.22 * alpha;
            ctx.fillStyle = '#d5f5fa';
            ctx.fillRect(x, peakY, barWidth, Math.max(1.5, blockH * 0.45));
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    function drawScene(name, alpha, dt) {
      if (name === 'rain') {
        drawRain(alpha, dt);
      } else if (name === 'ocean') {
        drawOcean(alpha, dt);
      } else if (name === 'custom') {
        drawCustom(alpha, dt);
      } else {
        drawWhite(alpha, dt, time);
      }
    }

    function frame(now) {
      if (destroyed) return;
      if (!last) last = now;

      var dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;

      time += dt * (0.35 + 0.65 * energy);

      var target = (playing ? 1 : 0.3) * (0.4 + 0.6 * volume / 100);
      energy += (target - energy) * Math.min(1, dt * 3.5);

      ctx.clearRect(0, 0, width, height);

      if (previous) {
        mix = Math.min(1, (now - mixStart) / 650);
        drawScene(previous, 1 - mix, dt);
        if (mix >= 1) previous = null;
      }
      drawScene(scene, previous ? mix : 1, dt);

      raf = global.requestAnimationFrame(frame);
    }

    function drawStatic() {
      if (!width || !height) return;
      ctx.clearRect(0, 0, width, height);
      energy = (playing ? 0.7 : 0.25) * (0.5 + 0.5 * volume / 100);
      previous = null;
      mix = 1;
      drawScene(scene, 1, 0);
    }

    function start() {
      if (destroyed || reduced || document.hidden || raf !== null) return;
      last = 0;
      raf = global.requestAnimationFrame(frame);
    }

    function stop() {
      if (raf !== null) {
        global.cancelAnimationFrame(raf);
        raf = null;
      }
    }

    function resize() {
      width = global.innerWidth;
      height = global.innerHeight;
      dpr = Math.min(2, global.devicePixelRatio || 1);

      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (reduced) drawStatic();
      else start();
    }

    var onVisibility = function () {
      if (document.hidden) stop();
      else start();
    };

    var onResize = function () {
      if (resizeTimer) global.clearTimeout(resizeTimer);
      resizeTimer = global.setTimeout(resize, 150);
    };

    var onMotionChange = function (event) {
      reduced = event.matches;
      if (reduced) {
        stop();
        drawStatic();
      } else {
        start();
      }
    };

    whiteDots = buildWhite();
    rainDrops = buildRain();
    resize();

    document.addEventListener('visibilitychange', onVisibility);
    global.addEventListener('resize', onResize);
    global.addEventListener('orientationchange', onResize);

    if (motionQuery) {
      if (motionQuery.addEventListener) motionQuery.addEventListener('change', onMotionChange);
      else if (motionQuery.addListener) motionQuery.addListener(onMotionChange);
    }

    return {
      setScene: function (id) {
        if (!VALID[id] || id === scene) return;
        if (reduced) {
          scene = id;
          drawStatic();
          return;
        }
        previous = scene;
        scene = id;
        mix = 0;
        mixStart = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
        start();
      },

      setPlaying: function (value) {
        playing = !!value;
        if (reduced) drawStatic();
        else start();
      },

      setVolume: function (value) {
        volume = clamp(Number(value) || 0, 0, 100);
        if (reduced) drawStatic();
      },

      setAnalyser: function (node) {
        analyserNode = node || null;
        if (analyserNode) {
          freqBytes = new Uint8Array(analyserNode.frequencyBinCount);
        } else {
          freqBytes = null;
        }
        spectrum.fill(0);
        spectrumTarget.fill(0);
        peaks.fill(0);
        pulseLevel = 0;
      },

      destroy: function () {
        destroyed = true;
        stop();
        analyserNode = null;
        freqBytes = null;
        document.removeEventListener('visibilitychange', onVisibility);
        global.removeEventListener('resize', onResize);
        global.removeEventListener('orientationchange', onResize);
        if (motionQuery) {
          if (motionQuery.removeEventListener) motionQuery.removeEventListener('change', onMotionChange);
          else if (motionQuery.removeListener) motionQuery.removeListener(onMotionChange);
        }
        if (resizeTimer) global.clearTimeout(resizeTimer);
        if (width && height) ctx.clearRect(0, 0, width, height);
      }
    };
  }

  global.WhiteNoiseScene = { create: create };
})(window);

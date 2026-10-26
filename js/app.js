/* ==========================================================================
   WhiteNoise V1.2 · 页面交互
   V1.0：播放暂停、音量、定时关闭
   V1.1：动态背景、结束前淡出、锁屏媒体控制、记住上次声音与音量
   V1.2：本地音频上传、独立 Web Audio 分析与实时波纹
   ========================================================================== */

(function () {
  'use strict';

  var SOUNDS = [
    { id: 'white', name: '白噪音', file: 'audio/white.wav' },
    { id: 'rain', name: '雨声', file: 'audio/rain.wav' },
    { id: 'ocean', name: '海浪声', file: 'audio/ocean.wav' },
    { id: 'custom', name: '自定义', file: '' }
  ];

  var TIMER_PRESETS = [15, 30, 60];
  var STORAGE_KEY = 'whitenoise:v1';
  var FADE_SECONDS = 30;
  var MAX_CUSTOM_BYTES = 10 * 1024 * 1024;

  // 内置声音用一个 audio 元素；自定义音频单独一个元素，只把这一路接进 Web Audio
  var mainAudio = null;
  var customAudio = null;
  var audioEl = null;
  var tickId = null;
  var fadeId = null;
  var fadeFactor = 1;
  var timerEndAt = 0;
  var scene = null;
  var saveTimer = null;
  var artworkUrl = null;
  var customUrl = null;
  var audioCtx = null;
  var sourceNode = null;
  var gainNode = null;
  var analyserNode = null;
  var audioGraphFailed = false;
  var visibilityHandler = null;

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function findSound(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return list[0];
  }

  function isValidSound(id) {
    for (var i = 0; i < SOUNDS.length; i++) {
      if (SOUNDS[i].id === id) return true;
    }
    return false;
  }

  function clampVolumeValue(value) {
    var num = Number(value);
    if (!isFinite(num)) return 0;
    return Math.min(100, Math.max(0, Math.round(num)));
  }

  function stripExtension(name) {
    if (!name) return '';
    return name.replace(/\.[^.]+$/, '');
  }

  function loadPrefs() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    } catch (err) {
      return {};
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // 锁屏封面：运行时画一张 512×512 PNG，不需要额外图片资源
  function getArtwork() {
    if (artworkUrl !== null) return artworkUrl || null;
    try {
      var size = 512;
      var canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      var ctx = canvas.getContext('2d');

      var bg = ctx.createLinearGradient(0, 0, size, size);
      bg.addColorStop(0, '#0b1322');
      bg.addColorStop(1, '#132844');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, size, size);

      var bars = [0.2, 0.36, 0.56, 0.36, 0.2];
      var barWidth = 34;
      var gap = 22;
      var total = bars.length * barWidth + (bars.length - 1) * gap;
      var startX = (size - total) / 2;
      var mid = size / 2;

      for (var i = 0; i < bars.length; i++) {
        var h = bars[i] * size * 0.9;
        var x = startX + i * (barWidth + gap);
        var y = mid - h / 2;
        var grad = ctx.createLinearGradient(0, y, 0, y + h);
        grad.addColorStop(0, '#8ff0ff');
        grad.addColorStop(1, '#9ea9ff');
        ctx.fillStyle = grad;
        roundRect(ctx, x, y, barWidth, h, barWidth / 2);
        ctx.fill();
      }

      artworkUrl = canvas.toDataURL('image/png');
    } catch (err) {
      artworkUrl = '';
    }
    return artworkUrl || null;
  }

  var initialPrefs = loadPrefs();
  var initialVolume = 50;
  if (initialPrefs.volume !== undefined && initialPrefs.volume !== null) {
    var savedVolume = Number(initialPrefs.volume);
    if (isFinite(savedVolume)) initialVolume = clampVolumeValue(savedVolume);
  }
  var initialSound = (initialPrefs.sound !== 'custom' && isValidSound(initialPrefs.sound))
    ? initialPrefs.sound
    : 'white';

  var app = Vue.createApp({
    data: function () {
      return {
        isPlaying: false,
        currentSound: initialSound,
        volume: initialVolume,
        timer: 0,
        timerPreset: 0,
        timerRunning: false,
        audioStarted: false,
        customReady: false,
        customName: '',
        customFileName: '',
        sounds: SOUNDS,
        presets: TIMER_PRESETS,
        errorMsg: ''
      };
    },

    computed: {
      currentSoundMeta: function () {
        if (this.currentSound === 'custom') {
          return {
            id: 'custom',
            name: this.customName || '自定义',
            file: customUrl || ''
          };
        }
        return findSound(this.sounds, this.currentSound);
      },
      formattedTimer: function () {
        var total = Math.max(0, Math.floor(Number(this.timer) || 0));
        return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
      }
    },

    watch: {
      currentSound: function (id) {
        if (scene) scene.setScene(id);
        this.syncVisualClass();
        this.updateMediaMetadata();
      },
      isPlaying: function (playing) {
        if (scene) scene.setPlaying(playing);
        this.syncMediaPlaybackState();
        if (playing) this.syncFade();
        else this.stopFade();
      },
      volume: function (value) {
        if (scene) scene.setVolume(value);
      }
    },

    mounted: function () {
      mainAudio = this.$refs.audio;
      customAudio = this.$refs.customAudio;
      audioEl = mainAudio;
      if (!mainAudio) return;

      this.applyOutputVolume();
      mainAudio.addEventListener('error', this.onAudioError);
      if (customAudio) customAudio.addEventListener('error', this.onAudioError);
      this.loadSound(this.currentSound);

      visibilityHandler = this.onVisibilityChange.bind(this);
      document.addEventListener('visibilitychange', visibilityHandler);

      if (window.WhiteNoiseScene) {
        try {
          scene = window.WhiteNoiseScene.create(document.querySelector('.bg-canvas'));
        } catch (err) {
          scene = null;
        }
        if (scene) {
          scene.setScene(this.currentSound);
          scene.setPlaying(this.isPlaying);
          scene.setVolume(this.clampVolume(this.volume));
        }
      }

      this.syncVisualClass();
      this.setupMediaSession();
    },

    beforeUnmount: function () {
      this.clearTick();
      this.stopFade();
      this.savePrefs(true);

      if (mainAudio) {
        mainAudio.removeEventListener('error', this.onAudioError);
        mainAudio.pause();
        mainAudio.removeAttribute('src');
        mainAudio.load();
      }
      if (customAudio) {
        customAudio.removeEventListener('error', this.onAudioError);
        customAudio.pause();
        customAudio.removeAttribute('src');
        customAudio.load();
      }
      mainAudio = null;
      customAudio = null;
      audioEl = null;

      if (visibilityHandler) {
        document.removeEventListener('visibilitychange', visibilityHandler);
        visibilityHandler = null;
      }

      if (audioCtx) {
        try {
          audioCtx.close();
        } catch (err) {
          /* 忽略 */
        }
        audioCtx = null;
      }
      sourceNode = null;
      gainNode = null;
      analyserNode = null;

      if (customUrl) {
        window.URL.revokeObjectURL(customUrl);
        customUrl = null;
      }

      if (scene) {
        scene.destroy();
        scene = null;
      }

      this.teardownMediaSession();
    },

    methods: {
      clampVolume: function (value) {
        return clampVolumeValue(value);
      },

      /* ------------------------------ 音频 ------------------------------ */

      applyOutputVolume: function () {
        var level = (this.clampVolume(this.volume) / 100) * fadeFactor;

        if (mainAudio) mainAudio.volume = level;

        if (customAudio) {
          if (gainNode && audioCtx) {
            customAudio.volume = 1;
            try {
              gainNode.gain.setTargetAtTime(level, audioCtx.currentTime, 0.04);
            } catch (err) {
              gainNode.gain.value = level;
            }
          } else {
            customAudio.volume = level;
          }
        }
      },

      loadSound: function (id) {
        if (id === 'custom') {
          if (!customAudio || !customUrl) return;
          audioEl = customAudio;
          customAudio.src = customUrl;
        } else {
          if (!mainAudio) return;
          audioEl = mainAudio;
          mainAudio.src = findSound(this.sounds, id).file;
        }

        this.applyOutputVolume();
      },

      ensureAudioGraph: function () {
        if (!customAudio || audioGraphFailed) return;

        if (audioCtx) {
          if (audioCtx.state !== 'running') {
            audioCtx.resume().catch(function () {});
          }
          return;
        }

        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) {
          audioGraphFailed = true;
          return;
        }

        try {
          audioCtx = new Ctx();
          sourceNode = audioCtx.createMediaElementSource(customAudio);
          gainNode = audioCtx.createGain();
          analyserNode = audioCtx.createAnalyser();
          analyserNode.fftSize = 2048;
          analyserNode.smoothingTimeConstant = 0.8;

          var level = (this.clampVolume(this.volume) / 100) * fadeFactor;
          gainNode.gain.value = level;
          customAudio.volume = 1;

          sourceNode.connect(gainNode);
          gainNode.connect(analyserNode);
          analyserNode.connect(audioCtx.destination);

          if (scene) scene.setAnalyser(analyserNode);

          if (audioCtx.state !== 'running') {
            audioCtx.resume().catch(function () {});
          }
        } catch (err) {
          audioGraphFailed = true;
          try {
            if (sourceNode && audioCtx) sourceNode.connect(audioCtx.destination);
          } catch (fallbackErr) {
            /* 忽略 */
          }
          gainNode = null;
          analyserNode = null;
          this.applyOutputVolume();
        }
      },

      onVisibilityChange: function () {
        if (!document.hidden && audioCtx && audioCtx.state !== 'running' && this.isPlaying) {
          audioCtx.resume().catch(function () {});
        }
      },

      syncVisualClass: function () {
        var root = document.getElementById('app');
        if (root) root.classList.toggle('visualizing', this.currentSound === 'custom');
      },

      togglePlay: function () {
        if (this.isPlaying) {
          this.pause();
        } else {
          this.play();
        }
      },

      play: function () {
        if (this.isPlaying || !audioEl) return;

        this.errorMsg = '';
        if (this.currentSound === 'custom') this.ensureAudioGraph();
        if (audioCtx && audioCtx.state !== 'running') {
          audioCtx.resume().catch(function () {});
        }

        // 先乐观置为播放中：连续点击时不会重复触发 play()；
        // 若浏览器拒绝播放，再在回调里复位。
        this.isPlaying = true;
        this.syncFade();

        var self = this;
        var result;
        try {
          result = audioEl.play();
        } catch (err) {
          this.onPlayFailure(err);
          return;
        }

        if (result && typeof result.then === 'function') {
          result.then(
            function () { self.onPlayStarted(); },
            function (err) { self.onPlayFailure(err); }
          );
        } else {
          this.onPlayStarted();
        }
      },

      onPlayStarted: function () {
        if (!this.isPlaying) return;

        this.audioStarted = true;

        // 暂停时选好的档位，等真正开始播放后再启动倒计时
        if (this.timerPreset > 0 && this.timer > 0 && !this.timerRunning) {
          this.beginCountdown();
        } else {
          this.syncFade();
        }
      },

      pause: function () {
        if (mainAudio) mainAudio.pause();
        if (customAudio) customAudio.pause();
        this.isPlaying = false;
        this.audioStarted = false;
        // 需求文档约定：暂停时同时清除计时，重播需重新选择档位
        this.clearTimer();
        this.stopFade();
      },

      onPlayFailure: function (err) {
        this.isPlaying = false;
        this.audioStarted = false;
        this.stopFade();
        if (!err) return;

        // 暂停操作会打断 play()，属于正常流程，不提示
        if (err.name === 'AbortError') return;

        if (err.name === 'NotAllowedError') {
          this.errorMsg = '浏览器拦截了这次播放，请再点一次「播放」。';
          return;
        }
        if (err.name === 'NotSupportedError') {
          this.errorMsg = '当前浏览器不支持该音频格式，请更换浏览器试试。';
          if (this.currentSound === 'custom') {
            this.showAudioErrorDialog('这个音频文件无法解析，或浏览器不支持它的格式。换一个文件试试。');
          }
          return;
        }
        this.errorMsg = '音频播放失败，请检查 audio/ 目录下的音频文件后刷新页面。';
      },

      showAudioErrorDialog: function (message) {
        var dialog = document.getElementById('audio-error-dialog');
        var text = document.getElementById('audio-error-message');
        if (text) text.textContent = message;

        if (!dialog) {
          window.alert(message);
          return;
        }

        if (typeof dialog.showModal === 'function') {
          try {
            if (!dialog.open) dialog.showModal();
            return;
          } catch (err) {
            /* 浏览器拒绝 showModal 时退回原生弹窗 */
          }
        }

        window.alert(message);
      },

      onAudioError: function (event) {
        var target = event ? event.currentTarget : null;
        if (target === mainAudio && this.currentSound === 'custom') return;
        if (target === customAudio && this.currentSound !== 'custom') return;

        this.isPlaying = false;
        this.audioStarted = false;
        this.stopFade();

        if (this.currentSound === 'custom') {
          this.errorMsg = '自定义音频加载失败，换一个文件试试。';
          this.showAudioErrorDialog('这个音频文件无法解析，或浏览器不支持它的格式。换一个文件试试。');
          return;
        }

        var name = this.currentSoundMeta ? this.currentSoundMeta.name : '当前声音';
        this.errorMsg = '「' + name + '」加载失败，请确认 audio/' + this.currentSound + '.wav 存在。';
      },

      /* ------------------------------ 音量 ------------------------------ */

      onVolumeInput: function (event) {
        // range 的 value 默认是字符串，先转数值再参与换算（BUG-01）
        this.volume = this.clampVolume(event.target.value);
        this.applyOutputVolume();
        this.savePrefs();
      },

      /* ------------------------------ 声音 ------------------------------ */

      selectSound: function (id) {
        if (id === 'custom' && !this.customReady) return;
        if (id === this.currentSound) return;

        // 需求文档约定：切换声音时先停止、再换源，并复位按钮状态
        if (mainAudio) mainAudio.pause();
        if (customAudio) customAudio.pause();
        this.isPlaying = false;
        this.audioStarted = false;
        this.stopFade();
        this.errorMsg = '';

        this.currentSound = id;
        this.loadSound(id);
        this.savePrefs(true);

        // 倒计时不因切换声音而中断或重置（第 4 周验收项）
      },

      /* ---------------------------- 自定义音频 --------------------------- */

      pickFile: function () {
        var input = this.$refs.fileInput;
        if (!input) return;
        input.value = '';
        input.click();
      },

      onFileChange: function (event) {
        var input = event.target;
        var file = input.files && input.files[0];
        input.value = '';
        if (file) this.handleCustomFile(file);
      },

      handleCustomFile: function (file) {
        if (!file) return;

        if (file.size <= 0) {
          this.errorMsg = '文件为空，请重新选择。';
          return;
        }
        if (file.size >= MAX_CUSTOM_BYTES) {
          this.errorMsg = '音频文件需要小于 10MB。';
          return;
        }

        var type = (file.type || '').toLowerCase();
        var name = (file.name || '').toLowerCase();
        if (type.indexOf('audio/') !== 0 && !/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/.test(name)) {
          this.errorMsg = '请选择音频文件（mp3、wav、m4a、ogg 等）。';
          return;
        }
        if (!window.URL || typeof window.URL.createObjectURL !== 'function') {
          this.errorMsg = '当前浏览器不支持本地音频上传。';
          return;
        }

        var url;
        try {
          url = window.URL.createObjectURL(file);
        } catch (err) {
          this.errorMsg = '读取文件失败，请重试。';
          return;
        }

        var oldUrl = customUrl;
        customUrl = url;
        this.customReady = true;
        this.customFileName = file.name || '自定义音频';
        this.customName = stripExtension(file.name) || '自定义';
        this.errorMsg = '';

        if (mainAudio) mainAudio.pause();
        if (customAudio) customAudio.pause();
        this.isPlaying = false;
        this.audioStarted = false;
        this.stopFade();

        if (this.currentSound === 'custom') {
          this.loadSound('custom');
          this.updateMediaMetadata();
          this.syncMediaPlaybackState();
          this.savePrefs(true);
        } else {
          this.selectSound('custom');
        }

        if (oldUrl) window.URL.revokeObjectURL(oldUrl);
      },

      /* ------------------------------ 定时 ------------------------------ */

      startTimer: function (minutes) {
        // 再次点击当前档位 → 取消定时
        if (this.timerPreset === minutes && this.timer > 0) {
          this.clearTimer();
          return;
        }

        this.clearTimer();
        this.timerPreset = minutes;
        this.timer = minutes * 60;
        this.timerRunning = false;

        // 播放中选档位立即开始；暂停时只预设定时，等播放后再启动
        if (this.audioStarted) this.beginCountdown();
      },

      beginCountdown: function () {
        if (this.timer <= 0 || tickId !== null) return;

        timerEndAt = Date.now() + this.timer * 1000;
        this.timerRunning = true;

        var self = this;
        tickId = window.setInterval(function () {
          self.tick();
        }, 1000);
        this.syncFade();
      },

      tick: function () {
        if (this.timer <= 0) return;

        this.timer -= 1;
        if (this.timer <= 0) {
          this.finishTimer();
        } else {
          this.syncFade();
        }
      },

      finishTimer: function () {
        this.clearTick();
        if (mainAudio) mainAudio.pause();
        if (customAudio) customAudio.pause();
        // 停止播放、复位按钮、清零计时、取消档位选中，在同一处完成
        this.isPlaying = false;
        this.audioStarted = false;
        this.stopFade();
        this.timer = 0;
        this.timerPreset = 0;
        this.timerRunning = false;
        timerEndAt = 0;
      },

      clearTick: function () {
        if (tickId !== null) {
          window.clearInterval(tickId);
          tickId = null;
        }
      },

      clearTimer: function () {
        this.clearTick();
        this.timer = 0;
        this.timerPreset = 0;
        this.timerRunning = false;
        timerEndAt = 0;
        this.stopFade();
      },

      /* --------------------------- 结束前淡出 --------------------------- */

      startFade: function () {
        if (fadeId !== null) return;
        var self = this;
        fadeId = window.setInterval(function () {
          var remaining = (timerEndAt - Date.now()) / 1000;
          fadeFactor = remaining >= FADE_SECONDS ? 1 : Math.max(0, remaining / FADE_SECONDS);
          self.applyOutputVolume();
        }, 100);
      },

      stopFade: function () {
        if (fadeId !== null) {
          window.clearInterval(fadeId);
          fadeId = null;
        }
        fadeFactor = 1;
        this.applyOutputVolume();
      },

      syncFade: function () {
        if (!this.audioStarted || this.timer <= 0 || !timerEndAt) {
          this.stopFade();
          return;
        }
        var remaining = (timerEndAt - Date.now()) / 1000;
        if (remaining <= FADE_SECONDS) this.startFade();
        else this.stopFade();
      },

      /* ---------------------------- 记忆偏好 ---------------------------- */

      savePrefs: function (immediate) {
        var self = this;
        var write = function () {
          try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
              sound: self.currentSound,
              volume: self.clampVolume(self.volume)
            }));
          } catch (err) {
            /* 隐私模式或 file:// 禁用存储时静默跳过 */
          }
        };

        if (saveTimer) {
          window.clearTimeout(saveTimer);
          saveTimer = null;
        }

        if (immediate) {
          write();
          return;
        }

        saveTimer = window.setTimeout(function () {
          saveTimer = null;
          write();
        }, 200);
      },

      /* ---------------------------- 媒体会话 ---------------------------- */

      setupMediaSession: function () {
        if (!('mediaSession' in navigator)) return;

        var self = this;
        var bind = function (action, handler) {
          try {
            navigator.mediaSession.setActionHandler(action, handler);
          } catch (err) {
            /* 浏览器不支持该动作时忽略 */
          }
        };

        bind('play', function () { self.play(); });
        bind('pause', function () { self.pause(); });
        bind('stop', function () { self.pause(); });

        this.updateMediaMetadata();
        this.syncMediaPlaybackState();
      },

      updateMediaMetadata: function () {
        if (!('mediaSession' in navigator) || typeof window.MediaMetadata !== 'function') return;

        var meta = this.currentSoundMeta;
        var artwork = getArtwork();
        var data = {
          title: meta.name,
          artist: 'WhiteNoise',
          album: '专注一下'
        };
        if (artwork) {
          data.artwork = [{ src: artwork, sizes: '512x512', type: 'image/png' }];
        }

        try {
          navigator.mediaSession.metadata = new window.MediaMetadata(data);
        } catch (err) {
          // 封面被拒绝时退回不带封面的 metadata
          try {
            navigator.mediaSession.metadata = new window.MediaMetadata({
              title: data.title,
              artist: data.artist,
              album: data.album
            });
          } catch (fallbackErr) {
            /* 忽略 */
          }
        }
      },

      syncMediaPlaybackState: function () {
        if (!('mediaSession' in navigator)) return;
        try {
          navigator.mediaSession.playbackState = this.isPlaying ? 'playing' : 'paused';
        } catch (err) {
          /* 忽略 */
        }
      },

      teardownMediaSession: function () {
        if (!('mediaSession' in navigator)) return;
        try {
          navigator.mediaSession.metadata = null;
        } catch (err) {
          /* 忽略 */
        }
        var actions = ['play', 'pause', 'stop'];
        for (var i = 0; i < actions.length; i++) {
          try {
            navigator.mediaSession.setActionHandler(actions[i], null);
          } catch (err) {
            /* 忽略 */
          }
        }
      }
    }
  });

  app.mount('#app');
})();

// smartLogger.js
// シンプルなロガー実装
// 特徴:
// - タイムスタンプ自動追加
// - 色分け（ANSI）
// - ラベル付与（任意）
// - エラー時にスタックを展開
// - context オブジェクトを簡単に出力
// - 環境(dev/prod) による出力切替
// - オプション: JSON 出力切替、ファイル出力（Node の fs を使う）

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');

// helper: simple backoff calculation
function calcBackoff(attempt, base = 500, cap = 30000) {
  const jitter = Math.random() * 100;
  const val = Math.min(cap, Math.floor(base * Math.pow(2, attempt)) + jitter);
  return val;
}

class SmartLogger {
  constructor(options = {}) {
    const {
      level = 'info',
      env = process.env.NODE_ENV || 'development',
      label = '',
      colors = true,
      json = false,
      file = null, // パスを指定するとファイルに追記
      rotation = null, // { size: bytes, maxFiles: n }
      remote = null, // { url, intervalMs, batchSize }
      remoteReliable = false, // enable disk-backed queue + backoff
      remoteQueuePath = './logs/remote-queue.jsonl',
      remoteGzip = false, // compress request body
    } = options;

    this.levels = { error: 0, warn: 1, info: 2, debug: 3 };
    this.level = this.levels[level] != null ? this.levels[level] : this.levels.info;
    this.env = env;
    this.label = label;
    this.useColors = colors;
    this.json = json;
  this.file = file ? path.resolve(file) : null;
  this.rotation = rotation;
  this.remote = remote;
  this.remoteReliable = remoteReliable;
  this.remoteQueuePath = remoteQueuePath ? path.resolve(remoteQueuePath) : null;
  this.remoteGzip = remoteGzip;

    // ANSI カラー
    this.colorMap = {
      error: '\u001b[31m', // red
      warn: '\u001b[33m', // yellow
      info: '\u001b[32m', // green
      debug: '\u001b[36m', // cyan
      reset: '\u001b[0m',
      dim: '\u001b[2m',
    };

    // ファイルストリームが必要ならオープン
    if (this.file) this._openLogStream();

    // Remote buffer and timer
    this.remoteBuffer = [];
    this.remoteTimer = null;
    if (this.remote && this.remote.url) {
      this.remoteIntervalMs = this.remote.intervalMs || 5000;
      this.remoteBatchSize = this.remote.batchSize || 10;
      this.remoteHeaders = this.remote.headers || {};
      this._startRemoteTimer();
    }

    // load persistent queue if enabled
    this._remoteFailCount = 0;
    if (this.remoteReliable && this.remoteQueuePath) {
      try {
        const dir = path.dirname(this.remoteQueuePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // ensure file exists
        if (!fs.existsSync(this.remoteQueuePath)) fs.writeFileSync(this.remoteQueuePath, '', { encoding: 'utf8' });
      } catch (e) {
        // ignore
      }
    }
  }

  _openLogStream() {
    try {
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.stream = fs.createWriteStream(this.file, { flags: 'a', encoding: 'utf8' });
    } catch (err) {
      this.stream = null;
      this._writeToConsole('warn', `failed to open log file ${this.file}: ${err.message}`);
    }
  }

  setLevel(levelStr) {
    if (this.levels[levelStr] != null) this.level = this.levels[levelStr];
  }

  _shouldLog(level) {
    if (this.env === 'production' && level === 'debug') return false; // production では debug を抑制
    return this.levels[level] <= this.level;
  }

  _timestamp() {
    return new Date().toISOString();
  }

  _format(level, message, context) {
    const ts = this._timestamp();
    const label = this.label ? `[${this.label}]` : '';

    if (this.json) {
      const payload = {
        timestamp: ts,
        level,
        label: this.label || undefined,
        message: message,
        context: context || undefined,
      };
      return JSON.stringify(payload);
    }

    const color = this.useColors ? (this.colorMap[level] || '') : '';
    const reset = this.useColors ? this.colorMap.reset : '';
    const dim = this.useColors ? this.colorMap.dim : '';

    let ctx = '';
    if (context) {
      try {
        ctx = typeof context === 'string' ? context : JSON.stringify(context, null, 2);
      } catch (e) {
        ctx = String(context);
      }
      ctx = ` ${dim}${ctx}${reset}`;
    }

    return `${color}${ts} ${level.toUpperCase()} ${label}${reset} - ${message}${ctx}`;
  }

  _writeToConsole(level, formatted) {
    if (level === 'error') console.error(formatted);
    else if (level === 'warn') console.warn(formatted);
    else console.log(formatted);
  }

  _writeToFile(formatted) {
    if (!this.stream) return;
    try {
      this.stream.write(formatted + '\n');
      // rotation check
      if (this.rotation && this.rotation.size) this._rotateIfNeeded();
    } catch (e) {
      // swallow
    }
  }

  _prepareMessage(msg, args) {
    // 第一引数が Error の場合は自動的にスタックを追加
    let message = msg;
    let context = null;
    if (msg instanceof Error) {
      message = msg.message;
      context = { stack: msg.stack };
      if (args && args.length) context.extra = args;
    } else if (args && args.length) {
      // args の最後が object なら context として扱う
      if (args.length === 1 && typeof args[0] === 'object') {
        context = args[0];
      } else {
        // 文字列テンプレート的な結合
        message = [msg].concat(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a)))).join(' ');
      }
    }

    return { message, context };
  }

  log(level, msg, ...args) {
    if (!this._shouldLog(level)) return;
    const { message, context } = this._prepareMessage(msg, args);
    const formatted = this._format(level, message, context);
    this._writeToConsole(level, formatted);
    if (this.stream) this._writeToFile(this.json ? formatted : formatted.replace(/\u001b\[[0-9;]*m/g, ''));

    // enqueue remote
    if (this.remote && this.remote.url) {
      const payload = this.json ? JSON.parse(formatted) : { timestamp: this._timestamp(), level, label: this.label || undefined, message, context };
      this._enqueueRemote(payload);
    }
  }

  info(msg, ...args) { this.log('info', msg, ...args); }
  warn(msg, ...args) { this.log('warn', msg, ...args); }
  error(msg, ...args) { this.log('error', msg, ...args); }
  debug(msg, ...args) { this.log('debug', msg, ...args); }

  child(overrides = {}) {
    const opts = Object.assign({}, {
      level: Object.keys(this.levels).find(k => this.levels[k] === this.level) || 'info',
      env: this.env,
      label: this.label,
      colors: this.useColors,
      json: this.json,
      file: this.file,
    }, overrides);
    return new SmartLogger(opts);
  }

  close() {
    if (this.stream) {
      try { this.stream.end(); } catch (e) { }
      this.stream = null;
    }
    // flush remote buffer and stop timer
    if (this.remoteTimer) {
      clearInterval(this.remoteTimer);
      this.remoteTimer = null;
    }
    if (this.remoteBuffer && this.remoteBuffer.length) {
      this._flushRemote();
    }
  }

  /* Rotation implementation (size-based) */
  _rotateIfNeeded() {
    try {
      const stats = fs.statSync(this.file);
      if (stats.size < this.rotation.size) return;

      const maxFiles = this.rotation.maxFiles || 5;
      // close current stream before renaming
      try { this.stream.end(); } catch (e) {}

      // shift existing files: file.(maxFiles-1) -> file.maxFiles, ...
      for (let i = maxFiles - 1; i >= 0; i--) {
        const src = i === 0 ? this.file : `${this.file}.${i}`;
        const dest = `${this.file}.${i + 1}`;
        if (fs.existsSync(src)) {
          try {
            // if dest exists and is the last one, remove it
            if (i + 1 > maxFiles) {
              fs.unlinkSync(dest);
            }
            fs.renameSync(src, dest);
          } catch (e) {
            // ignore rename errors
          }
        }
      }

      // reopen stream
      this._openLogStream();
    } catch (e) {
      // ignore stat errors
    }
  }

  /* Remote batching and POST */
  _startRemoteTimer() {
    if (this.remoteTimer) return;
    this.remoteTimer = setInterval(() => {
      if (this.remoteBuffer.length) this._flushRemote();
    }, this.remoteIntervalMs);
  }

  _enqueueRemote(item) {
    try {
      this.remoteBuffer.push(item);
      if (this.remoteBuffer.length >= this.remoteBatchSize) this._flushRemote();
    } catch (e) { /* swallow */ }
  }

  _flushRemote() {
    if (!this.remote || !this.remote.url) return;
    const buffer = this.remoteBuffer.splice(0, this.remoteBuffer.length);
    if (!buffer.length) return;
    let url;
    try { url = new URL(this.remote.url); } catch (e) { return; }

  let body = JSON.stringify(buffer);
  const shouldGzip = this.remoteGzip;
  const sendBody = shouldGzip ? zlib.gzipSync(body) : Buffer.from(body, 'utf8');
    const isHttps = url.protocol === 'https:';
    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(sendBody),
      }, this.remoteHeaders),
      timeout: this.remote && this.remote.timeoutMs ? this.remote.timeoutMs : 5000,
    };
    if (shouldGzip) opts.headers['Content-Encoding'] = 'gzip';

    const transport = isHttps ? https : http;
    const req = transport.request(opts, (res) => {
      // consume but ignore
      res.on('data', () => {});
      res.on('end', () => {});
    });
    const self = this;
    req.on('error', (err) => {
      // persist failed batch if reliable
      if (self.remoteReliable && self.remoteQueuePath) {
        try {
          const lines = buffer.map(b => JSON.stringify(b)).join('\n') + '\n';
          fs.appendFileSync(self.remoteQueuePath, lines, { encoding: 'utf8' });
        } catch (e) {}
      } else {
        // on error, requeue to memory
        try {
          self.remoteBuffer.unshift(...buffer);
          const cap = self.remote.maxBuffer || 1000;
          if (self.remoteBuffer.length > cap) self.remoteBuffer = self.remoteBuffer.slice(0, cap);
        } catch (e) {}
      }
      self._remoteFailCount++;
      const backoff = calcBackoff(self._remoteFailCount);
      if (self.remoteTimer) {
        clearInterval(self.remoteTimer);
        self.remoteTimer = null;
      }
      setTimeout(() => self._startRemoteTimer(), backoff);
    });
    req.on('timeout', () => { req.destroy(); });
    req.write(sendBody);
    req.end();
  }

  // try to flush persistent queue to remote (if exists)
  _flushPersistentQueue() {
    if (!this.remoteReliable || !this.remoteQueuePath) return;
    try {
      if (!fs.existsSync(this.remoteQueuePath)) return;
      const data = fs.readFileSync(this.remoteQueuePath, 'utf8');
      if (!data) return;
      // read up to batch size lines
      const lines = data.trim().split('\n');
      const take = Math.min(lines.length, this.remoteBatchSize || 10);
      const batch = lines.slice(0, take).map(l => JSON.parse(l));
      // attempt to send synchronously via _flushRemote internal mechanism
      // temporarily prepend batch to in-memory buffer and call _flushRemote
      this.remoteBuffer.unshift(...batch);
      // rewrite queue file with remaining lines
      const remaining = lines.slice(take);
      fs.writeFileSync(this.remoteQueuePath, remaining.join('\n') + (remaining.length ? '\n' : ''), 'utf8');
      // trigger immediate flush
      this._flushRemote();
    } catch (e) {
      // ignore
    }
  }

  // flush remote buffer immediately
  flushRemote() {
    return new Promise((resolve) => {
      try {
        if (this.remoteTimer) clearInterval(this.remoteTimer);
        if (this.remoteBuffer.length) this._flushRemote();
      } catch (e) {}
      // small delay to allow requests to complete
      setTimeout(() => {
        if (this.remoteTimer == null && this.remote && this.remote.url) this._startRemoteTimer();
        resolve();
      }, 200);
    });
  }
}

module.exports = SmartLogger;

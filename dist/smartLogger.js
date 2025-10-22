"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const url_1 = require("url");
const zlib_1 = __importDefault(require("zlib"));
function calcBackoff(attempt, base = 500, cap = 30000) {
    const jitter = Math.random() * 100;
    const val = Math.min(cap, Math.floor(base * Math.pow(2, attempt)) + jitter);
    return val;
}
class SmartLogger {
    constructor(options = {}) {
        this.levels = { error: 0, warn: 1, info: 2, debug: 3 };
        this.stream = null;
        this.colorMap = {
            error: '\u001b[31m', warn: '\u001b[33m', info: '\u001b[32m', debug: '\u001b[36m', reset: '\u001b[0m', dim: '\u001b[2m'
        };
        this.remoteHeaders = {};
        this.remoteBuffer = [];
        this.remoteTimer = null;
        this.remoteIntervalMs = 5000;
        this.remoteBatchSize = 10;
        this._remoteFailCount = 0;
        this.timeZone = null;
        const { level = 'info', env = process.env.NODE_ENV || 'development', label = '', colors = true, json = false, file = null, rotation = null, remote = null, remoteReliable = false, remoteQueuePath = './logs/remote-queue.jsonl', remoteGzip = false, timeZone = undefined } = options;
        this.level = this.levels[level];
        this.env = env;
        this.label = label;
        this.useColors = colors;
        this.json = json;
        this.file = file ? path_1.default.resolve(file) : null;
        this.rotation = rotation;
        this.timeZone = timeZone || null;
        this.remote = remote;
        this.remoteReliable = remoteReliable;
        this.remoteQueuePath = remoteQueuePath ? path_1.default.resolve(remoteQueuePath) : null;
        this.remoteGzip = remoteGzip;
        if (this.file)
            this._openLogStream();
        if (this.remote && this.remote.url) {
            this.remoteIntervalMs = this.remote.intervalMs || this.remoteIntervalMs;
            this.remoteBatchSize = this.remote.batchSize || this.remoteBatchSize;
            this.remoteHeaders = this.remote.headers || {};
            this._startRemoteTimer();
        }
        if (this.remoteReliable && this.remoteQueuePath) {
            try {
                const dir = path_1.default.dirname(this.remoteQueuePath);
                if (!fs_1.default.existsSync(dir))
                    fs_1.default.mkdirSync(dir, { recursive: true });
                if (!fs_1.default.existsSync(this.remoteQueuePath))
                    fs_1.default.writeFileSync(this.remoteQueuePath, '', 'utf8');
            }
            catch (e) { }
        }
    }
    setLevel(levelStr) { if (this.levels[levelStr] != null)
        this.level = this.levels[levelStr]; }
    _shouldLog(level) { if (this.env === 'production' && level === 'debug')
        return false; return this.levels[level] <= this.level; }
    _timestamp() {
        if (!this.timeZone)
            return new Date().toISOString();
        try {
            const now = new Date();
            // Build a ISO-like timestamp in the requested IANA timezone (no offset suffix)
            const fmt = new Intl.DateTimeFormat('en-CA', {
                timeZone: this.timeZone,
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                fractionalSecondDigits: 3,
                hour12: false
            });
            // formatToParts lets us assemble YYYY-MM-DDTHH:mm:SS.mmm
            const parts = fmt.formatToParts(now);
            const map = {};
            for (const p of parts) {
                if (p.type !== 'literal')
                    map[p.type] = p.value;
            }
            const date = `${map.year}-${map.month}-${map.day}`;
            const time = `${map.hour}:${map.minute}:${map.second}.${map.fractionalSecond || '000'}`;
            return `${date}T${time}`;
        }
        catch (e) {
            return new Date().toISOString();
        }
    }
    _openLogStream() {
        try {
            const dir = path_1.default.dirname(this.file);
            if (!fs_1.default.existsSync(dir))
                fs_1.default.mkdirSync(dir, { recursive: true });
            this.stream = fs_1.default.createWriteStream(this.file, { flags: 'a', encoding: 'utf8' });
        }
        catch (e) {
            this.stream = null;
            this._writeToConsole('warn', `failed to open log file ${this.file}: ${String(e)}`);
        }
    }
    _writeToConsole(level, formatted) { if (level === 'error')
        console.error(formatted);
    else if (level === 'warn')
        console.warn(formatted);
    else
        console.log(formatted); }
    _format(level, message, context) {
        const ts = this._timestamp();
        const label = this.label ? `[${this.label}]` : '';
        if (this.json) {
            const payload = { timestamp: ts, level, label: this.label || undefined, message, context: context || undefined };
            return JSON.stringify(payload);
        }
        const color = this.useColors ? (this.colorMap[level] || '') : '';
        const reset = this.useColors ? this.colorMap.reset : '';
        const dim = this.useColors ? this.colorMap.dim : '';
        let ctx = '';
        if (context) {
            try {
                ctx = typeof context === 'string' ? context : JSON.stringify(context, null, 2);
            }
            catch (e) {
                ctx = String(context);
            }
            ctx = ` ${dim}${ctx}${reset}`;
        }
        return `${color}${ts} ${level.toUpperCase()} ${label}${reset} - ${message}${ctx}`;
    }
    _writeToFile(formatted) { if (!this.stream)
        return; try {
        this.stream.write(formatted + '\n');
        if (this.rotation && this.rotation.size)
            this._rotateIfNeeded();
    }
    catch (e) { } }
    _prepareMessage(msg, args) {
        let message = msg;
        let context = null;
        if (msg instanceof Error) {
            message = msg.message;
            context = { stack: msg.stack };
            if (args && args.length) {
                context.extra = args;
            }
        }
        else if (args && args.length) {
            if (args.length === 1 && typeof args[0] === 'object') {
                context = args[0];
            }
            else {
                message = [msg].concat(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a)))).join(' ');
            }
        }
        return { message, context };
    }
    log(level, msg, ...args) { if (!this._shouldLog(level))
        return; const { message, context } = this._prepareMessage(msg, args); const formatted = this._format(level, message, context); this._writeToConsole(level, formatted); if (this.stream)
        this._writeToFile(this.json ? formatted : formatted.replace(/\u001b\[[0-9;]*m/g, '')); if (this.remote && this.remote.url) {
        const payload = this.json ? JSON.parse(formatted) : { timestamp: this._timestamp(), level, label: this.label || undefined, message, context };
        this._enqueueRemote(payload);
    } }
    info(msg, ...args) { this.log('info', msg, ...args); }
    warn(msg, ...args) { this.log('warn', msg, ...args); }
    error(msg, ...args) { this.log('error', msg, ...args); }
    debug(msg, ...args) { this.log('debug', msg, ...args); }
    child(overrides = {}) {
        const opts = Object.assign({}, { level: Object.keys(this.levels).find(k => this.levels[k] === this.level) || 'info', env: this.env, label: this.label, colors: this.useColors, json: this.json, file: this.file }, overrides);
        return new SmartLogger(opts);
    }
    close() { if (this.stream) {
        try {
            this.stream.end();
        }
        catch (e) { }
        this.stream = null;
    } if (this.remoteTimer) {
        clearInterval(this.remoteTimer);
        this.remoteTimer = null;
    } if (this.remoteBuffer && this.remoteBuffer.length)
        this._flushRemote(); }
    _rotateIfNeeded() { try {
        const stats = fs_1.default.statSync(this.file);
        if (stats.size < this.rotation.size)
            return;
        const maxFiles = this.rotation.maxFiles || 5;
        try {
            this.stream && this.stream.end();
        }
        catch (e) { }
        for (let i = maxFiles - 1; i >= 0; i--) {
            const src = i === 0 ? this.file : `${this.file}.${i}`;
            const dest = `${this.file}.${i + 1}`;
            if (fs_1.default.existsSync(src)) {
                try {
                    if (i + 1 > maxFiles) {
                        fs_1.default.unlinkSync(dest);
                    }
                    fs_1.default.renameSync(src, dest);
                }
                catch (e) { }
            }
        }
        this._openLogStream();
    }
    catch (e) { } }
    _startRemoteTimer() { if (this.remoteTimer)
        return; this.remoteTimer = setInterval(() => { if (this.remoteBuffer.length)
        this._flushRemote(); }, this.remoteIntervalMs); }
    _enqueueRemote(item) { try {
        this.remoteBuffer.push(item);
        if (this.remoteBuffer.length >= this.remoteBatchSize)
            this._flushRemote();
    }
    catch (e) { } }
    _flushRemote() {
        if (!this.remote || !this.remote.url)
            return;
        const buffer = this.remoteBuffer.splice(0, this.remoteBuffer.length);
        if (!buffer.length)
            return;
        let url;
        try {
            url = new url_1.URL(this.remote.url);
        }
        catch (e) {
            return;
        }
        let body = JSON.stringify(buffer);
        const shouldGzip = this.remoteGzip;
        const sendBody = shouldGzip ? zlib_1.default.gzipSync(body) : Buffer.from(body, 'utf8');
        const isHttps = url.protocol === 'https:';
        const opts = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + (url.search || ''),
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(sendBody) }, this.remoteHeaders),
            timeout: this.remote && this.remote.timeoutMs ? this.remote.timeoutMs : 5000,
        };
        if (shouldGzip)
            opts.headers['Content-Encoding'] = 'gzip';
        const transport = isHttps ? https_1.default : http_1.default;
        const req = transport.request(opts, (res) => { res.on('data', () => { }); res.on('end', () => { }); });
        const self = this;
        req.on('error', (err) => {
            if (self.remoteReliable && self.remoteQueuePath) {
                try {
                    const lines = buffer.map(b => JSON.stringify(b)).join('\n') + '\n';
                    fs_1.default.appendFileSync(self.remoteQueuePath, lines, { encoding: 'utf8' });
                }
                catch (e) { }
            }
            else {
                try {
                    self.remoteBuffer.unshift(...buffer);
                    const cap = self.remote.maxBuffer || 1000;
                    if (self.remoteBuffer.length > cap)
                        self.remoteBuffer = self.remoteBuffer.slice(0, cap);
                }
                catch (e) { }
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
    _flushPersistentQueue() { if (!this.remoteReliable || !this.remoteQueuePath)
        return; try {
        if (!fs_1.default.existsSync(this.remoteQueuePath))
            return;
        const data = fs_1.default.readFileSync(this.remoteQueuePath, 'utf8');
        if (!data)
            return;
        const lines = data.trim().split('\n');
        const take = Math.min(lines.length, this.remoteBatchSize || 10);
        const batch = lines.slice(0, take).map(l => JSON.parse(l));
        this.remoteBuffer.unshift(...batch);
        const remaining = lines.slice(take);
        fs_1.default.writeFileSync(this.remoteQueuePath, remaining.join('\n') + (remaining.length ? '\n' : ''), 'utf8');
        this._flushRemote();
    }
    catch (e) { } }
    flushRemote() { return new Promise((resolve) => { try {
        if (this.remoteTimer)
            clearInterval(this.remoteTimer);
        if (this.remoteBuffer.length)
            this._flushRemote();
    }
    catch (e) { } setTimeout(() => { if (this.remoteTimer == null && this.remote && this.remote.url)
        this._startRemoteTimer(); resolve(); }, 200); }); }
}
exports.default = SmartLogger;

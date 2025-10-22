import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import zlib from 'zlib';

export type Level = 'error' | 'warn' | 'info' | 'debug';

export interface RotationOptions { size: number; maxFiles?: number }
export interface RemoteOptions { url: string; intervalMs?: number; batchSize?: number; headers?: Record<string,string>; timeoutMs?: number; maxBuffer?: number }
export interface SmartLoggerOptions {
  level?: Level;
  env?: string;
  label?: string;
  colors?: boolean;
  json?: boolean;
  file?: string;
  rotation?: RotationOptions | null;
  remote?: RemoteOptions | null;
  timeZone?: string;
  remoteReliable?: boolean;
  remoteQueuePath?: string;
  remoteGzip?: boolean;
}

function calcBackoff(attempt: number, base = 500, cap = 30000) {
  const jitter = Math.random() * 100;
  const val = Math.min(cap, Math.floor(base * Math.pow(2, attempt)) + jitter);
  return val;
}

export default class SmartLogger {
  private levels = { error: 0, warn: 1, info: 2, debug: 3 } as Record<Level, number>;
  private level: number;
  private env: string;
  private label: string;
  private useColors: boolean;
  private json: boolean;
  private file: string | null;
  private rotation: RotationOptions | null;
  private stream: fs.WriteStream | null = null;
  private colorMap = {
    error: '\u001b[31m', warn: '\u001b[33m', info: '\u001b[32m', debug: '\u001b[36m', reset: '\u001b[0m', dim: '\u001b[2m'
  } as Record<string,string>;

  private remote: RemoteOptions | null;
  private remoteReliable: boolean;
  private remoteQueuePath: string | null;
  private remoteGzip: boolean;
  private remoteHeaders: Record<string,string> = {};
  private remoteBuffer: Array<Record<string, any>> = [];
  private remoteTimer: NodeJS.Timeout | null = null;
  private remoteIntervalMs = 5000;
  private remoteBatchSize = 10;
  private _remoteFailCount = 0;
  private timeZone: string | null = null;

  constructor(options: SmartLoggerOptions = {}){
    const { level = 'info', env = process.env.NODE_ENV || 'development', label = '', colors = true, json = false, file = null, rotation = null, remote = null, remoteReliable = false, remoteQueuePath = './logs/remote-queue.jsonl', remoteGzip = false, timeZone = undefined } = options;
    this.level = this.levels[level];
    this.env = env;
    this.label = label;
    this.useColors = colors;
    this.json = json;
    this.file = file ? path.resolve(file) : null;
    this.rotation = rotation;
    this.timeZone = timeZone || null;

    this.remote = remote;
    this.remoteReliable = remoteReliable;
    this.remoteQueuePath = remoteQueuePath ? path.resolve(remoteQueuePath) : null;
    this.remoteGzip = remoteGzip;

    if (this.file) this._openLogStream();
    if (this.remote && this.remote.url) {
      this.remoteIntervalMs = this.remote.intervalMs || this.remoteIntervalMs;
      this.remoteBatchSize = this.remote.batchSize || this.remoteBatchSize;
      this.remoteHeaders = this.remote.headers || {};
      this._startRemoteTimer();
    }

    if (this.remoteReliable && this.remoteQueuePath) {
      try{ const dir = path.dirname(this.remoteQueuePath); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); if (!fs.existsSync(this.remoteQueuePath)) fs.writeFileSync(this.remoteQueuePath,'','utf8'); }catch(e){}
    }
  }

  setLevel(levelStr: Level){ if (this.levels[levelStr] != null) this.level = this.levels[levelStr]; }
  private _shouldLog(level: Level){ if (this.env === 'production' && level === 'debug') return false; return this.levels[level] <= this.level; }
  private _timestamp(){
    if (!this.timeZone) return new Date().toISOString();
    try{
      const now = new Date();
      // Build a ISO-like timestamp in the requested IANA timezone (no offset suffix)
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: this.timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        fractionalSecondDigits: 3,
        hour12: false
      } as any);
      // formatToParts lets us assemble YYYY-MM-DDTHH:mm:SS.mmm
      const parts = fmt.formatToParts(now);
      const map: Record<string,string> = {};
      for (const p of parts) { if (p.type !== 'literal') map[p.type] = p.value; }
      const date = `${map.year}-${map.month}-${map.day}`;
      const time = `${map.hour}:${map.minute}:${map.second}.${map.fractionalSecond || '000'}`;
      return `${date}T${time}`;
    }catch(e){ return new Date().toISOString(); }
  }

  private _openLogStream(){
    try{ const dir = path.dirname(this.file as string); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); this.stream = fs.createWriteStream(this.file as string, { flags: 'a', encoding: 'utf8' }); }catch(e){ this.stream = null; this._writeToConsole('warn', `failed to open log file ${(this.file as string)}: ${String(e)}`); }
  }

  private _writeToConsole(level: Level, formatted: string){ if (level === 'error') console.error(formatted); else if (level === 'warn') console.warn(formatted); else console.log(formatted); }

  private _format(level: Level, message: string, context: any){
    const ts = this._timestamp(); const label = this.label ? `[${this.label}]` : '';
    if (this.json) { const payload = { timestamp: ts, level, label: this.label || undefined, message, context: context || undefined }; return JSON.stringify(payload); }
    const color = this.useColors ? (this.colorMap[level] || '') : '';
    const reset = this.useColors ? this.colorMap.reset : '';
    const dim = this.useColors ? this.colorMap.dim : '';
    let ctx = '';
    if (context){ try { ctx = typeof context === 'string' ? context : JSON.stringify(context, null, 2); } catch(e){ ctx = String(context); } ctx = ` ${dim}${ctx}${reset}`; }
    return `${color}${ts} ${level.toUpperCase()} ${label}${reset} - ${message}${ctx}`;
  }

  private _writeToFile(formatted: string){ if (!this.stream) return; try{ this.stream.write(formatted + '\n'); if (this.rotation && this.rotation.size) this._rotateIfNeeded(); }catch(e){} }

  private _prepareMessage(msg: any, args: any[]){
    let message = msg;
    let context: any = null;
    if (msg instanceof Error) {
      message = msg.message;
      context = { stack: msg.stack } as any;
      if (args && args.length) {
        context.extra = args;
      }
    } else if (args && args.length) {
      if (args.length === 1 && typeof args[0] === 'object') {
        context = args[0];
      } else {
        message = [msg].concat(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a)))).join(' ');
      }
    }
    return { message, context };
  }

  log(level: Level, msg: any, ...args: any[]){ if (!this._shouldLog(level)) return; const { message, context } = this._prepareMessage(msg, args); const formatted = this._format(level, message, context); this._writeToConsole(level, formatted); if (this.stream) this._writeToFile(this.json ? formatted : formatted.replace(/\u001b\[[0-9;]*m/g,'')); if (this.remote && this.remote.url) { const payload = this.json ? JSON.parse(formatted) : { timestamp: this._timestamp(), level, label: this.label || undefined, message, context }; this._enqueueRemote(payload); } }

  info(msg: any, ...args: any[]){ this.log('info', msg, ...args); }
  warn(msg: any, ...args: any[]){ this.log('warn', msg, ...args); }
  error(msg: any, ...args: any[]){ this.log('error', msg, ...args); }
  debug(msg: any, ...args: any[]){ this.log('debug', msg, ...args); }

  child(overrides: Partial<SmartLoggerOptions> = {}){
    const opts: SmartLoggerOptions = Object.assign({}, { level: (Object.keys(this.levels) as Level[]).find(k => this.levels[k] === this.level) || 'info', env: this.env, label: this.label, colors: this.useColors, json: this.json, file: this.file as string }, overrides as any);
    return new SmartLogger(opts);
  }

  close(){ if (this.stream) { try{ this.stream.end(); }catch(e){} this.stream = null; } if (this.remoteTimer) { clearInterval(this.remoteTimer as NodeJS.Timeout); this.remoteTimer = null; } if (this.remoteBuffer && this.remoteBuffer.length) this._flushRemote(); }

  private _rotateIfNeeded(){ try{ const stats = fs.statSync(this.file as string); if (stats.size < (this.rotation as RotationOptions).size) return; const maxFiles = (this.rotation as RotationOptions).maxFiles || 5; try{ this.stream && this.stream.end(); }catch(e){} for (let i = maxFiles - 1; i >= 0; i--){ const src = i === 0 ? this.file as string : `${this.file}.${i}`; const dest = `${this.file}.${i + 1}`; if (fs.existsSync(src)){ try{ if (i + 1 > maxFiles) { fs.unlinkSync(dest); } fs.renameSync(src, dest); }catch(e){} } } this._openLogStream(); }catch(e){} }

  private _startRemoteTimer(){ if (this.remoteTimer) return; this.remoteTimer = setInterval(()=>{ if (this.remoteBuffer.length) this._flushRemote(); }, this.remoteIntervalMs); }
  private _enqueueRemote(item: any){ try{ this.remoteBuffer.push(item); if (this.remoteBuffer.length >= this.remoteBatchSize) this._flushRemote(); }catch(e){} }

  private _flushRemote(){ if (!this.remote || !this.remote.url) return; const buffer = this.remoteBuffer.splice(0, this.remoteBuffer.length); if (!buffer.length) return; let url; try{ url = new URL(this.remote.url); }catch(e){ return; }

  let body = JSON.stringify(buffer);
  const shouldGzip = this.remoteGzip;
  const sendBody = shouldGzip ? zlib.gzipSync(body) : Buffer.from(body, 'utf8');
  const isHttps = url.protocol === 'https:';
  const opts = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + (url.search || ''),
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(sendBody) }, this.remoteHeaders),
    timeout: this.remote && this.remote.timeoutMs ? this.remote.timeoutMs : 5000,
  };
  if (shouldGzip) opts.headers['Content-Encoding'] = 'gzip';

  const transport = isHttps ? https : http;
  const req = transport.request(opts, (res)=>{ res.on('data', ()=>{}); res.on('end', ()=>{}); });
  const self = this;
  req.on('error', (err)=>{
    if (self.remoteReliable && self.remoteQueuePath){ try{ const lines = buffer.map(b => JSON.stringify(b)).join('\n') + '\n'; fs.appendFileSync(self.remoteQueuePath, lines, { encoding: 'utf8' }); }catch(e){} } else { try{ self.remoteBuffer.unshift(...buffer); const cap = (self.remote as any).maxBuffer || 1000; if (self.remoteBuffer.length > cap) self.remoteBuffer = self.remoteBuffer.slice(0,cap); }catch(e){} }
    self._remoteFailCount++;
    const backoff = calcBackoff(self._remoteFailCount);
    if (self.remoteTimer){ clearInterval(self.remoteTimer as NodeJS.Timeout); self.remoteTimer = null; }
    setTimeout(()=> self._startRemoteTimer(), backoff);
  });
  req.on('timeout', ()=>{ req.destroy(); });
  req.write(sendBody);
  req.end(); }

  private _flushPersistentQueue(){ if (!this.remoteReliable || !this.remoteQueuePath) return; try{ if (!fs.existsSync(this.remoteQueuePath)) return; const data = fs.readFileSync(this.remoteQueuePath,'utf8'); if (!data) return; const lines = data.trim().split('\n'); const take = Math.min(lines.length, this.remoteBatchSize || 10); const batch = lines.slice(0,take).map(l => JSON.parse(l)); this.remoteBuffer.unshift(...batch); const remaining = lines.slice(take); fs.writeFileSync(this.remoteQueuePath, remaining.join('\n') + (remaining.length ? '\n' : ''),'utf8'); this._flushRemote(); }catch(e){} }

  flushRemote(){ return new Promise<void>((resolve)=>{ try{ if (this.remoteTimer) clearInterval(this.remoteTimer as NodeJS.Timeout); if (this.remoteBuffer.length) this._flushRemote(); }catch(e){} setTimeout(()=>{ if (this.remoteTimer == null && this.remote && this.remote.url) this._startRemoteTimer(); resolve(); },200); }); }
}

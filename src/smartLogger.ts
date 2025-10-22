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
  files?: Partial<Record<Level,string>>;
  bufferFlushIntervalMs?: number;
  bufferMaxSize?: number;
  pretty?: boolean;
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
  private _streamBytesWritten = 0;
  private _bufferMap: Map<string,string[]> = new Map();
  private _bufferFlushTimer: NodeJS.Timeout | null = null;
  private _bufferFlushIntervalMs = 100; // default
  private _bufferMaxSize = 100;
  private _fileStreams: Map<string, fs.WriteStream> = new Map();
  private filesMap: Partial<Record<Level,string>> | null = null;
  private pretty: boolean = false;
  private colorMap = {
    // brighter and clearer defaults
    error: '\u001b[31;1m', // bright red, bold
    warn: '\u001b[33;1m',  // bright yellow, bold
    info: '\u001b[32m',    // green
    debug: '\u001b[36m',   // cyan
    label: '\u001b[35m',   // magenta
    timestamp: '\u001b[90m', // bright black (gray) for timestamps
    reset: '\u001b[0m',
    dim: '\u001b[2m',
    bold: '\u001b[1m'
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
  // Allow runtime theme changes
  setTheme(colors: boolean, customMap?: Record<string,string>){ this.useColors = colors; if (customMap) this.colorMap = Object.assign({}, this.colorMap, customMap); }

  constructor(options: SmartLoggerOptions = {}){
  const { level = 'info', env = process.env.NODE_ENV || 'development', label = '', colors = true, json = false, pretty = false, file = null, rotation = null, files = null, bufferFlushIntervalMs = 100, bufferMaxSize = 100, remote = null, remoteReliable = false, remoteQueuePath = './logs/remote-queue.jsonl', remoteGzip = false, timeZone = undefined, } = options;
    this.level = this.levels[level];
    this.env = env;
    this.label = label;
    this.useColors = colors;
    this.json = json;
    this.file = file ? path.resolve(file) : null;
    this.rotation = rotation;
    this.timeZone = timeZone || null;
  this.filesMap = files || null;
  this._bufferFlushIntervalMs = bufferFlushIntervalMs;
  this._bufferMaxSize = bufferMaxSize;

    this.remote = remote;
    this.remoteReliable = remoteReliable;
    this.remoteQueuePath = remoteQueuePath ? path.resolve(remoteQueuePath) : null;
    this.remoteGzip = remoteGzip;
    // If user explicitly provided pretty, use it. Otherwise enable pretty by default in non-production when json is true.
    if ((options as any).pretty !== undefined) {
      this.pretty = !!pretty;
    } else {
      this.pretty = !!(json && this.env !== 'production');
    }

    if (this.file) this._openLogStream();
  // Start buffer flush timer only if file-based output is enabled
  if (this.file || this.filesMap) this._startBufferFlushTimer();
    if (this.remote && this.remote.url) {
      this.remoteIntervalMs = this.remote.intervalMs || this.remoteIntervalMs;
      this.remoteBatchSize = this.remote.batchSize || this.remoteBatchSize;
      this.remoteHeaders = this.remote.headers || {};
      this._startRemoteTimer();
    }

    if (this.remoteReliable && this.remoteQueuePath) {
      try{ const dir = path.dirname(this.remoteQueuePath); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); if (!fs.existsSync(this.remoteQueuePath)) fs.writeFileSync(this.remoteQueuePath,'','utf8'); }catch(e){}
    }
      // apply custom colors if provided
      if ((options as any).colorsMap) this.setTheme(this.useColors, (options as any).colorsMap);
  }

  private _startBufferFlushTimer(){ if (this._bufferFlushTimer) return; this._bufferFlushTimer = setInterval(()=> this._flushBuffers(), this._bufferFlushIntervalMs); }
  private _stopBufferFlushTimer(){ if (!this._bufferFlushTimer) return; clearInterval(this._bufferFlushTimer); this._bufferFlushTimer = null; }

  private _getStreamForFile(fp: string){
    if (this._fileStreams.has(fp)) return this._fileStreams.get(fp) as fs.WriteStream;
    try{ const dir = path.dirname(fp); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); const s = fs.createWriteStream(fp, { flags: 'a', encoding: 'utf8' }); this._fileStreams.set(fp, s);
      try{ const st = fs.existsSync(fp) ? fs.statSync(fp) : null; /* we don't track per-file bytes for rotation here */ }catch(e){}
      return s;
    }catch(e){ return null as any; }
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
    try{
      const dir = path.dirname(this.file as string);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.stream = fs.createWriteStream(this.file as string, { flags: 'a', encoding: 'utf8' });
      // initialize bytes written counter to existing file size if any
      try{ const st = fs.existsSync(this.file as string) ? fs.statSync(this.file as string) : null; this._streamBytesWritten = st ? st.size : 0; }catch(e){}
    }catch(e){ this.stream = null; this._writeToConsole('warn', `failed to open log file ${(this.file as string)}: ${String(e)}`); }
  }

  private _writeToConsole(level: Level, formatted: string){ if (level === 'error') console.error(formatted); else if (level === 'warn') console.warn(formatted); else console.log(formatted); }

  // returns both colored and plain representations to avoid re-rendering
  private _format(level: Level, message: string, context: any){
    const ts = this._timestamp(); const label = this.label ? `[${this.label}]` : '';
    if (this.json) {
      const payload = { timestamp: ts, level, label: this.label || undefined, message, context: context || undefined };
      const json = JSON.stringify(payload);
      if (this.pretty) {
        const color = this.useColors ? (this.colorMap[level] || '') : '';
        const reset = this.useColors ? this.colorMap.reset : '';
        const labelColor = this.useColors ? this.colorMap.label : '';
        const tsColor = this.useColors ? this.colorMap.timestamp : '';
        const levelStr = `${level.toUpperCase()}`.padEnd(5);
        const colored = `${tsColor}${ts}${reset} ${color}${levelStr}${reset} ${labelColor}${label}${reset} - ${message}${context ? ' ' + (typeof context === 'string' ? context : JSON.stringify(context)) : ''}`;
        return { colored, plain: json } as any;
      }
      return { colored: json, plain: json } as any;
    }
    const color = this.useColors ? (this.colorMap[level] || '') : '';
    const reset = this.useColors ? this.colorMap.reset : '';
    const dim = this.useColors ? this.colorMap.dim : '';
    const labelColor = this.useColors ? this.colorMap.label : '';
    let ctx = '';
    if (context){ try { ctx = typeof context === 'string' ? context : JSON.stringify(context, null, 2); } catch(e){ ctx = String(context); } ctx = ` ${dim}${ctx}${reset}`; }
    const levelStr = `${level.toUpperCase()}`.padEnd(5);
    const colored = `${dim}${ts}${reset} ${color}${levelStr}${reset} ${labelColor}${label}${reset} - ${message}${ctx}`;
    const plain = `${ts} ${levelStr} ${label} - ${message}${context ? ' ' + (typeof context === 'string' ? context : JSON.stringify(context)) : ''}`;
    return { colored, plain } as any;
  }

  private _writeToFile(plain: string, level?: Level){
    // determine target file
    const target = (level && this.filesMap && this.filesMap[level]) ? this.filesMap[level] : this.file;
    if (!target) return;
    const fp = path.resolve(target as string);
    const entry = (this._bufferMap.get(fp) || []);
    entry.push(plain + '\n');
    this._bufferMap.set(fp, entry);
    if (entry.length >= this._bufferMaxSize) this._flushBuffersFor(fp);
  }

  private _flushBuffersFor(fp: string){ const arr = this._bufferMap.get(fp); if (!arr || !arr.length) return; const data = arr.join(''); this._bufferMap.set(fp, []); const s = this._getStreamForFile(fp); if (!s) return; try{ s.write(data); }catch(e){}
  }

  private _flushBuffers(){ try{ for (const [fp, arr] of Array.from(this._bufferMap.entries())){ if (!arr || !arr.length) continue; const data = arr.join(''); this._bufferMap.set(fp, []); const s = this._getStreamForFile(fp); if (!s) continue; try{ s.write(data); }catch(e){} } }catch(e){} }

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

  log(level: Level, msg: any, ...args: any[]){ if (!this._shouldLog(level)) return; const { message, context } = this._prepareMessage(msg, args); const formatted = this._format(level, message, context); this._writeToConsole(level, formatted.colored); if (this.file || this.filesMap) this._writeToFile(this.json ? formatted.plain : formatted.plain, level); if (this.remote && this.remote.url) { const payload = this.json ? JSON.parse(formatted.plain) : { timestamp: this._timestamp(), level, label: this.label || undefined, message, context }; this._enqueueRemote(payload); } }

  info(msg: any, ...args: any[]){ this.log('info', msg, ...args); }
  warn(msg: any, ...args: any[]){ this.log('warn', msg, ...args); }
  error(msg: any, ...args: any[]){ this.log('error', msg, ...args); }
  debug(msg: any, ...args: any[]){ this.log('debug', msg, ...args); }

  child(overrides: Partial<SmartLoggerOptions> = {}){
    const opts: SmartLoggerOptions = Object.assign({}, { level: (Object.keys(this.levels) as Level[]).find(k => this.levels[k] === this.level) || 'info', env: this.env, label: this.label, colors: this.useColors, json: this.json, file: this.file as string }, overrides as any);
    return new SmartLogger(opts);
  }

  close(){ // flush buffers and close streams
    try{ this._flushBuffers(); this._stopBufferFlushTimer(); }catch(e){}
    for (const s of Array.from(this._fileStreams.values())){ try{ s.end(); }catch(e){} }
    this._fileStreams.clear();
    if (this.stream) { try{ this.stream.end(); }catch(e){} this.stream = null; }
    if (this.remoteTimer) { clearInterval(this.remoteTimer as NodeJS.Timeout); this.remoteTimer = null; }
    if (this.remoteBuffer && this.remoteBuffer.length) this._flushRemote(); }

  private _rotateIfNeeded(){ try{ const currentSize = this._streamBytesWritten || (this.stream ? (this.stream as any).bytesWritten || 0 : 0); if (currentSize < (this.rotation as RotationOptions).size) return; const maxFiles = (this.rotation as RotationOptions).maxFiles || 5; try{ this.stream && this.stream.end(); }catch(e){} for (let i = maxFiles - 1; i >= 0; i--){ const src = i === 0 ? this.file as string : `${this.file}.${i}`; const dest = `${this.file}.${i + 1}`; if (fs.existsSync(src)){ try{ if (i + 1 > maxFiles) { if (fs.existsSync(dest)) fs.unlinkSync(dest); } fs.renameSync(src, dest); }catch(e){} } } this._openLogStream(); }catch(e){} }

  private _startRemoteTimer(){ if (this.remoteTimer) return; this.remoteTimer = setInterval(()=>{ if (this.remoteBuffer.length) this._flushRemote(); }, this.remoteIntervalMs); }
  private _enqueueRemote(item: any){ try{ this.remoteBuffer.push(item); if (this.remoteBuffer.length >= this.remoteBatchSize) this._flushRemote(); }catch(e){} }

  private _flushRemote(){ if (!this.remote || !this.remote.url) return; const buffer = this.remoteBuffer.splice(0, this.remoteBuffer.length); if (!buffer.length) return; let url; try{ url = new URL(this.remote.url); }catch(e){ return; }

  const body = JSON.stringify(buffer);
  const isHttps = url.protocol === 'https:';
  const optsBase = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + (url.search || ''),
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, this.remoteHeaders),
    timeout: this.remote && this.remote.timeoutMs ? this.remote.timeoutMs : 5000,
  } as any;

  const transport = isHttps ? https : http;

  const send = (buf: Buffer)=>{
    const opts = Object.assign({}, optsBase, { headers: Object.assign({}, optsBase.headers, { 'Content-Length': Buffer.byteLength(buf) }) });
    if (this.remoteGzip) opts.headers['Content-Encoding'] = 'gzip';
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
    req.write(buf);
    req.end();
  };

  if (this.remoteGzip){
    zlib.gzip(body, (err, result)=>{ if (err){ send(Buffer.from(body,'utf8')); } else { send(result); } });
  } else {
    send(Buffer.from(body,'utf8'));
  }
 }

  private _flushPersistentQueue(){ if (!this.remoteReliable || !this.remoteQueuePath) return; try{ const qp = this.remoteQueuePath as string; fs.promises.access(qp).then(()=> fs.promises.readFile(qp,'utf8')).then(data=>{ if (!data) return; const lines = data.trim().split('\n'); const take = Math.min(lines.length, this.remoteBatchSize || 10); const batch = lines.slice(0,take).map(l => JSON.parse(l)); this.remoteBuffer.unshift(...batch); const remaining = lines.slice(take); return fs.promises.writeFile(qp, remaining.join('\n') + (remaining.length ? '\n' : ''),'utf8'); }).then(()=> this._flushRemote()).catch(()=>{}); }catch(e){} }

  flushRemote(){ return new Promise<void>((resolve)=>{ try{ if (this.remoteTimer) clearInterval(this.remoteTimer as NodeJS.Timeout); if (this.remoteBuffer.length) this._flushRemote(); }catch(e){} setTimeout(()=>{ if (this.remoteTimer == null && this.remote && this.remote.url) this._startRemoteTimer(); resolve(); },200); }); }
}

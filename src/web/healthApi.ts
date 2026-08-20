import express from 'express';
import * as os from 'os';

export function createHealthRouter(): express.Router {
  const router = express.Router();
  const startTime = Date.now();

  // ── Basic Health ───────────────────────────────────────────────────────────

  router.get('/', (_req, res) => {
    res.json({
      status: 'healthy',
      version: '15.0.0',
      uptime: Math.round(process.uptime()),
      timestamp: new Date()
    });
  });

  // ── Deep Health Check ──────────────────────────────────────────────────────

  router.get('/deep', async (_req, res) => {
    const checks: Record<string, { status: 'ok' | 'warn' | 'fail'; detail?: any }> = {};

    // Memory check
    const mem = process.memoryUsage();
    const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024);
    checks.memory = {
      status: heapMb > 500 ? 'warn' : 'ok',
      detail: { heapUsedMb: heapMb, heapTotalMb, rss: Math.round(mem.rss / 1024 / 1024) }
    };

    // CPU check
    const cpus = os.cpus();
    const load = os.loadavg();
    checks.cpu = {
      status: load[0] > cpus.length * 0.9 ? 'warn' : 'ok',
      detail: { cores: cpus.length, loadAvg1m: load[0].toFixed(2), loadAvg5m: load[1].toFixed(2) }
    };

    // Disk check (simplified)
    checks.disk = {
      status: 'ok',
      detail: { note: 'Disk monitoring via OS tools' }
    };

    // Event loop lag
    const lagStart = Date.now();
    await new Promise(resolve => setImmediate(resolve));
    const lag = Date.now() - lagStart;
    checks.eventLoop = {
      status: lag > 100 ? 'warn' : 'ok',
      detail: { lagMs: lag }
    };

    // Uptime
    checks.uptime = {
      status: 'ok',
      detail: {
        processUptimeSec: Math.round(process.uptime()),
        serverStartMs: startTime,
        osUptimeSec: Math.round(os.uptime())
      }
    };

    const allOk = Object.values(checks).every(c => c.status === 'ok');
    const anyFail = Object.values(checks).some(c => c.status === 'fail');

    res.status(anyFail ? 503 : 200).json({
      status: anyFail ? 'unhealthy' : allOk ? 'healthy' : 'degraded',
      checks,
      summary: {
        ok: Object.values(checks).filter(c => c.status === 'ok').length,
        warn: Object.values(checks).filter(c => c.status === 'warn').length,
        fail: Object.values(checks).filter(c => c.status === 'fail').length
      }
    });
  });

  // ── System Metrics ─────────────────────────────────────────────────────────

  router.get('/metrics', (_req, res) => {
    const mem = process.memoryUsage();
    const load = os.loadavg();
    const cpus = os.cpus();

    res.json({
      process: {
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        version: process.version,
        memory: {
          heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
          rssMb: Math.round(mem.rss / 1024 / 1024),
          externalMb: Math.round((mem as any).external / 1024 / 1024)
        }
      },
      os: {
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        cpuCount: cpus.length,
        cpuModel: cpus[0]?.model || 'unknown',
        loadAvg: { '1m': load[0].toFixed(2), '5m': load[1].toFixed(2), '15m': load[2].toFixed(2) },
        totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
        freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
        osUptime: Math.round(os.uptime())
      },
      timestamp: new Date()
    });
  });

  // ── Readiness ─────────────────────────────────────────────────────────────

  router.get('/ready', (_req, res) => {
    res.json({ ready: true, timestamp: new Date() });
  });

  // ── Liveness ──────────────────────────────────────────────────────────────

  router.get('/live', (_req, res) => {
    res.json({ alive: true, timestamp: new Date() });
  });

  return router;
}

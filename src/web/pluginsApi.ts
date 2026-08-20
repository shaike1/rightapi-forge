// Plugins API — dynamic skill plugin management
import { Router, Request, Response } from 'express';
import { PluginLoader, PluginManifest } from '../plugins/PluginLoader.js';

export function createPluginsRouter(loader: PluginLoader): Router {
  const router = Router();

  // GET /api/plugins — list all loaded plugins
  router.get('/', (_req: Request, res: Response) => {
    const plugins = loader.listLoaded().map(p => ({
      id: p.manifest.id,
      name: p.manifest.name,
      description: p.manifest.description,
      version: p.manifest.version,
      author: p.manifest.author,
      category: p.manifest.category,
      tags: p.manifest.tags || [],
      status: p.status,
      error: p.error,
      loadedAt: p.loadedAt,
      commands: p.commands || [],
      permissions: p.manifest.permissions || []
    }));
    res.json({ plugins, total: plugins.length });
  });

  // GET /api/plugins/:id — get plugin details
  router.get('/:id', (req: Request, res: Response) => {
    const plugin = loader.getPlugin(req.params.id);
    if (!plugin) { res.status(404).json({ error: 'Plugin not found' }); return; }
    res.json({
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      description: plugin.manifest.description,
      version: plugin.manifest.version,
      author: plugin.manifest.author,
      category: plugin.manifest.category,
      tags: plugin.manifest.tags || [],
      status: plugin.status,
      error: plugin.error,
      loadedAt: plugin.loadedAt,
      commands: plugin.commands || [],
      permissions: plugin.manifest.permissions || [],
      dir: plugin.dir
    });
  });

  // POST /api/plugins/install — install a plugin from inline script
  router.post('/install', async (req: Request, res: Response) => {
    const { id, manifest, script } = req.body as {
      id?: string;
      manifest?: PluginManifest;
      script?: string;
    };
    if (!id || !manifest || !script) {
      res.status(400).json({ error: 'id, manifest, and script are required' });
      return;
    }
    // Basic safety: reject obvious dangerous patterns
    const dangerous = ['require("child_process")', 'require(\'child_process\')', 'exec(', 'spawn(', 'execSync(', 'fork(', '__proto__', 'process.exit'];
    const blocked = dangerous.find(d => script.includes(d));
    if (blocked) {
      res.status(400).json({ error: `Disallowed pattern in plugin script: ${blocked}` });
      return;
    }
    try {
      const plugin = await loader.installFromScript(id, manifest, script);
      res.json({ ok: plugin.status === 'active', plugin: { id: plugin.manifest.id, status: plugin.status, error: plugin.error } });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // POST /api/plugins/:id/reload — reload a plugin
  router.post('/:id/reload', async (req: Request, res: Response) => {
    try {
      const plugin = await loader.loadPlugin(req.params.id);
      res.json({ ok: plugin.status === 'active', status: plugin.status, error: plugin.error });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // DELETE /api/plugins/:id — uninstall a plugin
  router.delete('/:id', (req: Request, res: Response) => {
    const ok = loader.uninstallPlugin(req.params.id);
    if (!ok) { res.status(404).json({ error: 'Plugin not found' }); return; }
    res.json({ ok: true });
  });

  // POST /api/plugins/:id/execute — run a plugin command
  router.post('/:id/execute', async (req: Request, res: Response) => {
    const plugin = loader.getPlugin(req.params.id);
    if (!plugin) { res.status(404).json({ error: 'Plugin not found' }); return; }
    if (plugin.status !== 'active') { res.status(400).json({ error: 'Plugin not active' }); return; }
    if (!plugin.execute) { res.status(400).json({ error: 'Plugin has no execute function' }); return; }
    const { command, args, agentId, role, username } = req.body as {
      command?: string; args?: Record<string, unknown>; agentId?: string; role?: string; username?: string;
    };
    if (!command) { res.status(400).json({ error: 'command is required' }); return; }
    try {
      const result = await plugin.execute(command, args || {}, { agentId: agentId || 'system', role: role || 'viewer', username });
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  return router;
}

import { Router, Request, Response } from 'express';
import type { PluginLoader, PluginManifest } from '../plugins/PluginLoader.js';

export function createPluginRouter(pluginLoader: PluginLoader): Router {
  const router = Router();

  // List all plugins
  router.get('/', (_req: Request, res: Response) => {
    const plugins = pluginLoader.listLoaded();
    res.json({
      total: plugins.length,
      active: plugins.filter(p => p.status === 'active').length,
      error: plugins.filter(p => p.status === 'error').length,
      plugins: plugins.map(p => ({
        id: p.manifest.id,
        name: p.manifest.name,
        description: p.manifest.description,
        version: p.manifest.version,
        author: p.manifest.author,
        category: p.manifest.category,
        status: p.status,
        error: p.error,
        loadedAt: p.loadedAt,
        commands: p.commands || [],
        permissions: p.manifest.permissions || [],
        tags: p.manifest.tags || []
      }))
    });
  });

  // Get single plugin details
  router.get('/:id', (req: Request, res: Response) => {
    const plugin = pluginLoader.getPlugin(req.params.id);
    if (!plugin) { res.status(404).json({ error: 'Plugin not found' }); return; }
    res.json({
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      description: plugin.manifest.description,
      version: plugin.manifest.version,
      author: plugin.manifest.author,
      category: plugin.manifest.category,
      status: plugin.status,
      error: plugin.error,
      loadedAt: plugin.loadedAt,
      commands: plugin.commands || [],
      dir: plugin.dir
    });
  });

  // Install plugin from inline script
  router.post('/install', async (req: Request, res: Response) => {
    try {
      const { id, manifest, script } = req.body as { id: string; manifest: PluginManifest; script: string };
      if (!id || !manifest || !script) {
        res.status(400).json({ error: 'id, manifest, and script are required' });
        return;
      }
      const result = await pluginLoader.installFromScript(id, manifest, script);
      res.json({ success: result.status === 'active', plugin: { id: result.manifest.id, name: result.manifest.name, status: result.status, error: result.error } });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Reload a specific plugin (hot-reload)
  router.post('/:id/reload', async (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      await pluginLoader.unloadPlugin(id);
      const result = await pluginLoader.loadPlugin(id);
      res.json({ success: result.status === 'active', plugin: { id: result.manifest.id, name: result.manifest.name, status: result.status, error: result.error } });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Reload all plugins
  router.post('/reload-all', async (_req: Request, res: Response) => {
    try {
      const result = await pluginLoader.loadAll();
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Uninstall plugin
  router.delete('/:id', (req: Request, res: Response) => {
    const success = pluginLoader.uninstallPlugin(req.params.id);
    if (!success) { res.status(404).json({ error: 'Plugin not found' }); return; }
    res.json({ success: true, message: `Plugin ${req.params.id} uninstalled` });
  });

  // Execute plugin command
  router.post('/:id/execute', async (req: Request, res: Response) => {
    try {
      const plugin = pluginLoader.getPlugin(req.params.id);
      if (!plugin) { res.status(404).json({ error: 'Plugin not found' }); return; }
      if (plugin.status !== 'active' || !plugin.execute) {
        res.status(400).json({ error: 'Plugin is not active or has no execute function' });
        return;
      }
      const { command, args } = req.body as { command: string; args?: Record<string, unknown> };
      const context = { agentId: req.auth?.username || 'system', role: req.auth?.role || 'viewer', username: req.auth?.username };
      const result = await plugin.execute(command, args || {}, context);
      res.json({ success: true, result });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}

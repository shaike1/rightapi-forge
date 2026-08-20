// Extended Skills API router
import express from 'express';
import { KubernetesSkill } from '../skills/extended/KubernetesSkill.js';
import { DatabaseSkill } from '../skills/extended/DatabaseSkill.js';
import { DockerSkill } from '../skills/extended/DockerSkill.js';

export function createExtendedSkillsRouter(): express.Router {
  const router = express.Router();

  const k8s = new KubernetesSkill();
  const db = new DatabaseSkill();
  const docker = new DockerSkill();

  // List available skills
  router.get('/skills', (_req, res) => {
    res.json({
      skills: [
        { id: k8s.id, name: k8s.name, description: k8s.description, category: k8s.category, version: k8s.version,
          actions: ['get-pods','get-deployments','get-services','get-nodes','logs','describe-pod','scale','restart','top-pods','top-nodes'] },
        { id: db.id, name: db.name, description: db.description, category: db.category, version: db.version,
          actions: ['pg-query','pg-list-dbs','pg-list-tables','pg-backup','mysql-query','mysql-list-dbs','mysql-list-tables','mysql-backup'] },
        { id: docker.id, name: docker.name, description: docker.description, category: docker.category, version: docker.version,
          actions: ['list-containers','list-images','inspect','logs','start','stop','restart','stats','exec','pull','rm','prune'] },
      ],
      count: 3
    });
  });

  // Execute Kubernetes action
  router.post('/k8s/:action', async (req, res) => {
    const action = String(req.params.action);
    const params = req.body || {};
    const result = await k8s.execute(action, params);
    res.json(result);
  });

  // Execute Database action
  router.post('/db/:action', async (req, res) => {
    const action = String(req.params.action);
    const params = req.body || {};
    const result = await db.execute(action, params);
    res.json(result);
  });

  // Execute Docker action
  router.post('/docker/:action', async (req, res) => {
    const action = String(req.params.action);
    const params = req.body || {};
    const result = await docker.execute(action, params);
    res.json(result);
  });

  return router;
}

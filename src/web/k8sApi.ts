// /api/k8s/* — Kubernetes cluster introspection. Extracted from server.ts.
//
// Routes (mount at /api/k8s):
//   GET /status                       (no auth — preserved 1:1)
//   GET /namespaces
//   GET /pods?namespace=X
//   GET /deployments?namespace=X
//   GET /nodes
//   GET /events?namespace=X
//
// All endpoints fall back to `{ configured: false, items: [] }` when no
// kubeconfig is available, and `{ configured: true, items: [], error }`
// when the API call fails — matches the inline behavior 1:1. None of
// the routes auth-check; the deployment is expected to handle that
// upstream (e.g. ingress / oauth-proxy).
//
// The kubeconfig reader (parseKubeconfig + loadK8sConfig) and the raw
// HTTPS k8s client (k8sRequest) plus the duration formatter
// (ageFromTimestamp) are passed in as deps. Eventually they should
// move out of server.ts into a dedicated K8sClient module — leaving
// them in place here keeps the diff small.

import { Router, type Request, type Response } from 'express';

interface K8sConfigLike {
  cluster: { server: string; insecureSkipTlsVerify?: boolean; caData?: string };
  user: { token?: string; certData?: string; keyData?: string };
}

export interface K8sApiDeps {
  loadK8sConfig: () => K8sConfigLike | null;
  k8sRequest: (cfg: K8sConfigLike, apiPath: string) => Promise<unknown>;
  ageFromTimestamp: (ts?: string) => string;
}

export function createK8sRouter(deps: K8sApiDeps): Router {
  const router = Router();
  const { loadK8sConfig, k8sRequest, ageFromTimestamp } = deps;

  router.get('/status', (_req: Request, res: Response) => {
    const cfg = loadK8sConfig();
    if (!cfg) {
      res.json({ configured: false, version: null });
      return;
    }
    k8sRequest(cfg, '/version')
      .then((v: any) => res.json({ configured: true, version: v?.gitVersion ?? 'unknown' }))
      .catch(() => res.json({ configured: true, version: 'unknown' }));
  });

  router.get('/namespaces', async (_req: Request, res: Response) => {
    const cfg = loadK8sConfig();
    if (!cfg) { res.json({ configured: false, items: [] }); return; }
    try {
      const data: any = await k8sRequest(cfg, '/api/v1/namespaces');
      const items = (data?.items ?? []).map((ns: any) => ({
        name: ns.metadata?.name,
        status: ns.status?.phase,
        age: ageFromTimestamp(ns.metadata?.creationTimestamp),
      }));
      res.json({ configured: true, items });
    } catch (e) {
      res.json({ configured: true, items: [], error: (e as Error).message });
    }
  });

  router.get('/pods', async (req: Request, res: Response) => {
    const cfg = loadK8sConfig();
    if (!cfg) { res.json({ configured: false, items: [] }); return; }
    try {
      const ns = req.query.namespace as string | undefined;
      const apiPath = ns ? `/api/v1/namespaces/${ns}/pods` : '/api/v1/pods';
      const data: any = await k8sRequest(cfg, apiPath);
      const items = (data?.items ?? []).map((pod: any) => {
        const containerStatuses = pod.status?.containerStatuses ?? [];
        const restarts = containerStatuses.reduce((sum: number, c: any) => sum + (c.restartCount ?? 0), 0);
        const waitingReason = containerStatuses[0]?.state?.waiting?.reason;
        const phase = pod.status?.phase ?? 'Unknown';
        const podStatus = waitingReason ?? phase;
        return {
          name: pod.metadata?.name,
          namespace: pod.metadata?.namespace,
          status: podStatus,
          restarts,
          age: ageFromTimestamp(pod.metadata?.creationTimestamp),
          node: pod.spec?.nodeName ?? '—',
        };
      });
      res.json({ configured: true, items });
    } catch (e) {
      res.json({ configured: true, items: [], error: (e as Error).message });
    }
  });

  router.get('/deployments', async (req: Request, res: Response) => {
    const cfg = loadK8sConfig();
    if (!cfg) { res.json({ configured: false, items: [] }); return; }
    try {
      const ns = req.query.namespace as string | undefined;
      const apiPath = ns ? `/apis/apps/v1/namespaces/${ns}/deployments` : '/apis/apps/v1/deployments';
      const data: any = await k8sRequest(cfg, apiPath);
      const items = (data?.items ?? []).map((d: any) => ({
        name: d.metadata?.name,
        namespace: d.metadata?.namespace,
        ready: `${d.status?.readyReplicas ?? 0}/${d.spec?.replicas ?? 0}`,
        upToDate: d.status?.updatedReplicas ?? 0,
        available: d.status?.availableReplicas ?? 0,
        age: ageFromTimestamp(d.metadata?.creationTimestamp),
      }));
      res.json({ configured: true, items });
    } catch (e) {
      res.json({ configured: true, items: [], error: (e as Error).message });
    }
  });

  router.get('/nodes', async (_req: Request, res: Response) => {
    const cfg = loadK8sConfig();
    if (!cfg) { res.json({ configured: false, items: [] }); return; }
    try {
      const data: any = await k8sRequest(cfg, '/api/v1/nodes');
      const items = (data?.items ?? []).map((node: any) => {
        const readyCond = (node.status?.conditions ?? []).find((c: any) => c.type === 'Ready');
        const nodeStatus = readyCond?.status === 'True' ? 'Ready' : 'NotReady';
        const roles = Object.keys(node.metadata?.labels ?? {})
          .filter(k => k.startsWith('node-role.kubernetes.io/'))
          .map(k => k.replace('node-role.kubernetes.io/', ''))
          .join(',') || 'worker';
        const alloc = node.status?.allocatable ?? {};
        return {
          name: node.metadata?.name,
          status: nodeStatus,
          roles,
          age: ageFromTimestamp(node.metadata?.creationTimestamp),
          version: node.status?.nodeInfo?.kubeletVersion ?? '—',
          cpu: alloc.cpu ?? '—',
          memory: alloc.memory ?? '—',
        };
      });
      res.json({ configured: true, items });
    } catch (e) {
      res.json({ configured: true, items: [], error: (e as Error).message });
    }
  });

  router.get('/events', async (req: Request, res: Response) => {
    const cfg = loadK8sConfig();
    if (!cfg) { res.json({ configured: false, items: [] }); return; }
    try {
      const ns = req.query.namespace as string | undefined;
      const apiPath = ns ? `/api/v1/namespaces/${ns}/events` : '/api/v1/events';
      const data: any = await k8sRequest(cfg, apiPath);
      const items = ((data?.items ?? []) as any[])
        .sort((a, b) => {
          const ta = new Date(a.lastTimestamp ?? a.metadata?.creationTimestamp ?? 0).getTime();
          const tb = new Date(b.lastTimestamp ?? b.metadata?.creationTimestamp ?? 0).getTime();
          return tb - ta;
        })
        .slice(0, 50)
        .map((ev: any) => ({
          type: ev.type ?? 'Normal',
          reason: ev.reason ?? '—',
          object: `${ev.involvedObject?.kind ?? ''}/${ev.involvedObject?.name ?? ''}`,
          message: ev.message ?? '—',
          age: ageFromTimestamp(ev.lastTimestamp ?? ev.metadata?.creationTimestamp),
        }));
      res.json({ configured: true, items });
    } catch (e) {
      res.json({ configured: true, items: [], error: (e as Error).message });
    }
  });

  return router;
}

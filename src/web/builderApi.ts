import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  BuilderProjectRegistry,
  AppGenerator,
  PreviewRuntime,
  QualityGateRunner,
  QualityEvidenceRegistry,
  ManagedIntegrationRegistry,
  ManagedIntegrationBroker,
  ToolCatalog,
  ToolReleaseManager,
  applyVisualEdit,
  artifactChecksumFor,
  draftAppSpecFromMessage,
  formatAppSpecError,
  revisionDiff,
  AppSpecEditor,
  ToolLaunchRuntime,
  type BuilderProjectStatus,
} from '../builder/index.js';
import { SYSTEM_TENANT_ID } from '../tenancy/index.js';

export interface BuilderApiDeps {
  registry: BuilderProjectRegistry;
  generator: AppGenerator;
  previews: PreviewRuntime;
  gateRunner: QualityGateRunner;
  gateEvidence: QualityEvidenceRegistry;
  releases: ToolReleaseManager;
  connections: ManagedIntegrationRegistry;
  integrationBroker: ManagedIntegrationBroker;
  specEditor: AppSpecEditor;
  launches: ToolLaunchRuntime;
  catalog: ToolCatalog;
  authenticate: RequestHandler;
  requirePermission: (permission: string) => RequestHandler;
}

export function createBuilderRouter({ registry, generator, previews, gateRunner, gateEvidence, releases, connections, integrationBroker, specEditor, launches, catalog, authenticate, requirePermission }: BuilderApiDeps): Router {
  const router = Router();
  router.use((req, res, next) => publicSessionPath(req.path) ? next() : authenticate(req, res, next));
  const scope = (req: Request) => ({
    tenantId: req.tenant?.tenantId ?? SYSTEM_TENANT_ID,
    actor: req.auth?.username ?? 'builder',
  });

  router.get('/projects', requirePermission('builder.read'), (req: Request, res: Response) => {
    const { tenantId } = scope(req);
    const includeArchived = req.query.includeArchived === 'true';
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json({ projects: registry.list(tenantId, { includeArchived, limit }) });
  });

  router.get('/catalog', requirePermission('builder.read'), (req: Request, res: Response) => {
    const lifecycle = typeof req.query.lifecycle === 'string' && ['draft', 'ready', 'archived'].includes(req.query.lifecycle)
      ? req.query.lifecycle as BuilderProjectStatus : undefined;
    res.json({ tools: catalog.list(scope(req).tenantId, { query: typeof req.query.q === 'string' ? req.query.q : undefined, lifecycle }) });
  });

  router.post('/catalog/:id/launch', requirePermission('builder.read'), (req: Request, res: Response) => {
    try {
      const tool = catalog.recordLaunch(param(req, 'id'), scope(req).tenantId);
      if (!tool) { res.status(404).json({ error: 'active tool not found' }); return; }
      const deployment = tool.deploymentId ? releases.getDeployment(tool.deploymentId, scope(req).tenantId) : null;
      if (!deployment?.runtimeRef) { res.status(409).json({ error: 'tool runtime is unavailable' }); return; }
      const created = launches.create({ tenantId: scope(req).tenantId, projectId: tool.id, deploymentId: deployment.id, runtimeRef: deployment.runtimeRef, actor: scope(req).actor });
      res.json({ tool, session: created.session, accessUrl: `/api/builder/catalog/launches/${created.session.id}/access?token=${encodeURIComponent(created.accessToken)}` });
    } catch (error) { sendBuilderError(res, error); }
  });

  router.get('/catalog/launches/:id/access', (req: Request, res: Response) => {
    const id = param(req, 'id'); const token = typeof req.query.token === 'string' ? req.query.token : '';
    const exchanged = launches.exchange(id, token);
    if (!exchanged) { res.status(403).type('text/plain').send('Tool access denied'); return; }
    const maxAge = Math.max(1, Math.floor((Date.parse(exchanged.session.expiresAt) - Date.now()) / 1000));
    const secure = req.secure || req.header('x-forwarded-proto') === 'https';
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.cookie(launchCookieName(id), exchanged.cookie, { httpOnly: true, sameSite: 'strict', secure, maxAge: maxAge * 1000, path: `/api/builder/catalog/launches/${id}/proxy` });
    res.redirect(303, `/api/builder/catalog/launches/${id}/proxy/`);
  });

  const launchProxy = async (req: Request, res: Response) => {
    const id = param(req, 'id'); const cookie = readCookie(req.header('cookie') ?? '', launchCookieName(id));
    if (!cookie || !launches.authorize(id, cookie)) { res.status(403).type('text/plain').send('Tool access denied'); return; }
    try {
      const suffix = typeof req.params[0] === 'string' ? req.params[0] : '';
      const requestUrl = new URL(req.originalUrl, 'http://tool.local'); const path = `/${suffix}${requestUrl.search}`;
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.from(req.body === undefined ? '' : JSON.stringify(req.body));
      const response = await launches.request(id, cookie, { method: req.method, path, headers: { accept: req.header('accept') ?? '*/*', 'content-type': req.header('content-type') ?? 'application/json' }, body });
      for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, name === 'location' && value.startsWith('/') ? `/api/builder/catalog/launches/${id}/proxy${value}` : value);
      res.status(response.status); if (req.method === 'HEAD') res.end(); else res.send(response.body);
    } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : String(error) }); }
  };
  router.all('/catalog/launches/:id/proxy', launchProxy);
  router.all('/catalog/launches/:id/proxy/*', launchProxy);

  router.patch('/catalog/:id/lifecycle', requirePermission('builder.build'), (req: Request, res: Response) => {
    const status = req.body?.status as BuilderProjectStatus;
    if (!['draft', 'ready', 'archived'].includes(status)) { res.status(400).json({ error: 'status must be draft, ready, or archived' }); return; }
    const project = registry.setStatus(param(req, 'id'), scope(req).tenantId, status);
    if (!project) { res.status(404).json({ error: 'tool not found' }); return; }
    res.json({ project });
  });

  router.get('/connections', requirePermission('builder.read'), (req: Request, res: Response) => {
    res.json({ connections: connections.list(scope(req).tenantId) });
  });

  router.post('/connections', requirePermission('builder.build'), (req: Request, res: Response) => {
    try { res.status(201).json({ connection: connections.create({ tenantId: scope(req).tenantId, actor: scope(req).actor, connection: req.body }) }); }
    catch (error) { sendBuilderError(res, error); }
  });

  router.patch('/connections/:id/status', requirePermission('builder.build'), (req: Request, res: Response) => {
    const status = req.body?.status;
    if (!['ready', 'disabled'].includes(status)) { res.status(400).json({ error: 'status must be ready or disabled' }); return; }
    const connection = connections.setStatus(param(req, 'id'), scope(req).tenantId, status);
    if (!connection) { res.status(404).json({ error: 'connection not found' }); return; }
    res.json({ connection });
  });

  router.post('/projects/:id/integration-grants', requirePermission('builder.build'), (req: Request, res: Response) => {
    const { tenantId, actor } = scope(req); const project = registry.get(param(req, 'id'), tenantId);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    const integrationId = typeof req.body?.integrationId === 'string' ? req.body.integrationId : '';
    const capability = typeof req.body?.capability === 'string' ? req.body.capability : '';
    const integration = project.revision.spec.integrations.find(item => item.id === integrationId);
    if (!integration || !integration.capabilities.includes(capability)) {
      res.status(403).json({ error: 'capability is not declared by the current tool revision' }); return;
    }
    try { res.status(201).json(integrationBroker.issue({ tenantId, projectId: project.id, connectionRef: integration.connectionRef, capability, actor })); }
    catch (error) { sendBuilderError(res, error); }
  });

  router.post('/projects/:id/integrations/invoke', requirePermission('builder.read'), async (req: Request, res: Response) => {
    const { tenantId, actor } = scope(req); const project = registry.get(param(req, 'id'), tenantId);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    if (typeof req.body?.grant !== 'string') { res.status(400).json({ error: 'grant is required' }); return; }
    try { res.json(await integrationBroker.invoke({ grant: req.body.grant, tenantId, projectId: project.id, actor, body: req.body?.payload })); }
    catch (error) { sendBuilderError(res, error); }
  });

  router.get('/projects/:id/integration-calls', requirePermission('builder.read'), (req: Request, res: Response) => {
    const { tenantId } = scope(req); const project = registry.get(param(req, 'id'), tenantId);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    res.json({ calls: integrationBroker.calls(tenantId, project.id) });
  });

  router.post('/conversations', requirePermission('builder.build'), (req: Request, res: Response) => {
    const { tenantId, actor } = scope(req);
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > 5000) { res.status(400).json({ error: 'message must contain 1-5000 characters' }); return; }
    try {
      const spec = req.body?.proposedSpec ?? draftAppSpecFromMessage(message);
      const project = registry.create({ tenantId, actor, message, spec });
      res.status(201).json({ project, specificationOnly: true });
    } catch (error) {
      sendBuilderError(res, error);
    }
  });

  router.get('/projects/:id', requirePermission('builder.read'), (req: Request, res: Response) => {
    const project = registry.get(param(req, 'id'), scope(req).tenantId);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    res.json({ project, editState: registry.editState(project.id, project.tenantId) });
  });

  router.get('/projects/:id/revisions', requirePermission('builder.read'), (req: Request, res: Response) => {
    const id = param(req, 'id');
    const { tenantId } = scope(req);
    if (!registry.get(id, tenantId)) { res.status(404).json({ error: 'project not found' }); return; }
    res.json({ revisions: registry.revisions(id, tenantId) });
  });

  router.get('/projects/:id/revisions/compare', requirePermission('builder.read'), (req: Request, res: Response) => {
    const { tenantId } = scope(req);
    const project = registry.get(param(req, 'id'), tenantId);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    const from = Number(req.query.from); const to = Number(req.query.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from === to) {
      res.status(400).json({ error: 'from and to must be different positive revision numbers' }); return;
    }
    const revisions = registry.revisions(project.id, tenantId);
    const previous = revisions.find(item => item.revision === from);
    const current = revisions.find(item => item.revision === to);
    if (!previous || !current) { res.status(404).json({ error: 'revision not found' }); return; }
    res.json({ from, to, diff: revisionDiff(current.spec, previous.spec, previous.revision) });
  });

  router.post('/projects/:id/generate', requirePermission('builder.build'), (req: Request, res: Response) => {
    const project = registry.get(param(req, 'id'), scope(req).tenantId);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    try {
      const artifact = generator.generate({
        projectId: project.id,
        revision: project.currentRevision,
        spec: project.revision.spec,
        generatedAt: project.revision.createdAt,
      });
      res.json({ artifact, executed: false });
    } catch (error) {
      sendBuilderError(res, error);
    }
  });

  router.get('/projects/:id/gates', requirePermission('builder.read'), (req: Request, res: Response) => {
    const project = registry.get(param(req, 'id'), scope(req).tenantId);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    const revision = req.query.revision === undefined ? undefined : Number(req.query.revision);
    if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) {
      res.status(400).json({ error: 'revision must be a positive integer' }); return;
    }
    res.json({ evidence: gateEvidence.list(project.id, project.tenantId, revision) });
  });

  router.post('/projects/:id/gates', requirePermission('builder.build'), async (req: Request, res: Response) => {
    const { tenantId, actor } = scope(req);
    const project = registry.get(param(req, 'id'), tenantId);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    try {
      const artifact = generator.generate({
        projectId: project.id, revision: project.currentRevision, spec: project.revision.spec,
        generatedAt: project.revision.createdAt,
      });
      const evidence = await gateRunner.run({ tenantId, projectId: project.id, revision: project.currentRevision, actor, artifact });
      gateEvidence.save(evidence);
      res.status(201).json({ evidence });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(/capacity/.test(message) ? 429 : 503).json({ error: message });
    }
  });

  router.get('/gates/:id', requirePermission('builder.read'), (req: Request, res: Response) => {
    const evidence = gateEvidence.get(param(req, 'id'), scope(req).tenantId);
    if (!evidence) { res.status(404).json({ error: 'gate evidence not found' }); return; }
    res.json({ evidence, signatureValid: gateRunner.verify(evidence) });
  });

  router.get('/projects/:id/releases', requirePermission('builder.read'), (req: Request, res: Response) => {
    const project = registry.get(param(req, 'id'), scope(req).tenantId);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    res.json({ releases: releases.listReleases(project.id, project.tenantId) });
  });

  router.post('/projects/:id/releases', requirePermission('builder.build'), (req: Request, res: Response) => {
    const { tenantId, actor } = scope(req); const project = registry.get(param(req, 'id'), tenantId);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    const artifact = generator.generate({ projectId: project.id, revision: project.currentRevision, spec: project.revision.spec, generatedAt: project.revision.createdAt });
    const evidence = gateEvidence.latestPassing(project.id, tenantId, project.currentRevision, artifactChecksumFor(artifact));
    if (!evidence || !gateRunner.verify(evidence)) { res.status(409).json({ error: 'current revision must pass quality gates before release review' }); return; }
    const previous = registry.revisions(project.id, tenantId).find(item => item.revision === project.currentRevision - 1);
    try {
      const release = releases.request({ tenantId, projectId: project.id, revision: project.currentRevision, actor, artifactChecksum: artifactChecksumFor(artifact), evidence, spec: project.revision.spec, previousSpec: previous?.spec, previousRevision: previous?.revision });
      res.status(201).json({ release });
    } catch (error) { sendBuilderError(res, error); }
  });

  router.get('/releases/:id', requirePermission('builder.read'), (req: Request, res: Response) => {
    const release = releases.getRelease(param(req, 'id'), scope(req).tenantId);
    if (!release) { res.status(404).json({ error: 'release not found' }); return; }
    res.json({ release, events: releases.events(release.id, release.tenantId) });
  });

  router.post('/releases/:id/review', requirePermission('builder.review'), (req: Request, res: Response) => {
    const decision = req.body?.decision;
    if (!['approved', 'rejected'].includes(decision)) { res.status(400).json({ error: 'decision must be approved or rejected' }); return; }
    try {
      const release = releases.review(param(req, 'id'), scope(req).tenantId, scope(req).actor, decision as 'approved' | 'rejected', typeof req.body?.note === 'string' ? req.body.note : '');
      if (!release) { res.status(404).json({ error: 'release not found' }); return; }
      res.json({ release });
    } catch (error) { sendBuilderError(res, error); }
  });

  router.post('/releases/:id/deploy', requirePermission('builder.deploy'), async (req: Request, res: Response) => {
    const { tenantId, actor } = scope(req); const release = releases.getRelease(param(req, 'id'), tenantId);
    if (!release) { res.status(404).json({ error: 'release not found' }); return; }
    const revision = registry.revisions(release.projectId, tenantId).find(item => item.revision === release.revision);
    if (!revision) { res.status(409).json({ error: 'release revision is no longer available' }); return; }
    const artifact = generator.generate({ projectId: release.projectId, revision: release.revision, spec: revision.spec, generatedAt: revision.createdAt });
    const evidence = gateEvidence.get(release.evidenceId, tenantId);
    try {
      const result = await releases.deploy({ id: release.id, tenantId, actor, artifact, evidenceValid: !!evidence && gateRunner.verify(evidence) });
      res.status(result.deployment.status === 'healthy' ? 201 : 502).json(result);
    } catch (error) { sendBuilderError(res, error); }
  });

  router.get('/projects/:id/deployments', requirePermission('builder.read'), (req: Request, res: Response) => {
    const project = registry.get(param(req, 'id'), scope(req).tenantId);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    res.json({ deployments: releases.listDeployments(project.id, project.tenantId) });
  });

  router.post('/deployments/:id/rollback', requirePermission('builder.deploy'), async (req: Request, res: Response) => {
    const target = typeof req.body?.targetDeploymentId === 'string' ? req.body.targetDeploymentId : '';
    if (!target) { res.status(400).json({ error: 'targetDeploymentId is required' }); return; }
    try { res.json(await releases.rollback({ deploymentId: param(req, 'id'), targetDeploymentId: target, tenantId: scope(req).tenantId, actor: scope(req).actor })); }
    catch (error) { sendBuilderError(res, error); }
  });

  router.get('/previews', requirePermission('builder.read'), (req: Request, res: Response) => {
    res.json({ previews: previews.list(scope(req).tenantId) });
  });

  router.post('/projects/:id/previews', requirePermission('builder.build'), async (req: Request, res: Response) => {
    const { tenantId, actor } = scope(req);
    const project = registry.get(param(req, 'id'), tenantId);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    const roleId = typeof req.body?.roleId === 'string' ? req.body.roleId : project.revision.spec.roles[0]?.id;
    if (!roleId || !project.revision.spec.roles.some(role => role.id === roleId)) {
      res.status(400).json({ error: 'roleId must reference a role in the current specification' });
      return;
    }
    try {
      const artifact = generator.generate({
        projectId: project.id, revision: project.currentRevision, spec: project.revision.spec,
        generatedAt: project.revision.createdAt,
      });
      const passed = gateEvidence.latestPassing(project.id, tenantId, project.currentRevision, artifactChecksumFor(artifact));
      if (!passed || !gateRunner.verify(passed)) {
        res.status(409).json({ error: 'current revision must pass quality gates before preview' });
        return;
      }
      const created = await previews.create({
        tenantId, projectId: project.id, revision: project.currentRevision, roleId, actor, artifact,
        ttlMinutes: req.body?.ttlMinutes === undefined ? undefined : Number(req.body.ttlMinutes),
      });
      res.status(201).json({
        session: created.session,
        accessToken: created.accessToken,
        accessUrl: `/api/builder/previews/${created.session.id}/access?token=${encodeURIComponent(created.accessToken)}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(/capacity/.test(message) ? 429 : 503).json({ error: message });
    }
  });

  router.get('/previews/:id', requirePermission('builder.read'), (req: Request, res: Response) => {
    const session = previews.get(param(req, 'id'), scope(req).tenantId);
    if (!session) { res.status(404).json({ error: 'preview not found' }); return; }
    res.json({ session });
  });

  router.get('/previews/:id/logs', requirePermission('builder.read'), async (req: Request, res: Response) => {
    const logs = await previews.logs(param(req, 'id'), scope(req).tenantId, Number(req.query.tail ?? 200));
    if (logs === null) { res.status(404).json({ error: 'preview not found' }); return; }
    res.type('text/plain').send(logs);
  });

  router.delete('/previews/:id', requirePermission('builder.build'), async (req: Request, res: Response) => {
    const session = await previews.stop(param(req, 'id'), scope(req).tenantId);
    if (!session) { res.status(404).json({ error: 'preview not found' }); return; }
    res.json({ session });
  });

  router.get('/previews/:id/access', (req: Request, res: Response) => {
    const id = param(req, 'id');
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const session = previews.authorize(id, token);
    if (!session) { res.status(403).type('text/plain').send('Preview access denied'); return; }
    const maxAge = Math.max(1, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000));
    const secure = req.secure || req.header('x-forwarded-proto') === 'https';
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.cookie(previewCookieName(id), token, {
      httpOnly: true, sameSite: 'strict', secure, maxAge: maxAge * 1000,
      path: `/api/builder/previews/${id}/proxy`,
    });
    res.redirect(303, `/api/builder/previews/${id}/proxy/`);
  });

  const proxy = async (req: Request, res: Response) => {
    const id = param(req, 'id');
    const token = readCookie(req.header('cookie') ?? '', previewCookieName(id));
    if (!token || !previews.authorize(id, token)) { res.status(403).type('text/plain').send('Preview access denied'); return; }
    try {
      const suffix = typeof req.params[0] === 'string' ? req.params[0] : '';
      const requestUrl = new URL(req.originalUrl, 'http://preview.local');
      const path = `/${suffix}${requestUrl.search}`;
      const body = ['GET', 'HEAD'].includes(req.method)
        ? undefined
        : Buffer.from(req.body === undefined ? '' : JSON.stringify(req.body));
      const response = await previews.request(id, token, {
        method: req.method, path,
        headers: {
          accept: req.header('accept') ?? '*/*',
          'content-type': req.header('content-type') ?? 'application/json',
          'if-none-match': req.header('if-none-match') ?? '',
        },
        body,
      });
      for (const [name, value] of Object.entries(response.headers)) {
        if (name === 'location' && value.startsWith('/')) {
          res.setHeader(name, `/api/builder/previews/${id}/proxy${value}`);
        } else {
          res.setHeader(name, value);
        }
      }
      res.status(response.status);
      if (req.method === 'HEAD') res.end(); else res.send(response.body);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };
  router.all('/previews/:id/proxy', proxy);
  router.all('/previews/:id/proxy/*', proxy);

  router.post('/projects/:id/messages', requirePermission('builder.build'), async (req: Request, res: Response) => {
    const { tenantId, actor } = scope(req);
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > 5000) { res.status(400).json({ error: 'message must contain 1-5000 characters' }); return; }
    try {
      const expectedRevision = req.body?.expectedRevision === undefined
        ? undefined
        : Number(req.body.expectedRevision);
      if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) {
        res.status(400).json({ error: 'expectedRevision must be a positive integer' });
        return;
      }
      const current = registry.get(param(req, 'id'), tenantId);
      if (!current) { res.status(404).json({ error: 'project not found' }); return; }
      const spec = req.body?.proposedSpec === undefined
        ? await specEditor.edit(current.revision.spec, message)
        : req.body.proposedSpec;
      const project = registry.revise({
        projectId: param(req, 'id'), tenantId, actor, message,
        spec, expectedRevision,
      });
      if (!project) { res.status(404).json({ error: 'project not found' }); return; }
      res.json({ project, specificationOnly: true });
    } catch (error) {
      sendBuilderError(res, error);
    }
  });

  router.post('/projects/:id/visual-edits', requirePermission('builder.build'), (req: Request, res: Response) => {
    const { tenantId, actor } = scope(req);
    const current = registry.get(param(req, 'id'), tenantId);
    if (!current) { res.status(404).json({ error: 'project not found' }); return; }
    const expectedRevision = req.body?.expectedRevision === undefined ? undefined : Number(req.body.expectedRevision);
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) {
      res.status(400).json({ error: 'expectedRevision must be a positive integer' }); return;
    }
    try {
      const spec = applyVisualEdit(current.revision.spec, req.body?.edit);
      const project = registry.revise({ projectId: current.id, tenantId, actor, message: 'Visual property edit', spec, expectedRevision });
      res.json({ project, editState: registry.editState(current.id, tenantId) });
    } catch (error) { sendBuilderError(res, error); }
  });

  for (const direction of ['undo', 'redo'] as const) {
    router.post(`/projects/:id/${direction}`, requirePermission('builder.build'), (req: Request, res: Response) => {
      const { tenantId, actor } = scope(req);
      const expectedRevision = req.body?.expectedRevision === undefined ? undefined : Number(req.body.expectedRevision);
      if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) {
        res.status(400).json({ error: 'expectedRevision must be a positive integer' }); return;
      }
      try {
        const project = registry[direction]({ projectId: param(req, 'id'), tenantId, actor, expectedRevision });
        if (!project) { res.status(404).json({ error: 'project not found' }); return; }
        res.json({ project, editState: registry.editState(project.id, tenantId) });
      } catch (error) { sendBuilderError(res, error); }
    });
  }

  router.patch('/projects/:id/status', requirePermission('builder.build'), (req: Request, res: Response) => {
    const allowed = new Set<BuilderProjectStatus>(['draft', 'ready', 'archived']);
    const status = req.body?.status as BuilderProjectStatus;
    if (!allowed.has(status)) { res.status(400).json({ error: 'status must be draft, ready, or archived' }); return; }
    const project = registry.setStatus(param(req, 'id'), scope(req).tenantId, status);
    if (!project) { res.status(404).json({ error: 'project not found' }); return; }
    res.json({ project });
  });

  return router;
}

function param(req: Request, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}

function sendBuilderError(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    res.status(422).json({ error: 'invalid application specification', issues: formatAppSpecError(error) });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/revision conflict|UNIQUE constraint failed|cannot approve|already decided|cannot be reviewed/.test(message)) {
    res.status(409).json({ error: message });
    return;
  }
  res.status(400).json({ error: message });
}

function previewCookieName(id: string): string {
  return `itops_preview_${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

function launchCookieName(id: string): string { return `itops_launch_${id.replace(/[^a-zA-Z0-9_-]/g, '')}`; }

function publicSessionPath(path: string): boolean {
  return /^\/previews\/[^/]+\/(?:access|proxy(?:\/|$))/.test(path)
    || /^\/catalog\/launches\/[^/]+\/(?:access|proxy(?:\/|$))/.test(path);
}

function readCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

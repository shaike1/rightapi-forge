// /api/sdk/* — Self-Development SDK. Extracted from server.ts.
//
// Six endpoints power the dashboard's Develop page + agent automation:
//   POST   /develop            — plan + (optionally) execute
//   POST   /generate-skill     — pure: spec → FileChange[] + tests + scan
//   POST   /generate-workflow  — pure: spec → workflow JSON + scan
//   POST   /test               — sandboxed test runner
//   POST   /deploy             — commit + (optionally) trigger deploy
//   GET    /history            — recent in-process actions
//
// All routes share `settings.manage` permission — same level as
// /api/deploy/*. Mutating routes are also rate-limited inside the
// service itself (max 3 sessions / hour by default).

import { Router, type Request, type Response, type RequestHandler } from 'express';

interface SelfDevelopmentServiceLike {
  developFeature: (opts: {
    description: string;
    autoApprove: boolean;
    allowSecurityWarnings: boolean;
    branch?: string;
    testOnly: boolean;
    actor: string;
  }) => Promise<unknown>;
  generateSkill: (spec: unknown) => unknown;
  generateWorkflow: (spec: unknown) => unknown;
  testCode: (files: any[], tests: any[]) => Promise<unknown>;
  deployChange: (files: any[], message: string, ref?: string) => Promise<unknown>;
  recentHistory: () => unknown;
}

export interface SdkApiDeps {
  selfDevelopmentService: SelfDevelopmentServiceLike;
  requirePermission: (perm: string) => RequestHandler;
}

export function createSdkRouter(deps: SdkApiDeps): Router {
  const router = Router();
  const { selfDevelopmentService, requirePermission } = deps;

  router.post('/develop', requirePermission('settings.manage'), async (req: Request, res: Response) => {
    try {
      const { description, autoApprove, allowSecurityWarnings, branch, testOnly } = req.body ?? {};
      if (!description || typeof description !== 'string') {
        res.status(400).json({ error: 'description (string) is required' });
        return;
      }
      const out = await selfDevelopmentService.developFeature({
        description,
        autoApprove: !!autoApprove,
        allowSecurityWarnings: !!allowSecurityWarnings,
        branch: typeof branch === 'string' ? branch : undefined,
        testOnly: !!testOnly,
        actor: (req as any).user?.username ?? 'sdk',
      });
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post('/generate-skill', requirePermission('settings.manage'), (req: Request, res: Response) => {
    try {
      const result = selfDevelopmentService.generateSkill(req.body?.spec);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post('/generate-workflow', requirePermission('settings.manage'), (req: Request, res: Response) => {
    try {
      const result = selfDevelopmentService.generateWorkflow(req.body?.spec);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post('/test', requirePermission('settings.manage'), async (req: Request, res: Response) => {
    try {
      const { files, tests } = req.body ?? {};
      if (!Array.isArray(files) || !Array.isArray(tests)) {
        res.status(400).json({ error: 'files (FileChange[]) and tests (TestCase[]) are required' });
        return;
      }
      const results = await selfDevelopmentService.testCode(files, tests);
      res.json({ results });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post('/deploy', requirePermission('settings.manage'), async (req: Request, res: Response) => {
    try {
      const { files, message, ref } = req.body ?? {};
      if (!Array.isArray(files) || files.length === 0 || typeof message !== 'string') {
        res.status(400).json({ error: 'files (FileChange[]) and message (string) are required' });
        return;
      }
      const result = await selfDevelopmentService.deployChange(files, message, typeof ref === 'string' ? ref : undefined);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get('/history', requirePermission('settings.manage'), (_req: Request, res: Response) => {
    res.json({ history: selfDevelopmentService.recentHistory() });
  });

  /**
   * One-shot end-to-end smoke check of the SDK pipeline. Hardcodes a
   * trivial feature description, runs developFeature with autoApprove
   * AND testOnly so the pipeline writes files + executes sandboxed
   * tests but DOES NOT commit or deploy. Returns the plan + test
   * results so an operator can verify each stage fired.
   *
   * Useful for: post-deploy verification ("did wiring break?"),
   * CI-style gating before scaling SDK use, and answering "has this
   * thing ever actually worked?" with a curl-able yes/no.
   *
   * Why a separate endpoint instead of curl-ing /develop directly:
   * the input is fixed (small, safe, idempotent), the result is
   * narrowed to a verification-friendly shape, and we don't have to
   * teach operators which combination of flags constitutes a
   * "smoke test".
   */
  router.post('/self-test', requirePermission('settings.manage'), async (req: Request, res: Response) => {
    // The pipeline writes generated files to src/skills/generated/ in
    // testOnly mode (write happens, commit doesn't). To stay idempotent
    // across repeated self-test calls we vary the skill name per
    // invocation — a fixed name would 409 the second time we ran.
    const stamp = Date.now().toString(36);
    const description = `skill: smoketest probe ${stamp} that returns the literal string ok`;
    try {
      const out = await selfDevelopmentService.developFeature({
        description,
        autoApprove: true,
        testOnly: true,
        actor: (req as any).user?.username ?? 'sdk-self-test',
      });
      const failed = out.testResults.filter(t => !t.passed).length;
      res.json({
        ok: failed === 0,
        planId: out.plan.id,
        kind: out.plan.kind,
        files: out.plan.files.length,
        tests: out.testResults.length,
        testsFailed: failed,
        scanFindings: out.plan.scanFindings.length,
        steps: out.plan.steps,
        // Surface the generated file paths so an operator can sweep
        // accumulated probe files when they want to.
        writtenPaths: out.plan.files.map(f => f.path),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  return router;
}

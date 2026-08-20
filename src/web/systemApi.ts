// /api/system/* — system context + state-backup management. Extracted
// from server.ts.
//
// Routes (mount at /api/system):
//   GET  /context                     no auth
//   GET  /backups                     security.read
//   GET  /backups/inventory           security.read
//   POST /backups/create              config.write — also fires async
//                                     S3 upload + prune if configured
//   GET  /backups/:backupId/verify    security.read
//   POST /backups/:backupId/restore   config.write — DESTRUCTIVE; needs
//                                     confirmBackupId + confirmPhrase=RESTORE
//                                     unless dryRun=true (the default)
//   GET  /backups/health              security.read
//   GET  /backups/scheduler           security.read
//   POST /backups/scheduler/run       config.write
//
// Restore writes execution-audit records on both success and failure
// and (when a taskId is supplied) appends a rollback operation to
// that task's timeline.

import { Router, type Request, type Response } from 'express';
import path from 'node:path';
import type { ExecutionAuditStore } from '../security/ExecutionAuditStore.js';
import type { TaskManager } from '../tasks/TaskManager.js';

interface BackupResult {
  files: Array<{ action: string }>;
}

interface StateBackupManagerLike {
  list: (limit?: number) => unknown;
  create: (opts: { label?: string; actorId: string }) => { bundlePath: string; [key: string]: unknown };
  verify: (backupId: string) => unknown;
  restore: (backupId: string, opts: { dryRun: boolean; actorId: string }) => BackupResult;
}

interface S3UploaderLike {
  isConfigured: boolean;
  upload: (path: string) => Promise<{ key: string }>;
  pruneOldBackups: () => Promise<unknown>;
}

interface BackupSchedulerStateLike {
  [key: string]: unknown;
}

interface BackupRunResult {
  success: boolean;
  error?: string;
  backupId?: string;
  pruned?: number;
}

interface RecoveryRunResult {
  success: boolean;
  recoveryId?: string;
  archiveBytes?: number;
  offsiteKey?: string;
  pruned: number;
  error?: string;
}

interface RecoverySetManagerLike {
  list: (limit?: number) => unknown;
  resolveArchivePath: (id: string) => string;
  verify: (archivePath: string) => Promise<unknown>;
  restoreTo: (archivePath: string, targetDir: string) => Promise<unknown>;
}

type AuthResult = { ok: boolean; reason?: string; username?: string; role?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface SystemApiHelpers {
  cryptoRandomId: () => string;
}

export interface SystemApiDeps {
  buildSystemContext: () => unknown;
  stateBackupManager: StateBackupManagerLike;
  s3Uploader: S3UploaderLike;
  computeBackupHealthPayload: () => unknown;
  computeBackupInventoryPayload: () => unknown;
  backupSchedulerState: BackupSchedulerStateLike;
  runAutomatedBackup: (trigger: 'manual' | 'scheduled' | string) => BackupRunResult;
  recoverySetManager: RecoverySetManagerLike | null;
  recoverySchedulerState: BackupSchedulerStateLike;
  runRecoverySet: (trigger: string) => Promise<RecoveryRunResult>;
  recoveryRestoreRoot: string;
  onRecoveryStateChanged: () => void;
  executionAuditStore: ExecutionAuditStore;
  taskManager: TaskManager;
  helpers: SystemApiHelpers;
  log: { info: (msg: string, ctx?: Record<string, unknown>) => void; error: (msg: string, ctx?: Record<string, unknown>) => void };
  validateAuth: AuthCheck;
}

export function createSystemRouter(deps: SystemApiDeps): Router {
  const router = Router();
  const {
    buildSystemContext,
    stateBackupManager,
    s3Uploader,
    computeBackupHealthPayload,
    computeBackupInventoryPayload,
    backupSchedulerState,
    runAutomatedBackup,
    recoverySetManager,
    recoverySchedulerState,
    runRecoverySet,
    recoveryRestoreRoot,
    onRecoveryStateChanged,
    executionAuditStore,
    taskManager,
    helpers,
    log,
    validateAuth,
  } = deps;

  router.get('/context', (_req: Request, res: Response) => {
    res.json(buildSystemContext());
  });

  // /backups/health and /backups/scheduler come BEFORE /backups/:id/* so
  // that "health" / "scheduler" don't get matched as backup IDs.
  router.get('/backups/health', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const payload = computeBackupHealthPayload();
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get('/backups/inventory', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      res.json(computeBackupInventoryPayload());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get('/backups/scheduler', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    res.json({ scheduler: { ...backupSchedulerState }, recoveryScheduler: { ...recoverySchedulerState } });
  });

  router.get('/backups/recovery', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    if (!recoverySetManager) { res.status(503).json({ error: 'Recovery sets require BACKUP_ENCRYPTION_KEY' }); return; }
    res.json({ recoverySets: recoverySetManager.list(req.query.limit ? Number(req.query.limit) : 50), scheduler: recoverySchedulerState });
  });

  router.post('/backups/recovery/run', async (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'config.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const run = await runRecoverySet('manual');
    if (!run.success) { res.status(500).json(run); return; }
    executionAuditStore.append({
      id: helpers.cryptoRandomId(), timestamp: new Date().toISOString(), command: 'system.backup.recovery.run',
      skillId: 'system.backups', agentId: auth.username || 'unknown', agentRole: auth.role || 'operator',
      status: 'allowed', reason: `Recovery set created; recoveryId=${run.recoveryId}, offsite=${run.offsiteKey || 'not-configured'}`,
      approvalRequired: false, credentialIds: [], credentialScopes: [],
    });
    res.json({ ...run, scheduler: recoverySchedulerState });
  });

  router.get('/backups/recovery/:recoveryId/verify', async (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    if (!recoverySetManager) { res.status(503).json({ error: 'Recovery sets require BACKUP_ENCRYPTION_KEY' }); return; }
    try {
      const result = await recoverySetManager.verify(recoverySetManager.resolveArchivePath(req.params.recoveryId));
      res.json(result);
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });

  router.post('/backups/recovery/:recoveryId/restore', async (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'config.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    if (!recoverySetManager) { res.status(503).json({ error: 'Recovery sets require BACKUP_ENCRYPTION_KEY' }); return; }
    if (req.body?.confirmRecoveryId !== req.params.recoveryId || req.body?.confirmPhrase !== 'RESTORE ISOLATED') {
      res.status(400).json({ error: 'confirmRecoveryId and confirmPhrase=RESTORE ISOLATED are required' }); return;
    }
    const targetName = String(req.body?.targetName || '').trim();
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(targetName)) { res.status(400).json({ error: 'A safe targetName is required' }); return; }
    try {
      const targetDir = path.join(recoveryRestoreRoot, targetName);
      const manifest = await recoverySetManager.restoreTo(recoverySetManager.resolveArchivePath(req.params.recoveryId), targetDir);
      recoverySchedulerState.lastRestoreAt = new Date().toISOString();
      recoverySchedulerState.lastRestoreRecoveryId = req.params.recoveryId;
      recoverySchedulerState.lastRestoreTarget = targetDir;
      recoverySchedulerState.lastRestoreError = undefined;
      onRecoveryStateChanged();
      executionAuditStore.append({
        id: helpers.cryptoRandomId(), timestamp: new Date().toISOString(), command: 'system.backup.recovery.restore-isolated',
        skillId: 'system.backups', agentId: auth.username || 'unknown', agentRole: auth.role || 'operator', status: 'allowed',
        reason: `Recovery set restored to isolated target; recoveryId=${req.params.recoveryId}, targetName=${targetName}`,
        approvalRequired: false, credentialIds: [], credentialScopes: [],
      });
      res.json({ restored: true, targetDir, manifest });
    } catch (error) {
      recoverySchedulerState.lastRestoreError = (error as Error).message;
      onRecoveryStateChanged();
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/backups/scheduler/run', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'config.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const run = runAutomatedBackup('manual');
    if (!run.success) {
      res.status(500).json({ success: false, error: run.error || 'Automated backup run failed' });
      return;
    }
    executionAuditStore.append({
      id: helpers.cryptoRandomId(),
      timestamp: new Date().toISOString(),
      command: 'system.backup.scheduler.run',
      skillId: 'system.backups',
      agentId: auth.username || 'unknown',
      agentRole: auth.role || 'operator',
      status: 'allowed',
      reason: `Manual scheduler run success; backupId=${run.backupId || 'unknown'}, pruned=${run.pruned}`,
      approvalRequired: false,
      credentialIds: [],
      credentialScopes: [],
    });
    res.json({ success: true, run, scheduler: backupSchedulerState });
  });

  router.get('/backups', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      res.json({ backups: stateBackupManager.list(limit) });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post('/backups/create', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'config.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const label = req.body?.label ? String(req.body.label) : undefined;
      const backup = stateBackupManager.create({ label, actorId: auth.username || 'unknown' });
      if (s3Uploader.isConfigured) {
        s3Uploader.upload(backup.bundlePath)
          .then(({ key }) => log.info('Backup uploaded to S3', { key }))
          .catch(err => log.error('S3 backup upload failed', { err: err.message }));
        s3Uploader.pruneOldBackups().catch(() => {});
      }
      res.json({ success: true, backup });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get('/backups/:backupId/verify', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const report = stateBackupManager.verify(req.params.backupId);
      res.json(report);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
        return;
      }
      res.status(400).json({ error: message });
    }
  });

  router.post('/backups/:backupId/restore', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'config.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const backupId = String(req.params.backupId);
    const dryRun = req.body?.dryRun !== false;
    if (!dryRun) {
      const confirmBackupId = req.body?.confirmBackupId ? String(req.body.confirmBackupId) : '';
      const confirmPhrase = req.body?.confirmPhrase ? String(req.body.confirmPhrase) : '';
      if (confirmBackupId !== backupId || confirmPhrase !== 'RESTORE') {
        res.status(400).json({
          error: 'Restore confirmation required. Provide confirmBackupId=<backupId> and confirmPhrase=RESTORE.',
        });
        return;
      }
    }
    try {
      const linkedTaskId = req.body?.taskId ? String(req.body.taskId) : undefined;
      const startedAt = Date.now();
      const result = stateBackupManager.restore(backupId, {
        dryRun,
        actorId: auth.username || 'unknown',
      });
      executionAuditStore.append({
        id: helpers.cryptoRandomId(),
        timestamp: new Date().toISOString(),
        taskId: linkedTaskId,
        command: 'system.backup.restore',
        skillId: 'system.backups',
        agentId: auth.username || 'unknown',
        agentRole: auth.role || 'operator',
        status: 'allowed',
        reason: dryRun
          ? `Dry-run restore for ${backupId}`
          : `Restore applied for ${backupId}`,
        approvalRequired: false,
        credentialIds: [],
        credentialScopes: [],
        durationMs: Date.now() - startedAt,
      });
      if (linkedTaskId) {
        try {
          const actionCounts = result.files.reduce((acc, file) => {
            acc[file.action] = (acc[file.action] || 0) + 1;
            return acc;
          }, {} as Record<string, number>);
          taskManager.appendOperation(linkedTaskId, {
            actorId: auth.username,
            actorType: 'user',
            type: 'rollback',
            summary: `${dryRun ? 'Backup restore dry-run' : 'Backup restore applied'}: ${backupId}`,
            details: `restore=${actionCounts.restore || 0}, skip=${actionCounts.skip || 0}`,
            status: 'recorded',
          });
        } catch {
          // Ignore task link failures for restore attribution.
        }
      }
      res.json({ success: true, result });
    } catch (error) {
      const message = (error as Error).message;
      executionAuditStore.append({
        id: helpers.cryptoRandomId(),
        timestamp: new Date().toISOString(),
        command: 'system.backup.restore',
        skillId: 'system.backups',
        agentId: auth.username || 'unknown',
        agentRole: auth.role || 'operator',
        status: 'error',
        reason: message,
        approvalRequired: false,
        credentialIds: [],
        credentialScopes: [],
      });
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
        return;
      }
      res.status(400).json({ error: message });
    }
  });

  return router;
}

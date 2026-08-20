import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const router = Router();

const BRIDGE_DIR = process.env.CODEX_BRIDGE_DIR || '/opt/rightapi-forge/codex-bridge';
const DISPATCH_SCRIPT = process.env.CODEX_BRIDGE_DISPATCH_SCRIPT || path.join(BRIDGE_DIR, 'codex-bridge-dispatch.sh');
const STATUS_SCRIPT = process.env.CODEX_BRIDGE_STATUS_SCRIPT || path.join(BRIDGE_DIR, 'codex-bridge-status.sh');
const MAX_BUFFER = Number(process.env.CODEX_BRIDGE_MAX_BUFFER_BYTES || 1024 * 1024);
const TIMEOUT_MS = Number(process.env.CODEX_BRIDGE_TIMEOUT_MS || 120000);

interface DispatchBody {
  taskId?: string;
  workdir?: string;
  prompt?: string;
}

function isValidTaskId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function normalizeOutput(stdout: string, stderr: string): { output: string; stderr?: string } {
  const output = stdout.trim();
  const err = stderr.trim();
  return err ? { output, stderr: err } : { output };
}

async function runBridgeScript(scriptPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Bridge script not found: ${scriptPath}`);
  }

  const result = await execFileAsync(scriptPath, args, {
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8'
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

router.get('/health', async (_req: Request, res: Response) => {
  try {
    const dispatchExists = fs.existsSync(DISPATCH_SCRIPT);
    const statusExists = fs.existsSync(STATUS_SCRIPT);
    const dispatchDir = path.dirname(DISPATCH_SCRIPT);
    const statusDir = path.dirname(STATUS_SCRIPT);
    res.json({
      success: true,
      bridgeDir: BRIDGE_DIR,
      scripts: {
        dispatch: {
          path: DISPATCH_SCRIPT,
          exists: dispatchExists,
          directory: dispatchDir
        },
        status: {
          path: STATUS_SCRIPT,
          exists: statusExists,
          directory: statusDir
        }
      },
      ready: dispatchExists && statusExists
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to load bridge health',
      details: (error as Error).message
    });
  }
});

router.post('/dispatch', async (req: Request, res: Response) => {
  try {
    const { taskId, workdir, prompt } = (req.body || {}) as DispatchBody;

    if (!taskId || !workdir || !prompt) {
      res.status(400).json({ error: 'taskId, workdir, and prompt are required' });
      return;
    }

    if (!isValidTaskId(taskId)) {
      res.status(400).json({ error: 'taskId has invalid format' });
      return;
    }

    const { stdout, stderr } = await runBridgeScript(DISPATCH_SCRIPT, [
      '--task-id', taskId,
      '--workdir', workdir,
      '--prompt', prompt
    ]);

    res.json({
      success: true,
      taskId,
      message: 'Task dispatched to Codex Bridge',
      ...normalizeOutput(stdout, stderr)
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to dispatch task',
      details: (error as Error).message
    });
  }
});

router.get('/status/:taskId', async (req: Request, res: Response) => {
  try {
    const taskId = String(req.params.taskId || '');
    if (!isValidTaskId(taskId)) {
      res.status(400).json({ error: 'taskId has invalid format' });
      return;
    }

    const { stdout, stderr } = await runBridgeScript(STATUS_SCRIPT, ['--task-id', taskId]);
    const statusMatch = stdout.match(/Status:\s*([A-Za-z0-9_-]+)/i);

    res.json({
      success: true,
      taskId,
      status: statusMatch ? statusMatch[1].toLowerCase() : 'unknown',
      ...normalizeOutput(stdout, stderr)
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check status',
      details: (error as Error).message
    });
  }
});

router.get('/result/:taskId', async (req: Request, res: Response) => {
  try {
    const taskId = String(req.params.taskId || '');
    if (!isValidTaskId(taskId)) {
      res.status(400).json({ error: 'taskId has invalid format' });
      return;
    }

    const { stdout, stderr } = await runBridgeScript(STATUS_SCRIPT, ['--task-id', taskId, '--result']);

    try {
      const parsed = JSON.parse(stdout);
      res.json({
        success: true,
        taskId,
        result: parsed,
        stderr: stderr.trim() || undefined
      });
      return;
    } catch {
      // Fall back to raw text when bridge script does not return JSON.
    }

    res.json({
      success: true,
      taskId,
      ...normalizeOutput(stdout, stderr)
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get result',
      details: (error as Error).message
    });
  }
});

router.get('/list', async (_req: Request, res: Response) => {
  try {
    const { stdout, stderr } = await runBridgeScript(STATUS_SCRIPT, ['--list']);
    res.json({
      success: true,
      ...normalizeOutput(stdout, stderr)
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to list tasks',
      details: (error as Error).message
    });
  }
});

export default router;

import { Router, type Request, type Response } from 'express';
import { LetThemTalkBridge } from '../integrations/LetThemTalkBridge.js';

const router = Router();
const bridge = new LetThemTalkBridge();
bridge.init();

router.get('/status', (_req: Request, res: Response) => {
  res.json(bridge.status());
});

router.get('/messages', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(bridge.readMessages(limit));
});

router.get('/history', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(bridge.readHistory(limit));
});

router.get('/agents', (_req: Request, res: Response) => {
  res.json(bridge.readAgents());
});

router.get('/tasks', (_req: Request, res: Response) => {
  res.json(bridge.readTasks());
});

router.get('/mcp-config', (req: Request, res: Response) => {
  const agentName = String(req.query.agent || 'acp-worker');
  res.json(bridge.getMcpConfig(agentName));
});

export default router;

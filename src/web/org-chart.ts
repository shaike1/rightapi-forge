import express, { type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

const router = express.Router();

const DATA_DIR = '/data/itops-agents';
const ORG_FILE = path.join(DATA_DIR, 'org-chart.json');

interface OrgNode {
  id: string;
  name: string;
  role: string;
  parentId?: string;
  children?: OrgNode[];
  agents: string[];
  specializations?: string[];
  scope?: string[];
  metrics: {
    tasksCompleted: number;
    successRate: number;
    avgResponseTime: number;
  };
}

interface OrgChart {
  name: string;
  ceo: OrgNode;
}

// Default org chart based on the article
const defaultOrgChart: OrgChart = {
  name: 'IT Ops Organization',
  ceo: {
    id: 'director',
    name: 'IT Director',
    role: 'CEO / Director',
    agents: ['director'],
    metrics: {
      tasksCompleted: 0,
      successRate: 1.0,
      avgResponseTime: 0
    },
    children: [
      {
        id: 'sysadmin-team',
        name: 'System Administrators',
        role: 'Team Lead',
        parentId: 'director',
        agents: ['alice', 'bob', 'eve'],
        metrics: {
          tasksCompleted: 0,
          successRate: 1.0,
          avgResponseTime: 0
        },
        children: [
          {
            id: 'alice',
            name: 'Alice',
            role: 'Senior SysAdmin',
            parentId: 'sysadmin-team',
            agents: ['alice'],
            specializations: ['system-admin', 'monitoring', 'troubleshooting'],
            metrics: {
              tasksCompleted: 0,
              successRate: 1.0,
              avgResponseTime: 0
            }
          },
          {
            id: 'bob',
            name: 'Bob',
            role: 'Security Specialist',
            parentId: 'sysadmin-team',
            agents: ['bob'],
            specializations: ['security', 'audit', 'compliance'],
            metrics: {
              tasksCompleted: 0,
              successRate: 1.0,
              avgResponseTime: 0
            }
          },
          {
            id: 'eve',
            name: 'Eve',
            role: 'Network Engineer',
            parentId: 'sysadmin-team',
            agents: ['eve'],
            specializations: ['networking', 'firewall', 'connectivity'],
            metrics: {
              tasksCompleted: 0,
              successRate: 1.0,
              avgResponseTime: 0
            }
          }
        ]
      },
      {
        id: 'specialist-team',
        name: 'Specialists',
        role: 'Team Lead',
        parentId: 'director',
        agents: ['charlie', 'diana'],
        metrics: {
          tasksCompleted: 0,
          successRate: 1.0,
          avgResponseTime: 0
        },
        children: [
          {
            id: 'charlie',
            name: 'Charlie',
            role: 'Backup & Recovery',
            parentId: 'specialist-team',
            agents: ['charlie'],
            specializations: ['backup', 'recovery', 'disaster-recovery'],
            metrics: {
              tasksCompleted: 0,
              successRate: 1.0,
              avgResponseTime: 0
            }
          },
          {
            id: 'diana',
            name: 'Diana',
            role: 'Performance Engineer',
            parentId: 'specialist-team',
            agents: ['diana'],
            specializations: ['optimization', 'performance', 'monitoring'],
            metrics: {
              tasksCompleted: 0,
              successRate: 1.0,
              avgResponseTime: 0
            }
          }
        ]
      }
    ]
  }
};

// Load org chart
function loadOrgChart(): OrgChart {
  try {
    if (fs.existsSync(ORG_FILE)) {
      const data = fs.readFileSync(ORG_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    logger.error('Failed to load org chart:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  }
  
  // Save default
  saveOrgChart(defaultOrgChart);
  return defaultOrgChart;
}

// Save org chart
function saveOrgChart(chart: OrgChart) {
  try {
    fs.mkdirSync(path.dirname(ORG_FILE), { recursive: true });
    fs.writeFileSync(ORG_FILE, JSON.stringify(chart, null, 2));
  } catch (error) {
    logger.error('Failed to save org chart:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  }
}

// Get full org chart
router.get('/', (_req: Request, res: Response) => {
  try {
    const chart = loadOrgChart();
    res.json({ success: true, chart });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to load org chart',
      details: (error as Error).message 
    });
  }
});

// Replace full org chart document
router.put('/', (req: Request, res: Response) => {
  try {
    const chart = req.body && typeof req.body === 'object' ? req.body as OrgChart : null;
    if (!chart || !chart.ceo || !chart.name) {
      res.status(400).json({ error: 'Invalid org chart payload' });
      return;
    }
    saveOrgChart(chart);
    res.json({ success: true, chart });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to update org chart',
      details: (error as Error).message
    });
  }
});

// Patch one node by id
router.patch('/nodes/:nodeId', (req: Request, res: Response) => {
  try {
    const nodeId = String(req.params.nodeId || '').trim();
    if (!nodeId) {
      res.status(400).json({ error: 'nodeId is required' });
      return;
    }
    const chart = loadOrgChart();
    const patch = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    let found = false;
    function walk(node: OrgNode): void {
      if (found) return;
      if (node.id === nodeId) {
        if (patch.name !== undefined) node.name = String(patch.name || '').trim() || node.name;
        if (patch.role !== undefined) node.role = String(patch.role || '').trim() || node.role;
        if (patch.agents !== undefined && Array.isArray(patch.agents)) {
          node.agents = patch.agents.map(item => String(item || '').trim()).filter(Boolean);
        }
        if (patch.specializations !== undefined && Array.isArray(patch.specializations)) {
          node.specializations = patch.specializations.map(item => String(item || '').trim()).filter(Boolean);
        }
        if (patch.scope !== undefined && Array.isArray(patch.scope)) {
          node.scope = patch.scope.map(item => String(item || '').trim()).filter(Boolean);
        }
        found = true;
        return;
      }
      (node.children || []).forEach(walk);
    }
    walk(chart.ceo);
    if (!found) {
      res.status(404).json({ error: 'Org node not found' });
      return;
    }
    saveOrgChart(chart);
    res.json({ success: true, chart });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to patch org node',
      details: (error as Error).message
    });
  }
});

// Get metrics for all agents
router.get('/metrics', (_req: Request, res: Response) => {
  try {
    const chart = loadOrgChart();
    const metrics: any[] = [];
    
    function collectMetrics(node: OrgNode) {
      if (node.agents && node.agents.length > 0) {
        metrics.push({
          id: node.id,
          name: node.name,
          role: node.role,
          agents: node.agents,
          specializations: node.specializations || [],
          metrics: node.metrics
        });
      }
      
      if (node.children) {
        node.children.forEach(collectMetrics);
      }
    }
    
    collectMetrics(chart.ceo);
    
    res.json({ success: true, metrics });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to load metrics',
      details: (error as Error).message 
    });
  }
});

// Update metrics for an agent
router.post('/metrics/:agentId', (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const { tasksCompleted, successRate, avgResponseTime } = req.body;
    
    const chart = loadOrgChart();
    
    function updateMetrics(node: OrgNode): boolean {
      if (node.agents && node.agents.includes(agentId as string)) {
        if (tasksCompleted !== undefined) node.metrics.tasksCompleted = tasksCompleted;
        if (successRate !== undefined) node.metrics.successRate = successRate;
        if (avgResponseTime !== undefined) node.metrics.avgResponseTime = avgResponseTime;
        return true;
      }
      
      if (node.children) {
        for (const child of node.children) {
          if (updateMetrics(child)) return true;
        }
      }
      
      return false;
    }
    
    const updated = updateMetrics(chart.ceo);
    
    if (updated) {
      saveOrgChart(chart);
      res.json({ success: true, message: 'Metrics updated successfully' });
    } else {
      res.status(404).json({ error: 'Agent not found' });
    }
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to update metrics',
      details: (error as Error).message 
    });
  }
});

export default router;

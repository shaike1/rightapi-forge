import express, { type Request, type Response } from 'express';
import { TaskManager } from '../tasks/TaskManager.js';

const router = express.Router();
const taskManager = new TaskManager();

// Get all tasks (no auth required for monitoring)
router.get('/', (_req: Request, res: Response) => {
  try {
    const allTasks = taskManager.getAllTasks();
    
    const formattedTasks = allTasks.map((task: any) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      category: task.category,
      assignedTo: task.assignedTo,
      ownerId: task.ownerId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
      result: task.result ? String(task.result).substring(0, 200) + '...' : null,
      error: task.error
    }));
    
    res.json({
      success: true,
      tasks: formattedTasks,
      statistics: {
        total: allTasks.length,
        pending: taskManager.getPendingTasks().length,
        inProgress: taskManager.getInProgressTasks().length,
        completed: taskManager.getCompletedTasks().length,
        failed: taskManager.getFailedTasks().length
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to load tasks',
      details: (error as Error).message
    });
  }
});

// Get tasks by status
router.get('/status/:status', (req: Request, res: Response) => {
  try {
    const { status } = req.params;
    const tasks = taskManager.getTasksByStatus(status as any);
    
    res.json({
      success: true,
      status,
      count: tasks.length,
      tasks
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to load tasks',
      details: (error as Error).message
    });
  }
});

// Get tasks by agent
router.get('/agent/:agentId', (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const tasks = taskManager.getTasksByAgent(String(agentId));
    
    res.json({
      success: true,
      agentId,
      count: tasks.length,
      tasks
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to load tasks',
      details: (error as Error).message
    });
  }
});

// Get statistics
router.get('/stats', (_req: Request, res: Response) => {
  try {
    const stats = taskManager.getStatistics();
    
    res.json({
      success: true,
      statistics: stats
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to load statistics',
      details: (error as Error).message
    });
  }
});

export default router;

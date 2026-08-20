// Scheduling API router
import express from 'express';
import { TaskScheduler } from '../scheduling/TaskScheduler.js';
import { CronParser } from '../scheduling/CronParser.js';

export function createSchedulingRouter(scheduler: TaskScheduler): express.Router {
  const router = express.Router();
  
  // Get all schedules
  router.get('/schedules', (_req, res) => {
    const schedules = scheduler.getAllSchedules();
    res.json({ schedules, count: schedules.length });
  });
  
  // Get single schedule
  router.get('/schedules/:id', (req, res) => {
    const schedule = scheduler.getSchedule(String(req.params.id));
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.json(schedule);
  });
  
  // Create schedule
  router.post('/schedules', (req, res) => {
    const { name, description, cronExpression, taskTemplate, enabled, timezone, missedRunPolicy, conflictPolicy } = req.body;
    
    if (!name || !cronExpression || !taskTemplate) {
      res.status(400).json({ error: 'Missing required fields: name, cronExpression, taskTemplate' });
      return;
    }
    
    // Validate cron expression
    const validation = CronParser.validate(cronExpression);
    if (!validation.valid) {
      res.status(400).json({ error: 'Invalid cron expression', details: validation.error });
      return;
    }
    
    try {
      const schedule = scheduler.addSchedule({
        name,
        description,
        cronExpression,
        taskTemplate,
        enabled: enabled !== false,
        timezone,
        missedRunPolicy: missedRunPolicy || 'skip',
        conflictPolicy: conflictPolicy || 'skip'
      });
      
      res.json({ success: true, schedule });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
  
  // Update schedule
  router.patch('/schedules/:id', (req, res) => {
    const id = String(req.params.id);
    const updates = req.body;
    
    // Validate cron expression if provided
    if (updates.cronExpression) {
      const validation = CronParser.validate(updates.cronExpression);
      if (!validation.valid) {
        res.status(400).json({ error: 'Invalid cron expression', details: validation.error });
        return;
      }
    }
    
    const schedule = scheduler.updateSchedule(id, updates);
    if (!schedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    
    res.json({ success: true, schedule });
  });
  
  // Delete schedule
  router.delete('/schedules/:id', (req, res) => {
    const deleted = scheduler.deleteSchedule(String(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.json({ success: true });
  });
  
  // Get schedule runs (history)
  router.get('/schedules/:id/runs', (req, res) => {
    const scheduleId = String(req.params.id);
    const limit = parseInt(String(req.query.limit || '50'), 10);
    
    const runs = scheduler.getScheduleRuns(scheduleId, limit);
    res.json({ runs, count: runs.length });
  });
  
  // Validate cron expression
  router.post('/cron/validate', (req, res) => {
    const { expression } = req.body;
    
    if (!expression) {
      res.status(400).json({ error: 'Missing cron expression' });
      return;
    }
    
    const validation = CronParser.validate(expression);
    const result: any = { valid: validation.valid };
    
    if (!validation.valid) {
      result.error = validation.error;
    } else {
      try {
        result.description = CronParser.describe(expression);
        result.nextRun = CronParser.getNextRun(expression);
      } catch (error) {
        result.error = (error as Error).message;
      }
    }
    
    res.json(result);
  });
  
  // Get next run time
  router.post('/cron/next-run', (req, res) => {
    const { expression, from } = req.body;
    
    if (!expression) {
      res.status(400).json({ error: 'Missing cron expression' });
      return;
    }
    
    try {
      const fromDate = from ? new Date(from) : new Date();
      const nextRun = CronParser.getNextRun(expression, fromDate);
      const description = CronParser.describe(expression);
      
      res.json({ nextRun, description });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  
  return router;
}

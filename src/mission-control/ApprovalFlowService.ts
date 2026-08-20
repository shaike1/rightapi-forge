// Approval Flow Service for Mission Control - manages human-in-the-loop approval workflows

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import type { ApprovalFlow } from '../types/index.js';

export class ApprovalFlowService {
  private flows: Map<string, ApprovalFlow> = new Map();
  private dataPath: string;

  constructor(dataPath: string = './data/approval-flows.json') {
    this.dataPath = dataPath;
    this.ensureDataDir();
    this.load();
  }

  private ensureDataDir(): void {
    const dir = path.dirname(this.dataPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Create a new approval flow
  createFlow(
    entityType: ApprovalFlow['entityType'],
    entityId: string,
    title: string,
    description: string,
    requestedBy: string,
    requiredApprovals: number = 1,
    approvers?: string[],
    metadata?: Record<string, unknown>
  ): ApprovalFlow {
    const flow: ApprovalFlow = {
      id: uuidv4(),
      entityType,
      entityId,
      title,
      description,
      requestedBy,
      requestedAt: new Date(),
      status: 'pending',
      approvers: (approvers || []).map(userId => ({
        userId,
        decision: undefined,
        decisionAt: undefined,
        comment: undefined
      })),
      requiredApprovals,
      metadata
    };

    this.flows.set(flow.id, flow);
    this.save();
    return flow;
  }

  // Get a flow by ID
  getFlow(id: string): ApprovalFlow | undefined {
    return this.flows.get(id);
  }

  // Get all flows
  getAllFlows(): ApprovalFlow[] {
    return Array.from(this.flows.values()).sort(
      (a, b) => b.requestedAt.getTime() - a.requestedAt.getTime()
    );
  }

  // Get flows by entity
  getFlowsByEntity(entityType: ApprovalFlow['entityType'], entityId: string): ApprovalFlow[] {
    return Array.from(this.flows.values())
      .filter(f => f.entityType === entityType && f.entityId === entityId)
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
  }

  // Get pending flows for a specific approver
  getPendingForApprover(userId: string): ApprovalFlow[] {
    return Array.from(this.flows.values())
      .filter(f =>
        f.status === 'pending' &&
        f.approvers.some(a => a.userId === userId && !a.decision)
      )
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  }

  // Get pending flows
  getPendingFlows(): ApprovalFlow[] {
    return Array.from(this.flows.values())
      .filter(f => f.status === 'pending')
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  }

  // Record an approval decision
  decide(
    flowId: string,
    userId: string,
    decision: 'approved' | 'rejected',
    comment?: string
  ): ApprovalFlow | null {
    const flow = this.flows.get(flowId);
    if (!flow) return null;
    if (flow.status !== 'pending') return null;

    // Find the approver
    const approver = flow.approvers.find(a => a.userId === userId);
    if (!approver) return null;
    if (approver.decision) return null; // Already decided

    // Record the decision
    approver.decision = decision;
    approver.decisionAt = new Date();
    approver.comment = comment;

    // Check if we have enough approvals
    this.updateFlowStatus(flow);

    this.save();
    return flow;
  }

  // Add an approver to a flow
  addApprover(flowId: string, userId: string): ApprovalFlow | null {
    const flow = this.flows.get(flowId);
    if (!flow) return null;
    if (flow.status !== 'pending') return null;

    // Check if already an approver
    if (flow.approvers.some(a => a.userId === userId)) return null;

    flow.approvers.push({
      userId,
      decision: undefined,
      decisionAt: undefined,
      comment: undefined
    });

    this.save();
    return flow;
  }

  // Cancel a flow
  cancelFlow(flowId: string, userId: string): ApprovalFlow | null {
    const flow = this.flows.get(flowId);
    if (!flow) return null;
    if (flow.status !== 'pending') return null;

    // Only the requester can cancel
    if (flow.requestedBy !== userId) return null;

    flow.status = 'cancelled';
    this.save();
    return flow;
  }

  // Update flow status based on approvals
  private updateFlowStatus(flow: ApprovalFlow): void {
    const approvals = flow.approvers.filter(a => a.decision === 'approved').length;
    const rejections = flow.approvers.filter(a => a.decision === 'rejected').length;
    const pending = flow.approvers.filter(a => !a.decision).length;

    // Auto-reject if anyone rejected
    if (rejections > 0) {
      flow.status = 'rejected';
      return;
    }

    // Approve if we have enough approvals
    if (approvals >= flow.requiredApprovals) {
      flow.status = 'approved';
      return;
    }

    // Still pending if we haven't reached required approvals and no rejections
    if (pending > 0 || approvals < flow.requiredApprovals) {
      flow.status = 'pending';
    }
  }

  // Get approval status summary
  getStatusSummary(flowId: string): {
    flow: ApprovalFlow;
    approved: number;
    rejected: number;
    pending: number;
    isApproved: boolean;
    isRejected: boolean;
    isPending: boolean;
  } | null {
    const flow = this.flows.get(flowId);
    if (!flow) return null;

    const approved = flow.approvers.filter(a => a.decision === 'approved').length;
    const rejected = flow.approvers.filter(a => a.decision === 'rejected').length;
    const pending = flow.approvers.filter(a => !a.decision).length;

    return {
      flow,
      approved,
      rejected,
      pending,
      isApproved: flow.status === 'approved',
      isRejected: flow.status === 'rejected',
      isPending: flow.status === 'pending'
    };
  }

  // Get statistics
  getStats(): {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    cancelled: number;
    byEntityType: Record<string, number>;
  } {
    const flows = Array.from(this.flows.values());
    const byEntityType: Record<string, number> = {};

    for (const flow of flows) {
      byEntityType[flow.entityType] = (byEntityType[flow.entityType] || 0) + 1;
    }

    return {
      total: flows.length,
      pending: flows.filter(f => f.status === 'pending').length,
      approved: flows.filter(f => f.status === 'approved').length,
      rejected: flows.filter(f => f.status === 'rejected').length,
      cancelled: flows.filter(f => f.status === 'cancelled').length,
      byEntityType
    };
  }

  // Clean up old completed flows
  cleanup(olderThanDays: number = 30): number {
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    let removed = 0;

    for (const [id, flow] of this.flows.entries()) {
      if (
        flow.status !== 'pending' &&
        flow.requestedAt < cutoffDate
      ) {
        this.flows.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      this.save();
    }

    return removed;
  }

  // Persistence
  save(): void {
    const data = {
      version: 1,
      flows: Array.from(this.flows.entries())
    };
    fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2), 'utf8');
  }

  load(): boolean {
    if (!fs.existsSync(this.dataPath)) {
      return false;
    }

    try {
      const content = fs.readFileSync(this.dataPath, 'utf8');
      const data = JSON.parse(content);

      // Convert date strings back to Date objects
      const flows = data.flows || [];
      for (const [id, flow] of flows) {
        flow.requestedAt = new Date(flow.requestedAt);
        for (const approver of flow.approvers) {
          if (approver.decisionAt) {
            approver.decisionAt = new Date(approver.decisionAt);
          }
        }
        this.flows.set(id, flow);
      }

      return true;
    } catch (error) {
      logger.error('Failed to load approval flows:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      return false;
    }
  }

  // Export/Import
  export(): string {
    const data = {
      version: 1,
      exportDate: new Date().toISOString(),
      flows: Array.from(this.flows.entries())
    };
    return JSON.stringify(data, null, 2);
  }

  import(jsonData: string, mode: 'merge' | 'replace' = 'merge'): { success: boolean; imported: number; errors?: string[] } {
    const errors: string[] = [];
    let imported = 0;

    try {
      const data = JSON.parse(jsonData);

      if (data.version !== 1) {
        return { success: false, imported: 0, errors: ['Invalid version'] };
      }

      if (mode === 'replace') {
        this.flows.clear();
      }

      for (const [id, flow] of data.flows || []) {
        try {
          if (!this.flows.has(id)) {
            // Convert date strings
            flow.requestedAt = new Date(flow.requestedAt);
            for (const approver of flow.approvers) {
              if (approver.decisionAt) {
                approver.decisionAt = new Date(approver.decisionAt);
              }
            }
            this.flows.set(id, flow);
            imported++;
          }
        } catch (e) {
          errors.push(`Failed to import flow ${id}: ${e}`);
        }
      }

      this.save();

      return {
        success: true,
        imported,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (error) {
      return {
        success: false,
        imported: 0,
        errors: [`Failed to parse JSON: ${error}`]
      };
    }
  }
}

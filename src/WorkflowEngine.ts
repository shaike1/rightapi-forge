// Workflow Engine with Suspend/Resume Pattern

export interface WorkflowStep {
  id: string;
  name: string;
  execute: (context: WorkflowContext) => Promise<WorkflowResult>;
  resumeSchema?: any; // Zod schema for resume data
}

export interface WorkflowContext {
  data: any;
  resumeData?: any;
  workflowId: string;
  stepId: string;
}

export interface WorkflowResult {
  data?: any;
  suspended?: {
    message: string;
    metadata?: any;
  };
  error?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  onComplete?: (data: any) => Promise<void>;
  onError?: (error: any) => Promise<void>;
}

export class WorkflowEngine {
  private workflows: Map<string, Workflow> = new Map();
  private activeWorkflows: Map<string, {
    workflow: Workflow;
    currentStep: number;
    data: any;
    status: 'running' | 'suspended' | 'completed' | 'failed';
  }> = new Map();

  register(workflow: Workflow): void {
    this.workflows.set(workflow.id, workflow);
  }

  async start(workflowId: string, initialData: any): Promise<WorkflowResult> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error('Workflow not found: ' + workflowId);
    }

    let currentStep = 0;
    let data = { ...initialData };

    this.activeWorkflows.set(workflowId + '-' + Date.now(), {
      workflow,
      currentStep: 0,
      data,
      status: 'running'
    });

    while (currentStep < workflow.steps.length) {
      const step = workflow.steps[currentStep];
      
      try {
        const result = await step.execute({ 
          data, 
          workflowId, 
          stepId: step.id 
        });

        if (result.suspended) {
          // Workflow is suspended, waiting for resume
          return {
            suspended: result.suspended,
            data
          };
        }

        if (result.data) {
          data = { ...data, ...result.data };
        }

        if (result.error) {
          if (workflow.onError) {
            await workflow.onError(result.error);
          }
          return { error: result.error };
        }

      } catch (error: any) {
        if (workflow.onError) {
          await workflow.onError(error);
        }
        return { error: error.message };
      }

      currentStep++;
    }

    // Workflow completed
    if (workflow.onComplete) {
      await workflow.onComplete(data);
    }

    return { data };
  }

  async resume(workflowInstanceId: string, resumeData: any): Promise<WorkflowResult> {
    const instance = this.activeWorkflows.get(workflowInstanceId);
    if (!instance) {
      throw new Error('Workflow instance not found: ' + workflowInstanceId);
    }

    if (instance.status !== 'suspended') {
      throw new Error('Workflow is not suspended');
    }

    const step = instance.workflow.steps[instance.currentStep];
    const result = await step.execute({
      data: instance.data,
      resumeData,
      workflowId: instance.workflow.id,
      stepId: step.id
    });

    if (result.suspended) {
      return { suspended: result.suspended };
    }

    if (result.error) {
      instance.status = 'failed';
      if (instance.workflow.onError) {
        await instance.workflow.onError(result.error);
      }
      return { error: result.error };
    }

    instance.data = { ...instance.data, ...result.data };
    instance.currentStep++;

    if (instance.currentStep >= instance.workflow.steps.length) {
      instance.status = 'completed';
      if (instance.workflow.onComplete) {
        await instance.workflow.onComplete(instance.data);
      }
      return { data: instance.data };
    }

    // Continue to next step
    return this.resume(workflowInstanceId, undefined);
  }

  getInstance(instanceId: string) {
    return this.activeWorkflows.get(instanceId);
  }

  listActive(): Array<{id: string, workflow: string, step: number, status: string}> {
    return Array.from(this.activeWorkflows.entries()).map(([id, inst]) => ({
      id,
      workflow: inst.workflow.name,
      step: inst.currentStep,
      status: inst.status
    }));
  }
}

// Example: Deploy Approval Workflow
export const deployApprovalWorkflow = {
  id: 'deploy-approval',
  name: 'Deploy Approval Workflow',
  description: 'Require approval for production deployments',
  steps: [
    {
      id: 'validate',
      name: 'Validate Deployment',
      execute: async (ctx: WorkflowContext) => {
        const isProd = ctx.data.environment === 'production';
        
        if (isProd) {
          return {
            suspended: {
              message: 'Production deployment requires approval',
              metadata: {
                type: 'approval',
                environment: ctx.data.environment,
                version: ctx.data.version
              }
            }
          };
        }
        
        return { data: { validated: true } };
      }
    },
    {
      id: 'deploy',
      name: 'Execute Deployment',
      execute: async (ctx: WorkflowContext) => {
        // Check if resumed with approval
        if (ctx.resumeData?.approved) {
          return { 
            data: { 
              deployed: true, 
              environment: ctx.data.environment,
              approvedBy: ctx.resumeData.approvedBy 
            } 
          };
        }
        
        return { 
          error: 'Deployment was not approved',
          data: { deployed: false }
        };
      }
    }
  ]
};

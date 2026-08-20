// Deployment automation skills

import type { Skill } from '../types/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';

const execAsync = promisify(exec);

interface Deployment {
  id: string;
  name: string;
  environment: 'dev' | 'staging' | 'production';
  status: 'pending' | 'running' | 'success' | 'failed' | 'rolled_back';
  startTime: Date;
  endTime?: Date;
  logs: string[];
  rollbackCommands?: string[];
}

export class DeploymentSkill {
  private deployments: Map<string, Deployment> = new Map();

  getSkill(): Skill {
    return {
      id: 'deployment',
      name: 'Deployment Automation',
      description: 'CI/CD pipelines, release management, and deployment automation',
      category: 'deployment',
      enabled: true,
      commands: [
        {
          name: 'deploy.start',
          description: 'Start a new deployment',
          handler: 'deployStart',
          parameters: { name: 'string', environment: 'string', service: 'string' }
        },
        {
          name: 'deploy.status',
          description: 'Get deployment status',
          handler: 'deployStatus',
          parameters: { deploymentId: 'string' }
        },
        {
          name: 'deploy.list',
          description: 'List all deployments',
          handler: 'deployList'
        },
        {
          name: 'deploy.rollback',
          description: 'Rollback a deployment',
          handler: 'deployRollback',
          parameters: { deploymentId: 'string' }
        },
        {
          name: 'deploy.logs',
          description: 'Get deployment logs',
          handler: 'deployLogs',
          parameters: { deploymentId: 'string' }
        },
        {
          name: 'git.deploy',
          description: 'Deploy from git repository',
          handler: 'gitDeploy',
          parameters: { repo: 'string', branch: 'string', environment: 'string' }
        },
        {
          name: 'docker.deploy',
          description: 'Deploy Docker container',
          handler: 'dockerDeploy',
          parameters: { image: 'string', name: 'string', ports: 'string' }
        },
        {
          name: 'k8s.deploy',
          description: 'Deploy to Kubernetes',
          handler: 'k8sDeploy',
          parameters: { manifest: 'string', namespace: 'string' }
        },
        {
          name: 'health.check',
          description: 'Check deployment health',
          handler: 'healthCheck',
          parameters: { service: 'string' }
        }
      ]
    };
  }

  async deployStart(params: { name: string; environment: string; service: string }): Promise<string> {
    const { name, environment, service } = params;
    if (!name || !environment || !service) {
      return 'Error: deploy.start requires { name, environment, service }';
    }
    const deployment: Deployment = {
      id: uuidv4(),
      name,
      environment: environment as 'dev' | 'staging' | 'production',
      status: 'pending',
      startTime: new Date(),
      logs: [`[SIMULATED] Starting deployment of ${service} to ${environment}`]
    };

    this.deployments.set(deployment.id, deployment);

    // NOTE: This is a simulated deployment — no real build/test/deploy actions
    // are executed. To run a real deployment use docker.deploy / k8s.deploy /
    // git.deploy from this skill, or compose.* commands from infrastructure.
    deployment.status = 'running';
    deployment.logs.push(`[SIMULATED] Building ${service}...`);
    deployment.logs.push(`[SIMULATED] Running tests for ${service}...`);
    deployment.logs.push(`[SIMULATED] Deploying ${service} to ${environment}...`);

    deployment.status = 'success';
    deployment.endTime = new Date();
    deployment.logs.push(`[SIMULATED] Deployment marker recorded — no real deployment was performed.`);

    return `Simulated deployment recorded: ${deployment.id}\n` + deployment.logs.join('\n');
  }

  deployStatus(params: { deploymentId: string }): string {
    const deployment = this.deployments.get(params.deploymentId);
    if (!deployment) {
      return `Deployment not found: ${params.deploymentId}`;
    }

    return `
Deployment: ${deployment.name} (${deployment.id})
Status:     ${deployment.status.toUpperCase()}
Environment: ${deployment.environment}
Started:    ${deployment.startTime.toISOString()}
${deployment.endTime ? `Ended:      ${deployment.endTime.toISOString()}` : ''}
Duration:   ${deployment.endTime
  ? `${(deployment.endTime.getTime() - deployment.startTime.getTime()) / 1000}s`
  : 'in progress...'}
    `.trim();
  }

  deployList(): string {
    if (this.deployments.size === 0) {
      return 'No deployments found.';
    }

    return Array.from(this.deployments.values()).map(d =>
      `${d.id} - ${d.name} [${d.environment}] - ${d.status.toUpperCase()}`
    ).join('\n');
  }

  async deployRollback(params: { deploymentId: string }): Promise<string> {
    const deployment = this.deployments.get(params.deploymentId);
    if (!deployment) {
      return `Deployment not found: ${params.deploymentId}`;
    }

    deployment.status = 'rolled_back';
    deployment.endTime = new Date();
    deployment.logs.push(`[SIMULATED] Rollback marker recorded.`);

    return `Deployment ${params.deploymentId} rollback marker recorded (simulated).`;
  }

  deployLogs(params: { deploymentId: string }): string {
    const deployment = this.deployments.get(params.deploymentId);
    if (!deployment) {
      return `Deployment not found: ${params.deploymentId}`;
    }

    return deployment.logs.join('\n');
  }

  async gitDeploy(params: { repo: string; branch: string; environment: string }): Promise<string> {
    const { repo, branch, environment } = params;
    if (!repo || !branch || !environment) {
      return 'Error: git.deploy requires { repo, branch, environment }';
    }
    try {
      const deployment: Deployment = {
        id: uuidv4(),
        name: `Git deploy: ${repo}#${branch}`,
        environment: environment as 'dev' | 'staging' | 'production',
        status: 'running',
        startTime: new Date(),
        logs: []
      };

      deployment.logs.push(`[SIMULATED] Would clone ${repo} (branch: ${branch})`);
      deployment.logs.push(`[SIMULATED] Would install dependencies, build, deploy to ${environment}`);
      deployment.status = 'success';
      deployment.endTime = new Date();

      this.deployments.set(deployment.id, deployment);

      return `Simulated git deployment recorded: ${deployment.id}\n` + deployment.logs.join('\n');
    } catch (error) {
      return `Error in git deploy: ${(error as Error).message}`;
    }
  }

  async dockerDeploy(params: { image: string; name: string; ports: string }): Promise<string> {
    const { image, name, ports } = params;
    if (!image || !name) {
      return 'Error: docker.deploy requires { image, name } and optional { ports }';
    }
    try {
      const portsArg = ports ? `-p ${ports} ` : '';
      const { stdout } = await execAsync(
        `docker run -d --name ${name} ${portsArg}${image}`
      );

      return `Docker container deployed: ${name}\nContainer ID: ${stdout.trim()}`;
    } catch (error) {
      return `Error deploying Docker container: ${(error as Error).message}`;
    }
  }

  async k8sDeploy(params: { manifest: string; namespace?: string }): Promise<string> {
    const manifest = params.manifest;
    const namespace = params.namespace || 'default';
    if (!manifest) {
      return 'Error: k8s.deploy requires { manifest } (path to manifest file)';
    }
    try {
      const { stdout } = await execAsync(
        `kubectl apply -f ${manifest} -n ${namespace}`
      );

      return `Kubernetes deployment completed:\n${stdout}`;
    } catch (error) {
      return `Error deploying to Kubernetes: ${(error as Error).message}`;
    }
  }

  async healthCheck(params: { service: string }): Promise<string> {
    const service = params?.service;
    if (!service) return 'Error: health.check requires { service }';
    try {
      // Try docker health check
      const { stdout: dockerPs } = await execAsync(`docker ps --filter "name=${service}" --format "{{.Status}}"`);

      if (dockerPs) {
        return `Service health check for ${service}:\n${dockerPs}`;
      }

      // Try k8s health check
      const { stdout: k8sPods } = await execAsync(`kubectl get pods -l app=${service} -o jsonpath='{.items[*].status.phase}'`);

      if (k8sPods) {
        return `Service health check for ${service}:\nPod statuses: ${k8sPods}`;
      }

      return `Service ${service} not found in Docker or Kubernetes.`;
    } catch (error) {
      return `Error checking health: ${(error as Error).message}`;
    }
  }
}

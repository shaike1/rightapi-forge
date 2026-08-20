import { InfrastructureSkill } from '../skills/InfrastructureSkill.js';
import { MonitoringSkill } from '../skills/MonitoringSkill.js';
import { DeploymentSkill } from '../skills/DeploymentSkill.js';
import { SecuritySkill } from '../skills/SecuritySkill.js';

interface WorkerPayload {
  skillId: string;
  handler: string;
  params?: Record<string, unknown>;
  parameterOrder?: string[];
}

function buildArgs(payload: WorkerPayload): unknown[] {
  const params = payload.params || {};
  const ordered = payload.parameterOrder || Object.keys(params);
  return ordered
    .filter(key => Object.prototype.hasOwnProperty.call(params, key))
    .map(key => params[key]);
}

async function execute(payload: WorkerPayload): Promise<string> {
  const args = buildArgs(payload);

  switch (payload.skillId) {
    case 'infrastructure': {
      const infra = new InfrastructureSkill();
      const fn = (infra as any)[payload.handler];
      if (typeof fn !== 'function') throw new Error(`Handler not found: ${payload.handler}`);
      return await fn.apply(infra, args);
    }
    case 'monitoring': {
      const monitor = new MonitoringSkill();
      const fn = (monitor as any)[payload.handler];
      if (typeof fn !== 'function') throw new Error(`Handler not found: ${payload.handler}`);
      return await fn.apply(monitor, args);
    }
    case 'deployment': {
      const deploy = new DeploymentSkill();
      const fn = (deploy as any)[payload.handler];
      if (typeof fn !== 'function') throw new Error(`Handler not found: ${payload.handler}`);
      return await fn.apply(deploy, args);
    }
    case 'security': {
      const sec = new SecuritySkill();
      const fn = (sec as any)[payload.handler];
      if (typeof fn !== 'function') throw new Error(`Handler not found: ${payload.handler}`);
      return await fn.apply(sec, args);
    }
    default:
      throw new Error(`Unsupported skill: ${payload.skillId}`);
  }
}

async function main() {
  try {
    const payloadB64 = process.env.SANDBOX_PAYLOAD_B64 || '';
    if (!payloadB64) throw new Error('Missing SANDBOX_PAYLOAD_B64');
    const payloadJson = Buffer.from(payloadB64, 'base64').toString('utf8');
    const payload = JSON.parse(payloadJson) as WorkerPayload;
    const result = await execute(payload);
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: (error as Error).message }));
    process.exitCode = 1;
  }
}

main();


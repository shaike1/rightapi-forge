// DeploySkill — agent-facing wrapper around the SDK's deployChange()
// path. Persists a FileChange[] on a fresh feature branch, optionally
// triggering the GitHub Actions workflow that does the actual rollout.
//
// We intentionally never push or merge from this surface — the deploy
// bridge does that out-of-band. An operator (or the dashboard) can
// promote the resulting feature branch to a PR via the usual route.

import type { Skill } from '../../types/index.js';
import { encode, ok, fail } from '../SkillResult.js';
import { SelfDevelopmentService } from '../../sdk/SelfDevelopmentService.js';
import type { FileChange } from '../../sdk/SdkTypes.js';

export class DeploySkill {
  constructor(private readonly service: SelfDevelopmentService) {}

  getSkill(): Skill {
    return {
      id: 'sdk.deploy',
      name: 'SDK Deploy',
      description: 'Commit FileChange[] to a feature branch + (optionally) trigger the deploy workflow.',
      category: 'deployment',
      enabled: true,
      commands: [
        {
          name: 'sdk.deploy.commit',
          description: 'Persist files under a feature branch and (if configured) trigger the deploy workflow.',
          handler: 'commit',
          parameters: { files: 'object', message: 'string', ref: 'string' },
        },
      ],
    };
  }

  async commit(params: { files?: FileChange[]; message?: string; ref?: string }): Promise<string> {
    if (!Array.isArray(params?.files) || params.files.length === 0) {
      return encode(fail('sdk.deploy.commit requires { files: FileChange[] }'));
    }
    if (!params.message || params.message.length < 3) {
      return encode(fail('sdk.deploy.commit requires { message } (>=3 chars)'));
    }
    try {
      const result = await this.service.deployChange(params.files, params.message, params.ref);
      return encode(ok(result, `committed on ${result.branch}` + (result.workflowRunId ? `, deploy run ${result.workflowRunId}` : '')));
    } catch (err: unknown) {
      return encode(fail((err as Error).message, 'deploy commit failed'));
    }
  }
}

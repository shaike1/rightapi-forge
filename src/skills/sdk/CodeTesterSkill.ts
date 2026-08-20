// CodeTesterSkill — runs the SDK's sandboxed test runner against a
// FileChange[] + TestCase[] pair. This is the seam an agent uses to
// verify that the code it just generated actually returns ok=true on
// its smoke tests before asking an operator to commit + deploy.

import type { Skill } from '../../types/index.js';
import { encode, ok, fail } from '../SkillResult.js';
import { SelfDevelopmentService } from '../../sdk/SelfDevelopmentService.js';
import type { FileChange, TestCase } from '../../sdk/SdkTypes.js';

export class CodeTesterSkill {
  /** The service is shared with the rest of the SDK surface. The
   *  server-side wiring constructs one and passes it in. */
  constructor(private readonly service: SelfDevelopmentService) {}

  getSkill(): Skill {
    return {
      id: 'sdk.codeTester',
      name: 'SDK Code Tester',
      description: 'Runs sandboxed self-tests against generated FileChange[] + TestCase[].',
      category: 'general',
      enabled: true,
      commands: [
        {
          name: 'sdk.codeTester.run',
          description: 'Run TestCase[] in worker_threads sandbox against the matching .plugin.js file in `files`.',
          handler: 'run',
          parameters: { files: 'object', tests: 'object' },
        },
      ],
    };
  }

  async run(params: { files?: FileChange[]; tests?: TestCase[] }): Promise<string> {
    if (!Array.isArray(params?.files) || params.files.length === 0) {
      return encode(fail('sdk.codeTester.run requires { files: FileChange[] }'));
    }
    if (!Array.isArray(params.tests)) {
      return encode(fail('sdk.codeTester.run requires { tests: TestCase[] }'));
    }
    try {
      const results = await this.service.testCode(params.files, params.tests);
      const failed = results.filter(r => !r.passed).length;
      return encode(ok(
        { results, passed: results.length - failed, failed },
        `${results.length} test(s), ${failed} failed`,
      ));
    } catch (err: unknown) {
      return encode(fail((err as Error).message, 'sandbox tests failed to run'));
    }
  }
}

// CodeWriterSkill — agent-facing wrapper around the Self-Development
// SDK's generation surface. Lets a DevelopmentAgent ask for skill or
// workflow code WITHOUT needing to import the SDK service directly.
//
// The skill never writes to disk by itself — it returns the
// FileChange[] the orchestrator (sdk.develop or /api/sdk/develop) will
// hand to writeFiles + scan + sandbox-test. This keeps the seam
// between "what code do we want" and "is it safe to ship" cleanly
// separated.

import type { Skill } from '../../types/index.js';
import { encode, ok, fail } from '../SkillResult.js';
import {
  generateSkillFiles,
  generateWorkflowFile,
  defaultSkillTests,
} from '../../sdk/CodeGenerator.js';
import { scanFiles, hasBlockingFindings } from '../../sdk/SecurityScanner.js';
import type { SkillSpec, WorkflowSpec } from '../../sdk/SdkTypes.js';

export class CodeWriterSkill {
  getSkill(): Skill {
    return {
      id: 'sdk.codeWriter',
      name: 'SDK Code Writer',
      description: 'Generates skill or workflow source files from a spec; pure (no disk writes).',
      category: 'general',
      enabled: true,
      commands: [
        {
          name: 'sdk.codeWriter.generateSkill',
          description: 'Render a SkillSpec into FileChange[] (a TS source + a .plugin.js shim) plus default smoke tests.',
          handler: 'generateSkill',
          parameters: { spec: 'object' },
        },
        {
          name: 'sdk.codeWriter.generateWorkflow',
          description: 'Render a WorkflowSpec into a single workflow JSON FileChange.',
          handler: 'generateWorkflow',
          parameters: { spec: 'object' },
        },
      ],
    };
  }

  async generateSkill(params: { spec?: SkillSpec }): Promise<string> {
    if (!params?.spec) return encode(fail('sdk.codeWriter.generateSkill requires { spec }'));
    try {
      const files = generateSkillFiles(params.spec);
      const tests = defaultSkillTests(params.spec);
      const findings = scanFiles(files);
      const summary = `${files.length} file(s), ${tests.length} smoke test(s), ${findings.length} scan finding(s)`;
      return encode(ok({
        files, tests, findings,
        blocked: hasBlockingFindings(findings),
      }, summary));
    } catch (err: unknown) {
      return encode(fail((err as Error).message, 'generateSkill failed'));
    }
  }

  async generateWorkflow(params: { spec?: WorkflowSpec }): Promise<string> {
    if (!params?.spec) return encode(fail('sdk.codeWriter.generateWorkflow requires { spec }'));
    try {
      const file = generateWorkflowFile(params.spec);
      const findings = scanFiles([file]);
      return encode(ok({
        files: [file], findings,
        blocked: hasBlockingFindings(findings),
      }, `workflow JSON ready (${findings.length} scan finding(s))`));
    } catch (err: unknown) {
      return encode(fail((err as Error).message, 'generateWorkflow failed'));
    }
  }
}

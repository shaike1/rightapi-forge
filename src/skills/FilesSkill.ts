// Files management skill

import type { Skill } from '../types/index.js';
import type { SkillExecutionContext } from './SkillManager.js';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { shellEscape } from '../utils/shellEscape.js';
import { encode, ok, fail } from './SkillResult.js';

const execAsync = promisify(exec);

function failure(action: string, e: any): string {
  return encode(fail(`${action}: ${e?.message ?? String(e)}`, action));
}

export class FilesSkill {
  getSkill(): Skill {
    return {
      id: 'files',
      name: 'Files Management',
      description: 'Read, write, list and manage files on the server',
      category: 'infrastructure',
      enabled: true,
      commands: [
        {
          name: 'file.read',
          description: 'Read file contents',
          handler: 'fileRead',
          parameters: { path: 'string', lines: 'number' }
        },
        {
          name: 'file.write',
          description: 'Write content to a file',
          handler: 'fileWrite',
          parameters: { path: 'string', content: 'string' }
        },
        {
          name: 'file.list',
          description: 'List files in a directory',
          handler: 'fileList',
          parameters: { path: 'string', pattern: 'string' }
        },
        {
          name: 'file.info',
          description: 'Get file information',
          handler: 'fileInfo',
          parameters: { path: 'string' }
        },
        {
          name: 'file.exists',
          description: 'Check if file or directory exists',
          handler: 'fileExists',
          parameters: { path: 'string' }
        },
        {
          name: 'file.mkdir',
          description: 'Create a directory',
          handler: 'fileMkdir',
          parameters: { path: 'string' }
        },
        {
          name: 'file.delete',
          description: 'Delete a file or directory',
          handler: 'fileDelete',
          parameters: { path: 'string', recursive: 'boolean' },
        },
        {
          name: 'file.copy',
          description: 'Copy a file or directory',
          handler: 'fileCopy',
          parameters: { source: 'string', destination: 'string' }
        },
        {
          name: 'file.move',
          description: 'Move a file or directory',
          handler: 'fileMove',
          parameters: { source: 'string', destination: 'string' }
        },
        {
          name: 'file.size',
          description: 'Get file size',
          handler: 'fileSize',
          parameters: { path: 'string' }
        },
        {
          name: 'file.permissions',
          description: 'Get file permissions',
          handler: 'filePermissions',
          parameters: { path: 'string' }
        },
        {
          name: 'file.find',
          description: 'Find files by name pattern',
          handler: 'fileFind',
          parameters: { directory: 'string', pattern: 'string' }
        }
      ]
    };
  }

  async fileRead(params: { path: string; lines?: number }): Promise<string> {
    if (!params?.path) return encode(fail('file.read requires { path }'));
    try {
      if (!fs.existsSync(params.path)) return encode(fail(`file not found: ${params.path}`));
      const stats = fs.statSync(params.path);
      if (stats.isDirectory()) return encode(fail(`path is a directory: ${params.path}`));
      let content = fs.readFileSync(params.path, 'utf8');
      const totalLines = content.split('\n').length;
      let truncated = false;
      if (params.lines) {
        const lines = content.split('\n');
        content = lines.slice(0, params.lines).join('\n');
        truncated = lines.length > params.lines;
      }
      return encode(ok({ content, totalLines, truncated, path: params.path }, `${totalLines} line(s)${truncated ? ' (truncated)' : ''}`));
    } catch (error) { return failure(`reading ${params.path}`, error); }
  }

  async fileWrite(
    params: { path: string; content: string },
    ctx?: SkillExecutionContext
  ): Promise<string> {
    // typo fix: previously declared `path: 'string'` (string-literal type) which
    // erased TS coverage. Now correctly `path: string`.
    if (!params?.path || params.content === undefined) return encode(fail('file.write requires { path, content }'));
    try {
      const dir = path.dirname(params.path);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Capture pre-write state for the rollback recipe — restore the prior
      // contents if the file existed, otherwise delete it.
      const existed = fs.existsSync(params.path);
      const prior = existed ? fs.readFileSync(params.path, 'utf8') : null;

      fs.writeFileSync(params.path, params.content, 'utf8');

      if (ctx?.registerRollback && ctx.callerAgentId && ctx.taskId) {
        if (existed) {
          // Restore prior contents via a fresh file.write call.
          ctx.registerRollback({
            agentId: ctx.callerAgentId,
            taskId: ctx.taskId,
            action: `overwrote ${params.path} (${Buffer.byteLength(prior || '', 'utf8')} bytes prior)`,
            rollback: { kind: 'tool', tool: 'file.write', params: { path: params.path, content: prior } },
            skill: 'files',
          });
        } else {
          ctx.registerRollback({
            agentId: ctx.callerAgentId,
            taskId: ctx.taskId,
            action: `created ${params.path}`,
            rollback: { kind: 'tool', tool: 'file.delete', params: { path: params.path } },
            skill: 'files',
          });
        }
      }

      return encode(ok({ path: params.path, bytes: Buffer.byteLength(params.content, 'utf8') }, `wrote ${params.path}`));
    } catch (error) { return failure(`writing ${params.path}`, error); }
  }

  async fileList(params: { path: string; pattern?: string }): Promise<string> {
    if (!params?.path) return encode(fail('file.list requires { path }'));
    try {
      if (!fs.existsSync(params.path)) return encode(fail(`directory not found: ${params.path}`));
      const stats = fs.statSync(params.path);
      if (!stats.isDirectory()) return encode(fail(`path is not a directory: ${params.path}`));
      let names = fs.readdirSync(params.path);
      if (params.pattern) {
        const regex = new RegExp(params.pattern);
        names = names.filter(f => regex.test(f));
      }
      const entries = names.map(name => {
        const stat = fs.statSync(path.join(params.path, name));
        return { name, type: stat.isDirectory() ? 'dir' : 'file', size: stat.size };
      });
      return encode(ok({ entries, count: entries.length, path: params.path }, `${entries.length} entry/entries`));
    } catch (error) { return failure(`listing ${params.path}`, error); }
  }

  async fileInfo(params: { path: string }): Promise<string> {
    if (!params?.path) return encode(fail('file.info requires { path }'));
    try {
      if (!fs.existsSync(params.path)) return encode(fail(`path not found: ${params.path}`));
      const stats = fs.statSync(params.path);
      return encode(ok({
        type: stats.isDirectory() ? 'directory' : 'file',
        size: stats.size,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        accessedAt: stats.atime.toISOString(),
        path: params.path
      }, `${stats.isDirectory() ? 'directory' : 'file'} ${params.path}`));
    } catch (error) { return failure(`stat ${params.path}`, error); }
  }

  async fileExists(params: { path: string }): Promise<string> {
    if (!params?.path) return encode(fail('file.exists requires { path }'));
    if (fs.existsSync(params.path)) {
      const stats = fs.statSync(params.path);
      return encode(ok({ exists: true, type: stats.isDirectory() ? 'directory' : 'file', path: params.path }, 'exists'));
    }
    return encode(ok({ exists: false, type: null, path: params.path }, 'not found'));
  }

  async fileMkdir(
    params: { path: string },
    ctx?: SkillExecutionContext
  ): Promise<string> {
    if (!params?.path) return encode(fail('file.mkdir requires { path }'));
    const existed = fs.existsSync(params.path);
    try {
      fs.mkdirSync(params.path, { recursive: true });
      if (!existed && ctx?.registerRollback && ctx.callerAgentId && ctx.taskId) {
        ctx.registerRollback({
          agentId: ctx.callerAgentId,
          taskId: ctx.taskId,
          action: `created directory ${params.path}`,
          rollback: { kind: 'tool', tool: 'file.delete', params: { path: params.path, recursive: true } },
          skill: 'files',
        });
      }
      return encode(ok({ path: params.path }, `created ${params.path}`));
    } catch (error) { return failure(`mkdir ${params.path}`, error); }
  }

  async fileDelete(
    params: { path: string; recursive?: boolean },
    ctx?: SkillExecutionContext
  ): Promise<string> {
    if (!params?.path) return encode(fail('file.delete requires { path }'));
    try {
      if (!fs.existsSync(params.path)) return encode(fail(`path not found: ${params.path}`));
      const stats = fs.statSync(params.path);
      // Capture file contents BEFORE delete so the rollback can restore.
      // Directories aren't recoverable from a one-line undo, so we register
      // an advisory rollback that the operator must implement.
      let prior: string | null = null;
      if (!stats.isDirectory()) {
        try { prior = fs.readFileSync(params.path, 'utf8'); } catch { prior = null; }
      }

      if (stats.isDirectory()) {
        if (params.recursive) fs.rmSync(params.path, { recursive: true });
        else fs.rmdirSync(params.path);
      } else {
        fs.unlinkSync(params.path);
      }

      if (ctx?.registerRollback && ctx.callerAgentId && ctx.taskId) {
        if (!stats.isDirectory() && prior !== null) {
          ctx.registerRollback({
            agentId: ctx.callerAgentId,
            taskId: ctx.taskId,
            action: `deleted file ${params.path}`,
            rollback: { kind: 'tool', tool: 'file.write', params: { path: params.path, content: prior } },
            skill: 'files',
          });
        } else {
          ctx.registerRollback({
            agentId: ctx.callerAgentId,
            taskId: ctx.taskId,
            action: `deleted ${stats.isDirectory() ? 'directory' : 'file'} ${params.path} (no automatic restore — backup required)`,
            rollback: { kind: 'bash', command: `echo "TODO: restore ${params.path} from backup" >&2; exit 1` },
            skill: 'files',
          });
        }
      }

      return encode(ok({ path: params.path, recursive: !!params.recursive }, `deleted ${params.path}`));
    } catch (error) { return failure(`deleting ${params.path}`, error); }
  }

  async fileCopy(
    params: { source: string; destination: string },
    ctx?: SkillExecutionContext
  ): Promise<string> {
    if (!params?.source || !params?.destination) return encode(fail('file.copy requires { source, destination }'));
    try {
      if (!fs.existsSync(params.source)) return encode(fail(`source not found: ${params.source}`));
      const destDir = path.dirname(params.destination);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      const stats = fs.statSync(params.source);
      if (stats.isDirectory()) return encode(fail('use file.move for directories'));
      const destExisted = fs.existsSync(params.destination);
      const priorDest = destExisted ? fs.readFileSync(params.destination, 'utf8') : null;
      fs.copyFileSync(params.source, params.destination);

      if (ctx?.registerRollback && ctx.callerAgentId && ctx.taskId) {
        if (destExisted) {
          ctx.registerRollback({
            agentId: ctx.callerAgentId,
            taskId: ctx.taskId,
            action: `overwrote ${params.destination} via copy from ${params.source}`,
            rollback: { kind: 'tool', tool: 'file.write', params: { path: params.destination, content: priorDest } },
            skill: 'files',
          });
        } else {
          ctx.registerRollback({
            agentId: ctx.callerAgentId,
            taskId: ctx.taskId,
            action: `copied ${params.source} → ${params.destination}`,
            rollback: { kind: 'tool', tool: 'file.delete', params: { path: params.destination } },
            skill: 'files',
          });
        }
      }

      return encode(ok({ source: params.source, destination: params.destination }, `copied ${params.source} → ${params.destination}`));
    } catch (error) { return failure(`copying ${params.source} → ${params.destination}`, error); }
  }

  async fileMove(
    params: { source: string; destination: string },
    ctx?: SkillExecutionContext
  ): Promise<string> {
    if (!params?.source || !params?.destination) return encode(fail('file.move requires { source, destination }'));
    try {
      if (!fs.existsSync(params.source)) return encode(fail(`source not found: ${params.source}`));
      const destDir = path.dirname(params.destination);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(params.source, params.destination);

      // Move is its own inverse — register the reciprocal move.
      if (ctx?.registerRollback && ctx.callerAgentId && ctx.taskId) {
        ctx.registerRollback({
          agentId: ctx.callerAgentId,
          taskId: ctx.taskId,
          action: `moved ${params.source} → ${params.destination}`,
          rollback: { kind: 'tool', tool: 'file.move', params: { source: params.destination, destination: params.source } },
          skill: 'files',
        });
      }

      return encode(ok({ source: params.source, destination: params.destination }, `moved ${params.source} → ${params.destination}`));
    } catch (error) { return failure(`moving ${params.source} → ${params.destination}`, error); }
  }

  async fileSize(params: { path: string }): Promise<string> {
    if (!params?.path) return encode(fail('file.size requires { path }'));
    try {
      if (!fs.existsSync(params.path)) return encode(fail(`file not found: ${params.path}`));
      const stats = fs.statSync(params.path);
      if (stats.isDirectory()) return encode(fail('use file.find to walk directories'));
      return encode(ok({ bytes: stats.size, kilobytes: stats.size / 1024, path: params.path }, `${stats.size} bytes`));
    } catch (error) { return failure(`stat ${params.path}`, error); }
  }

  async filePermissions(params: { path: string }): Promise<string> {
    if (!params?.path) return encode(fail('file.permissions requires { path }'));
    try {
      if (!fs.existsSync(params.path)) return encode(fail(`path not found: ${params.path}`));
      const stats = fs.statSync(params.path);
      const perms = (stats.mode & 0o777).toString(8);
      return encode(ok({ permissions: perms, mode: stats.mode, path: params.path }, `mode ${perms}`));
    } catch (error) { return failure(`stat ${params.path}`, error); }
  }

  async fileFind(params: { directory: string; pattern: string }): Promise<string> {
    if (!params?.directory || !params?.pattern) return encode(fail('file.find requires { directory, pattern }'));
    try {
      if (!fs.existsSync(params.directory)) return encode(fail(`directory not found: ${params.directory}`));
      const dir = shellEscape(params.directory);
      const glob = shellEscape(`*${params.pattern}*`);
      const { stdout } = await execAsync(`find ${dir} -name ${glob} 2>/dev/null | head -20`);
      const matches = stdout.split('\n').filter(Boolean);
      return encode(ok(
        { matches, count: matches.length, directory: params.directory, pattern: params.pattern },
        matches.length ? `${matches.length} match(es)` : 'no matches'
      ));
    } catch (error) { return failure(`find in ${params.directory}`, error); }
  }
}

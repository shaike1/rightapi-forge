// Public API barrel for the skills module.

export { SkillManager, type SkillExecutionContext } from './SkillManager.js';
export { encode, ok, fail, runResult, type SkillResult } from './SkillResult.js';
export {
  CircuitBreakerRegistry,
  type CircuitBreakerConfig,
  type CircuitBreakerSnapshot,
} from './CircuitBreaker.js';

export { SkillPluginLoader, type PluginLoaderOptions, type PluginModule } from './SkillPluginLoader.js';
export {
  type PluginPermissions, type ResolvedPermissions, resolvePermissions,
} from './sandbox/PluginPermissions.js';
export { SandboxedPluginRunner, type SandboxedPluginOptions, type LoadedSandboxedPlugin } from './sandbox/SandboxedPluginRunner.js';

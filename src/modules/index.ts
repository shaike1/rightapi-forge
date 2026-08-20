// Public API barrel for the modules module.
//
// This module provides the registry + boundary enforcement primitives
// every other module uses to declare its API surface and resolve
// dependencies. Keep the export list narrow — internal helpers stay
// inside their files.

export {
  CORE_ALLOWLIST,
  MODULES,
  getModule,
  importAllowed,
  type ModuleDefinition,
  type ModuleId,
} from './ModuleRegistry.js';

export {
  ServiceRegistry,
  getServiceRegistry,
  resetServiceRegistry,
  type ServiceDescriptor,
} from './ServiceRegistry.js';

export {
  envelope,
  reply,
  isInternalMessage,
  type InternalMessage,
  type CreateOptions,
} from './InternalMessageContract.js';

// Public API barrel for the security module.

export { AuthService, type UserRole, type Permission } from './AuthService.js';
export { ApiKeyService, type ApiKey } from './ApiKeyService.js';
export {
  ApprovalTokenService,
  type MintApprovalParams,
  type MintedApprovalToken,
  type ApprovalValidationResult,
} from './ApprovalTokenService.js';
export { AuditLog } from './AuditLog.js';

export {
  CredentialVault,
  type CredentialKind,
  type CredentialRecordMeta,
} from './CredentialVault.js';
export {
  CredentialRotationManager,
  type Rotator,
  type RotationResult,
  type RotationAlert,
  type AlertSink,
} from './CredentialRotationManager.js';

export { GenericApiKeyRotator,        type GenericApiKeyRotatorConfig }        from './rotators/GenericApiKeyRotator.js';
export { CertificateRotator,           type CertificateRotatorConfig,
         type CertificateBundle }                                               from './rotators/CertificateRotator.js';
export { EnvironmentVariableRotator,   type EnvironmentVariableRotatorConfig,
         updateEnvFile }                                                        from './rotators/EnvironmentVariableRotator.js';

export { RbacService, type RbacServiceOptions } from './rbac/RbacService.js';
// RbacStore lives in the persistence module (it's pure storage);
// re-exported through persistence/index.ts.
export {
  ROLES, ROLE_RANK, PERMISSIONS, ROLE_PERMISSIONS,
  permissionsForRole, hasPermission,
  type RbacRole, type RbacPermission,
  type RoleDefinition, type UserRoleAssignment, type ResolvedPermissions,
} from './rbac/RbacTypes.js';
export { createRbacMiddleware } from './rbac/rbacMiddleware.js';

export { createAuthMiddleware } from './authMiddleware.js';

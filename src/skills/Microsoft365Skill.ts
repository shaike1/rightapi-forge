// Microsoft 365 & Azure AD Skill
//
// TODO: This skill declares 23 commands but implements ZERO handlers — every
// command listed in getSkill() will fail with "Handler not found" at dispatch
// time. It is intentionally NOT registered in SkillManager (see comment at top
// of SkillManager.ts). Implement the handlers below, then re-enable the
// registration. Until then this file is dormant metadata.

import type { Skill } from '../types/index.js';

export class Microsoft365Skill {
  getSkill(): Skill {
    return {
      id: 'microsoft365',
      name: 'Microsoft 365 Management',
      description: 'Microsoft 365, Azure AD, and Active Directory management',
      category: 'microsoft365',
      enabled: true,
      commands: [
        {
          name: 'azuread.users.list',
          description: 'List all Azure AD users',
          handler: 'azureadUsersList',
          parameters: {
            filter: 'string (optional)'
          }
        },
        {
          name: 'azuread.users.create',
          description: 'Create new Azure AD user',
          handler: 'azureadUsersCreate',
          parameters: {
            displayName: 'string',
            mailNickname: 'string',
            userPrincipalName: 'string',
            password: 'string'
          }
        },
        {
          name: 'azuread.users.update',
          description: 'Update Azure AD user properties',
          handler: 'azureadUsersUpdate',
          parameters: {
            userId: 'string',
            properties: 'object'
          }
        },
        {
          name: 'azuread.users.delete',
          description: 'Delete Azure AD user',
          handler: 'azureadUsersDelete',
          parameters: {
            userId: 'string'
          }
        },
        {
          name: 'azuread.groups.list',
          description: 'List all Azure AD groups',
          handler: 'azureadGroupsList'
        },
        {
          name: 'azuread.groups.addMember',
          description: 'Add member to Azure AD group',
          handler: 'azureadGroupsAddMember',
          parameters: {
            groupId: 'string',
            userId: 'string'
          }
        },
        {
          name: 'azuread.permissions.list',
          description: 'List Azure AD permissions and roles',
          handler: 'azureadPermissionsList'
        },
        {
          name: 'azuread.roles.assign',
          description: 'Assign Azure AD role to user',
          handler: 'azureadRolesAssign',
          parameters: {
            userId: 'string',
            roleId: 'string'
          }
        },
        {
          name: 'azuread.licenses.list',
          description: 'List Microsoft 365 licenses',
          handler: 'azureadLicensesList'
        },
        {
          name: 'azuread.licenses.assign',
          description: 'Assign license to user',
          handler: 'azureadLicensesAssign',
          parameters: {
            userId: 'string',
            licenseId: 'string'
          }
        },
        {
          name: 'ms365.mailbox.get',
          description: 'Get mailbox information',
          handler: 'ms365MailboxGet',
          parameters: {
            userEmail: 'string'
          }
        },
        {
          name: 'ms365.mailbox.setPermissions',
          description: 'Set mailbox permissions',
          handler: 'ms365MailboxSetPermissions',
          parameters: {
            userEmail: 'string',
            permissions: 'object'
          }
        },
        {
          name: 'ms365.groups.list',
          description: 'List Microsoft 365 groups',
          handler: 'ms365GroupsList'
        },
        {
          name: 'ms365.teams.list',
          description: 'List Microsoft Teams',
          handler: 'ms365TeamsList'
        },
        {
          name: 'ms365.teams.addMember',
          description: 'Add member to Microsoft Team',
          handler: 'ms365TeamsAddMember',
          parameters: {
            teamId: 'string',
            userId: 'string'
          }
        },
        {
          name: 'ms365.sharepoint.list',
          description: 'List SharePoint sites',
          handler: 'ms365SharepointList'
        },
        {
          name: 'ms365.sharepoint.getPermissions',
          description: 'Get SharePoint site permissions',
          handler: 'ms365SharepointGetPermissions',
          parameters: {
            siteUrl: 'string'
          }
        },
        {
          name: 'ad.users.list',
          description: 'List Active Directory users',
          handler: 'adUsersList',
          parameters: {
            ou: 'string (optional)'
          }
        },
        {
          name: 'ad.users.unlock',
          description: 'Unlock Active Directory user account',
          handler: 'adUsersUnlock',
          parameters: {
            username: 'string'
          }
        },
        {
          name: 'ad.groups.list',
          description: 'List Active Directory groups',
          handler: 'adGroupsList'
        },
        {
          name: 'ad.gpo.list',
          description: 'List Group Policy Objects',
          handler: 'adGpoList'
        },
        {
          name: 'ad.permissions.check',
          description: 'Check user permissions',
          handler: 'adPermissionsCheck',
          parameters: {
            username: 'string',
            resource: 'string'
          }
        },
        {
          name: 'ad.sync.status',
          description: 'Check Azure AD Connect sync status',
          handler: 'adSyncStatus'
        }
      ]
    };
  }
}

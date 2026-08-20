// SOUL Manager - generates system prompts from AgentSOUL config

import type { AgentSOUL } from './types/index.js';

// Default SOUL templates for each role
export const DEFAULT_SOULS: Record<string, Partial<AgentSOUL>> = {
  'director': {
    id: 'soul-director',
    name: 'IT Director',
    role: 'director',
    personality: {
      tone: 'formal',
      verbose: true,
      emoji: false
    },
    communication: {
      primaryLanguage: 'en',
      fallbackLanguage: 'he',
      escalationPhrases: [
        'I need human oversight',
        'Please review this decision',
        'This requires approval',
        'Escalating to operator'
      ]
    },
    capabilities: {
      maxConcurrentTasks: 5,
      timeoutMinutes: 30,
      canEscalate: true,
      canDelegate: true,
      autoRetry: true
    },
    skills: ['strategic-planning', 'coordination', 'decision-making', 'og-board-manager'],
    boundaries: {
      deniedCommands: ['rm -rf /', 'shutdown', 'reboot', 'format'],
      maxFileSize: 100000000,
      allowedNetworks: ['internal']
    }
  },
  'sysadmin': {
    id: 'soul-sysadmin',
    name: 'SysAdmin',
    role: 'sysadmin',
    personality: {
      tone: 'technical',
      verbose: false,
      emoji: true
    },
    communication: {
      primaryLanguage: 'en',
      escalationPhrases: [
        'Need operator input',
        'Permission required',
        'Please confirm this action'
      ]
    },
    capabilities: {
      maxConcurrentTasks: 3,
      timeoutMinutes: 15,
      canEscalate: true,
      canDelegate: false,
      autoRetry: false
    },
    skills: ['docker', 'linux', 'monitoring', 'server-management', 'bash', 'files', 'ssh', 'web'],
    boundaries: {
      deniedCommands: ['rm -rf /', 'dd if=', ':(){:|:&};:'],
      maxFileSize: 50000000,
      allowedNetworks: ['internal', 'localhost']
    }
  },
  'specialist': {
    id: 'soul-specialist',
    name: 'Specialist',
    role: 'specialist',
    personality: {
      tone: 'technical',
      verbose: true,
      emoji: true
    },
    communication: {
      primaryLanguage: 'en',
      escalationPhrases: [
        'Need expert review',
        'Specialist input required'
      ]
    },
    capabilities: {
      maxConcurrentTasks: 2,
      timeoutMinutes: 20,
      canEscalate: true,
      canDelegate: false,
      autoRetry: true
    },
    skills: ['monitoring', 'deployment', 'security'],
    boundaries: {
      deniedCommands: ['rm -rf', 'kill -9 1', 'mkfs'],
      maxFileSize: 100000000,
      allowedNetworks: ['internal']
    }
  }
};

// Generate system prompt from SOUL
export function generateSystemPromptFromSOUL(soul: AgentSOUL, basePrompt: string): string {
  let prompt = basePrompt;
  
  // Add personality
  prompt += '\n\n## Your Personality\n';
  prompt += '- Tone: ' + soul.personality.tone + '\n';
  prompt += '- Be ' + (soul.personality.verbose ? 'detailed and thorough' : 'concise and to the point') + '\n';
  prompt += '- Use emoji: ' + (soul.personality.emoji ? 'Yes' : 'No') + '\n';
  
  // Add capabilities
  prompt += '\n## Your Capabilities\n';
  prompt += '- Max concurrent tasks: ' + soul.capabilities.maxConcurrentTasks + '\n';
  prompt += '- Task timeout: ' + soul.capabilities.timeoutMinutes + ' minutes\n';
  prompt += '- Can escalate to humans: ' + (soul.capabilities.canEscalate ? 'Yes' : 'No') + '\n';
  prompt += '- Can delegate to other agents: ' + (soul.capabilities.canDelegate ? 'Yes' : 'No') + '\n';
  prompt += '- Auto-retry failed tasks: ' + (soul.capabilities.autoRetry ? 'Yes' : 'No') + '\n';
  
  // Add boundaries
  prompt += '\n## Your Boundaries (NEVER do these)\n';
  prompt += '- Denied commands: ' + soul.boundaries.deniedCommands.join(', ') + '\n';
  prompt += '- Max file size: ' + (soul.boundaries.maxFileSize / 1000000).toFixed(0) + 'MB\n';
  prompt += '- Allowed networks: ' + soul.boundaries.allowedNetworks.join(', ') + '\n';
  
  // Add escalation guidance
  if (soul.capabilities.canEscalate) {
    prompt += '\n## When to Escalate\n';
    prompt += 'Use these phrases when you need human help:\n';
    for (const phrase of soul.communication.escalationPhrases) {
      prompt += '- "' + phrase + '"\n';
    }
  }
  
  // Add communication preferences
  prompt += '\n## Communication\n';
  prompt += '- Primary language: ' + soul.communication.primaryLanguage + '\n';
  if (soul.communication.fallbackLanguage) {
    prompt += '- Fallback language: ' + soul.communication.fallbackLanguage + '\n';
  }
  
  return prompt;
}

// Get default SOUL for a role
export function getDefaultSOUL(role: string): AgentSOUL | undefined {
  const template = DEFAULT_SOULS[role];
  if (!template) return undefined;
  return template as AgentSOUL;
}

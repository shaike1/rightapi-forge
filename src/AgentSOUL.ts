// Agent SOUL types and definitions

export interface AgentSOUL {
  // Identity
  id: string;
  name: string;
  role: 'director' | 'sysadmin' | 'specialist';
  
  // Personality
  personality: {
    tone: 'formal' | 'casual' | 'technical' | 'friendly';
    verbose: boolean;
    emoji: boolean;
  };
  
  // Communication
  communication: {
    primaryLanguage: 'en' | 'he';
    fallbackLanguage?: 'en' | 'he';
    escalationPhrases: string[];
  };
  
  // Capabilities
  capabilities: {
    maxConcurrentTasks: number;
    timeoutMinutes: number;
    canEscalate: boolean;
    canDelegate: boolean;
    autoRetry: boolean;
  };
  
  // Skills
  skills: string[];
  
  // Boundaries
  boundaries: {
    deniedCommands: string[];
    maxFileSize: number;
    allowedNetworks: string[];
  };
  
  // Custom System Prompt (replaces default)
  customSystemPrompt?: string;
}

// Default SOULs for each agent type
export const DEFAULT_SOULS: Record<string, AgentSOUL> = {
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
    skills: ['docker', 'linux', 'monitoring', 'server-management', 'bash', 'files', 'ssh'],
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
  prompt += '- Verbose: ' + (soul.personality.verbose ? 'Yes' : 'No') + '\n';
  prompt += '- Emoji: ' + (soul.personality.emoji ? 'Yes' : 'No') + '\n';
  
  // Add capabilities
  prompt += '\n## Your Capabilities\n';
  prompt += '- Max concurrent tasks: ' + soul.capabilities.maxConcurrentTasks + '\n';
  prompt += '- Task timeout: ' + soul.capabilities.timeoutMinutes + ' minutes\n';
  prompt += '- Can escalate: ' + (soul.capabilities.canEscalate ? 'Yes' : 'No') + '\n';
  prompt += '- Can delegate: ' + (soul.capabilities.canDelegate ? 'Yes' : 'No') + '\n';
  
  // Add boundaries
  prompt += '\n## Your Boundaries\n';
  prompt += '- Denied commands: ' + soul.boundaries.deniedCommands.join(', ') + '\n';
  prompt += '- Max file size: ' + (soul.boundaries.maxFileSize / 1000000).toFixed(0) + 'MB\n';
  prompt += '- Allowed networks: ' + soul.boundaries.allowedNetworks.join(', ') + '\n';
  
  // Add escalation guidance
  prompt += '\n## Escalation\n';
  prompt += 'When you need human help, use these phrases: ' + soul.communication.escalationPhrases.join(', ') + '\n';
  
  return prompt;
}

#!/usr/bin/env node
// RightAPI Forge CLI

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import dotenv from 'dotenv';
import { AIProviderFactory } from '../ai/factory.js';
import { OrganizationManager } from '../agents/Organization.js';
import { TaskManager } from '../tasks/TaskManager.js';
import { SkillManager } from '../skills/SkillManager.js';
import type { AIPlatform } from '../types/index.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const program = new Command();

program
  .name('itops')
  .description('RightAPI Forge - AI-powered autonomous organization for IT operations')
  .version('1.0.0');

// Initialize state
let organization: OrganizationManager | null = null;
let taskManager: TaskManager | null = null;
let skillManager: SkillManager | null = null;

function initializeComponents() {
  const aiFactory = new AIProviderFactory({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL
  });

  organization = new OrganizationManager('IT Ops Team', aiFactory);
  taskManager = new TaskManager();
  skillManager = new SkillManager();

  return { aiFactory, organization, taskManager, skillManager };
}

// Agent commands
program
  .command('agent')
  .description('Manage agents')
  .addCommand(
    new Command('create')
      .description('Create a new agent')
      .argument('<name>', 'Agent name')
      .argument('<role>', 'Agent role (director, sysadmin, specialist)')
      .option('-p, --platform <platform>', 'AI platform (claude, openai, ollama)', 'claude')
      .option('-s, --specialty <specialty>', 'Specialty for specialist agents')
      .action(async (name, role, options) => {
        const spinner = ora('Creating agent...').start();

        try {
          const { organization, aiFactory } = initializeComponents();
          const platform = options.platform as AIPlatform;

          let agent;
          if (role === 'director') {
            agent = await organization.createDirector(platform);
          } else if (role === 'sysadmin') {
            agent = await organization.createSysAdmin(name, platform);
          } else if (role === 'specialist') {
            agent = await organization.createSpecialist(
              name,
              options.specialty || 'general',
              platform
            );
          } else {
            spinner.fail('Invalid role. Use: director, sysadmin, or specialist');
            return;
          }

          spinner.succeed(`Agent created: ${agent.name} (${agent.id})`);
          logger.info(chalk.gray(`Role: ${agent.role}`));
          logger.info(chalk.gray(`Platform: ${platform}`));
        } catch (error) {
          spinner.fail(`Failed to create agent: ${(error as Error).message}`);
        }
      })
  )
  .addCommand(
    new Command('list')
      .description('List all agents')
      .action(() => {
        const { organization } = initializeComponents();
        const tree = organization.getAgentTree();

        logger.info(chalk.bold('\n📋 IT Ops Team Organization\n'));

        if ('error' in tree) {
          logger.info(chalk.yellow(tree.error));
          return;
        }

        const director = tree.director as { name: string; id: string; skills: string[] };
        const sysadmins = tree.sysadmins as Array<{ name: string; id: string; skills: string[] }>;
        const specialists = tree.specialists as Array<{ name: string; id: string; skills: string[] }>;

        logger.info(chalk.cyan('Director:'));
        logger.info(`  ${chalk.green(director.name)} (${director.id})`);
        logger.info(`  Skills: ${director.skills.join(', ')}\n`);

        logger.info(chalk.cyan('System Administrators:'));
        if (sysadmins.length === 0) {
          logger.info(chalk.gray('  None\n'));
        } else {
          sysadmins.forEach((sa) => {
            logger.info(`  ${chalk.green(sa.name)} (${sa.id})`);
            logger.info(`  Skills: ${sa.skills.join(', ')}\n`);
          });
        }

        logger.info(chalk.cyan('Specialists:'));
        if (specialists.length === 0) {
          logger.info(chalk.gray('  None\n'));
        } else {
          specialists.forEach((sp) => {
            logger.info(`  ${chalk.green(sp.name)} (${sp.id})`);
            logger.info(`  Skills: ${sp.skills.join(', ')}\n`);
          });
        }
      })
  )
  .addCommand(
    new Command('info')
      .description('Get agent information')
      .argument('<agentId>', 'Agent ID or name')
      .action(async (agentId) => {
        const { organization } = initializeComponents();
        const agent = organization.getAgent(agentId) ||
                      organization.getAllAgents().find(a => a.name === agentId);

        if (!agent) {
          logger.info(chalk.red(`Agent not found: ${agentId}`));
          return;
        }

        logger.info(chalk.bold(`\n🤖 Agent Information\n`));
        logger.info(`ID:       ${agent.id}`);
        logger.info(`Name:     ${agent.name}`);
        logger.info(`Role:     ${agent.role}`);
        logger.info(`Platform: ${agent.config.aiPlatform}`);
        logger.info(`Skills:   ${agent.config.skills.join(', ')}`);
        logger.info(`Status:   ${agent.config.status}`);
      })
  )
  .addCommand(
    new Command('message')
      .description('Send a message to an agent')
      .argument('<agent>', 'Agent ID or name')
      .argument('<message>', 'Message to send')
      .action(async (agentId, message) => {
        const spinner = ora('Sending message...').start();
        const { organization } = initializeComponents();

        const agent = organization.getAgent(agentId) ||
                      organization.getAllAgents().find(a => a.name === agentId);

        if (!agent) {
          spinner.fail(`Agent not found: ${agentId}`);
          return;
        }

        try {
          const response = await agent.processMessage(message);
          spinner.succeed('Response received');
          logger.info(chalk.bold(`\n${agent.name}:\n`));
          logger.info(response);
        } catch (error) {
          spinner.fail(`Error: ${(error as Error).message}`);
        }
      })
  );

// Task commands
program
  .command('task')
  .description('Manage tasks')
  .addCommand(
    new Command('create')
      .description('Create a new task')
      .argument('<title>', 'Task title')
      .option('-d, --description <desc>', 'Task description')
      .option('-o, --owner <owner>', 'Owner agent ID')
      .option('-a, --assign <agent>', 'Assign to agent ID')
      .option('-c, --category <category>', 'Task category (infrastructure, monitoring, deployment, security)', 'general')
      .option('-p, --priority <priority>', 'Task priority (low, medium, high, critical)', 'medium')
      .action(async (title, options) => {
        const { taskManager, organization } = initializeComponents();

        const task = taskManager.createTask({
          title,
          description: options.description || title,
          ownerId: options.owner || organization.getOrganization().director.id,
          category: options.category,
          priority: options.priority,
          assignedTo: options.assign
        });

        logger.info(chalk.green(`\nTask created: ${task.id}`));
        logger.info(chalk.gray(`Status: ${task.status}`));
        logger.info(chalk.gray(`Priority: ${task.priority}`));
      })
  )
  .addCommand(
    new Command('list')
      .description('List tasks')
      .option('-s, --status <status>', 'Filter by status')
      .option('-a, --agent <agent>', 'Filter by agent')
      .action((options) => {
        const { taskManager } = initializeComponents();

        let tasks = taskManager.getAllTasks();
        if (options.status) {
          tasks = taskManager.getTasksByStatus(options.status);
        }
        if (options.agent) {
          tasks = taskManager.getTasksByAgent(options.agent);
        }

        if (tasks.length === 0) {
          logger.info(chalk.yellow('No tasks found.'));
          return;
        }

        logger.info(chalk.bold('\n📋 Tasks\n'));
        tasks.forEach(t => {
          const statusColor = {
            pending: 'yellow',
            assigned: 'blue',
            in_progress: 'cyan',
            completed: 'green',
            failed: 'red',
            blocked: 'gray',
            cancelled: 'gray',
            dropped: 'gray',
            rolling_back: 'magenta',
            rolled_back: 'green'
          }[t.status] || 'white';

          const statusText = `[${t.status.toUpperCase()}]`;
          let coloredStatus = statusText;
          if (statusColor === 'yellow') coloredStatus = chalk.yellow(statusText);
          else if (statusColor === 'blue') coloredStatus = chalk.blue(statusText);
          else if (statusColor === 'cyan') coloredStatus = chalk.cyan(statusText);
          else if (statusColor === 'green') coloredStatus = chalk.green(statusText);
          else if (statusColor === 'red') coloredStatus = chalk.red(statusText);
          else if (statusColor === 'gray') coloredStatus = chalk.gray(statusText);
          else if (statusColor === 'magenta') coloredStatus = chalk.magenta(statusText);
          else coloredStatus = chalk.white(statusText);

          logger.info(coloredStatus + ` ${t.title}`);
          logger.info(chalk.gray(`  ID: ${t.id} | Priority: ${t.priority}`));
          logger.info();
        });
      })
  )
  .addCommand(
    new Command('status')
      .description('Update task status')
      .argument('<taskId>', 'Task ID')
      .argument('<status>', 'New status')
      .action((taskId, status) => {
        const { taskManager } = initializeComponents();

        try {
          const task = taskManager.updateTaskStatus(taskId, status);
          logger.info(chalk.green(`Task status updated: ${task.id} -> ${status}`));
        } catch (error) {
          logger.info(chalk.red(`Error: ${(error as Error).message}`));
        }
      })
  )
  .addCommand(
    new Command('stats')
      .description('Show task statistics')
      .action(() => {
        const { taskManager } = initializeComponents();
        const stats = taskManager.getStatistics();

        logger.info(chalk.bold('\n📊 Task Statistics\n'));
        Object.entries(stats).forEach(([key, value]) => {
          logger.info(`  ${key}: ${value}`);
        });
      })
  );

// Skill commands
program
  .command('skill')
  .description('Manage skills')
  .addCommand(
    new Command('list')
      .description('List available skills')
      .action(() => {
        const { skillManager } = initializeComponents();
        const skills = skillManager.getAll();

        logger.info(chalk.bold('\n🛠️  Available Skills\n'));
        skills.forEach(s => {
          const status = s.enabled ? chalk.green('✓') : chalk.red('✗');
          logger.info(`${status} ${chalk.cyan(s.name)} [${s.category}]`);
          logger.info(`  ${s.description}`);
          logger.info(`  Commands: ${s.commands.map(c => c.name).join(', ')}`);
          logger.info();
        });
      })
  )
  .addCommand(
    new Command('exec')
      .description('Execute a skill command')
      .argument('<command>', 'Command name (e.g., docker.list, health.check)')
      .option('-p, --params <params>', 'Parameters as JSON string')
      .action(async (command, options) => {
        const spinner = ora('Executing command...').start();
        const { skillManager } = initializeComponents();

        try {
          const skill = skillManager.findCommand(command);
          if (!skill) {
            spinner.fail(`Command not found: ${command}`);
            return;
          }

          // For demonstration, just show the command info
          // In production, you'd execute the actual handler
          spinner.succeed(`Command: ${skill.name}`);
          logger.info(`Description: ${skill.description}`);
          logger.info(`Handler: ${skill.handler}`);
          if (skill.parameters) {
            logger.info(`Parameters: ${JSON.stringify(skill.parameters)}`);
          }
        } catch (error) {
          spinner.fail(`Error: ${(error as Error).message}`);
        }
      })
  );

// Organization commands
program
  .command('org')
  .description('Manage organization')
  .addCommand(
    new Command('init')
      .description('Initialize a default organization')
      .option('-p, --platform <platform>', 'Default AI platform', 'claude')
      .action(async (options) => {
        const spinner = ora('Initializing organization...').start();

        try {
          const { organization } = initializeComponents();

          // Create director
          await organization.createDirector(options.platform);

          spinner.succeed('Organization initialized!');
          logger.info(chalk.green('\nDirector created. Add team members with:'));
          logger.info(chalk.gray('  itops agent create <name> sysadmin'));
          logger.info(chalk.gray('  itops agent create <name> specialist --specialty <type>'));
        } catch (error) {
          spinner.fail(`Error: ${(error as Error).message}`);
        }
      })
  )
  .addCommand(
    new Command('tree')
      .description('Show organization tree')
      .action(() => {
        const { organization } = initializeComponents();
        const tree = organization.getAgentTree();

        logger.info(chalk.bold('\n🏢 Organization Tree\n'));
        logger.info(JSON.stringify(tree, null, 2));
      })
  );

// Server command
program
  .command('start')
  .description('Start the web server')
  .option('-p, --port <port>', 'Port number', '19123')
  .action(async (options) => {
    const { startServer } = await import('../web/server.js');
    await startServer(parseInt(options.port));
  });

// Interactive mode
program
  .command('chat')
  .description('Interactive chat mode')
  .argument('[agent]', 'Agent ID or name (default: director)')
  .action(async (agentId) => {
    const { organization } = initializeComponents();

    // Use director if no agent specified
    let targetId = agentId || 'director';
    let agent = organization.getAgent(targetId) ||
                organization.getAllAgents().find(a => a.name === targetId);

    if (!agent) {
      // Try to get director
      agent = organization.getDirector();
      if (!agent) {
        logger.info(chalk.red('No agents found. Initialize with: itops org init'));
        return;
      }
    }

    logger.info(chalk.bold(`\n💬 Chat with ${agent.name}\n`));
    logger.info(chalk.gray('Type "exit" to quit\n'));

    while (true) {
      const { message } = await inquirer.prompt([
        {
          type: 'input',
          name: 'message',
          message: chalk.cyan('You:')
        }
      ]);

      if (message.toLowerCase() === 'exit') {
        logger.info(chalk.gray('Goodbye!'));
        break;
      }

      if (!message.trim()) continue;

      const spinner = ora('Thinking...').start();
      try {
        const response = await agent.processMessage(message);
        spinner.stop();
        logger.info(chalk.bold(`${agent.name}:`));
        logger.info(response);
        logger.info();
      } catch (error) {
        spinner.fail(`Error: ${(error as Error).message}`);
      }
    }
  });

program.parse();

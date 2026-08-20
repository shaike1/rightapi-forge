// Full Admin Dashboard for RightAPI Forge

// Step 1 — validate the environment before ANY other module loads. A
// missing required secret or a malformed numeric here exits the process
// with a clear error block on stderr; everything below this line gets
// to assume the env is sane.
import { validateAtStartup } from '../config/ConfigValidator.js';
validateAtStartup();

// Step 2 — telemetry must be imported and started before any other module
// that we want to instrument loads, so auto-instrumentations can patch
// `http`/`express` etc. before they're used. The init helper itself is a
// no-op when OTEL_ENABLED is unset / false.
import { initTelemetry } from '../observability/Telemetry.js';
await initTelemetry();

// Component loggers used throughout this file. Wrapping the base JSON
// logger via createLogger gives every record a `component` tag plus
// whatever traceId / spanId the active OTel span carries.
import { createLogger } from '../observability/Logger.js';
const serverLog = createLogger({ component: 'server' });
const healthLog = createLogger({ component: 'health-monitor' });
const schedLog  = createLogger({ component: 'scheduler' });

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import https from 'https';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFileSync, exec } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { AIProviderFactory } from '../ai/factory.js';
import { AiDecisionStore } from '../ai/AiDecisionStore.js';
import { AutonomyAttemptStore } from '../ai/AutonomyAttemptStore.js';
import { computeAutonomyMetrics } from '../ai/AutonomyMetrics.js';
import { AutonomyWatchdog } from '../ai/AutonomyWatchdog.js';
import { AutoTriageEngine } from '../ai/AutoTriageEngine.js';
import { AutoResolver } from '../ai/AutoResolver.js';
import { PredictiveEngine } from '../ai/PredictiveEngine.js';
import { AutoRunbookGenerator } from '../ai/AutoRunbookGenerator.js';
import { ProviderHealthMonitor } from '../ai/ProviderHealthMonitor.js';
import { taskDurationMinutes } from './agentPerformanceMetrics.js';
import { AlertManager } from '../alerting/AlertManager.js';
import { NotificationService as AlertNotificationService } from '../alerting/NotificationService.js';
import { buildMonitoringAlertConditions } from '../monitoring/MonitoringAlertConditions.js';
import missionControlRouter from './missionControlApi.js';
import autocompleteRouter from './autocompleteApi.js'
import chatRouter from './chatApi.js'
import { ChatHistoryStore } from './chatHistoryStore.js'
import ralphTuiRouter from './ralphTuiApi.js'
import { createRunbooksRouter } from './runbooksApi.js'
import { OrganizationManager } from '../agents/Organization.js';
import { AgentMessageBus, type AgentBusMessage } from '../agents/AgentMessageBus.js';
import { AgentRouter } from '../agents/AgentRouter.js';
import { AgentWorkloadTracker } from '../agents/AgentWorkloadTracker.js';
import { pickAgentForIncident } from '../agents/IncidentRouter.js';
import { AgentSpecialization } from '../agents/AgentSpecialization.js';
import { createReflectionsRouter } from './reflectionsApi.js';
import { Agent } from '../agents/Agent.js';
import { UsageTracker } from '../agents/UsageTracker.js';
import { createUsageRouter } from './usageApi.js';
import { createCircuitBreakerRouter } from './circuitBreakerApi.js';
import { TaskManager } from '../tasks/TaskManager.js';
import { DelegationManager } from '../tasks/DelegationManager.js';
import automationRouter from './automationApi.js';
import alertsRouter, { startAlertEvaluator } from './alertsApi.js';
import analyticsRouter from './analyticsApi.js';
import leaderboardRouter from './leaderboardApi.js';
import integrationsRouter from './integrationsApi.js';
import { createAIAssistantRouter } from './aiAssistantApi.js';
import selfHealingRouter from './selfHealingApi.js';
import marketplaceRouter from './marketplaceApi.js';
import multiTenantRouter from './multiTenantApi.js';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swaggerConfig.js';
import { createTaskAssignmentRouter } from './taskAssignmentApi.js';
import { createWorkflowsRouter } from './workflowsApi.js';
import { createOpsMonitoringRouter } from './opsMonitoringApi.js';
import { OperationalInsightsService } from '../monitoring/OperationalInsightsService.js';
import { WorkflowEngine } from '../workflows/WorkflowEngine.js';
import { RunbookEngine } from '../runbooks/RunbookEngine.js';
import { RunbookRunStore } from '../runbooks/RunbookRunStore.js';
import { RunbookApprovalStore } from '../runbooks/RunbookApprovalStore.js';
import { RunbookMatcher } from '../runbooks/RunbookMatcher.js';
import { PluginManager } from '../plugins/PluginManager.js';
import { SLAEngine } from '../sla/SLAEngine.js';
import { createSlaRouter } from './slaApi.js';
import { ReportGenerator } from '../reports/ReportGenerator.js';
import { ProblemStore } from '../incidents/ProblemStore.js';
import { RecurringDetector } from '../incidents/RecurringDetector.js';
import { createProblemsRouter } from './problemsApi.js';
import { ReportScheduler } from '../reports/ReportScheduler.js';
import { renderHtml as renderReportHtml, renderMarkdown as renderReportMarkdown, renderJson as renderReportJson } from '../reports/ReportFormatter.js';
import { createReportsRouter } from './reportsApi.js';
import type { DeliveryChannel, ReportData } from '../reports/ReportTypes.js';
import { PluginConfigEncryption } from '../plugins/PluginConfigEncryption.js';
import { createPluginHttp } from '../plugins/PluginHttpClient.js';
import { PagerDutyPlugin } from '../plugins/builtin/PagerDutyPlugin.js';
import { OpsGeniePlugin } from '../plugins/builtin/OpsGeniePlugin.js';
import { PrometheusPlugin } from '../plugins/builtin/PrometheusPlugin.js';
import { createIntegrationPluginsRouter } from './integrationPluginsApi.js';
import { createMcpRouter, MCP_TOOLS_CATALOGUE } from '../mcp/ITOpsMcpServer.js';
import { PluginLoader } from '../plugins/PluginLoader.js';
import { createPlannerApi } from './plannerApi.js';
import { createFactoryRouter } from './factoryApi.js';
import { FactoryTaskService } from '../factory/FactoryTaskService.js';
import { DelegationPolicyStore } from '../tasks/DelegationPolicyStore.js';
import { TaskSnapshotStore } from '../tasks/TaskSnapshotStore.js';
import { SkillManager } from '../skills/SkillManager.js';
import type { AIPlatform, Task, TaskStatus, Delegation, DelegationState } from '../types/index.js';
import { SANDBOX_LAUNCH_SPECS, TOOL_POLICIES, getToolLaunchSpec, getToolPolicy } from '../security/ToolingPolicy.js';
import { evaluateToolExecution } from '../security/ExecutionGuard.js';
import { CredentialVault } from '../security/CredentialVault.js';
import { TaskScheduler } from '../automation/TaskScheduler.js';
import { IncidentManager } from '../incidents/IncidentManager.js';
import { ChatBotService } from '../chat/index.js';
import { AgentIncidentHandler } from '../incidents/AgentIncidentHandler.js';
import { createIncidentVerifier } from '../incidents/IncidentVerifier.js';
import { EscalationPipeline } from '../incidents/EscalationPipeline.js';
import { PostMortemGenerator } from '../incidents/PostMortemGenerator.js';
import { PostMortemStore } from '../persistence/PostMortemStore.js';
import { IncidentAutoRemediator } from '../self-healing/IncidentAutoRemediator.js';
import { SystemMonitors } from '../monitoring/SystemMonitors.js';
import { ServerRegistry, LOCAL_SERVER_ID, type MonitoredServer } from '../monitoring/ServerRegistry.js';
import { AssetStore } from '../cmdb/AssetStore.js';
import { ImpactAnalyzer } from '../cmdb/ImpactAnalyzer.js';
import { createAssetsRouter } from './assetsApi.js';
import { ChangeStore } from '../changes/ChangeStore.js';
import { ChangeCorrelation } from '../changes/ChangeCorrelation.js';
import { createChangesRouter } from './changesApi.js';
import { KnowledgeStore } from '../knowledge/KnowledgeStore.js';
import { createKnowledgeRouter } from './knowledgeApi.js';
import { RemoteExecutor } from '../monitoring/RemoteExecutor.js';
import { MaintenanceStore } from '../maintenance/MaintenanceStore.js';
import { MaintenanceScheduler } from '../maintenance/MaintenanceScheduler.js';
import { createMaintenanceRouter } from './maintenanceApi.js';
import { MetricsHistoryStore } from '../monitoring/MetricsHistoryStore.js';
import { DataLifecycleManager } from '../ops/DataLifecycleManager.js';
import { TrendAnalyzer } from '../monitoring/TrendAnalyzer.js';
import { createServersRouter } from './serversApi.js';
import { createMetricsHistoryRouter } from './metricsHistoryApi.js';
import { createActivityFeedRouter } from './activityFeedApi.js';
import { IncidentAnalyzer } from '../ai/IncidentAnalyzer.js';
import { RunbookGenerator } from '../ai/RunbookGenerator.js';
import { JiraIntegrationService, JiraTicket } from '../integrations/JiraIntegrationService.js';
import { getOpenClaw } from '../integrations/openclaw.js';
import { TicketingSink } from "../integrations/TicketingSink.js";
import { getTelegram } from '../integrations/telegram.js';
import { SqliteIncidentStore, SqliteAgentMemoryStore } from '../persistence/SqliteStore.js';
import { AlertRulesEngine } from '../automation/AlertRulesEngine.js';
import { correlationEngine } from '../automation/AlertCorrelationEngine.js';
import { anomalyDetector } from '../monitoring/AnomalyDetector.js';
import { ApprovalTokenService } from '../security/ApprovalTokenService.js';
import { ExecutionAuditStore } from '../security/ExecutionAuditStore.js';
import { ApprovalTokenLedger } from '../security/ApprovalTokenLedger.js';
import { AuthService } from '../security/AuthService.js';
import type { Permission, UserRole } from '../security/AuthService.js';
import { ApiKeyService } from "../security/ApiKeyService.js";
import { AuditLog } from "../security/AuditLog.js";
import { createAuthMiddleware } from "../security/authMiddleware.js";
import { createRbacRouter } from "./rbacApi.js";
import { createPluginRouter } from "./pluginApi.js";
import { createAuthUsersRouter } from './authUsersApi.js';
import { createImprovementLoopRouter } from './improvementLoopApi.js';
import { createAutonomyRouter } from './autonomyApi.js';
import { createIncidentsRouter } from './incidentsApi.js';
import { createPostMortemsRouter } from './postMortemsApi.js';
import { createExternalApiRouter } from './externalApi.js';
import { createTaskQueueRouter, buildTaskQueueStats } from './taskQueueApi.js';
import { createJiraRouter } from './jiraApi.js';
import { createSettingsRouter } from './settingsApi.js';
import { createOperationalAlertsRouter } from './operationalAlertsApi.js';
import { createSecurityRouter } from './securityApi.js';
import { createDelegationsRouter } from './delegationsApi.js';
import { createTasksRouter } from './tasksApi.js';
import { createAgentsRouter } from './agentsApi.js';
import { createPerformanceRouter } from './performanceApi.js';
import { createK8sRouter } from './k8sApi.js';
import { createScheduledTasksRouter } from './scheduledTasksApi.js';
import { createAutomationRulesRouter } from './automationRulesApi.js';
import { createSchedulesRouter } from './schedulesApi.js';
import { createCrystallizedSkillsRouter } from './crystallizedSkillsApi.js';
import { createSdkRouter } from './sdkApi.js';
import { createBuilderRouter } from './builderApi.js';
import {
  AppGenerator, BuilderProjectRegistry, DockerPreviewBackend, PreviewRuntime,
  LocalGateRuntimeVerifier, QualityEvidenceRegistry, QualityGateRunner,
  ToolReleaseManager, ToolReleaseStore, FilesystemGitReleaseExporter, DockerToolDeploymentAdapter,
  ManagedIntegrationRegistry, ManagedIntegrationBroker, ToolCatalog,
  AppSpecEditor, ToolLaunchRuntime, DockerToolRuntimeGateway,
} from '../builder/index.js';
import { createRbacAdminRouter } from './rbacAdminApi.js';
import { createApprovalsRouter } from './approvalsApi.js';
import { createAgentBusRouter } from './agentBusApi.js';
// (Phase-35 createMonitoredServersRouter import removed — superseded by
// the SQLite-backed ServerRegistry + /api/servers router below.)
import { createWebhooksRouter } from './webhooksApi.js';
import { createOrchestratorRouter } from './orchestratorApi.js';
import { createCredentialsRouter } from './credentialsApi.js';
import { createSystemRouter } from './systemApi.js';
import { createAgentsAddonsRouter } from './agentsAddonsApi.js';
import { createAgentChatRouter, createRoundtableRouter } from './agentChatApi.js';
import { ADAuthManager } from '../auth/ADAuthManager.js';
import { ADConfigStore } from '../auth/ADConfigStore.js';
import { TeamsProvider } from '../integrations/TeamsProvider.js';
import { TeamsWebhookHandler } from '../integrations/TeamsWebhookHandler.js';
import { TeamsConfigStore } from '../integrations/TeamsConfigStore.js';
import { AgentCardService } from '../a2a/AgentCardService.js';
import { A2ATaskStore } from '../a2a/A2ATaskStore.js';
import { A2ATaskRunner } from '../a2a/A2ATaskRunner.js';
import { A2APeerClient } from '../a2a/A2APeerClient.js';
import { A2APeerRouter } from '../a2a/A2APeerRouter.js';
import { ExternalAgentRegistry } from '../a2a/ExternalAgentRegistry.js';
import { NLIntentClassifier } from '../a2a/NLIntentClassifier.js';
import type { A2ATaskSendParams, A2AJsonRpcRequest, A2AJsonRpcResponse } from '../a2a/A2ATypes.js';
import { SandboxRunner } from '../security/SandboxRunner.js';
import { ConcurrencyPolicyStore } from '../security/ConcurrencyPolicyStore.js';
import { PrivilegedTargetAllowlistPolicyStore } from '../security/PrivilegedTargetAllowlistPolicyStore.js';
import { CredentialCatalogStore } from '../security/CredentialCatalogStore.js';
import { CredentialExecutionResolver } from '../security/CredentialExecutionResolver.js';
import { PolicyChangeAuditStore } from '../security/PolicyChangeAuditStore.js';
import { SlaSnapshotStore } from '../metrics/SlaSnapshotStore.js';
import { SlaSnapshotPolicyStore } from '../metrics/SlaSnapshotPolicyStore.js';
import { StateBackupManager, type BackupTargetFile, type BackupSummary } from '../ops/StateBackupManager.js';
import { buildBackupInventory, planBackupCoverage, type BackupInventoryVolume } from '../ops/BackupInventory.js';
import { SqliteBackupRunner } from '../ops/SqliteBackupRunner.js';
import { SqliteVacuumRunner } from '../ops/SqliteVacuumRunner.js';
import { DatabaseSizeMonitor } from '../ops/DatabaseSizeMonitor.js';
import { requestContextMiddleware } from './requestContextMiddleware.js';
import { setCurrentUserId } from '../observability/RequestContext.js';
import cronLib from 'node-cron';
import { S3BackupUploader } from '../backup/S3BackupUploader.js';
import { RecoverySetManager } from '../backup/RecoverySetManager.js';
import { FactoryBoardService } from '../factory/FactoryBoardService.js';
import { OrchestratorReliabilityPolicyStore } from '../orchestrator/OrchestratorReliabilityPolicyStore.js';
import {
  OrchestratorService,
  type OrchestratorReliabilityPolicy,
  type OrchestratorRecoveryEvent
} from '../orchestrator/OrchestratorService.js';
import codexBridgeRouter from './codex-bridge.js';
import agentBridgeRouter from './agentBridgeApi.js';
import apiKeysRouter, { getAICredentials } from "./api-keys.js";
import credentialsRouter from "./credentials.js";
import credentialCatalogRouter from './credential-catalog.js';
import agentConfigRouter from "./agent-config.js";
import orgChartRouter from "./org-chart.js";
import letThemTalkRouter, { bridgeEvents } from "./letThemTalkApi.js";
import rateLimit from 'express-rate-limit';
import {
  applySecurity,
  globalLimiter,
  authLimiter as authLimiterTight,
  aiLimiter,
  wsRateLimiter,
} from './securityMiddleware.js';
import { sanitiseBodyMiddleware } from './validation.js';
import { errorHandler, installCrashGuards } from './errorMiddleware.js';
import { aiProxyGuard, AIProxyBreakerOpenError } from '../ai/AIProxyGuard.js';
import { SmtpService } from '../notifications/SmtpService.js';
import { EmailService } from '../notifications/EmailService.js';
import { SlackService } from '../notifications/SlackService.js';
import { DiscordService } from '../notifications/DiscordService.js';
import { PushService, type PushPayload } from '../notifications/PushService.js';
import { createPushRouter } from './pushApi.js';
import { DiscordBot } from '../integrations/DiscordBot.js';
import { ReportsScheduler } from '../notifications/ReportsScheduler.js';
import Database from 'better-sqlite3';
import { validateHmacWebhook } from '../utils/webhookValidator.js';
import { logger } from '../utils/logger.js';
import auditLogRouter from "./auditLogApi.js";
import cicdRouter from "./cicdApi.js";
import { IRCBridgeService } from '../irc/IRCBridgeService.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.get("/tui", (_req, res) => res.sendFile("tui.html", { root: "public" }));
app.get("/tui-chat", (_req, res) => res.sendFile("tui-chat.html", { root: "public" }));
app.get("/tui-bridge", (_req, res) => res.sendFile("tui-bridge.html", { root: "public" }));
app.get("/tui-incidents", (_req, res) => res.sendFile("tui-incidents.html", { root: "public" }));
app.get("/tui-servers", (_req, res) => res.sendFile("tui-servers.html", { root: "public" }));
app.get("/tui-workflows", (_req, res) => res.sendFile("tui-workflows.html", { root: "public" }));
app.get("/tui-monitoring", (_req, res) => res.sendFile("tui-monitoring.html", { root: "public" }));
app.get("/tui-audit",      (_req, res) => res.sendFile("tui-audit.html",      { root: "public" }));
app.get("/tui-agents",     (_req, res) => res.sendFile("tui-agents.html",     { root: "public" }));
app.get("/tui-irc",        (_req, res) => res.sendFile("tui-irc.html",        { root: "public" }));
app.get("/agent-runtime",  (_req, res) => res.sendFile("agent-runtime.html",  { root: "public" }));
app.get("/automation", (_req, res) => res.sendFile("automation-dashboard.html", { root: "public" }));
app.get("/rbac", (_req, res) => res.sendFile("rbac-dashboard.html", { root: "public" }));
app.get("/plugin-manager", (_req, res) => res.sendFile("plugin-manager.html", { root: "public" }));
app.get("/agent-bridge", (_req, res) => res.sendFile("agent-bridge.html", { root: "public" }));
app.get("/task-assignment", (_req, res) => res.sendFile("task-assignment.html", { root: "public" }));
app.get("/workflows", (_req, res) => res.sendFile("workflows.html", { root: "public" }));
app.get("/global", (_req, res) => res.sendFile("global-status.html", { root: "public" }));
app.get("/scheduler", (_req, res) => res.sendFile("scheduler.html", { root: "public" }));
app.get("/incidents", (_req, res) => res.sendFile("incidents.html", { root: "public" }));
app.get("/servers", (_req, res) => res.sendFile("servers.html", { root: "public" }));
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, { customSiteTitle: "RightAPI Forge API" }));
app.get("/api-docs.json", (_req, res) => { res.setHeader("Content-Type", "application/json"); res.send(swaggerSpec); });
// /api/docs alias — the hardening spec asks for this path explicitly so
// API clients have a stable, predictable Swagger UI URL co-located with
// the rest of the /api/* surface. Same swagger spec, just a second
// mount point. The JSON variant under /api/docs.json mirrors the
// legacy /api-docs.json so tooling can hit either.
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, { customSiteTitle: "RightAPI Forge API" }));
app.get("/api/docs.json", (_req, res) => { res.setHeader("Content-Type", "application/json"); res.send(swaggerSpec); });
app.use(express.static('public', { index: false }));

// React SPA — serve index.html for all /app/* routes
app.get("/app", (_req, res) => res.sendFile("app/index.html", { root: "public" }));
app.get("/app/*", (_req, res) => res.sendFile("app/index.html", { root: "public" }));

// Self-service portal — short URL alias for /app/portal/. The React app
// owns rendering; this just shortens the link end-users get told to
// open. The trailing slash is preserved so deep links like
// /portal/ticket/INC-123 still resolve under the BrowserRouter basename.
app.get("/portal", (_req, res) => res.redirect(302, "/app/portal/"));
app.get("/portal/*", (req, res) => res.redirect(302, "/app" + req.originalUrl));

// Prometheus HTTP metrics — captures method/route/status/duration for
// every API request. Mounted before the request-context middleware so a
// failed metrics record never blocks the request scope.
app.use(metricsMiddleware);

// Request-context middleware — generates/propagates X-Request-Id and
// runs every request inside an AsyncLocalStorage scope so downstream
// logs carry the request id without explicit plumbing. Also emits ONE
// summary log line per request when the response finishes
// (method/path/status/duration/userId). Skips /app/* static assets so
// SPA refreshes don't drown the log.
app.use(requestContextMiddleware({ skipPrefixes: ['/app/', '/api/docs/'] }));

app.get("/performance", (_req, res) => {
  res.sendFile("performance.html", { root: "public" });
});

app.get("/task-queue", (_req, res) => {
  res.sendFile("task-queue.html", { root: "public" });
});

app.get("/agent-chat", (_req, res) => {
  res.sendFile("agent-chat.html", { root: "public" });
});

app.get("/agent-details", (_req, res) => {
  res.sendFile("agent-details.html", { root: "public" });
});

app.get("/monitoring", (_req, res) => {
  res.sendFile("monitoring.html", { root: "public" });
});
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Load configuration from environment or use defaults
const config = {
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  openaiKey: process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
  ollamaUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_DEFAULT_MODEL || 'llama3',
  defaultPlatform: process.env.DEFAULT_AI_PLATFORM || 'claude',
  orgName: process.env.ORG_NAME || 'IT Ops Team'
};
const rawBackupHealthHours = Number(process.env.BACKUP_HEALTH_MAX_AGE_HOURS || '24');
const BACKUP_HEALTH_MAX_AGE_HOURS = Number.isFinite(rawBackupHealthHours) && rawBackupHealthHours > 0
  ? rawBackupHealthHours
  : 24;
const BACKUP_AUTOMATION_ENABLED = parseBoolEnv(process.env.BACKUP_AUTOMATION_ENABLED, false);
const rawBackupAutomationIntervalMinutes = Number(process.env.BACKUP_AUTOMATION_INTERVAL_MINUTES || '60');
const BACKUP_AUTOMATION_INTERVAL_MINUTES = Number.isFinite(rawBackupAutomationIntervalMinutes) && rawBackupAutomationIntervalMinutes >= 5
  ? Math.floor(rawBackupAutomationIntervalMinutes)
  : 60;
const BACKUP_AUTOMATION_RUN_ON_STARTUP = parseBoolEnv(process.env.BACKUP_AUTOMATION_RUN_ON_STARTUP, false);
const rawRetentionKeepLatest = Number(process.env.RETENTION_KEEP_LATEST || '30');
const RETENTION_KEEP_LATEST = Number.isFinite(rawRetentionKeepLatest) && rawRetentionKeepLatest >= 0
  ? Math.floor(rawRetentionKeepLatest)
  : 30;
const rawRetentionMaxAgeDays = Number(process.env.RETENTION_MAX_AGE_DAYS || '14');
const RETENTION_MAX_AGE_DAYS = Number.isFinite(rawRetentionMaxAgeDays) && rawRetentionMaxAgeDays >= 0
  ? Math.floor(rawRetentionMaxAgeDays)
  : 14;
const RECOVERY_SET_ENABLED = parseBoolEnv(process.env.RECOVERY_SET_ENABLED, false);
const RECOVERY_SET_CRON = process.env.RECOVERY_SET_CRON || '15 3 * * *';
const rawRecoverySetRetain = Number(process.env.RECOVERY_SET_RETAIN || 7);
const RECOVERY_SET_RETAIN = Number.isFinite(rawRecoverySetRetain) ? Math.max(1, Math.floor(rawRecoverySetRetain)) : 7;
const rawRecoverySetMaxAgeDays = Number(process.env.RECOVERY_SET_MAX_AGE_DAYS || 14);
const RECOVERY_SET_MAX_AGE_DAYS = Number.isFinite(rawRecoverySetMaxAgeDays) ? Math.max(1, Math.floor(rawRecoverySetMaxAgeDays)) : 14;
const backupSchedulerState: BackupSchedulerState = {
  enabled: BACKUP_AUTOMATION_ENABLED,
  intervalMinutes: BACKUP_AUTOMATION_INTERVAL_MINUTES,
  retentionKeepLatest: RETENTION_KEEP_LATEST,
  retentionMaxAgeDays: RETENTION_MAX_AGE_DAYS
};
const PRIVILEGED_TARGET_ALLOWLIST = String(process.env.PRIVILEGED_TARGET_ALLOWLIST || '')
  .split(',')
  .map(value => value.trim().toLowerCase())
  .filter(Boolean);
const CREDENTIAL_ANOMALY_WINDOW_MINUTES = Math.max(5, Number(process.env.CREDENTIAL_ANOMALY_WINDOW_MINUTES || 60));
const CREDENTIAL_ANOMALY_MAX_USES = Math.max(3, Number(process.env.CREDENTIAL_ANOMALY_MAX_USES || 10));
const ORCHESTRATOR_SLO_WINDOW_MINUTES = Math.max(15, Number(process.env.ORCHESTRATOR_SLO_WINDOW_MINUTES || 60));
const ORCHESTRATOR_SLO_MAX_QUARANTINED = Math.max(0, Number(process.env.ORCHESTRATOR_SLO_MAX_QUARANTINED || 1));
const ORCHESTRATOR_SLO_MAX_RECOVERY_FAILED = Math.max(0, Number(process.env.ORCHESTRATOR_SLO_MAX_RECOVERY_FAILED || 0));
const ORCHESTRATOR_SLO_MIN_SUCCESS_RATE = Math.min(
  1,
  Math.max(0, Number(process.env.ORCHESTRATOR_SLO_MIN_SUCCESS_RATE || 0.9))
);

// IRC Bridge configuration
const IRC_BRIDGE_ENABLED = ['1', 'true', 'yes', 'on'].includes((process.env.IRC_BRIDGE_ENABLED || '').toLowerCase());

interface BackupHealthResponse {
  thresholdHours: number;
  latestBackup: BackupSummary | null;
  backupAgeSeconds: number | null;
  stale: boolean;
  verification?: {
    ok: boolean;
    verifiedAt: string;
    backup?: BackupSummary;
    checks?: Array<{ key: string; exists: boolean; required: boolean; hashMatches?: boolean; reason?: string }>;
    error?: string;
  };
}

interface BackupSchedulerState {
  enabled: boolean;
  intervalMinutes: number;
  retentionKeepLatest: number;
  retentionMaxAgeDays: number;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  lastBackupId?: string;
  lastPrunedCount?: number;
}

interface RecoverySchedulerState {
  enabled: boolean;
  cron: string;
  retentionKeepLatest: number;
  retentionMaxAgeDays: number;
  offsiteConfigured: boolean;
  keySource: SecretSource;
  externalKeyCustody: boolean;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  lastRecoveryId?: string;
  lastArchiveBytes?: number;
  lastOffsiteKey?: string;
  lastOffsiteVerified?: boolean;
  lastOffsiteSha256?: string;
  lastPrunedCount?: number;
  lastRestoreAt?: string;
  lastRestoreRecoveryId?: string;
  lastRestoreTarget?: string;
  lastRestoreError?: string;
}

interface OrchestratorReliabilitySloResponse {
  generatedAt: string;
  windowMinutes: number;
  thresholds: {
    maxQuarantined: number;
    maxRecoveryFailed: number;
    minSuccessRate: number;
  };
  totals: {
    actions: number;
    retries: number;
    quarantined: number;
    recoveryFailed: number;
  };
  successRate: number;
  breaches: Array<{
    key: 'max_quarantined' | 'max_recovery_failed' | 'min_success_rate';
    message: string;
  }>;
  tuningSuggestions: Array<{
    id: string;
    title: string;
    reason: string;
    patch: Partial<OrchestratorReliabilityPolicy>;
  }>;
  status: 'ok' | 'warning';
  recommendations: string[];
  sample: OrchestratorRecoveryEvent[];
}

interface OpenClawChatState {
  chatId: string;
  userId?: string;
  targetAgentId?: string;
  threadId?: string;
  lastDeliveredAt?: string;
  updatedAt: string;
}

interface OpenClawBridgeStateFile {
  version: number;
  chats: Record<string, OpenClawChatState>;
}

function parseBoolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

type SecretSource = 'env' | 'file' | 'command' | 'provider_vault' | 'provider_file' | 'provider_aws_sm' | 'provider_gcp_sm' | 'provider_azure_kv' | 'default';

function readSecretFromEnvDirect(name: string): { value: string; source: SecretSource } {
  const direct = process.env[name];
  if (direct !== undefined && String(direct).trim() !== '') {
    return { value: String(direct), source: 'env' };
  }
  const filePath = process.env[`${name}_FILE`];
  if (filePath && String(filePath).trim() !== '') {
    try {
      return { value: fs.readFileSync(String(filePath), 'utf8').trim(), source: 'file' };
    } catch (error) {
      logger.error(`Failed to read ${name}_FILE:`, { err: (error as Error).message });
    }
  }
  const command = process.env[`${name}_CMD`];
  if (command && String(command).trim() !== '') {
    try {
      const output = execFileSync('/bin/sh', ['-lc', String(command)], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 64
      }).trim();
      if (output) {
        return { value: output, source: 'command' };
      }
    } catch (error) {
      logger.error(`Failed to run ${name}_CMD:`, { err: (error as Error).message });
    }
  }
  return { value: '', source: 'default' };
}

function readSecretFromProvider(name: string): { value: string; source: SecretSource } {
  const provider = String(process.env.SECRET_PROVIDER || '').trim().toLowerCase();
  if (!provider || provider === 'none') {
    return { value: '', source: 'default' };
  }
  const providerSecretKey = process.env[`${name}_PROVIDER_KEY`]
    ? String(process.env[`${name}_PROVIDER_KEY`]).trim()
    : name.toLowerCase();
  if (!providerSecretKey) {
    return { value: '', source: 'default' };
  }
  if (provider === 'file') {
    const providerFilePath = String(process.env.SECRET_PROVIDER_FILE_PATH || '/data/itops-agents/secret-provider.json').trim();
    if (!providerFilePath) {
      return { value: '', source: 'default' };
    }
    try {
      const raw = fs.readFileSync(providerFilePath, 'utf8');
      const parsed = JSON.parse(raw) as { secrets?: Record<string, unknown>; [key: string]: unknown };
      const source = parsed && typeof parsed === 'object' && parsed.secrets && typeof parsed.secrets === 'object'
        ? parsed.secrets as Record<string, unknown>
        : parsed as Record<string, unknown>;
      const value = source && Object.prototype.hasOwnProperty.call(source, providerSecretKey)
        ? source[providerSecretKey]
        : undefined;
      if (value === undefined || value === null) {
        return { value: '', source: 'default' };
      }
      return { value: String(value).trim(), source: 'provider_file' };
    } catch (error) {
      logger.error(`Failed to load ${name} from file provider:`, { err: (error as Error).message });
      return { value: '', source: 'default' };
    }
  }
  if (provider === 'aws_sm') {
    const region = String(process.env.SECRET_PROVIDER_AWS_REGION || '').trim();
    const defaultSecretId = String(process.env.SECRET_PROVIDER_AWS_SECRET_ID || '').trim();
    const secretId = process.env[`${name}_AWS_SECRET_ID`]
      ? String(process.env[`${name}_AWS_SECRET_ID`]).trim()
      : defaultSecretId;
    const secretKey = process.env[`${name}_AWS_KEY`]
      ? String(process.env[`${name}_AWS_KEY`]).trim()
      : providerSecretKey;
    if (!secretId || !secretKey) {
      return { value: '', source: 'default' };
    }
    try {
      const args = ['secretsmanager', 'get-secret-value', '--secret-id', secretId, '--query', 'SecretString', '--output', 'text'];
      if (region) {
        args.push('--region', region);
      }
      const secretString = execFileSync('aws', args, {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024
      }).trim();
      if (!secretString || secretString === 'None' || secretString === 'null') {
        return { value: '', source: 'default' };
      }
      const normalized = secretString.trim();
      if ((normalized.startsWith('{') && normalized.endsWith('}')) || (normalized.startsWith('[') && normalized.endsWith(']'))) {
        const parsed = JSON.parse(normalized) as Record<string, unknown>;
        const value = Object.prototype.hasOwnProperty.call(parsed, secretKey) ? parsed[secretKey] : undefined;
        if (value === undefined || value === null) {
          return { value: '', source: 'default' };
        }
        return { value: String(value).trim(), source: 'provider_aws_sm' };
      }
      // If the secret string is a plain value, accept it only when key explicitly points to full payload.
      if (secretKey === '_' || secretKey === 'value' || secretKey === 'secret') {
        return { value: normalized, source: 'provider_aws_sm' };
      }
      return { value: '', source: 'default' };
    } catch (error) {
      logger.error(`Failed to load ${name} from aws_sm provider:`, { err: (error as Error).message });
      return { value: '', source: 'default' };
    }
  }
  if (provider === 'gcp_sm') {
    const project = String(process.env.SECRET_PROVIDER_GCP_PROJECT || '').trim();
    const defaultSecretId = String(process.env.SECRET_PROVIDER_GCP_SECRET_ID || '').trim();
    const secretId = process.env[`${name}_GCP_SECRET_ID`]
      ? String(process.env[`${name}_GCP_SECRET_ID`]).trim()
      : defaultSecretId;
    const secretKey = process.env[`${name}_GCP_KEY`]
      ? String(process.env[`${name}_GCP_KEY`]).trim()
      : providerSecretKey;
    if (!secretId || !secretKey) {
      return { value: '', source: 'default' };
    }
    try {
      const args = ['secrets', 'versions', 'access', 'latest', `--secret=${secretId}`];
      if (project) {
        args.push(`--project=${project}`);
      }
      const secretString = execFileSync('gcloud', args, {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024
      }).trim();
      if (!secretString || secretString === 'None' || secretString === 'null') {
        return { value: '', source: 'default' };
      }
      const normalized = secretString.trim();
      if ((normalized.startsWith('{') && normalized.endsWith('}')) || (normalized.startsWith('[') && normalized.endsWith(']'))) {
        const parsed = JSON.parse(normalized) as Record<string, unknown>;
        const value = Object.prototype.hasOwnProperty.call(parsed, secretKey) ? parsed[secretKey] : undefined;
        if (value === undefined || value === null) {
          return { value: '', source: 'default' };
        }
        return { value: String(value).trim(), source: 'provider_gcp_sm' };
      }
      if (secretKey === '_' || secretKey === 'value' || secretKey === 'secret') {
        return { value: normalized, source: 'provider_gcp_sm' };
      }
      return { value: '', source: 'default' };
    } catch (error) {
      logger.error(`Failed to load ${name} from gcp_sm provider:`, { err: (error as Error).message });
      return { value: '', source: 'default' };
    }
  }
  if (provider === 'azure_kv') {
    const vaultName = String(process.env.SECRET_PROVIDER_AZURE_VAULT_NAME || '').trim();
    const defaultSecretName = String(process.env.SECRET_PROVIDER_AZURE_SECRET_NAME || '').trim();
    const secretName = process.env[`${name}_AZURE_SECRET_NAME`]
      ? String(process.env[`${name}_AZURE_SECRET_NAME`]).trim()
      : defaultSecretName;
    const secretKey = process.env[`${name}_AZURE_KEY`]
      ? String(process.env[`${name}_AZURE_KEY`]).trim()
      : providerSecretKey;
    if (!vaultName || !secretName || !secretKey) {
      return { value: '', source: 'default' };
    }
    try {
      const secretString = execFileSync('az', [
        'keyvault',
        'secret',
        'show',
        '--vault-name',
        vaultName,
        '--name',
        secretName,
        '--query',
        'value',
        '-o',
        'tsv'
      ], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024
      }).trim();
      if (!secretString || secretString === 'None' || secretString === 'null') {
        return { value: '', source: 'default' };
      }
      const normalized = secretString.trim();
      if ((normalized.startsWith('{') && normalized.endsWith('}')) || (normalized.startsWith('[') && normalized.endsWith(']'))) {
        const parsed = JSON.parse(normalized) as Record<string, unknown>;
        const value = Object.prototype.hasOwnProperty.call(parsed, secretKey) ? parsed[secretKey] : undefined;
        if (value === undefined || value === null) {
          return { value: '', source: 'default' };
        }
        return { value: String(value).trim(), source: 'provider_azure_kv' };
      }
      if (secretKey === '_' || secretKey === 'value' || secretKey === 'secret') {
        return { value: normalized, source: 'provider_azure_kv' };
      }
      return { value: '', source: 'default' };
    } catch (error) {
      logger.error(`Failed to load ${name} from azure_kv provider:`, { err: (error as Error).message });
      return { value: '', source: 'default' };
    }
  }
  if (provider !== 'vault') {
    return { value: '', source: 'default' };
  }
  const vaultAddr = String(process.env.SECRET_PROVIDER_VAULT_ADDR || '').trim().replace(/\/+$/, '');
  const tokenResolved = readSecretFromEnvDirect('SECRET_PROVIDER_VAULT_TOKEN');
  const vaultToken = tokenResolved.value;
  if (!vaultAddr || !vaultToken) {
    return { value: '', source: 'default' };
  }
  const defaultPath = String(process.env.SECRET_PROVIDER_VAULT_PATH || '').trim();
  const pathKey = process.env[`${name}_VAULT_PATH`] ? String(process.env[`${name}_VAULT_PATH`]).trim() : defaultPath;
  if (!pathKey) {
    return { value: '', source: 'default' };
  }
  const secretKey = process.env[`${name}_VAULT_KEY`]
    ? String(process.env[`${name}_VAULT_KEY`]).trim()
    : providerSecretKey;
  if (!secretKey) {
    return { value: '', source: 'default' };
  }
  const pathNoSlash = pathKey.replace(/^\/+/, '');
  const url = `${vaultAddr}/v1/${pathNoSlash}`;
  try {
    const output = execFileSync('curl', ['-fsS', '-H', `X-Vault-Token: ${vaultToken}`, url], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    const parsed = JSON.parse(output || '{}') as {
      data?: {
        data?: Record<string, unknown>;
        [k: string]: unknown;
      };
    };
    const kv2Data = parsed?.data?.data;
    const flatData = parsed?.data;
    const fromKv2 = kv2Data && Object.prototype.hasOwnProperty.call(kv2Data, secretKey)
      ? kv2Data[secretKey]
      : undefined;
    const fromFlat = flatData && Object.prototype.hasOwnProperty.call(flatData, secretKey)
      ? flatData[secretKey]
      : undefined;
    const value = fromKv2 !== undefined ? fromKv2 : fromFlat;
    if (value === undefined || value === null) {
      return { value: '', source: 'default' };
    }
    return { value: String(value).trim(), source: 'provider_vault' };
  } catch (error) {
    logger.error(`Failed to load ${name} from Vault provider:`, { err: (error as Error).message });
    return { value: '', source: 'default' };
  }
}

function readSecretFromEnv(name: string, fallback: string = ''): { value: string; source: SecretSource } {
  const direct = readSecretFromEnvDirect(name);
  if (direct.value) {
    return direct;
  }
  const provided = readSecretFromProvider(name);
  if (provided.value) {
    return provided;
  }
  return { value: fallback, source: 'default' };
}

function isWeakSecret(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.toLowerCase();
  if (value.length < 32) return true;
  const banned = [
    'change-this-master-key',
    'itops-master-key-change-me',
    'itops-approval-secret-change-me',
    'changeme',
    'password',
    'secret'
  ];
  return banned.some(item => normalized.includes(item));
}

// Store for configuration updates
let runtimeConfig = { ...config };
const CONFIG_PATH = process.env.CONFIG_PATH || '/data/itops-agents/config.json';

function loadPersistedConfig(): void {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const persisted = JSON.parse(raw);
    runtimeConfig = { ...runtimeConfig, ...persisted };
  } catch (error) {
    logger.error('Failed to load persisted config:', { err: (error as Error).message });
  }
}

function persistConfig(): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(runtimeConfig, null, 2), 'utf8');
  } catch (error) {
    logger.error('Failed to persist config:', { err: (error as Error).message });
  }
}

loadPersistedConfig();

function openAIRouteSettings() {
  return {
    openaiExpectedModel: process.env.OPENAI_EXPECTED_MODEL,
    openaiFallbackBaseUrl: process.env.OPENAI_FALLBACK_BASE_URL,
    openaiFallbackModel: process.env.OPENAI_FALLBACK_MODEL,
    openaiFallbackExpectedModel: process.env.OPENAI_FALLBACK_EXPECTED_MODEL,
    openaiFailureThreshold: Number(process.env.OPENAI_BREAKER_FAILURE_THRESHOLD || 3),
    openaiBreakerOpenMs: Number(process.env.OPENAI_BREAKER_OPEN_MS || 60_000),
    openaiLatencyBudgetMs: Number(process.env.OPENAI_LATENCY_BUDGET_MS || 30_000),
    openaiErrorRateBudget: Number(process.env.OPENAI_ERROR_RATE_BUDGET || 0.2),
  };
}


// Initialize components using persisted/runtime config
const aiFactory = new AIProviderFactory({
  ...getAICredentials(),
  anthropicApiKey: runtimeConfig.anthropicKey,
  // Optional: route Anthropic SDK calls through a proxy (e.g. cliproxy
  // exposing /v1/messages). When unset the SDK uses api.anthropic.com.
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
  anthropicModel:   process.env.ANTHROPIC_MODEL,
  openaiApiKey: process.env.OPENAI_API_KEY || runtimeConfig.openaiKey,
  openaiBaseUrl: process.env.OPENAI_BASE_URL || runtimeConfig.openaiBaseUrl,
  openaiModel: process.env.OPENAI_MODEL || runtimeConfig.openaiModel,
  ...openAIRouteSettings(),
  ollamaBaseUrl: runtimeConfig.ollamaUrl,
  ollamaModel: config.ollamaModel
}, { preferredPlatform: (runtimeConfig.defaultPlatform || 'openai') as AIPlatform });

const ORG_FILE = process.env.ORGANIZATION_FILE || '/data/itops-agents/organization.json';
const organization = new OrganizationManager(runtimeConfig.orgName, aiFactory);
// טען ארגון מהקובץ אם קיים
try {
  if (organization.load(ORG_FILE)) {
    logger.info('✅ Organization loaded from ' + ORG_FILE);
  } else {
    logger.info('📝 No organization file found, creating new one...');
  }
} catch (error) {
  logger.error('❌ Failed to load organization:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
}

{
  const override = String(process.env.AGENT_AI_PLATFORM_OVERRIDE || '').trim();
  if (override) {
    if (!['claude', 'openai', 'ollama'].includes(override)) {
      throw new Error(`Unsupported AGENT_AI_PLATFORM_OVERRIDE: ${override}`);
    }
    const changed = organization.setAllAgentPlatforms(override as AIPlatform);
    if (changed > 0) {
      organization.save(ORG_FILE);
      logger.info('[migration] Updated persisted agent AI platforms', {
        platform: override,
        changed
      });
    }
  }
}

// ── Skill backfill ───────────────────────────────────────────────────────────
// Sysadmins persisted before the incident toolkit existed won't have
// 'incident' / 'runbook' in their config.skills, which means the agent
// ReAct loop can't see those tools. Backfill them on load so an upgrade
// applies on the next restart without forcing operators to recreate agents.
{
  const incidentToolkit = ['incident', 'runbook'];
  let mutated = false;
  for (const agent of organization.getAllAgents()) {
    if (agent.role !== 'sysadmin' && agent.role !== 'director') continue;
    const current = new Set(agent.config.skills || []);
    for (const s of incidentToolkit) {
      if (!current.has(s)) { current.add(s); mutated = true; }
    }
    agent.config.skills = Array.from(current);
  }
  if (mutated) {
    try {
      organization.save(ORG_FILE);
      logger.info('[migration] Backfilled incident toolkit into existing sysadmin/director agents');
    } catch (e) {
      logger.warn('[migration] Skill backfill save failed', { err: e instanceof Error ? e.message : String(e) });
    }
  }
}
const taskManager = new TaskManager(
  process.env.TASK_DB_PATH || '/data/itops-agents/tasks.db'
);
const delegationManager = new DelegationManager(
  process.env.DELEGATION_STORE_PATH || '/data/itops-agents/delegations.json'
);
const chatHistoryStore = new ChatHistoryStore(
  process.env.CHAT_HISTORY_PATH || '/data/itops-agents/chat-history.json'
);
const delegationPolicyStore = new DelegationPolicyStore(
  process.env.DELEGATION_POLICY_PATH || '/data/itops-agents/delegation-policy.json'
);
const taskSnapshotStore = new TaskSnapshotStore(
  process.env.TASK_SNAPSHOT_PATH || '/data/itops-agents/task-snapshots.json'
);
const agentBus = new AgentMessageBus(
  process.env.AGENT_BUS_PATH || '/data/itops-agents/agent-bus.json'
);
const skillManager = new SkillManager();
// Wire agent-to-agent delegation: lets any agent invoke delegate.ask /
// delegate.broadcast / delegate.status during its ReAct loop. The agent bus
// doubles as the audit log so the conversation thread shows delegation
// requests + responses alongside regular messages. The router uses the
// DelegationSkill's own load tracker for in-flight counts and the bus's
// historical stats for past success rate.
const delegationExec = skillManager.getExecutor('delegation') as unknown as
  { getActiveTaskCount(id: string): number } | undefined;
const agentRouter = new AgentRouter({
  loadSource: delegationExec ? { getActiveTaskCount: (id) => delegationExec.getActiveTaskCount(id) } : undefined,
  historySource: { getDelegationStatsByAssignee: () => agentBus.getDelegationStatsByAssignee() },
});
skillManager.wireDelegation(organization, { auditor: agentBus, router: agentRouter });

// ─── Self-Development SDK ────────────────────────────────────────────
// Lets operations agents extend the platform from inside. The service does
// the heavy lifting (plan, scan, generate, sandbox-test, commit on a
// feature branch); the agent-facing skills wrap that surface so a
// DevelopmentAgent can drive it through the standard skill dispatcher.
// The HTTP routes (POST /api/sdk/*) are wired alongside the deploy
// surface further down — they share the `settings.manage` permission.
import { SelfDevelopmentService } from '../sdk/SelfDevelopmentService.js';
import { CodeWriterSkill }  from '../skills/sdk/CodeWriterSkill.js';
import { CodeTesterSkill }  from '../skills/sdk/CodeTesterSkill.js';
import { GitSkill as SdkGitSkill } from '../skills/sdk/GitSkill.js';
import { DeploySkill as SdkDeploySkill } from '../skills/sdk/DeploySkill.js';
const selfDevelopmentService = new SelfDevelopmentService({
  // repoRoot defaults to the package root at runtime (two levels up
  // from dist/sdk/SelfDevelopmentService.js).
  //
  // deployTrigger: bridges a successful SDK session to the GitHub
  // Actions deploy workflow. Without this hook the pipeline writes
  // files + commits a feature branch but never fires a deploy — the
  // session just stops at "branch ready". With it wired, the same
  // bridge powering the manual Deploy button (POST /api/deploy/trigger)
  // gets called with the SDK's branch name as the ref. Only fires
  // when GH_DEPLOY_TOKEN + GH_DEPLOY_REPO are set; otherwise resolves
  // undefined (the SDK gracefully falls back to "deploy skipped").
  deployTrigger: async (ref) => {
    const token = process.env.GH_DEPLOY_TOKEN;
    const repo = process.env.GH_DEPLOY_REPO;
    const workflow = process.env.GH_DEPLOY_WORKFLOW || 'deploy.yml';
    if (!token || !repo) return undefined;
    try {
      await ghApi<void>(`/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
        method: 'POST',
        body: JSON.stringify({ ref }),
      });
      // GitHub's dispatches endpoint returns 204 with no run id — the
      // dashboard polls /api/deploy/status to find the run that just
      // got created. Returning undefined here is honest about that.
      return undefined;
    } catch (err) {
      serverLog.warn('[sdk] deploy trigger failed', { ref, err: (err as Error).message });
      return undefined;
    }
  },
  // onHistory: every SDK session emits an event so the history panel
  // and downstream tools (alerting on rejected sessions, daily reports)
  // see the full development trail. The in-process ring buffer is
  // still authoritative for the /api/sdk/history endpoint; this is
  // additive observability.
  onHistory: (action) => {
    const verb = action.outcome ?? 'planned';
    const type =
      verb === 'completed' ? EventTypes.SDK_COMPLETED
      : verb === 'rejected' ? EventTypes.SDK_REJECTED
      : verb === 'failed'   ? EventTypes.SDK_FAILED
      : EventTypes.SDK_PLANNED;
    void eventBus.publish({
      aggregateType: AggregateTypes.SDK,
      aggregateId: action.id,
      type,
      actor: action.actor || 'sdk',
      data: {
        kind: action.kind,
        description: action.description?.slice(0, 200),
        files: action.files,
        testsPassed: action.testsPassed,
        testsFailed: action.testsFailed,
        durationMs: action.durationMs,
        branch: action.branch,
        workflowRunId: action.workflowRunId,
      },
    });
  },
});
{
  const codeWriter = new CodeWriterSkill();
  const codeTester = new CodeTesterSkill(selfDevelopmentService);
  const sdkGit     = new SdkGitSkill();
  const sdkDeploy  = new SdkDeploySkill(selfDevelopmentService);
  skillManager.registerWithExecutor(codeWriter.getSkill(), codeWriter as any);
  skillManager.registerWithExecutor(codeTester.getSkill(), codeTester as any);
  skillManager.registerWithExecutor(sdkGit.getSkill(),     sdkGit     as any);
  skillManager.registerWithExecutor(sdkDeploy.getSkill(),  sdkDeploy  as any);
  serverLog.info('self-development SDK ready', {
    skills: ['sdk.codeWriter', 'sdk.codeTester', 'sdk.git', 'sdk.deploy'],
  });
}

// ─── External MCP clients (ITOps as MCP client) ──────────────────────
// Lets ITOps connect *outward* to other MCP servers (OpenClaw, custom
// integrations, etc.) and use their tools. The manager owns the
// connection fleet; the McpToolsSkill exposes a small command surface to
// the agent's ReAct loop for tool discovery and invocation. Init runs
// async — bad/slow servers never block startup.
import { getMcpClientManager } from '../integrations/mcp/McpClientManager.js';
import { McpToolsSkill } from '../skills/McpToolsSkill.js';
const mcpClientManager = getMcpClientManager();
{
  const mcpToolsSkill = new McpToolsSkill(mcpClientManager);
  skillManager.registerWithExecutor(mcpToolsSkill.getSkill(), mcpToolsSkill as any);
  void mcpClientManager.init().catch(err => {
    serverLog.warn('mcp client manager init failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  });
  serverLog.info('mcp client manager ready', { skill: 'mcp' });
}

// JSON workflow registry + executor — declarative, file-driven workflows
// validated against the schema in src/workflows/WorkflowDef.ts. Every
// run + step emits events on the EventBus so dashboards and replays
// see the full trail. Lives next to the legacy WorkflowEngine (which
// stays for the imperative templates) — this layer is for JSON-defined
// workflows under SKILL_WORKFLOW_DIR.
import { WorkflowRegistry } from '../workflows/WorkflowRegistry.js';
import { WorkflowJsonExecutor } from '../workflows/WorkflowJsonExecutor.js';
const workflowRegistry = new WorkflowRegistry({
  workflowDir: process.env.WORKFLOW_DIR || '/data/itops-agents/workflows',
});
{
  const r = workflowRegistry.loadAll();
  serverLog.info('json workflow registry ready', {
    dir: process.env.WORKFLOW_DIR || '/data/itops-agents/workflows',
    loaded: r.loaded, failed: r.failed,
  });
}

// Runbook library — bundled JSON workflows under src/runbooks/library/.
// Loaded once at startup into the same WorkflowRegistry so /run hits
// them by id without any operator action. Library content is curated +
// versioned by the platform; operator-supplied runbooks live in
// WORKFLOW_DIR and stay separate.
import { RunbookLibrary } from '../runbooks/RunbookLibrary.js';
const runbookLibrary = new RunbookLibrary();
{
  const r = runbookLibrary.loadAll(workflowRegistry);
  serverLog.info('runbook library ready', { loaded: r.loaded, failed: r.failed });
}

// ─── Early-init secrets + ApprovalTokenService ───────────────────────
// These need to land BEFORE WorkflowJsonExecutor below — its constructor
// dereferences `approvalTokenService` synchronously, so a forward-reference
// would crash at module load (the original layout had it ~550 lines later
// and ESM TDZ rules turned it into a ReferenceError). The full secrets
// validation block (weak-secret checks, CredentialVault, rotation manager,
// AuthService) still runs further down the file — only the inputs needed
// by the workflow executor have been hoisted.
const credentialMasterKeyPrimary = readSecretFromEnv('CREDENTIAL_MASTER_KEY', '');
const credentialMasterKeyLegacy = credentialMasterKeyPrimary.value
  ? { value: '', source: 'default' as SecretSource }
  : readSecretFromEnv('SECRET_MASTER_KEY', '');
const credentialMasterKey = credentialMasterKeyPrimary.value || credentialMasterKeyLegacy.value;
const credentialMasterKeySource = credentialMasterKeyPrimary.value
  ? credentialMasterKeyPrimary.source
  : (credentialMasterKeyLegacy.value ? credentialMasterKeyLegacy.source : 'default');
const approvalTokenSecretResolved = readSecretFromEnv('APPROVAL_TOKEN_SECRET', '');
const approvalTokenSecret = approvalTokenSecretResolved.value;
const approvalTokenSecretSource = approvalTokenSecretResolved.source;
const authTokenSecretResolved = readSecretFromEnv('AUTH_TOKEN_SECRET', '');
const authTokenSecret = authTokenSecretResolved.value;
const authTokenSecretSource = authTokenSecretResolved.source;
const approvalTokenService = new ApprovalTokenService(
  approvalTokenSecret || credentialMasterKey || 'change-this-master-key'
);

const workflowJsonExecutor = new WorkflowJsonExecutor({
  skillManager,
  approvals: approvalTokenService,
});

// Workflow-aware scheduler — durable cron jobs whose actions are
// either a registered workflow id (typically a runbook from the
// library above) or an inline shell command. The engine persists
// schedules + run history in storeFactory.schedules, replays missed
// runs on startup within a configurable window, and enforces a
// per-schedule in-flight lock so a long-running run can't be
// shadowed by the next cron tick.
import { ScheduleEngine } from '../scheduling/ScheduleEngine.js';
import { buildSchedule } from '../scheduling/ScheduledTaskTypes.js';
// storeFactory is hoisted: the ScheduleEngine + crystallization wiring
// below dereference its sub-stores synchronously at module load, so
// declaring it later (where the rest of the persistence wiring lives)
// would be a TDZ ReferenceError. The getStoreFactory import below in
// this file is hoisted by ESM, so calling it here is safe.
import { getStoreFactory } from '../persistence/StoreFactory.js';
const storeFactory = getStoreFactory();
serverLog.info('store factory ready', { provider: storeFactory.getProvider() });

const scheduleEngine = new ScheduleEngine({
  store:            storeFactory.schedules,
  workflowExecutor: workflowJsonExecutor,
  workflowRegistry: workflowRegistry,
  skillManager:     skillManager,
  missedRunWindowMs: Number(process.env.SCHEDULE_MISSED_WINDOW_MS) || 24 * 60 * 60 * 1000,
});

// Default schedules — seeded once for new deployments. Existing rows
// keep their state (cron + status), so an operator who paused the
// daily health check stays paused across restarts. The seed only
// fires for ids not already present.
async function seedDefaultSchedules(): Promise<void> {
  // Where the host-targeting runbooks should SSH to. Inside Docker, the
  // host running the daemon is reachable as host.docker.internal — that
  // matches the SSH key mount layout (/root/.ssh:ro from the host).
  // Operators can override per deployment via MONITORED_DEFAULT_HOST.
  const monitoredHost = process.env.MONITORED_DEFAULT_HOST || 'host.docker.internal';
  const want = [
    buildSchedule({
      id: 'default.daily-health-check',
      name: 'Daily Health Check',
      cron: '0 7 * * *',
      action: { kind: 'workflow', workflowId: 'library.server-health-check',
                inputs: { host: monitoredHost, service: 'ssh' } },
      description: 'Bundled runbook: server-health-check on the default monitored host.',
    }),
    buildSchedule({
      id: 'default.weekly-cert-scan',
      name: 'Weekly Certificate Expiry Scan',
      cron: '0 6 * * 1',
      action: { kind: 'workflow', workflowId: 'library.certificate-expiry-scan',
                inputs: { host: monitoredHost } },
      description: 'Bundled runbook: certificate-expiry-scan, weekly.',
    }),
    buildSchedule({
      id: 'default.daily-backup-verification',
      name: 'Daily Backup Verification',
      cron: '0 5 * * *',
      action: { kind: 'workflow', workflowId: 'library.backup-verification' },
      description: 'Bundled runbook: backup-verification on the local backup dir.',
    }),
    // Real-work schedules below: each runs a workflow that produces
    // concrete numbers + named offenders in its summary line, and fails
    // when its threshold is breached so the alert pipeline picks it up.
    buildSchedule({
      id: 'default.docker-housekeeping',
      name: 'Docker Housekeeping (every 6h)',
      cron: '0 */6 * * *',
      action: { kind: 'workflow', workflowId: 'library.docker-housekeeping' },
      description: 'Counts unhealthy/flapping containers and dangling-image disk reclaim. Fails when action is needed.',
    }),
    buildSchedule({
      id: 'default.log-error-scan',
      name: 'Log Error Scan (every 30 min)',
      cron: '*/30 * * * *',
      action: { kind: 'workflow', workflowId: 'library.log-error-scan',
                inputs: { host: monitoredHost, windowMinutes: 30, errorThreshold: 50 } },
      description: 'Scans host journal + each container\'s last 30m of logs for errors. Reports top noisy units.',
    }),
    buildSchedule({
      id: 'default.disk-space-audit',
      name: 'Disk Space Audit (daily 04:30)',
      cron: '30 4 * * *',
      action: { kind: 'workflow', workflowId: 'library.disk-space-audit',
                inputs: { host: monitoredHost } },
      description: 'Per-mount %use, top 10 largest files, reclaimable old logs, docker overlay size.',
    }),
    buildSchedule({
      id: 'default.security-audit',
      name: 'Security Audit (daily 03:30)',
      cron: '30 3 * * *',
      action: { kind: 'workflow', workflowId: 'library.security-audit',
                inputs: { host: monitoredHost, windowHours: 24 } },
      description: 'Failed SSH attempts + top source IPs, listening ports, pending security updates, recent sudo.',
    }),
    buildSchedule({
      id: 'default.service-dependency-check',
      name: 'Service Dependency Check (every 15 min)',
      cron: '*/15 * * * *',
      action: { kind: 'workflow', workflowId: 'library.service-dependency-check',
                inputs: { host: monitoredHost,
                          requiredServices: process.env.REQUIRED_SYSTEMD_UNITS || 'ssh docker',
                          requiredContainers: process.env.REQUIRED_CONTAINERS || 'itops-agents' } },
      description: 'Checks that required systemd units + docker containers are running and healthy.',
    }),
  ];
  for (const w of want) {
    const existing = await Promise.resolve(storeFactory.schedules.get(w.id));
    if (existing) continue;
    try { await scheduleEngine.upsert(w); }
    catch (err: unknown) {
      serverLog.warn('default schedule seed failed', { id: w.id, err: err instanceof Error ? err.message : String(err) });
    }
  }
}

if ((process.env.SCHEDULE_ENGINE_ENABLED ?? 'true').toLowerCase() !== 'false') {
  void seedDefaultSchedules()
    .then(() => scheduleEngine.start())
    .catch(err => serverLog.warn('schedule engine failed to start', { err: err?.message }));
}

// Skill plugin hot-reload — watches SKILL_PLUGIN_DIR and (un)registers
// skills as files land/change/disappear. Built-in skills are protected: a
// plugin cannot shadow a core capability. Distinct from the legacy
// directory-based PluginLoader (Phase 15) imported above — this one
// integrates directly with SkillManager so loaded plugins show up under
// /api/skills and on the dispatch path, not as a separate execution layer.
// Started in fire-and-forget — the loader logs its own status, and a
// failure to start the watcher is non-fatal (the process keeps serving
// with whatever plugins were loaded by the initial scan). The shutdown
// hook below stops the watcher cleanly.
import { SkillPluginLoader } from '../skills/SkillPluginLoader.js';
// First-party plugin dir (in-process, trusted code only).
const skillPluginLoader = new SkillPluginLoader(skillManager, {
  pluginDir: process.env.SKILL_PLUGIN_DIR || '/data/itops-agents/skill-plugins',
});
void skillPluginLoader.start().catch(err => serverLog.warn('skill plugin loader failed to start', { err: err?.message }));

// Third-party / sandboxed plugin dir — every plugin runs in a Worker
// thread with a permission manifest. Set SKILL_SANDBOX_PLUGIN_DIR to
// enable; otherwise this loader sits idle. Built-in skills are still
// protected from shadowing, and the worker terminates on shutdown.
const sandboxedSkillPluginLoader = new SkillPluginLoader(skillManager, {
  pluginDir: process.env.SKILL_SANDBOX_PLUGIN_DIR || '/data/itops-agents/skill-plugins-sandboxed',
  sandbox: true,
  sandboxSkillManager: skillManager,
});
void sandboxedSkillPluginLoader.start().catch(err => serverLog.warn('sandboxed plugin loader failed to start', { err: err?.message }));

// ─── Skill Crystallization ───────────────────────────────────────────
// Pipeline: ResolutionAnalyzer → SkillCrystallizer → CrystallizedSkillStore
// → AutoPromotion. Hooked into Agent.ts via the static crystallization
// hook so individual agents don't need to know about the service.
import { CrystallizationService } from '../crystallization/CrystallizationService.js';
import type { CrystallizedSkill } from '../crystallization/CrystallizedSkillTypes.js';
import { Agent } from '../agents/Agent.js';

// Autonomy loop — Piece A bridge.
// ActiveSkillRegistrar turns each "active" CrystallizedSkill into a
// SkillManager catalogue entry so agents can call it from their ReAct
// loop, not just via /api/workflows/json/:id/run. The registrar is
// constructed here (between WorkflowJsonExecutor and CrystallizationService)
// because the service's registerActive hook below calls it.
import { ActiveSkillRegistrar } from '../autonomy/ActiveSkillRegistrar.js';
const activeSkillRegistrar = new ActiveSkillRegistrar({
  skillManager,
  workflowExecutor: workflowJsonExecutor,
});

const crystallizationService = new CrystallizationService({
  store: storeFactory.crystallizedSkills,
  // When a skill becomes "active", do BOTH:
  //   1. Register the generated workflow with the WorkflowRegistry so
  //      /api/workflows/json/:id/run drives it like any other workflow.
  //   2. Register it with the SkillManager (via activeSkillRegistrar) so
  //      agents discover it in their dispatch table on the next ReAct
  //      step. This is the "crystallization → catalogue" link of the
  //      autonomy loop. WorkflowRegistry is necessary; SkillManager
  //      registration is what makes the skill actually reachable to
  //      agent reasoning.
  registerActive: (skill: CrystallizedSkill): boolean => {
    let workflowOk = false;
    try {
      const wf = JSON.parse(skill.generatedWorkflow);
      const result = workflowRegistry.registerFromObject(wf);
      if (!result.ok) {
        serverLog.warn('crystallized skill workflow rejected', { id: skill.id, errors: result.errors });
      } else {
        serverLog.info('crystallized skill registered as workflow', { id: skill.id, workflowId: wf.id });
        workflowOk = true;
      }
    } catch (err: unknown) {
      serverLog.warn('crystallized skill register (workflow) failed', { id: skill.id, err: err instanceof Error ? err.message : String(err) });
    }
    // Register in SkillManager too. Independent failure path so a
    // workflow-registry rejection doesn't keep the skill out of the
    // catalogue if the SkillManager registration succeeds (and vice
    // versa). We return true if EITHER path succeeded — the service's
    // contract is "did at least one consumer accept this skill".
    const skillOk = activeSkillRegistrar.register(skill);
    return workflowOk || skillOk;
  },
  // No native "unregister" exists on WorkflowRegistry today; re-running
  // registerFromObject overwrites the entry, so demoting just leaves
  // the prior registration in place but the skill row reflects the
  // new status. Future cleanup would prune the registry entry; for now
  // we log so an operator can audit.
  unregisterActive: (id: string): void => {
    // SkillManager-side: drop the catalogue entry so agents stop
    // seeing the skill in their next dispatch.
    activeSkillRegistrar.unregister(id);
    // WorkflowRegistry has no native "unregister"; re-running
    // registerFromObject overwrites the entry, so demoting just leaves
    // the prior registration in place but the skill row reflects the
    // new status. Future cleanup would prune the registry entry; for now
    // we log so an operator can audit.
    serverLog.info('crystallized skill demoted', { id });
  },
  // Bridge crystallization events into the durable EventBus so the
  // dashboard's activity feed + projections see them in real time.
  onEvent: (e) => {
    void eventBus.publish({
      tenantId: e.tenantId,
      aggregateType: 'crystallized_skill',
      aggregateId: e.skillId ?? e.agentId,
      type: e.type,
      actor: e.agentId,
      data: { from: e.from, to: e.to, reason: e.reason, analysis: e.analysis },
    }).catch((err) => serverLog.warn('crystallization event publish failed', { err: err?.message }));
  },
});

// Wire the static crystallization hook on Agent so EVERY agent's
// successful task funnels into the pipeline. Failures are swallowed
// at the Agent level; this is best-effort scaffolding.
// Autonomy loop — Pieces B + C.
// PatternDetector accumulates command sequences from every successful
// task. AutonomyOrchestrator periodically scans for recurring patterns
// (≥ 3 occurrences across ≥ 2 agents in the last 7 days) and fires
// the SDK pipeline to crystallize them into reusable plugins.
import { PatternDetector } from '../autonomy/PatternDetector.js';
import { AutonomyOrchestrator } from '../autonomy/AutonomyOrchestrator.js';
const patternDetector = new PatternDetector({
  minOccurrences:    parseInt(process.env.AUTONOMY_PATTERN_MIN_OCCURRENCES || '3', 10),
  minDistinctAgents: parseInt(process.env.AUTONOMY_PATTERN_MIN_AGENTS      || '2', 10),
});
const autonomyOrchestrator = new AutonomyOrchestrator(
  {
    crystallizationService,
    crystallizedStore: storeFactory.crystallizedSkills,
    activeSkillRegistrar,
    patternDetector,
    sdkService: selfDevelopmentService,
    skillManager,
    broadcast,
  },
  {
    intervalMs:           parseInt(process.env.AUTONOMY_LOOP_INTERVAL_MS     || '3600000', 10),
    maxSdkRequestsPerDay: parseInt(process.env.AUTONOMY_MAX_SDK_PER_DAY      || '3',       10),
    perPatternCooldownMs: parseInt(process.env.AUTONOMY_PATTERN_COOLDOWN_MS  || '86400000', 10),
    pluginHotReloadDir:   process.env.SKILL_PLUGIN_DIR || '/data/itops-agents/skill-plugins',
  },
);

Agent.setCrystallizationHook(async (input) => {
  // Pull existing crystallized skills for the novelty check inside
  // the analyzer. We bound the list to ~50 so the analyzer stays cheap.
  const existing = await Promise.resolve(
    storeFactory.crystallizedSkills.list({ status: 'active', limit: 50 }),
  );
  await crystallizationService.onResolutionCompleted({
    taskId: input.taskId,
    agentId: input.agentId,
    title: input.title,
    category: input.category,
    steps: input.steps,
    reflection: input.reflection,
    existingSkills: existing,
    // The store generates a resolution id we don't have here; using
    // taskId as the audit anchor is good enough — the source resolution
    // is recoverable from the agent_resolutions table by taskId.
    resolutionId: input.taskId,
  });
  // Feed the same trace into the autonomy orchestrator so it can
  // accumulate cross-task patterns. Best-effort — orchestrator
  // failures don't block crystallization.
  await autonomyOrchestrator.recordCompletedTask({
    taskId: input.taskId, agentId: input.agentId, title: input.title,
    category: input.category, steps: input.steps, reflection: input.reflection,
    existingSkills: existing,
  });
});

// Re-register every "active" crystallized skill at boot so the
// WorkflowRegistry AND SkillManager have them available before the
// first request lands.
void (async () => {
  const active = await Promise.resolve(storeFactory.crystallizedSkills.list({ status: 'active', limit: 200 }));
  for (const s of active) {
    try {
      const wf = JSON.parse(s.generatedWorkflow);
      workflowRegistry.registerFromObject(wf);
    } catch (err: unknown) {
      serverLog.warn('failed to re-register crystallized skill at boot', { id: s.id, err: err instanceof Error ? err.message : String(err) });
    }
  }
  if (active.length > 0) serverLog.info('crystallized skills re-registered', { count: active.length });
  // SkillManager-side re-registration: separately so a workflow JSON
  // failure doesn't take out the catalogue entry.
  const skillCount = await autonomyOrchestrator.activateExistingCrystallizedSkills();
  if (skillCount > 0) serverLog.info('crystallized skills available in SkillManager', { count: skillCount });
})();

if ((process.env.AUTONOMY_LOOP_ENABLED || '').toLowerCase() === 'true') {
  autonomyOrchestrator.start();
}

const taskScheduler = new TaskScheduler(
  process.env.SCHEDULER_TASKS_PATH || '/data/itops-agents/scheduled-tasks.json',
  async (agentId: string, prompt: string) => {
    const agents = organization.getAllAgents();
    const target = agentId === 'auto'
      ? agents.find(a => a.role !== 'director')
      : agents.find(a => a.id === agentId);
    const task = taskManager.createTask({
      title: prompt.slice(0, 80),
      description: prompt,
      category: 'monitoring',
      priority: 'medium',
      ownerId: 'scheduler',
      assignedTo: target?.id
    });
    return task.id;
  }
);
// Declared before incidentManager so the onCreated closure can reference it
let jiraService: JiraIntegrationService | null = null;
// Auto-remediator: handles disk/Docker/container incidents inline. Forward-
// declared because it needs an `IncidentManager` reference, but the manager
// constructor wants an onCreated closure that fires the remediator.
let autoRemediator: IncidentAutoRemediator | null = null;
// Agent-driven incident handler. Late-bound so the dispatchIncidentToAgent
// closure below can fire the ReAct loop once we've wired the handler with
// all its dependencies (skillManager, incidentManager, autoRemediator,
// workflow engine). When this is null (cold start, before the handler is
// constructed), dispatchIncidentToAgent falls back to its legacy
// "create-task-and-hope" behaviour so no incident gets dropped.
let agentIncidentHandler: AgentIncidentHandler | null = null;
// Chat-widget service. Late-bound — it needs incidentManager + serverRegistry,
// both of which are built below; the WebSocket dispatch checks for null when
// a chat:message arrives before init has completed (extremely brief window).
let chatBotService: ChatBotService | null = null;
// Runbook matcher. Late-bound — needs RemoteExecutor + ServerRegistry +
// MetricsHistoryStore (all built much later in this file). The inline
// IncidentManager.onCreated closure below references this binding by
// reference, so once the engine + matcher are wired up around line ~7420
// every subsequent incident creation runs through the matcher.
let runbookMatcher: RunbookMatcher | null = null;
// PluginManager — late-bound for the same reason. The inline
// IncidentManager.onCreated closure dispatches to plugins through this
// binding so the fan-out is additive and any plugin that throws is
// isolated (see PluginManager.fanOut).
let pluginManager: PluginManager | null = null;
// SLA Engine — late-bound so the IncidentManager.onCreated closure can
// kick off tracking, and so the tick + onResolved listener can run
// against the same instance. Constructed below after AlertRulesEngine.
let slaEngine: SLAEngine | null = null;
// Report scheduler — late-bound; needs metricsHistory + runbookRunStore
// + slaEngine, all of which are built later in the file. The cron tick
// + on-demand API both reference this binding.
let reportScheduler: ReportScheduler | null = null;
// Recurring-incident detector + its underlying ProblemStore. Both are
// constructed below — the inline IncidentManager.onCreated closure
// references the detector lazily so the fan-out picks up every newly
// created incident.
let problemStore: ProblemStore | null = null;
let recurringDetector: RecurringDetector | null = null;
// AI autonomy stack — built after stores exist (assetStore + changeStore
// + knowledgeStore + problemStore are all declared later in this file).
// The incident onCreated closure dereferences these lazily so every new
// incident flows through the autonomy chain (triage → resolve).
let autoTriageEngine: AutoTriageEngine | null = null;
let autoResolver:     AutoResolver     | null = null;
let predictiveEngine: PredictiveEngine | null = null;
let autoRunbookGenerator: AutoRunbookGenerator | null = null;
let aiDecisionStore:  AiDecisionStore  | null = null;
// Beacon self-monitor — built after the HealthChecker is fully wired
// and the IncidentManager exists. Polls the deep-health pipeline on a
// timer and files an incident against Beacon itself when a probe
// stays failing for N consecutive ticks. The route handler for
// /api/health/deep dereferences `beaconSelfMonitor` to surface the
// per-check failure-streak state, so the forward-decl matters.
let beaconSelfMonitor: BeaconSelfMonitor | null = null;

// ── Roles SQLite DB ───────────────────────────────────────────────────────────
const rolesDb = new Database(process.env.ROLES_DB_PATH || '/data/itops-agents/roles.db');
rolesDb.pragma('journal_mode = WAL');
rolesDb.pragma('synchronous = NORMAL');
rolesDb.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    permissions TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS user_roles (
    username TEXT NOT NULL,
    role_id INTEGER NOT NULL,
    PRIMARY KEY (username, role_id),
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
  );
`);
// ─────────────────────────────────────────────────────────────────────────────

// ── Notifications SQLite DB ───────────────────────────────────────────────────
const notificationsDb = new Database(process.env.NOTIFICATIONS_DB_PATH || '/data/itops-agents/notifications.db');
notificationsDb.pragma('journal_mode = WAL');
notificationsDb.pragma('synchronous = NORMAL');
notificationsDb.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    severity TEXT DEFAULT 'info',
    read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
// ─────────────────────────────────────────────────────────────────────────────

const incidentManager = new IncidentManager(
  new SqliteIncidentStore(process.env.INCIDENT_DB_PATH || '/data/itops-agents/incidents.db'),
  {
    critical: parseInt(process.env.SLA_CRITICAL_MINUTES || '60', 10),
    high:     parseInt(process.env.SLA_HIGH_MINUTES     || '240', 10),
    medium:   parseInt(process.env.SLA_MEDIUM_MINUTES   || '1440', 10),
    low:      parseInt(process.env.SLA_LOW_MINUTES      || '4320', 10),
  },
  (incident) => {
    logger.warn(`[CRITICAL INCIDENT] ${incident.id}: ${incident.title} — auto-escalation triggered`);
    broadcast({ type: 'critical_incident', data: incident });
  },
  // Auto-trigger AI analysis on every new incident, then auto-start the
  // incident-response workflow for high/critical ones.
  (incident) => {
    // ── 1a. AI triage decision (fire-and-forget) ──────────────────────────
    // The AutoTriageEngine classifies severity, picks an assignee, tags
    // the incident, and either auto-applies (confidence >= threshold)
    // or records a suggestion. Late-bound: the engine is null until
    // the asset/change/knowledge stores are wired further down in this
    // file. Once non-null, every new incident is triaged before
    // dispatch.
    if (autoTriageEngine) {
      autoTriageEngine.onIncidentCreated(incident).catch(e =>
        logger.warn('[AutoTriage] onIncidentCreated threw', { incidentId: incident.id, err: e instanceof Error ? e.message : String(e) })
      );
    }

    // ── 1b. AI auto-resolve evaluation (fire-and-forget) ──────────────────
    // For incidents that match a strongly-curated KB article AND a
    // runbook with a good track record, the resolver executes the
    // runbook in place. Critical incidents are always suggestion-only
    // and the threshold is configurable (default 0.85).
    if (autoResolver) {
      autoResolver.onIncidentCreated(incident).catch(e =>
        logger.warn('[AutoResolver] onIncidentCreated threw', { incidentId: incident.id, err: e instanceof Error ? e.message : String(e) })
      );
    }

    // ── 1. AI analysis for every severity ────────────────────────────────
    // Fire-and-forget so a slow LLM call can't block the create response.
    // The endpoint POST /api/incidents/:id/analyze does the same work
    // synchronously when an operator clicks "Analyze"; this just front-runs
    // that step so the analysis is already stored by the time anyone looks
    // at the incident. Errors only log — the incident itself is created
    // either way.
    (async () => {
      try {
        const similar = incidentManager.list({ severity: incident.severity })
          .filter(i => i.id !== incident.id)
          .slice(0, 3); // trimmed from 10 — large prompts trip Anthropic per-min token quota
        const analysis = await incidentAnalyzer.analyze(incident, similar);
        incidentManager.incidentStore.saveAnalysis(incident.id, JSON.stringify(analysis));
        broadcast({ type: 'incident_analyzed', data: { incidentId: incident.id } });
        logger.info(`[IncidentAnalysis] auto-analyzed ${incident.id} (severity=${incident.severity})`);
      } catch (e) {
        logger.error('[IncidentAnalysis] auto-analyze failed:', {
          incidentId: incident.id,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    })();

    // OpenClaw chat-gateway notification (every severity, fire-and-forget).
    // Disabled by default; activated via OPENCLAW_ENABLED + URL + token.
    const openclaw = getOpenClaw();
    if (openclaw.isConfigured()) {
      openclaw.sendAlert(incident).catch(e =>
        logger.error('[OpenClaw] sendAlert threw', {
          incidentId: incident.id,
          err: e instanceof Error ? e.message : String(e),
        })
      );
    }

    // Telegram bot alert — direct path to phone, independent of the
    // OpenClaw gateway. Min-severity defaults to "high", so low/medium
    // health-monitor noise stays out of chat unless explicitly lowered.
    const telegram = getTelegram();
    if (telegram.isConfigured()) {
      const serverName = incident.serverId
        ? serverRegistry.get(incident.serverId)?.name
        : undefined;
      telegram.sendAlert(incident, serverName).catch(e =>
        logger.error('[Telegram] sendAlert threw', {
          incidentId: incident.id,
          err: e instanceof Error ? e.message : String(e),
        })
      );
    }

    // Email notification — to assignee if known, otherwise to every
    // operator+admin in the system. Fire-and-forget; never blocks
    // incident creation. Disabled silently when SMTP is unconfigured.
    if (emailService.isEnabled()) {
      const recipients = resolveIncidentRecipients(incident);
      if (recipients.length > 0) {
        emailService.sendIncidentOpened(recipients, incident).catch(e =>
          logger.warn('[Email] sendIncidentOpened threw', {
            incidentId: incident.id, err: e instanceof Error ? e.message : String(e),
          })
        );
      }
    }

    // ── 1b. Auto-remediation — DEMOTED to fallback path ─────────────────
    // The auto-remediator (disk-cleanup / docker-housekeeping / container-
    // restart recipes) no longer fires unconditionally on every incident.
    // It's now invoked by AgentIncidentHandler ONLY when the agent's ReAct
    // loop fails or times out. This avoids the previous race where the
    // remediator pruned containers while the agent was still diagnosing.
    // If agentIncidentHandler is null (cold start, before wiring), the
    // legacy fallback in dispatchIncidentToAgent will fire the remediator
    // directly so no incident loses coverage.

    // ── 2. Workflow auto-start — DEMOTED to fallback path ──────────────
    // Workflow auto-start (e.g. incident-response template) used to fire
    // unconditionally for every high/critical incident. It's now invoked
    // by AgentIncidentHandler if neither the agent nor the auto-remediator
    // closed the incident. Keeping it here would race with the agent path.

    // Fire-and-forget Jira ticket creation (non-blocking, high/critical only).
    // Matches the previous gating — low/medium incidents stay agent-internal
    // until they escalate.
    if (jiraService && (incident.severity === 'high' || incident.severity === 'critical')) {
      jiraService.createTicketForIncident(incident).catch(e =>
        logger.error('[server] Jira ticket creation failed:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined })
      );
    }

    // ── 3. Pick & assign an agent, then create an investigation task ────
    // dispatchIncidentToAgent is defined below — it routes the incident
    // through pickAgentForIncident, marks the agent busy in the workload
    // tracker, sets the incident's assignedAgent + assignedTo fields, and
    // returns the agent it picked (or null if the org has no agents).
    try {
      dispatchIncidentToAgent(incident, 'auto-dispatch on create');
    } catch (e) {
      logger.error('[IncidentTask] Failed to dispatch agent on create:', { err: e instanceof Error ? e.message : String(e) });
    }

    // ── 4. RunbookMatcher trigger ────────────────────────────────────────
    // Runs alongside the existing library.incident-response trigger above —
    // keeping both so we don't pull the rug out from under any currently-
    // automated incident response. The matcher fires every enabled runbook
    // whose triggerType='incident_match' config matches this incident.
    if (runbookMatcher) {
      runbookMatcher.matchIncident({
        id: incident.id,
        title: incident.title,
        severity: incident.severity,
        sourceRef: incident.sourceRef ?? null,
        serverId: incident.serverId ?? null,
      }).catch(e => logger.warn('[RunbookMatcher] matchIncident threw', {
        incidentId: incident.id, err: e instanceof Error ? e.message : String(e),
      }));
    }

    // ── 5. PluginManager fan-out ─────────────────────────────────────────
    // Notifies every enabled integration plugin (PagerDuty, OpsGenie,
    // Prometheus, …) that a new incident exists. Fire-and-forget; errors
    // are isolated inside PluginManager.fanOut so a slow PagerDuty call
    // can't block any other path.
    pluginManager?.notifyIncidentCreated(incident);

    // ── 6. SLA tracking ─────────────────────────────────────────────────
    // Insert a tracking row with response + resolution deadlines. The
    // engine resolves the matching policy by severity; missing policies
    // log + skip rather than fail the create.
    try {
      slaEngine?.onIncidentCreated(incident);
    } catch (e) {
      logger.warn('[SLA] onIncidentCreated threw', { incidentId: incident.id, err: e instanceof Error ? e.message : String(e) });
    }

    // ── 7. RecurringDetector check ──────────────────────────────────────
    // Look at recently-resolved + active incidents and decide whether
    // this incident makes the count cross the recurrence threshold.
    // Fire-and-forget — errors are caught inside the detector and never
    // block incident creation.
    recurringDetector?.checkIncident(incident).catch(e =>
      logger.warn('[RecurringDetector] checkIncident threw', {
        incidentId: incident.id, err: e instanceof Error ? e.message : String(e),
      }),
    );
  }
);

// Workload tracker: who's busy with what. Persisted next to the
// incidents/tasks DBs so the panel survives a restart instead of
// looking like every agent suddenly went idle. Wired into the
// incidentManager once both exist.
const agentWorkloadTracker = new AgentWorkloadTracker(
  process.env.AGENT_WORKLOAD_PATH || '/data/itops-agents/agent-workload.json',
);
incidentManager.setWorkloadTracker(agentWorkloadTracker);
(globalThis as any).agentWorkloadTracker = agentWorkloadTracker;

// One-shot cleanup of incidents stuck on the 'IT Director' placeholder.
// Older health-monitor / trend-analyzer paths set assignedTo='IT Director'
// at create time, and assignAgent() only fills assignedTo when it's
// null, so those rows stayed labelled "IT Director" forever even after
// Ops Bravo / Ops Charlie / Ops Alpha actually picked them up via
// assignedAgent. The source-of-truth bug is fixed by removing the
// hardcoded label at the four creation sites, but the historical rows
// still need a sweep. Runs in setImmediate so the organization is fully
// loaded by then (its agents are the resolver source).
setImmediate(() => {
  try {
    const allAgents = organization.getAllAgents();
    const byId = new Map(allAgents.map(a => [a.id, a.name]));
    const fixed = incidentManager.rewriteStaleDirectorLabel(id => byId.get(id) ?? null);
    if (fixed > 0) {
      logger.info('[IncidentManager] cleaned stale "IT Director" labels at boot', { count: fixed });
    }
  } catch (e: any) {
    logger.error('[IncidentManager] director-label cleanup failed', { err: e?.message });
  }
});

// Agent server-affinity store. Defaults are seeded right below — the
// organization has been loaded for ~700 lines at this point, so the
// agent name lookups will resolve. Exposed on globalThis so the
// agents-API extension can reach it without a constructor injection.
const agentSpecialization = new AgentSpecialization(
  process.env.AGENT_AFFINITY_DB_PATH || '/data/itops-agents/agent-affinity.db',
);
(globalThis as any).agentSpecialization = agentSpecialization;

// Default affinity seeds — deferred to setImmediate so the
// serverRegistry (declared much later in this file) is in scope by the
// time we look up valid server ids. Maps the (case-insensitive) agent
// display name → list of server ids the agent should be preferred for.
// Only writes a row when the agent has none, so operator edits via PUT
// /api/agents/:id/affinity stick across boots.
setImmediate(() => {
  const SEEDS: Array<{ name: string; servers: string[] }> = [
    // local row's id stays 'local' even when its display name is 'vps1'
    { name: 'alice',       servers: ['local'] },
    { name: 'ops alpha',   servers: ['local'] },
    { name: 'ops bravo',   servers: ['vps2'] },
    { name: 'ops charlie', servers: ['vps2'] },
    { name: 'ops diana',   servers: ['vps3'] },
  ];
  const registry = (globalThis as any).serverRegistry as ServerRegistry | undefined;
  if (!registry) {
    logger.debug('[AgentSpecialization] deferred seed skipped — registry not ready yet');
    return;
  }
  const allAgents = organization.getAllAgents();
  let seededCount = 0;
  for (const seed of SEEDS) {
    const match = allAgents.find(a => (a.name ?? '').toLowerCase() === seed.name);
    if (!match) continue;
    const validServers = seed.servers.filter(sid => registry.get(sid) != null);
    if (validServers.length === 0) continue;
    const result = agentSpecialization.ensureSeed(match.id, validServers);
    if (result.created) {
      seededCount++;
      logger.info('[AgentSpecialization] seeded default affinity', {
        agent: match.name, agentId: match.id, servers: validServers,
      });
    }
  }
  if (seededCount === 0) {
    logger.debug('[AgentSpecialization] no new affinities seeded (already configured or agents missing)');
  }
});

/** Dispatch an incident to an agent. Used by the create-callback above
 *  and by the /escalate route. Picks an agent via the keyword router,
 *  marks them busy, persists assignedAgent on the incident, and creates
 *  an investigation task they can act on. Idempotent: if the incident
 *  is already assigned to the same agent the picker would choose, we
 *  just keep the existing assignment and re-emit the task creation. */
function dispatchIncidentToAgent(
  incident: { id: string; title: string; description?: string; severity: 'low' | 'medium' | 'high' | 'critical'; assignedAgent?: string | null; serverId?: string | null },
  reason: string,
): { agentId: string; agentName: string; taskId: string } | null {
  const agents = organization.getAllAgents();
  const healthyAgents = agents.filter(a => {
    if (a.config.status !== 'active') return false;
    if (!aiFactory.isPlatformAvailable(a.config.aiPlatform)) return false;
    return !Agent.isPlatformDegraded(a.config.aiPlatform);
  });
  if (healthyAgents.length === 0) {
    logger.warn(`[IncidentDispatch] No agents in org — cannot dispatch ${incident.id}`);
    const failures = agents
      .map(a => `${a.name}:${a.config.aiPlatform}${Agent.getPlatformFailure(a.config.aiPlatform)?.error ? ` (${Agent.getPlatformFailure(a.config.aiPlatform)?.error})` : ''}`)
      .join(', ');
    incidentManager.addNote(
      incident.id,
      'incident-dispatch',
      `No healthy AI agents available. Human attention required.${failures ? ` Agents: ${failures}` : ''}`,
    );
    incidentManager.escalate(incident.id, 'No healthy AI agents available for autonomous incident handling');
    createNotification('incident', 'Incident needs human attention', `${incident.id}: no healthy AI agents available`, 'critical');
    return null;
  }

  // Re-use the existing assignment if there is one — escalate calls
  // this with the latest incident state and we don't want to thrash
  // assignments on every escalation.
  let pickedAgent = incident.assignedAgent
    ? agents.find(a => a.id === incident.assignedAgent) || null
    : null;
  if (pickedAgent && !healthyAgents.some(a => a.id === pickedAgent!.id)) pickedAgent = null;
  let pickReason = reason;
  if (!pickedAgent) {
    // Resolve serverId from the persisted incident row if the caller
    // didn't include one (escalate path passes only id/title/severity).
    const serverId = incident.serverId
      ?? incidentManager.get(incident.id)?.serverId
      ?? null;
    const pick = pickAgentForIncident(
      { id: incident.id, title: incident.title, description: incident.description, severity: incident.severity, serverId },
      healthyAgents,
      {
        workload: agentWorkloadTracker,
        specialization: agentSpecialization,
        outcomeScore: agentId => autonomyAttemptStore.reliabilityForAgent(agentId),
      },
    );
    if (!pick) return null;
    pickedAgent = pick.agent;
    pickReason = `${reason} — ${pick.reason}`;
  }

  incidentManager.assignAgent(
    incident.id,
    { id: pickedAgent.id, name: pickedAgent.name },
    pickReason,
  );

  const sevLabel = incident.severity === 'critical' ? 'CRITICAL'
                 : incident.severity === 'high'     ? 'HIGH'
                                                    : incident.severity.toUpperCase();
  const prompt = `Investigate incident ${incident.id} — [${sevLabel}] ${incident.title}. ` +
    (incident.description ? `Details: ${incident.description.slice(0, 300)}. ` : '') +
    `Check the affected system, identify the root cause, and suggest remediation. ` +
    `Use available tools (server.info, server.disk, server.memory, docker.list, docker.logs) to gather data.`;
  const task = taskManager.createTask({
    title: `Investigate: [${sevLabel}] ${incident.title}`,
    description: prompt,
    priority: incident.severity === 'critical' ? 'critical' : incident.severity === 'high' ? 'high' : 'medium',
    ownerId: 'incident-manager',
    category: 'incident-response',
    assignedTo: pickedAgent.id,
  });
  logger.info(`[IncidentDispatch] ${incident.id} → ${pickedAgent.name} (task ${task.id}, ${pickReason})`);
  broadcast({ type: 'task_created', data: { taskId: task.id, incidentId: incident.id, agentId: pickedAgent.id, agentName: pickedAgent.name } });
  broadcast({ type: 'agent_workload_updated', data: agentWorkloadTracker.list() });

  // ── Kick off the agent's ReAct loop directly. ─────────────────────────
  // This is the difference between "agent is assigned" (badge in the UI)
  // and "agent is actually thinking + acting" (calling tools, updating
  // the timeline, resolving the incident). The handler runs async; on
  // failure it falls back to autoRemediator → workflow → escalate.
  // When the handler isn't wired yet (very early boot), the legacy
  // fallback below preserves prior behaviour (fire autoRemediator + a
  // matching workflow) so the incident still gets some autonomous attention.
  if (agentIncidentHandler) {
    // Re-fetch the freshest Incident row — assignAgent above mutated it.
    const live = incidentManager.get(incident.id);
    if (live) {
      agentIncidentHandler.runFor(live, pickedAgent, task.id).then(result => {
        logger.info('[AgentIncidentHandler] finished', {
          incidentId: incident.id, outcome: result.outcome,
          iterations: result.iterations, durationMs: result.durationMs,
          agent: result.agentName,
        });
      }).catch(e =>
        logger.error('[AgentIncidentHandler] crashed', {
          incidentId: incident.id, err: e instanceof Error ? e.message : String(e),
        })
      );
    }
  } else {
    // Legacy fallback — handler not yet wired.
    try { autoRemediator?.handle(incident as any); } catch { /* swallow */ }
    if (incident.severity === 'high' || incident.severity === 'critical') {
      try {
        const wfEngine = WorkflowEngine.getInstance();
        const tpl = wfEngine.listTemplates().find(t => {
          try { return new RegExp(t.trigger, 'i').test('incident'); } catch { return false; }
        });
        if (tpl) wfEngine.startRun({ templateId: tpl.id, taskId: `inc-${incident.id}`, title: `[${incident.severity.toUpperCase()}] ${incident.title}` });
      } catch { /* swallow */ }
    }
  }

  return { agentId: pickedAgent.id, agentName: pickedAgent.name, taskId: task.id };
}
(globalThis as any).dispatchIncidentToAgent = dispatchIncidentToAgent;

incidentManager.setVerifier(createIncidentVerifier({
  skillManager,
  getServerRegistry: () => (globalThis as any).serverRegistry,
  getRemoteExecutor: () => (globalThis as any).remoteExecutor,
}));

const incidentAnalyzer = new IncidentAnalyzer(aiFactory);
const runbookGenerator = new RunbookGenerator();

// Auto-remediator must be constructed AFTER incidentManager (it holds a
// reference for adding timeline notes and flipping status). The
// onCreated closure above reads the `autoRemediator` outer binding by
// reference, so this assignment retroactively activates remediation for
// every subsequent incident creation. Disabled wholesale via
// AUTO_REMEDIATION_ENABLED=false.
autoRemediator = new IncidentAutoRemediator(incidentManager, {
  broadcast,
  getServerRegistry: () => (globalThis as any).serverRegistry,
  getRemoteExecutor: () => (globalThis as any).remoteExecutor,
});

// ─── Post-mortem store + generator ───────────────────────────────────────
// Incident knowledge base — every medium-or-worse resolution drops a
// structured row here so future agents can search past resolutions
// before re-deriving the fix. The generator runs from the IncidentManager
// onResolved hook (registered below).
const postMortemStore = new PostMortemStore(
  process.env.POST_MORTEM_DB_PATH || '/data/itops-agents/post-mortems.db'
);
(globalThis as any).postMortemStore = postMortemStore;

const postMortemMinSeverity = (process.env.POST_MORTEM_MIN_SEVERITY || 'medium').toLowerCase();
const includedSeverities: Array<'low' | 'medium' | 'high' | 'critical'> =
  postMortemMinSeverity === 'low'      ? ['low', 'medium', 'high', 'critical'] :
  postMortemMinSeverity === 'high'     ? ['high', 'critical'] :
  postMortemMinSeverity === 'critical' ? ['critical'] :
                                         ['medium', 'high', 'critical'];

const postMortemGenerator = new PostMortemGenerator(
  aiFactory,
  incidentManager,
  postMortemStore,
  {
    includedSeverities,
    skipAi: process.env.POST_MORTEM_SKIP_AI === '1',
    broadcast,
  },
);
(globalThis as any).postMortemGenerator = postMortemGenerator;

// Fire the generator every time an incident is resolved. The hook is
// fire-and-forget — slow or failing AI calls never block the resolve
// pipeline (the generator catches and logs).
incidentManager.onResolved((inc) => {
  postMortemGenerator.handle(inc);
});

// Telegram "resolved" notice — only fires for incidents that crossed
// the configured min-severity (defaults to high). Operators want to
// know their phone-buzz alert is over; they don't need a ping for every
// low-sev auto-resolve from the stale sweep.
incidentManager.onResolved((inc) => {
  const telegram = getTelegram();
  if (!telegram.isConfigured()) return;
  // The closure runs after onResolved fires, so serverRegistry is in
  // scope (it's declared later in the file but module init has long
  // since finished by the time any incident resolves).
  const serverName = inc.serverId
    ? (globalThis as any).serverRegistry?.get?.(inc.serverId)?.name
    : undefined;
  const durationMs = inc.resolvedAt && inc.createdAt
    ? Date.parse(inc.resolvedAt) - Date.parse(inc.createdAt)
    : undefined;
  telegram.sendResolution(inc, {
    durationMs,
    resolvedBy: inc.assignedTo ?? 'auto',
    serverName,
  }).catch(e =>
    logger.error('[Telegram] sendResolution threw', {
      incidentId: inc.id, err: e instanceof Error ? e.message : String(e),
    })
  );
});
logger.info('[PostMortemGenerator] wired — resolved incidents will be summarised into the knowledge base', {
  includedSeverities,
  skipAi: process.env.POST_MORTEM_SKIP_AI === '1',
});

const autonomyAttemptStore = new AutonomyAttemptStore(
  process.env.AUTONOMY_ATTEMPT_DB_PATH || '/data/itops-agents/autonomy-attempts.db',
);
incidentManager.onResolved((incident) => {
  const attempt = autonomyAttemptStore.latestForIncident(incident.id, true);
  if (!attempt) return;
  const usedFallback = attempt.phases.some(phase =>
    phase.kind === 'fallback_remediator' || phase.kind === 'fallback_workflow'
  );
  if (usedFallback) {
    autonomyAttemptStore.conclude(attempt.id, 'assisted', 'fallback_resolved_incident', {
      verification: 'not_applicable',
      details: { incidentResolvedAt: incident.resolvedAt || null },
    });
  }
});
const rawAutonomyAttemptExpiryHours = Number(process.env.AUTONOMY_ATTEMPT_EXPIRY_HOURS || 48);
const autonomyAttemptExpiryHours = Number.isFinite(rawAutonomyAttemptExpiryHours)
  ? Math.max(1, rawAutonomyAttemptExpiryHours) : 48;
setInterval(() => {
  const cutoff = new Date(Date.now() - autonomyAttemptExpiryHours * 60 * 60 * 1000).toISOString();
  const expired = autonomyAttemptStore.expireInProgress(cutoff);
  if (expired > 0) logger.warn('[AutonomyAttempts] expired unfinished attempts', { expired, cutoff });
}, 60 * 60 * 1000);

// Wire the canonical IncidentManager + RunbookEngine into the IncidentSkill
// so when an agent calls incident.note / incident.resolve / runbook.execute
// during ReAct, those operations go through the same instances the rest of
// the server uses (and trigger the right callbacks).
skillManager.wireIncidentTools({
  incidents: incidentManager,
  runbooks: RunbookEngine.getInstance(),
});

// Escalation pipeline — extends the agent/remediator chain with a third
// stage that pages a human (via OpenClaw) when automation fails, plus a
// fourth stage that promotes stuck incidents to critical urgency. The
// pipeline is constructed BEFORE the handler so the handler can hold a
// reference to it; the pipeline's only dep is incidentManager + openclaw.
const escalationEnvFlag = (process.env.ESCALATION_ENABLED ?? 'true').toLowerCase();
const escalationMinSeverityEnv = (process.env.ESCALATION_MIN_SEVERITY ?? 'medium').toLowerCase();
const validMinSev = ['low', 'medium', 'high', 'critical'].includes(escalationMinSeverityEnv)
  ? (escalationMinSeverityEnv as 'low' | 'medium' | 'high' | 'critical')
  : 'medium';
const escalationPipeline = new EscalationPipeline(
  incidentManager,
  getOpenClaw(),
  {
    enabled: escalationEnvFlag !== 'false' && escalationEnvFlag !== '0',
    l3DelayMs: parseInt(process.env.ESCALATION_L3_DELAY_MS || '60000', 10),
    l4TimeoutMs: parseInt(process.env.ESCALATION_L4_TIMEOUT_MS || '1800000', 10),
    webhookUrl: process.env.ESCALATION_WEBHOOK_URL,
    minSeverity: validMinSev,
    broadcast,
    telegram: getTelegram(),
  },
);
(globalThis as any).escalationPipeline = escalationPipeline;
logger.info('[EscalationPipeline] wired', {
  enabled: escalationPipeline.isEnabled(),
  minSeverity: validMinSev,
  l3DelayMs: parseInt(process.env.ESCALATION_L3_DELAY_MS || '60000', 10),
  l4TimeoutMs: parseInt(process.env.ESCALATION_L4_TIMEOUT_MS || '1800000', 10),
  webhookConfigured: Boolean(process.env.ESCALATION_WEBHOOK_URL),
});

// Stand up the AgentIncidentHandler. From this point on, every dispatched
// incident gets a real ReAct loop instead of just a "task created" UI badge.
// On failure the handler falls back to autoRemediator (pattern recipes) and
// then to a matching workflow, finally escalating if nothing applied.
agentIncidentHandler = new AgentIncidentHandler(
  skillManager,
  incidentManager,
  taskManager,
  autoRemediator,
  WorkflowEngine.getInstance(),
  {
    maxIterations: parseInt(process.env.INCIDENT_AGENT_MAX_ITERATIONS || '10', 10),
    disableRemediatorFallback: process.env.INCIDENT_AGENT_DISABLE_REMEDIATOR === '1',
    disableWorkflowFallback: process.env.INCIDENT_AGENT_DISABLE_WORKFLOW === '1',
    broadcast,
    escalation: escalationPipeline,
    // Knowledge base — agents see the top-3 most similar past post-mortems
    // injected into their prompt before they start the ReAct loop. Tunable
    // via INCIDENT_AGENT_KB_TOP_K=0 to disable, =N to widen.
    postMortems: postMortemStore,
    knowledgeBaseTopK: parseInt(process.env.INCIDENT_AGENT_KB_TOP_K || '3', 10),
    attemptStore: autonomyAttemptStore,
  },
);
logger.info('[AgentIncidentHandler] wired — dispatched incidents now run a real ReAct loop with remediator+workflow fallback');

// Improvement loop is constructed AFTER orchestratorService below — see
// the block following the orchestratorService declaration. v1's earlier
// position pre-dated the v2 dependency on orchestrator.getStatus().

WorkflowEngine.getInstance().startScheduler();

// Wire stage-active callback: when a stage transitions to in_progress,
// broadcast a WS event and create an agent task if the owner is a known agent.
WorkflowEngine.getInstance().setStageActiveCallback((runId, stageName, owner) => {
  broadcast({ type: 'workflow_stage_active', data: { runId, stageName, owner } });
  if (!owner) return;
  const agents = organization.getAllAgents();
  const assignedAgent = agents.find(a => a.id === owner || a.config?.name === owner);
  if (!assignedAgent) return;
  try {
    const run = WorkflowEngine.getInstance().getRun(runId);
    taskManager.createTask({
      title: `Workflow stage: ${stageName}`,
      description: `You have been assigned the "${stageName}" stage of workflow run "${run?.title ?? runId}" (${runId}). Use workflow.advance to mark it done when complete.`,
      category: 'monitoring',
      priority: 'high',
      ownerId: 'workflow-engine',
      assignedTo: assignedAgent.id,
    });
    logger.info(`[WorkflowEngine] Created task for agent ${assignedAgent.id} → stage "${stageName}" on run ${runId}`);
  } catch (e) {
    logger.error('[WorkflowEngine] Failed to create agent task for stage:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
  }
});

// Runbook engine
const runbookEngine = RunbookEngine.getInstance();
runbookEngine.setSkillManager(skillManager);
runbookEngine.setBroadcast(broadcast);

// Jira Integration — initialized after both skillManager and incidentManager are ready
jiraService = JiraIntegrationService.getInstance();
jiraService.setSkillExecutor((cmd, params) => skillManager.execute(cmd, params));
jiraService.setStore(incidentManager.incidentStore);

// Start Jira polling if enabled
if (jiraService.isEnabled()) {
  jiraService.startPolling(incidentManager, (count: number) => {
    if (count > 0) {
      broadcast({ type: 'jira_sync_complete', data: { count, timestamp: new Date().toISOString() } });
      logger.info(`[JiraIntegration] Poll imported ${count} new ticket(s)`);
    }
  });
}

// Compliance Ticketing Sink — syncs resolved incidents to external trackers
const ticketingSink = new TicketingSink({
  getJiraService: () => jiraService,
  getGitHubConfig: () => ({
    enabled: process.env.GITHUB_ISSUES_ENABLED === "true",
    token: process.env.GITHUB_TOKEN || "",
    owner: process.env.GITHUB_OWNER || "",
    repo: process.env.GITHUB_REPO || ""
  }),
  store: incidentManager.incidentStore
});
incidentManager.onResolved((inc) => {
  ticketingSink.syncResolvedIncident(inc).catch(e =>
    logger.error("[server] TicketingSink sync failed", { incidentId: inc.id, err: e instanceof Error ? e.message : String(e) })
  );
});

// A2A Agent Card Service — initialized after organization and skillManager are ready
const agentCardService = new AgentCardService(organization, skillManager);

// A2A Task Store + Runner — Phase 2: task execution, Phase 3: peer routing
const a2aTaskStore = new A2ATaskStore(
  process.env.A2A_TASKS_PATH || '/data/itops-agents/a2a-tasks.json'
);
const a2aTaskRunner = new A2ATaskRunner(
  a2aTaskStore,
  (command, params) => skillManager.execute(command, params),
  agentCardService,
);

// Phase 3: Wire peer client + router (internal token for intra-mesh calls)
// Issued after auth accounts are set up — placed at end of startup in startServer()
let a2aPeerClient: A2APeerClient;
let a2aPeerRouter: A2APeerRouter;
let externalAgentRegistry: ExternalAgentRegistry;

const agentMemoryStore = new SqliteAgentMemoryStore(
  process.env.AGENT_MEMORY_DB_PATH || '/data/itops-agents/agent-memory.db'
);
// Wire memory store to all agents
for (const agent of organization.getAllAgents()) {
  if (typeof agent.setMemoryStore === 'function') {
    agent.setMemoryStore(agentMemoryStore);
  }
}
const alertRulesEngine = new AlertRulesEngine(
  process.env.ALERT_RULES_PATH || '/data/itops-agents/alert-rules.json',
  async (msg, severity) => {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    if (telegramToken) {
      await skillManager.execute('alert.telegram', { message: msg, severity });
    } else {
      logger.info(`[Alert] ${severity.toUpperCase()}: ${msg}`);
    }
    createNotification('alert', `Alert Fired: ${severity.toUpperCase()}`, msg, severity === 'critical' ? 'critical' : severity === 'warning' ? 'warning' : 'info');
    slackService.notifyAlert({ name: msg, metric: '', threshold: 0, operator: '' }, 0).catch(() => {});
    discordService.notifyAlert({ name: msg, metric: '', threshold: 0, operator: '' }, 0).catch(() => {});
    // Email fan-out — only for critical alerts so warning/info noise
    // doesn't fill operator inboxes. Disabled silently when SMTP is
    // unconfigured. Fire-and-forget.
    if (severity === 'critical' && emailService.isEnabled()) {
      const recipients = resolveOperatorRecipients();
      if (recipients.length > 0) {
        emailService.sendAlertTriggered(recipients, {
          title: msg.split(':')[0] || msg.slice(0, 80),
          message: msg,
          severity,
          source: 'alert-rule',
          firedAt: new Date().toISOString(),
        }).catch(e => logger.warn('[Email] sendAlertTriggered threw', {
          err: e instanceof Error ? e.message : String(e),
        }));
      }
    }
    // PluginManager fan-out — alerts feed into PrometheusPlugin's
    // counter and any future "page on alert" integration.
    pluginManager?.notifyAlertFired({
      ruleName: msg.split(':')[0] || msg.slice(0, 80),
      severity,
      firedAt: new Date().toISOString(),
      message: msg,
    });
  },
  (title, description, severity, sourceRef) => {
    try {
      // Dedup by rule id (passed as sourceRef) — a rule that keeps tripping
      // should update the existing incident rather than spawn duplicates.
      // Titles like "High Disk Usage on 172.31.0.1" stay stable per rule,
      // but sourceRef is what we trust because operators may rename rules.
      incidentManager.create({
        title, description, severity: severity as any, source: 'alert-rule', sourceRef,
        dedupBy: 'sourceRef',
      });
    } catch (e) {
      logger.error('[AlertRules] Failed to open incident:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
    }
  },
  (cmd, params) => skillManager.execute(cmd, params),
  runbookEngine
);
alertRulesEngine.start();

// ─── SLA Engine ───────────────────────────────────────────────────────────
// Replaces the old SLA breach alerting loop, which depended on an
// `incident.slaBreached` field that was never set. The new engine owns
// the breach state in its own SQLite tables, fires events via the
// broadcast() helper, and auto-escalates incidents whose resolution
// deadline has been missed.
slaEngine = new SLAEngine({
  dbPath: process.env.SLA_DB_PATH || '/data/itops-agents/sla.db',
  incidentManager,
});
// Local non-null alias so the closures below don't trip the
// strictNullChecks-ish path that the forward-declared `let slaEngine`
// would surface in a typechecker.
const sla = slaEngine;

// Listener: resolved incidents close out their tracking row + record
// resolution_met. The legacy timeline note keeps emitting too — both
// paths describe the same event from different angles.
incidentManager.onResolved((inc) => {
  try { sla.onIncidentResolved(inc); }
  catch (e) { logger.warn('[SLA] onIncidentResolved threw', { incidentId: inc.id, err: e instanceof Error ? e.message : String(e) }); }
});

// Tick every 60s — detect responses + breaches + warnings. Fan-out:
//   - newWarnings → broadcast `sla_warning` so the dashboard can tint
//     the row amber.
//   - newBreaches → broadcast `sla_breach`, auto-escalate the incident
//     one level (capped at critical), and notify the plugin manager so
//     PagerDuty/OpsGenie see it as an escalation event too.
const SLA_TICK_INTERVAL_MS = parseInt(process.env.SLA_TICK_INTERVAL_MS || '60000', 10);
setInterval(() => {
  try {
    sla.detectResponses();
    const { newBreaches, newWarnings } = sla.checkBreaches();
    if (newWarnings.length > 0) {
      broadcast({
        type: 'sla_warning',
        data: {
          incidents: newWarnings.map(w => ({
            id: w.incident.id, title: w.incident.title, severity: w.incident.severity,
            resolutionDeadline: w.tracking.resolutionDeadline,
          })),
        },
      });
    }
    if (newBreaches.length > 0) {
      broadcast({
        type: 'sla_breach',
        data: {
          newBreaches: newBreaches.length,
          incidents: newBreaches.map(b => ({
            id: b.incident.id, title: b.incident.title, severity: b.incident.severity,
            kind: b.kind,
          })),
        },
      });
      logger.warn(`[SLA] ${newBreaches.length} new SLA breach(es) detected`);
      for (const b of newBreaches) {
        if (b.incident.severity !== 'critical') {
          try { incidentManager.escalate(b.incident.id, `Auto-escalated — ${b.kind} SLA breached`); }
          catch (e) { logger.warn('[SLA] auto-escalate failed', { incidentId: b.incident.id, err: e instanceof Error ? e.message : String(e) }); }
        }
        // Surface to plugins as an escalation event so PagerDuty/OpsGenie
        // bump priority. Level 1 = "first auto-escalation triggered by SLA".
        const refreshed = incidentManager.get(b.incident.id);
        if (refreshed && pluginManager) {
          pluginManager.notifyIncidentEscalated(refreshed, 1);
        }
      }
    }
  } catch (e: any) {
    logger.error('[SLA] tick failed:', { err: e instanceof Error ? e.message : String(e) });
  }
}, SLA_TICK_INTERVAL_MS);

// Secrets resolutions (credentialMasterKey, approvalTokenSecret,
// authTokenSecret + their *Source companions) are hoisted above
// WorkflowJsonExecutor — see the early-init block earlier in this file.
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const defaultAccountPasswordResolved = readSecretFromEnv('DEFAULT_ACCOUNT_PASSWORD', '');
const defaultAccountPassword = defaultAccountPasswordResolved.value;
const adminPasswordResolved = readSecretFromEnv('ADMIN_PASSWORD', defaultAccountPassword);
const adminPassword = adminPasswordResolved.value;
const operatorUsername = process.env.OPERATOR_USERNAME || '';
const operatorPasswordResolved = readSecretFromEnv('OPERATOR_PASSWORD', defaultAccountPassword);
const operatorPassword = operatorPasswordResolved.value;
const viewerUsername = process.env.VIEWER_USERNAME || '';
const viewerPasswordResolved = readSecretFromEnv('VIEWER_PASSWORD', defaultAccountPassword);
const viewerPassword = viewerPasswordResolved.value;
const enforceStrongSecrets = parseBoolEnv(
  process.env.REQUIRE_STRONG_SECRETS,
  process.env.NODE_ENV === 'production'
);
const weakCredentialMasterKey = ['change-this-master-key', 'itops-master-key-change-me'].includes(credentialMasterKey);
const weakApprovalTokenSecret = isWeakSecret(approvalTokenSecret);
const weakAuthTokenSecret = isWeakSecret(authTokenSecret);
const weakOperatorPassword = isWeakSecret(operatorPassword);
const weakAdminPassword = isWeakSecret(adminPassword);
if (weakCredentialMasterKey || isWeakSecret(credentialMasterKey)) {
  logger.warn('⚠️ Weak credential master key detected. Set CREDENTIAL_MASTER_KEY to a strong secret.');
}
if (weakApprovalTokenSecret) {
  logger.warn('⚠️ Weak approval token secret detected. Set APPROVAL_TOKEN_SECRET to a strong secret.');
}
if (weakAuthTokenSecret) {
  logger.warn('⚠️ Weak auth token secret detected. Set AUTH_TOKEN_SECRET to a strong secret.');
}
if (weakOperatorPassword) {
  logger.warn('⚠️ Weak operator password detected. Set OPERATOR_PASSWORD to a strong secret.');
}
if (weakAdminPassword) {
  logger.warn('⚠️ Weak admin password detected. Set ADMIN_PASSWORD to a strong secret.');
}
if (enforceStrongSecrets) {
  const failures: string[] = [];
  if (isWeakSecret(credentialMasterKey)) failures.push('CREDENTIAL_MASTER_KEY');
  if (isWeakSecret(approvalTokenSecret)) failures.push('APPROVAL_TOKEN_SECRET');
  if (isWeakSecret(authTokenSecret)) failures.push('AUTH_TOKEN_SECRET');
  if (!adminUsername) failures.push('ADMIN_USERNAME');
  if (isWeakSecret(adminPassword)) failures.push('ADMIN_PASSWORD');
  if (operatorUsername && isWeakSecret(operatorPassword)) failures.push('OPERATOR_PASSWORD');
  if (viewerUsername && isWeakSecret(viewerPassword)) failures.push('VIEWER_PASSWORD');
  if (failures.length > 0) {
    throw new Error(
      `Startup blocked by security policy. Weak/missing secrets: ${failures.join(', ')}. ` +
      'Set strong values or set REQUIRE_STRONG_SECRETS=false for non-production testing.'
    );
  }
}
const credentialVault = new CredentialVault(
  process.env.CREDENTIAL_VAULT_PATH || '/data/itops-agents/credentials.vault.json',
  credentialMasterKey || 'change-this-master-key'
);

// Credential auto-rotation — sweeps the vault on a schedule, calls a
// kind-specific rotator, and emits alerts on failure / overdue credentials.
// Rotators are intentionally NOT registered here: every deployment has a
// different IdP / CA / secret manager. Operator code (or a follow-up commit)
// calls rotationManager.registerRotator(kind, fn). Until a rotator is
// registered for a kind, due credentials of that kind raise a "no-rotator"
// warn alert so the operator notices and either rotates by hand or wires
// one in. Alerts route through the structured logger; later we'll forward
// them to email / Telegram.
import { CredentialRotationManager } from '../security/CredentialRotationManager.js';
const rotationManager = new CredentialRotationManager(credentialVault, {
  checkIntervalMs: Number(process.env.CREDENTIAL_ROTATION_INTERVAL_MS) || 60 * 60 * 1000,
  warnBeforeMs:    Number(process.env.CREDENTIAL_ROTATION_WARN_BEFORE_MS) || 7 * 24 * 60 * 60 * 1000,
  onAlert: (a) => {
    if (a.level === 'error') serverLog.error(a.message, { ...a, kind: a.kind });
    else                     serverLog.warn(a.message,  { ...a, kind: a.kind });
  },
});
if ((process.env.CREDENTIAL_ROTATION_ENABLED ?? 'true').toLowerCase() !== 'false') {
  rotationManager.start();
}

// Concrete rotators. Each is opt-in: a deployment that doesn't set the
// matching env variable simply has no rotator registered for that
// credential kind, so the manager logs a warn alert when something
// expires and the operator handles it manually.
//
// Add custom rotators here following the same pattern: import the
// implementation, build it from env config, call registerRotator.
import { GenericApiKeyRotator } from '../security/rotators/GenericApiKeyRotator.js';
import { CertificateRotator } from '../security/rotators/CertificateRotator.js';
import { EnvironmentVariableRotator } from '../security/rotators/EnvironmentVariableRotator.js';
if (process.env.API_KEY_ROTATOR_URL) {
  rotationManager.registerRotator('api-key', new GenericApiKeyRotator({
    endpoint:    process.env.API_KEY_ROTATOR_URL,
    bearerToken: process.env.API_KEY_ROTATOR_TOKEN,
  }).rotate);
  serverLog.info('credential rotator registered', { kind: 'api-key', endpoint: process.env.API_KEY_ROTATOR_URL });
}
if ((process.env.CERT_ROTATOR_ENABLED ?? 'false').toLowerCase() === 'true') {
  // Self-signed by default; flip to mode=csr + supply a signCsr hook
  // to integrate with a real CA.
  rotationManager.registerRotator('cert', new CertificateRotator({
    mode: 'self-signed',
    commonName:      process.env.CERT_ROTATOR_CN  || 'itops-agents.local',
    subjectAltNames: (process.env.CERT_ROTATOR_SANS || '').split(',').map(s => s.trim()).filter(Boolean),
    validDays: Number(process.env.CERT_ROTATOR_DAYS) || 365,
  }).rotate);
  serverLog.info('credential rotator registered', { kind: 'cert' });
}
if (process.env.ENV_ROTATOR_FILE && process.env.ENV_ROTATOR_KEYS) {
  // ENV_ROTATOR_KEYS is a comma list of "<envKey>:<credentialName>".
  // Example: "POSTGRES_PASSWORD:pg-pass,REDIS_PASSWORD:redis-pass"
  const mapping: Record<string, (cred: { name: string }) => boolean> = {};
  for (const entry of process.env.ENV_ROTATOR_KEYS.split(',')) {
    const [envKey, credName] = entry.split(':').map(s => s.trim());
    if (envKey && credName) mapping[envKey] = (c) => c.name === credName;
  }
  if (Object.keys(mapping).length > 0) {
    rotationManager.registerRotator('password', new EnvironmentVariableRotator({
      filePath: process.env.ENV_ROTATOR_FILE,
      mapping,
    }).rotate);
    serverLog.info('credential rotator registered', { kind: 'password', file: process.env.ENV_ROTATOR_FILE });
  }
}
// approvalTokenService is constructed in the early-init block above
// (right before WorkflowJsonExecutor) so it's available to forward
// references that fire at module load.
const authService = new AuthService({
  tokenSecret: authTokenSecret || approvalTokenSecret || credentialMasterKey || 'change-this-master-key',
  usersFilePath: process.env.AUTH_USERS_PATH || '/data/itops-agents/auth-users.json',
  ttlSeconds: Number(process.env.AUTH_SESSION_TTL_SECONDS || 3600),
  bootstrapUsers: [
    // Bootstrap is create-if-missing (AuthService constructor guards against
    // overwrite). ADMIN_EMAIL is honoured if supplied so the user record
    // carries a contact handle the UI can display.
    {
      username: adminUsername || 'admin',
      password: adminPassword || 'admin-password-change-me',
      role: 'admin',
      email: process.env.ADMIN_EMAIL || 'admin@itops.local',
    },
    ...(operatorUsername && operatorPassword
      ? [{
          username: operatorUsername,
          password: operatorPassword,
          role: 'operator' as const,
          email: process.env.OPERATOR_EMAIL,
        }]
      : []),
    ...(viewerUsername && viewerPassword
      ? [{
          username: viewerUsername,
          password: viewerPassword,
          role: 'viewer' as const,
          email: process.env.VIEWER_EMAIL,
        }]
      : []),
    // Self-service portal demo account — `user` / `user`, role
    // `requester`. Create-if-missing per AuthService semantics, so an
    // operator who changes the password won't get it reset on restart.
    // Disable by setting REQUESTER_DEMO_USER_DISABLED=true once the
    // platform is provisioned for real end-users.
    ...(process.env.REQUESTER_DEMO_USER_DISABLED === 'true'
      ? []
      : [{
          username: process.env.REQUESTER_USERNAME || 'user',
          password: process.env.REQUESTER_PASSWORD || 'user',
          role: 'requester' as const,
          email: process.env.REQUESTER_EMAIL,
        }]),
  ]
});

// Plugin system (Phase 15)
const pluginLoader = new PluginLoader(process.env.PLUGINS_DIR || '/data/itops-agents/plugins');
pluginLoader.loadAll().then(r => {
  logger.info(`[Plugins] Loaded ${r.loaded} plugins, ${r.errors} errors`);
}).catch(e => logger.error('[Plugins] Load error', { err: String(e) }));

// ── Phase 15: API Key Service, Audit Log, Auth Middleware ────────────────────
const apiKeyService = new ApiKeyService(process.env.API_KEYS_PATH || "/data/itops-agents/api-keys.json");
const auditLog = new AuditLog(process.env.AUDIT_LOG_PATH || "/data/itops-agents/audit-log.json");
const { requireAuth, requireRole } = createAuthMiddleware(authService, apiKeyService, auditLog);


// ── Active Directory / LDAP integration ──────────────────────────────────────
const adConfigStore = new ADConfigStore(
  process.env.AD_CONFIG_PATH || '/data/itops-agents/ad-config.json'
);
// Override from environment variables if set (useful for Docker env)
{
  const cfg = adConfigStore.config;
  if (process.env.LDAP_URL) {
    cfg.ldap = {
      enabled: process.env.LDAP_ENABLED !== 'false',
      url: process.env.LDAP_URL,
      bindDN: process.env.LDAP_BIND_DN || cfg.ldap?.bindDN || '',
      bindPassword: process.env.LDAP_BIND_PASSWORD || cfg.ldap?.bindPassword || '',
      baseDN: process.env.LDAP_BASE_DN || cfg.ldap?.baseDN || '',
      userFilter: process.env.LDAP_USER_FILTER || cfg.ldap?.userFilter,
      tlsRejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== 'false',
      timeout: Number(process.env.LDAP_TIMEOUT || 5000),
    };
  }
  if (process.env.AZURE_TENANT_ID) {
    cfg.azure = {
      enabled: process.env.AZURE_ENABLED !== 'false',
      tenantId: process.env.AZURE_TENANT_ID,
      clientId: process.env.AZURE_CLIENT_ID || cfg.azure?.clientId || '',
      clientSecret: process.env.AZURE_CLIENT_SECRET || cfg.azure?.clientSecret || '',
      redirectUri: process.env.AZURE_REDIRECT_URI || cfg.azure?.redirectUri || `http://localhost:${process.env.PORT || 19123}/auth/azure/callback`,
      scopes: cfg.azure?.scopes,
    };
  }
  if (process.env.AD_GROUP_ROLE_MAP) {
    try { cfg.groupRoleMap = JSON.parse(process.env.AD_GROUP_ROLE_MAP); } catch {}
  }
}
const adManager = new ADAuthManager(adConfigStore.config);

// ── MS Teams integration ──────────────────────────────────────────────────────
const teamsConfigStore = new TeamsConfigStore(
  process.env.TEAMS_CONFIG_PATH || '/data/itops-agents/teams-config.json'
);
// Allow env-var bootstrap for Docker deployments
if (process.env.TEAMS_INCOMING_WEBHOOK_URL) {
  const cfg = teamsConfigStore.config;
  if (!cfg.defaultWebhookUrl) {
    cfg.defaultWebhookUrl = process.env.TEAMS_INCOMING_WEBHOOK_URL;
    cfg.enabled = true;
    if (process.env.TEAMS_OUTGOING_WEBHOOK_SECRET) {
      cfg.outgoingWebhookSecret = process.env.TEAMS_OUTGOING_WEBHOOK_SECRET;
    }
    teamsConfigStore.save(cfg);
  }
}
const teamsProvider = new TeamsProvider();
const smtpService = new SmtpService();
// Env-driven email notifier for invites + incidents + alerts. Distinct
// from SmtpService (which is the admin-managed JSON-config path). Safe
// to construct unconditionally — disables itself when SMTP_HOST is unset.
const emailService = new EmailService();

/** Resolve the email recipients for an incident notification. Order of
 *  preference: (1) explicit assignedTo user has an email → just them;
 *  (2) createdBy user has an email → them too; (3) every active
 *  operator/admin with an email. Returns a de-duplicated list. */
function resolveIncidentRecipients(incident: { assignedTo?: string | null; createdBy?: string | null }): string[] {
  const out = new Set<string>();
  const lookup = (uname: string | null | undefined) => {
    if (!uname) return;
    const u = authService.getUser(uname);
    if (u?.email && u.active !== false) out.add(u.email);
  };
  lookup(incident.assignedTo ?? null);
  lookup(incident.createdBy ?? null);
  if (out.size === 0) {
    for (const u of authService.listUsers()) {
      if (!u.email || u.active === false) continue;
      if (u.role === 'admin' || u.role === 'operator' || u.role === 'superadmin') {
        out.add(u.email);
      }
    }
  }
  return Array.from(out);
}

/** Recipients for alert-rule notifications — every active operator+admin
 *  with an email. Distinct from incident recipients because alerts may
 *  fire before any incident is opened. */
function resolveOperatorRecipients(): string[] {
  const out = new Set<string>();
  for (const u of authService.listUsers()) {
    if (!u.email || u.active === false) continue;
    if (u.role === 'admin' || u.role === 'operator' || u.role === 'superadmin') {
      out.add(u.email);
    }
  }
  return Array.from(out);
}

// Resolved-incident email. Mirrors the onCreated path: assignee/creator
// first, fall back to all operators. The listener is fire-and-forget,
// disabled silently when SMTP isn't configured.
incidentManager.onResolved((inc) => {
  if (!emailService.isEnabled()) return;
  const recipients = resolveIncidentRecipients(inc);
  if (recipients.length === 0) return;
  emailService.sendIncidentResolved(recipients, inc).catch(e =>
    logger.warn('[Email] sendIncidentResolved threw', {
      incidentId: inc.id, err: e instanceof Error ? e.message : String(e),
    })
  );
});

const slackService = new SlackService();
const discordService = new DiscordService();
const reportsScheduler = new ReportsScheduler(smtpService);

// PWA Web Push. VAPID keys persist across restarts so existing
// subscriptions stay valid; subscription rows live in their own SQLite
// so the incidents.db remains unaffected by a push-only re-init.
const pushService = new PushService({
  dbPath: process.env.PUSH_DB_PATH || '/data/itops-agents/push.db',
  vapidKeyPath: process.env.VAPID_KEY_PATH || '/data/itops-agents/vapid.json',
  vapidSubject: process.env.VAPID_SUBJECT || (process.env.ADMIN_EMAIL ? `mailto:${process.env.ADMIN_EMAIL}` : 'mailto:ops@itops-agents.local'),
});

/** Resolve all usernames currently holding `role`, regardless of whether
 *  they have any push subscriptions. PushService.sendToUsers will quietly
 *  no-op for users without devices. */
function usersByRole(role: 'admin' | 'operator' | 'viewer' | 'requester'): string[] {
  try {
    return authService.listUsers()
      .filter(u => u.role === role && u.active)
      .map(u => u.username);
  } catch {
    return [];
  }
}

/** Fire-and-forget push helper. Never throws — meant to be sprinkled
 *  through event hooks without try/catch noise. */
function pushToUsers(usernames: string[], payload: PushPayload): void {
  if (!usernames || usernames.length === 0) return;
  pushService.sendToUsers(usernames, payload).catch(e => {
    logger.warn('[push] fan-out failed', { err: e instanceof Error ? e.message : String(e) });
  });
}
function pushToRole(role: 'admin' | 'operator' | 'viewer' | 'requester', payload: PushPayload): void {
  pushToUsers(usersByRole(role), payload);
}

{
  const _internalResult = authService.issueToken(
    adminUsername || 'admin',
    adminPassword || 'admin-password-change-me',
  );
  const _internalToken = _internalResult?.token ?? '';
  a2aPeerClient = new A2APeerClient(
    process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '19123'}`,
    _internalToken,
  );
  a2aPeerRouter = new A2APeerRouter(agentCardService);
  externalAgentRegistry = new ExternalAgentRegistry(
    process.env.EXTERNAL_AGENTS_PATH || '/data/itops-agents/external-agents.json'
  );
  a2aPeerRouter.setExternalRegistry(externalAgentRegistry);
  // NL intent classifier — wired in if any AI provider is configured
  if (aiFactory.getAvailablePlatforms().length > 0) {
    const nlClassifier = new NLIntentClassifier(aiFactory);
    a2aPeerRouter.setNLClassifier(nlClassifier);
    logger.info('[A2A] NL intent classifier enabled');
  }
  a2aTaskRunner.setPeerRouting(a2aPeerClient, a2aPeerRouter, externalAgentRegistry);
}

const approvalTokenLedger = new ApprovalTokenLedger(
  process.env.APPROVAL_LEDGER_PATH || '/data/itops-agents/approval-ledger.json'
);
const executionAuditStore = new ExecutionAuditStore(
  process.env.EXECUTION_AUDIT_PATH || '/data/itops-agents/execution-audit.json'
);
const credentialCatalogStore = new CredentialCatalogStore(
  process.env.CREDENTIAL_CATALOG_PATH || '/data/itops-agents/credential-catalog.json'
);
const credentialExecutionResolver = new CredentialExecutionResolver(credentialCatalogStore);
const concurrencyPolicyStore = new ConcurrencyPolicyStore(
  process.env.CONCURRENCY_POLICY_PATH || '/data/itops-agents/concurrency-policy.json'
);
const privilegedTargetAllowlistPolicyStore = new PrivilegedTargetAllowlistPolicyStore(
  process.env.TARGET_ALLOWLIST_POLICY_PATH || '/data/itops-agents/target-allowlist-policy.json',
  PRIVILEGED_TARGET_ALLOWLIST
);
const slaSnapshotStore = new SlaSnapshotStore(
  process.env.SLA_SNAPSHOT_PATH || '/data/itops-agents/sla-snapshots.json'
);
const slaSnapshotPolicyStore = new SlaSnapshotPolicyStore(
  process.env.SLA_SNAPSHOT_POLICY_PATH || '/data/itops-agents/sla-snapshot-policy.json'
);
const policyChangeAuditStore = new PolicyChangeAuditStore(
  process.env.POLICY_AUDIT_PATH || '/data/itops-agents/policy-audit.json'
);
const orchestratorReliabilityPolicyStore = new OrchestratorReliabilityPolicyStore(
  process.env.ORCHESTRATOR_RELIABILITY_POLICY_PATH || '/data/itops-agents/orchestrator-reliability-policy.json',
  {
    autoRecoverEnabled: ['1', 'true', 'yes', 'on'].includes(String(process.env.ORCHESTRATOR_AUTO_RECOVER || 'true').toLowerCase()),
    stuckThresholdMinutes: Number.isFinite(Number(process.env.ORCHESTRATOR_STUCK_THRESHOLD_MINUTES || '90'))
      ? Math.max(1, Math.floor(Number(process.env.ORCHESTRATOR_STUCK_THRESHOLD_MINUTES || '90')))
      : 90,
    retryLimit: Number.isFinite(Number(process.env.ORCHESTRATOR_STUCK_RETRY_LIMIT || '2'))
      ? Math.max(0, Math.floor(Number(process.env.ORCHESTRATOR_STUCK_RETRY_LIMIT || '2')))
      : 2,
    retryCooldownMinutes: Number.isFinite(Number(process.env.ORCHESTRATOR_STUCK_RETRY_COOLDOWN_MINUTES || '15'))
      ? Math.max(1, Math.floor(Number(process.env.ORCHESTRATOR_STUCK_RETRY_COOLDOWN_MINUTES || '15')))
      : 15
  }
);
const OPENCLAW_BRIDGE_ENABLED = parseBoolEnv(process.env.OPENCLAW_BRIDGE_ENABLED, false);
const OPENCLAW_BRIDGE_SECRET = process.env.OPENCLAW_BRIDGE_SECRET || '';
const OPENCLAW_BRIDGE_STATE_PATH = process.env.OPENCLAW_BRIDGE_STATE_PATH || '/data/itops-agents/openclaw-bridge-state.json';
const openClawBridgeState: OpenClawBridgeStateFile = { version: 1, chats: {} };
loadOpenClawBridgeState();
const STATE_BACKUP_DIR = process.env.STATE_BACKUP_DIR || '/data/itops-agents/backups';
const STATE_BACKUP_TARGETS: BackupTargetFile[] = [
  { key: 'config', filePath: CONFIG_PATH, required: true },
  { key: 'delegations', filePath: process.env.DELEGATION_STORE_PATH ? process.env.DELEGATION_STORE_PATH.replace(/\.json$/, '.db') : '/data/itops-agents/delegations.db', required: true },
  { key: 'delegationPolicy', filePath: process.env.DELEGATION_POLICY_PATH || '/data/itops-agents/delegation-policy.json', required: true },
  { key: 'taskSnapshots', filePath: process.env.TASK_SNAPSHOT_PATH || '/data/itops-agents/task-snapshots.json', required: false },
  { key: 'agentBus', filePath: process.env.AGENT_BUS_PATH || '/data/itops-agents/agent-bus.json', required: false },
  { key: 'credentialsVault', filePath: process.env.CREDENTIAL_VAULT_PATH || '/data/itops-agents/credentials.vault.json', required: false },
  { key: 'authUsers', filePath: process.env.AUTH_USERS_PATH || '/data/itops-agents/auth-users.json', required: true },
  { key: 'approvalsLedger', filePath: process.env.APPROVAL_LEDGER_PATH || '/data/itops-agents/approval-ledger.json', required: false },
  { key: 'executionAudit', filePath: process.env.EXECUTION_AUDIT_PATH || '/data/itops-agents/execution-audit.json', required: false },
  { key: 'concurrencyPolicy', filePath: process.env.CONCURRENCY_POLICY_PATH || '/data/itops-agents/concurrency-policy.json', required: true },
  { key: 'targetAllowlistPolicy', filePath: process.env.TARGET_ALLOWLIST_POLICY_PATH || '/data/itops-agents/target-allowlist-policy.json', required: true },
  { key: 'orchestratorReliabilityPolicy', filePath: process.env.ORCHESTRATOR_RELIABILITY_POLICY_PATH || '/data/itops-agents/orchestrator-reliability-policy.json', required: true },
  { key: 'slaSnapshots', filePath: process.env.SLA_SNAPSHOT_PATH || '/data/itops-agents/sla-snapshots.json', required: false },
  { key: 'slaSnapshotPolicy', filePath: process.env.SLA_SNAPSHOT_POLICY_PATH || '/data/itops-agents/sla-snapshot-policy.json', required: true },
  { key: 'policyAudit', filePath: process.env.POLICY_AUDIT_PATH || '/data/itops-agents/policy-audit.json', required: false }
];
const BACKUP_ENCRYPTION_SECRET_RESOLVED = readSecretFromEnv('BACKUP_ENCRYPTION_KEY', '');
const BACKUP_ENCRYPTION_SECRET = BACKUP_ENCRYPTION_SECRET_RESOLVED.value;
const BACKUP_EXTERNAL_KEY_CUSTODY = BACKUP_ENCRYPTION_SECRET_RESOLVED.source.startsWith('provider_')
  || (BACKUP_ENCRYPTION_SECRET_RESOLVED.source === 'file'
    && String(process.env.BACKUP_ENCRYPTION_KEY_FILE || '').startsWith('/run/secrets/'))
  || parseBoolEnv(process.env.BACKUP_KEY_CUSTODY_EXTERNAL, false);
const stateBackupManager = new StateBackupManager(STATE_BACKUP_DIR, STATE_BACKUP_TARGETS, {
  encryptionSecret: BACKUP_ENCRYPTION_SECRET,
  requireEncryption: parseBoolEnv(process.env.BACKUP_ENCRYPTION_REQUIRED, false),
});
const s3Uploader = new S3BackupUploader();

// ── DB hardening pipeline: paths, runners, size monitor ─────────────────
// Single source of truth for every SQLite file the platform writes to.
// The backup runner, vacuum runner, and size monitor all iterate this
// list. To add a new store, append one entry — the rest of the pipeline
// picks it up automatically. Wiring (cron schedules, monitor start) is
// in startBeaconDbHardening() called from startServer().
const BEACON_DB_PATHS: Array<{ name: string; path: string }> = [
  { name: 'tasks',                 path: process.env.TASK_DB_PATH                || '/data/itops-agents/tasks.db' },
  { name: 'roles',                 path: process.env.ROLES_DB_PATH               || '/data/itops-agents/roles.db' },
  { name: 'notifications',         path: process.env.NOTIFICATIONS_DB_PATH       || '/data/itops-agents/notifications.db' },
  { name: 'incidents',             path: process.env.INCIDENT_DB_PATH            || '/data/itops-agents/incidents.db' },
  { name: 'agent-affinity',        path: process.env.AGENT_AFFINITY_DB_PATH      || '/data/itops-agents/agent-affinity.db' },
  { name: 'post-mortems',          path: process.env.POST_MORTEM_DB_PATH         || '/data/itops-agents/post-mortems.db' },
  { name: 'agent-memory',          path: process.env.AGENT_MEMORY_DB_PATH        || '/data/itops-agents/agent-memory.db' },
  { name: 'sla',                   path: process.env.SLA_DB_PATH                 || '/data/itops-agents/sla.db' },
  { name: 'push',                  path: process.env.PUSH_DB_PATH                || '/data/itops-agents/push.db' },
  { name: 'servers',               path: process.env.SERVER_REGISTRY_DB_PATH     || '/data/itops-agents/servers.db' },
  { name: 'assets',                path: process.env.ASSET_STORE_DB_PATH         || '/data/itops-agents/assets.db' },
  { name: 'changes',               path: process.env.CHANGE_STORE_DB_PATH        || '/data/itops-agents/changes.db' },
  { name: 'knowledge',             path: process.env.KB_DB_PATH                  || '/data/itops-agents/knowledge.db' },
  { name: 'metrics-history',       path: process.env.METRICS_HISTORY_DB_PATH     || '/data/itops-agents/metrics-history.db' },
  { name: 'runbook-runs',          path: process.env.RUNBOOK_RUNS_DB_PATH        || '/data/itops-agents/runbook-runs.db' },
  { name: 'runbook-approvals',     path: process.env.RUNBOOK_APPROVALS_DB_PATH   || '/data/itops-agents/runbook-approvals.db' },
  { name: 'integration-plugins',   path: process.env.INTEGRATION_PLUGINS_DB_PATH || '/data/itops-agents/integration-plugins.db' },
  { name: 'reports',               path: process.env.REPORTS_DB_PATH             || '/data/itops-agents/reports.db' },
  { name: 'problems',              path: process.env.PROBLEMS_DB_PATH            || '/data/itops-agents/problems.db' },
  { name: 'maintenance',           path: process.env.MAINTENANCE_DB_PATH         || '/data/itops-agents/maintenance.db' },
  { name: 'events',                path: process.env.EVENT_DB_PATH                || '/data/itops-agents/events.db' },
  { name: 'ai-decisions',          path: process.env.AI_DECISION_DB_PATH          || '/data/itops-agents/ai-decisions.db' },
  { name: 'builder',               path: process.env.BUILDER_DB_PATH              || '/data/itops-agents/builder.db' },
];

{
  const initialInventory = buildBackupInventory({
    dataRoot: process.env.DATA_DIR || '/data/itops-agents',
    stateTargets: STATE_BACKUP_TARGETS,
    sqliteTargets: BEACON_DB_PATHS.map(target => ({ key: target.name, filePath: target.path, required: true })),
    volumes: [],
  });
  const coveragePlan = planBackupCoverage(initialInventory);
  const promotedDatabasePaths = new Set(coveragePlan.sqliteTargets.map(target => path.resolve(target.filePath)));
  for (let index = STATE_BACKUP_TARGETS.length - 1; index >= 0; index--) {
    if (promotedDatabasePaths.has(path.resolve(STATE_BACKUP_TARGETS[index].filePath))) {
      STATE_BACKUP_TARGETS.splice(index, 1);
    }
  }
  STATE_BACKUP_TARGETS.push(...coveragePlan.stateTargets);
  BEACON_DB_PATHS.push(...coveragePlan.sqliteTargets.map(target => ({ name: target.key, path: target.filePath })));
  serverLog.info('backup coverage reconciled', {
    discoveredStateTargets: coveragePlan.stateTargets.length,
    discoveredSqliteTargets: coveragePlan.sqliteTargets.length,
    stateTargetCount: STATE_BACKUP_TARGETS.length,
    sqliteTargetCount: BEACON_DB_PATHS.length,
  });
}

const BACKUP_VOLUME_INVENTORY: BackupInventoryVolume[] = [
  { name: 'itops-data', service: 'itops-agents', mountPath: process.env.DATA_DIR || '/data/itops-agents', purpose: 'Core application state', requiredForCoreRestore: true },
  { name: 'postgres-data', service: 'postgres', mountPath: '/var/lib/postgresql/data', purpose: 'Optional PostgreSQL backend', requiredForCoreRestore: process.env.DB_PROVIDER === 'postgres' },
  { name: 'redis-data', service: 'redis', mountPath: '/data', purpose: 'Optional Redis message bus', requiredForCoreRestore: false },
  { name: 'irc-data', service: 'irc-server', mountPath: '/data', purpose: 'IRC server state', requiredForCoreRestore: false },
  { name: 'ollama-data', service: 'ollama', mountPath: '/root/.ollama', purpose: 'Local model cache', requiredForCoreRestore: false },
  { name: 'prometheus-data', service: 'prometheus', mountPath: '/prometheus', purpose: 'Metrics history', requiredForCoreRestore: false },
  { name: 'grafana-data', service: 'grafana', mountPath: '/var/lib/grafana', purpose: 'Dashboard configuration', requiredForCoreRestore: false },
];

function computeBackupInventoryPayload() {
  return buildBackupInventory({
    dataRoot: process.env.DATA_DIR || '/data/itops-agents',
    stateTargets: STATE_BACKUP_TARGETS,
    sqliteTargets: BEACON_DB_PATHS.map(target => ({ key: target.name, filePath: target.path, required: true })),
    volumes: BACKUP_VOLUME_INVENTORY,
  });
}

const sqliteBackupRunner = new SqliteBackupRunner({
  destRoot: process.env.SQLITE_BACKUP_DIR || path.join(STATE_BACKUP_DIR, 'sqlite'),
  retentionDays: Number(process.env.SQLITE_BACKUP_RETENTION_DAYS) || 14,
});

const WORKFLOW_RECOVERY_ENABLED = parseBoolEnv(process.env.WORKFLOW_RECOVERY_ENABLED, true);
const rawWorkflowOrphanGraceMinutes = Number(process.env.WORKFLOW_ORPHAN_GRACE_MINUTES || 60);
const WORKFLOW_ORPHAN_GRACE_MINUTES = Number.isFinite(rawWorkflowOrphanGraceMinutes) ? Math.max(5, rawWorkflowOrphanGraceMinutes) : 60;
const rawWorkflowStaleFailMinutes = Number(process.env.WORKFLOW_STALE_FAIL_MINUTES || 120);
const WORKFLOW_STALE_FAIL_MINUTES = Number.isFinite(rawWorkflowStaleFailMinutes)
  ? Math.max(WORKFLOW_ORPHAN_GRACE_MINUTES, rawWorkflowStaleFailMinutes) : 120;
const rawWorkflowRecoveryIntervalMinutes = Number(process.env.WORKFLOW_RECOVERY_INTERVAL_MINUTES || 5);
const WORKFLOW_RECOVERY_INTERVAL_MINUTES = Number.isFinite(rawWorkflowRecoveryIntervalMinutes)
  ? Math.max(1, rawWorkflowRecoveryIntervalMinutes) : 5;

function reconcileWorkflowBacklog(): void {
  if (!WORKFLOW_RECOVERY_ENABLED) return;
  const now = Date.now();
  const report = WorkflowEngine.getInstance().recoverActiveRuns(run => {
    if (!run.taskId.startsWith('inc-')) return { action: 'keep' };
    const incidentId = run.taskId.slice(4);
    const incident = incidentManager.get(incidentId);
    const ageMinutes = Math.max(0, (now - Date.parse(run.updatedAt)) / 60_000);
    if (!incident && ageMinutes >= WORKFLOW_ORPHAN_GRACE_MINUTES) {
      return { action: 'failed', reason: `Source incident ${incidentId} no longer exists` };
    }
    if (incident && (incident.status === 'resolved' || incident.status === 'closed')) {
      return { action: 'completed', reason: `Source incident ${incidentId} is ${incident.status}` };
    }
    if (incident && ageMinutes >= WORKFLOW_STALE_FAIL_MINUTES) {
      return { action: 'failed', reason: `Fallback workflow stale for ${Math.floor(ageMinutes)} minutes; incident remains ${incident.status}` };
    }
    return { action: 'keep' };
  });
  if (report.changedRunIds.length > 0) {
    for (const runId of report.changedRunIds) {
      const run = WorkflowEngine.getInstance().getRun(runId);
      if (!run || run.status !== 'failed' || !run.taskId.startsWith('inc-')) continue;
      const attempt = autonomyAttemptStore.latestForIncident(run.taskId.slice(4), true);
      if (attempt) {
        autonomyAttemptStore.conclude(attempt.id, 'failed', 'fallback_workflow_failed', {
          details: { workflowRunId: run.id },
        });
      }
    }
    logger.warn('[WorkflowEngine] reconciled active workflow backlog', report);
    orchestratorService.tick('workflow_recovery');
  }
}

setTimeout(reconcileWorkflowBacklog, 15_000);
setInterval(reconcileWorkflowBacklog, WORKFLOW_RECOVERY_INTERVAL_MINUTES * 60_000);
const recoverySetManager = BACKUP_ENCRYPTION_SECRET ? new RecoverySetManager({
  rootDir: STATE_BACKUP_DIR,
  encryptionSecret: BACKUP_ENCRYPTION_SECRET,
  stateBackupManager,
  sqliteBackupRunner,
}) : null;
const RECOVERY_STATUS_PATH = process.env.RECOVERY_STATUS_PATH || path.join(STATE_BACKUP_DIR, 'recovery-status.json');
const recoverySchedulerState: RecoverySchedulerState = {
  ...loadRecoverySchedulerState(),
  enabled: RECOVERY_SET_ENABLED,
  cron: RECOVERY_SET_CRON,
  retentionKeepLatest: RECOVERY_SET_RETAIN,
  retentionMaxAgeDays: RECOVERY_SET_MAX_AGE_DAYS,
  offsiteConfigured: s3Uploader.isConfigured,
  keySource: BACKUP_ENCRYPTION_SECRET_RESOLVED.source,
  externalKeyCustody: BACKUP_EXTERNAL_KEY_CUSTODY,
};

function loadRecoverySchedulerState(): Partial<RecoverySchedulerState> {
  try {
    return JSON.parse(fs.readFileSync(RECOVERY_STATUS_PATH, 'utf8')) as Partial<RecoverySchedulerState>;
  } catch { return {}; }
}

function persistRecoverySchedulerState(): void {
  fs.mkdirSync(path.dirname(RECOVERY_STATUS_PATH), { recursive: true });
  const temp = `${RECOVERY_STATUS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(recoverySchedulerState, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, RECOVERY_STATUS_PATH);
  fs.chmodSync(RECOVERY_STATUS_PATH, 0o600);
}

const sqliteVacuumRunner = new SqliteVacuumRunner();

const databaseSizeMonitor = new DatabaseSizeMonitor(
  {
    // incidentManager is already initialized above (line ~1446). The
    // size monitor only calls into it at .tickOnce() time, which can't
    // happen until start() runs from startServer.
    incidentManager: {
      create: (input: any) => incidentManager.create(input),
      update: (id: string, patch: any) => incidentManager.update(id, patch),
      resolve: (id: string, note?: string) => incidentManager.resolve(id, note),
    },
  },
  {
    intervalMs: Number(process.env.DB_SIZE_INTERVAL_MS) || 60 * 60 * 1000,
    warnBytes:  (Number(process.env.DB_SIZE_WARN_MB) || 500)  * 1024 * 1024,
    failBytes:  (Number(process.env.DB_SIZE_FAIL_MB) || 1024) * 1024 * 1024,
    failStreakThreshold: 2,
  },
);
const orchestratorService = new OrchestratorService(
  taskManager,
  delegationManager,
  orchestratorReliabilityPolicyStore.get()
);
orchestratorService.tick('startup');

// ─── Phase 18: Autonomous improvement loop ─────────────────────────────
// v1: deterministic watchdog. v2: optional LLM judge for stuck-task and
// draft-promotion verdicts. The judge is gated by its own env flag so the
// LLM layer can be toggled independently of the loop. Constructed here
// (rather than next to incidentAnalyzer) so it can reference
// orchestratorService.
import { ImprovementLoop } from '../improvement/ImprovementLoop.js';
import { ImprovementLoopJudge } from '../improvement/ImprovementLoopJudge.js';
import { SandboxValidator } from '../improvement/SandboxValidator.js';

const improvementLoopJudge = ((process.env.IMPROVEMENT_LOOP_JUDGE_ENABLED || '').toLowerCase() === 'true')
  ? new ImprovementLoopJudge(aiFactory, 'claude')
  : undefined;

// v3 safety layer — runs each draft's workflow in a Docker (or host
// fallback) sandbox before the loop auto-promotes it. Always
// constructed; gates itself on IMPROVEMENT_LOOP_SANDBOX_ENABLED env.
const improvementLoopSandbox = new SandboxValidator();

const improvementLoop = new ImprovementLoop(
  {
    incidentManager,
    incidentAnalyzer,
    crystallizationStore: storeFactory.crystallizedSkills,
    crystallizationService,
    taskManager,
    orchestratorService,
    organization,
    judge: improvementLoopJudge,
    sandboxValidator: improvementLoopSandbox,
    broadcast,
  },
  {
    intervalMs:           parseInt(process.env.IMPROVEMENT_LOOP_INTERVAL_MS  || '900000', 10),
    maxActionsPerTick:    parseInt(process.env.IMPROVEMENT_LOOP_MAX_ACTIONS  || '3',      10),
    draftReviewAgeMs:     parseInt(process.env.IMPROVEMENT_LOOP_DRAFT_AGE_MS || '86400000', 10),
  },
);
if ((process.env.IMPROVEMENT_LOOP_ENABLED || '').toLowerCase() === 'true') {
  improvementLoop.start();
}

function computeBackupHealthPayload(): BackupHealthResponse {
  const backups = stateBackupManager.list(1);
  const latest = backups.length > 0 ? backups[0] : null;
  const nowMs = Date.now();
  let ageSeconds: number | null = null;
  if (latest) {
    const createdMs = Date.parse(latest.createdAt);
    if (!Number.isNaN(createdMs)) {
      ageSeconds = Math.max(0, Math.floor((nowMs - createdMs) / 1000));
    }
  }
  let verification: BackupHealthResponse['verification'] | undefined;
  if (latest) {
    try {
      const report = stateBackupManager.verify(latest.id);
      verification = {
        ok: report.ok,
        verifiedAt: new Date().toISOString(),
        backup: report.backup,
        checks: report.checks
      };
    } catch (error) {
      verification = {
        ok: false,
        verifiedAt: new Date().toISOString(),
        error: (error as Error).message
      };
    }
  }
  const thresholdSeconds = BACKUP_HEALTH_MAX_AGE_HOURS * 3600;
  const stale = latest === null || ageSeconds === null || ageSeconds > thresholdSeconds;
  return {
    thresholdHours: BACKUP_HEALTH_MAX_AGE_HOURS,
    latestBackup: latest,
    backupAgeSeconds: ageSeconds,
    stale,
    verification
  };
}

function pruneStateBackups(policy: { keepLatest: number; maxAgeDays: number }): { deleted: number } {
  const keepLatest = Math.max(0, Math.floor(policy.keepLatest));
  const maxAgeDays = Math.max(0, Math.floor(policy.maxAgeDays));
  const nowMs = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const backups = stateBackupManager.list(5000);
  let deleted = 0;
  backups.forEach((backup, index) => {
    if (index < keepLatest) return;
    const createdMs = Date.parse(backup.createdAt);
    if (!Number.isFinite(createdMs)) return;
    if ((nowMs - createdMs) <= maxAgeMs) return;
    if (!backup.bundlePath.startsWith(`${STATE_BACKUP_DIR}${path.sep}`) || !backup.bundlePath.endsWith('.json')) return;
    try {
      if (fs.existsSync(backup.bundlePath)) {
        fs.unlinkSync(backup.bundlePath);
        deleted += 1;
      }
    } catch {
      // Ignore prune errors for individual files.
    }
  });
  return { deleted };
}

function runAutomatedBackup(reason: string): { success: boolean; backupId?: string; pruned: number; error?: string } {
  backupSchedulerState.lastRunAt = new Date().toISOString();
  try {
    const backup = stateBackupManager.create({
      label: `auto-${reason}-${new Date().toISOString()}`,
      actorId: 'system'
    });
    const verify = stateBackupManager.verify(backup.id);
    if (!verify.ok) {
      throw new Error('Automated backup verification failed');
    }
    const prune = pruneStateBackups({
      keepLatest: RETENTION_KEEP_LATEST,
      maxAgeDays: RETENTION_MAX_AGE_DAYS
    });
    backupSchedulerState.lastSuccessAt = new Date().toISOString();
    backupSchedulerState.lastBackupId = backup.id;
    backupSchedulerState.lastPrunedCount = prune.deleted;
    backupSchedulerState.lastError = undefined;
    return { success: true, backupId: backup.id, pruned: prune.deleted };
  } catch (error) {
    backupSchedulerState.lastFailureAt = new Date().toISOString();
    backupSchedulerState.lastError = (error as Error).message;
    return { success: false, pruned: 0, error: (error as Error).message };
  }
}

let recoveryRunInFlight = false;
async function runRecoverySet(reason: string): Promise<{ success: boolean; recoveryId?: string; archiveBytes?: number; offsiteKey?: string; pruned: number; error?: string }> {
  recoverySchedulerState.lastRunAt = new Date().toISOString();
  if (recoveryRunInFlight) return { success: false, pruned: 0, error: 'Recovery-set run already in progress' };
  recoveryRunInFlight = true;
  try {
    if (!recoverySetManager) throw new Error('BACKUP_ENCRYPTION_KEY is required for recovery sets');
    const recovery = await recoverySetManager.create({ label: `recovery-${reason}`, actorId: 'system' });
    let offsiteKey: string | undefined;
    if (s3Uploader.isConfigured) {
      const uploaded = await s3Uploader.upload(recovery.archivePath);
      const remoteKeys = await s3Uploader.listBackups();
      if (!remoteKeys.includes(uploaded.key)) throw new Error(`Off-site upload could not be verified: ${uploaded.key}`);
      const remoteVerification = await s3Uploader.verifyUpload(recovery.archivePath, uploaded.key);
      offsiteKey = uploaded.key;
      recoverySchedulerState.lastOffsiteSha256 = remoteVerification.sha256;
      await s3Uploader.pruneOldBackups();
    }
    const pruned = recoverySetManager.prune(RECOVERY_SET_RETAIN, RECOVERY_SET_MAX_AGE_DAYS);
    recoverySchedulerState.lastSuccessAt = new Date().toISOString();
    recoverySchedulerState.lastRecoveryId = recovery.id;
    recoverySchedulerState.lastArchiveBytes = recovery.bytes;
    recoverySchedulerState.lastOffsiteKey = offsiteKey;
    recoverySchedulerState.lastOffsiteVerified = s3Uploader.isConfigured ? true : false;
    recoverySchedulerState.lastPrunedCount = pruned;
    recoverySchedulerState.lastError = undefined;
    persistRecoverySchedulerState();
    return { success: true, recoveryId: recovery.id, archiveBytes: recovery.bytes, offsiteKey, pruned };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recoverySchedulerState.lastFailureAt = new Date().toISOString();
    recoverySchedulerState.lastError = message;
    recoverySchedulerState.lastOffsiteVerified = false;
    persistRecoverySchedulerState();
    return { success: false, pruned: 0, error: message };
  } finally {
    recoveryRunInFlight = false;
  }
}

const factoryBoardService = new FactoryBoardService(process.env.FACTORY_BOARD_PATH);
const auditExportSecret = process.env.AUDIT_EXPORT_SECRET || authTokenSecret || approvalTokenSecret || credentialMasterKey || 'change-this-master-key';
const sandboxRunner = new SandboxRunner(
  process.env.SANDBOX_IMAGE || 'itops-agents:latest'
);
const activeExecutionsByCommand = new Map<string, number>();
let lastSlaSnapshotCaptureAt = 0;

function getMaxConcurrentExecutions(command: string): number {
  const concurrencyPolicy = concurrencyPolicyStore.get();
  const override = concurrencyPolicy.byCommand[command];
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.min(Math.max(Math.floor(override), 1), 20);
  }
  const policy = getToolPolicy(command);
  if (!policy) return 1;
  return concurrencyPolicy.byRisk[policy.risk] || 1;
}

function acquireExecutionSlot(command: string): { ok: boolean; active: number; limit: number } {
  const limit = getMaxConcurrentExecutions(command);
  const active = activeExecutionsByCommand.get(command) || 0;
  if (active >= limit) {
    return { ok: false, active, limit };
  }
  activeExecutionsByCommand.set(command, active + 1);
  return { ok: true, active: active + 1, limit };
}

function releaseExecutionSlot(command: string): void {
  const active = activeExecutionsByCommand.get(command) || 0;
  if (active <= 1) {
    activeExecutionsByCommand.delete(command);
    return;
  }
  activeExecutionsByCommand.set(command, active - 1);
}

function captureSlaSnapshot(windowHours: number = 24) {
  const trend = buildSlaTrends(windowHours);
  const summary = (trend.buckets || []).reduce((acc, b) => {
    acc.delegationCreated += b.delegationCreated || 0;
    acc.delegationCompleted += b.delegationCompleted || 0;
    acc.delegationRejected += b.delegationRejected || 0;
    acc.stalledEscalations += b.stalledEscalations || 0;
    acc.overdueEscalations += b.overdueEscalations || 0;
    return acc;
  }, {
    delegationCreated: 0,
    delegationCompleted: 0,
    delegationRejected: 0,
    stalledEscalations: 0,
    overdueEscalations: 0
  });
  const record = slaSnapshotStore.append({
    id: cryptoRandomId(),
    timestamp: new Date().toISOString(),
    windowHours: trend.windowHours,
    summary,
    topAgents: (trend.agentSummary || []).slice(0, 12)
  });
  const policy = slaSnapshotPolicyStore.get();
  slaSnapshotStore.prune({
    retentionHours: policy.retentionHours,
    maxRecords: policy.maxRecords
  });
  return record;
}

function maybeCaptureSlaSnapshot(force: boolean = false): void {
  const policy = slaSnapshotPolicyStore.get();
  const now = Date.now();
  if (!force && (now - lastSlaSnapshotCaptureAt) < policy.captureIntervalMs) return;
  captureSlaSnapshot(policy.defaultWindowHours);
  lastSlaSnapshotCaptureAt = now;
}
setInterval(processDelegationEscalations, Number(process.env.DELEGATION_SWEEP_INTERVAL_MS || 60_000));
startAlertEvaluator(Number(process.env.ALERT_EVAL_INTERVAL_MS || 5 * 60 * 1000));
startAlertEvaluator(Number(process.env.ALERT_EVAL_INTERVAL_MS || 5 * 60 * 1000));
setInterval(() => {
  try {
    maybeCaptureSlaSnapshot(false);
  } catch {
    // ignore snapshot capture failures
  }
}, 60_000);
try {
  maybeCaptureSlaSnapshot(true);
} catch {
  // ignore initial snapshot capture failures
}

// Orchestrator dispatch loop — assigns pending tasks to agents and executes them
const ORCHESTRATOR_DISPATCH_INTERVAL_MS = Number(process.env.ORCHESTRATOR_DISPATCH_INTERVAL_MS || 15_000);
async function runOrchestratorDispatch(): Promise<void> {
  try {
    orchestratorService.tick('dispatch');
    const allAgents = organization.getAllAgents();
    const dispatched = await orchestratorService.dispatchPendingTasks(
      allAgents,
      skillManager,
      (taskId, result) => {
        const task = taskManager.getTask(taskId);
        broadcast({ type: 'task_completed', data: { taskId, result, task } });
        createNotification('task', `Task Completed: ${task?.title || taskId}`, `Task ${taskId} finished successfully`, 'info');
        logger.info(`[Orchestrator] Task ${taskId} completed`);
      },
      (taskId, error) => {
        const task = taskManager.getTask(taskId);
        broadcast({ type: 'task_failed', data: { taskId, error, task } });
        createNotification('task', `Task Failed: ${task?.title || taskId}`, `Task ${taskId} failed: ${error}`, 'warning');
        logger.error(`[Orchestrator] Task ${taskId} failed: ${error}`);
      }
    );
    if (dispatched > 0) {
      logger.info(`[Orchestrator] Dispatched ${dispatched} task(s) to agents`);
    }
  } catch (err) {
    logger.error('[Orchestrator] Dispatch error:', { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? (err as Error).stack : undefined });
  }
}
setInterval(runOrchestratorDispatch, ORCHESTRATOR_DISPATCH_INTERVAL_MS);
// Run once on startup after a short delay to let agents load
setTimeout(runOrchestratorDispatch, 5_000);

// Orchestrator sweep heartbeat — calls tick() independently of dispatch to keep
// workflow drift detection and stuck-task recovery up to date
const ORCHESTRATOR_SWEEP_INTERVAL_MS = Number(process.env.ORCHESTRATOR_SWEEP_INTERVAL_MS || 60_000);
setInterval(() => {
  try {
    orchestratorService.tick('sweep');
    logger.debug('[Orchestrator] Auto-sweep tick completed');
  } catch (err) {
    logger.error('[Orchestrator] Auto-sweep tick error:', { err: err instanceof Error ? err.message : String(err) });
  }
}, ORCHESTRATOR_SWEEP_INTERVAL_MS);
if (BACKUP_AUTOMATION_ENABLED) {
  if (BACKUP_AUTOMATION_RUN_ON_STARTUP) {
    runAutomatedBackup('startup');
  }
  setInterval(() => {
    runAutomatedBackup('interval');
  }, BACKUP_AUTOMATION_INTERVAL_MINUTES * 60 * 1000);
}
taskManager.on('task:status_changed', ({ task }: { task: Task }) => {
  if (task.parentTaskId) {
    try {
      rollupParentTaskStatus(task.parentTaskId);
    } catch {
      // ignore rollup failures
    }
  }
});

// WebSocket clients
const clients = new Set<WebSocket>();

function broadcast(data: unknown) {
  const message = JSON.stringify(data);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });

  // Hook: when a runbook completes, store resolution memory for all agents
  const evt = data as { type?: string; data?: { run?: { templateName?: string; templateId?: string; stepResults?: Array<{ output?: string }> } } };
  if (evt?.type === 'runbook_completed' && evt.data?.run) {
    const run = evt.data.run;
    const templateName = run.templateName ?? run.templateId ?? 'unknown runbook';
    const resolution = run.stepResults?.map(s => s.output).filter(Boolean).join(' | ') || `Runbook "${templateName}" completed successfully`;
    const incident = { title: `Runbook: ${templateName}`, severity: 'medium' };
    for (const agent of organization.getAllAgents()) {
      agentMemoryStore.storeResolution(agent.id, incident, resolution, templateName);
    }
  }

  // Hook: forward incident state changes to ChatBotService so any chat
  // session watching the incident gets a push notification. We only act
  // on incident_updated (status/severity changes) — the onResolved hook
  // covers the resolve case separately.
  const incEvt = data as { type?: string; data?: { id?: string; title?: string; status?: string; severity?: string } };
  if (incEvt?.type === 'incident_updated' && incEvt.data && incEvt.data.id && incEvt.data.status && incEvt.data.severity) {
    chatBotService?.notifyIncidentChange({
      id: incEvt.data.id,
      title: incEvt.data.title ?? incEvt.data.id,
      status: incEvt.data.status,
      severity: incEvt.data.severity,
    });
  }

  // Hook: PluginManager fan-out for runbook_completed + incident
  // escalation events. We piggy-back on the existing broadcast pipeline
  // rather than adding new listener arrays — every meaningful state
  // change already passes through here.
  const evt2 = data as { type?: string; data?: any };
  if (pluginManager && evt2?.type === 'runbook_completed' && evt2.data?.run) {
    pluginManager.notifyRunbookCompleted(evt2.data.run);
  }
  if (pluginManager && evt2?.type === 'incident_escalation_level' && evt2.data?.incident && typeof evt2.data?.level === 'number') {
    pluginManager.notifyIncidentEscalated(evt2.data.incident, evt2.data.level);
  }

  // Hook: auto-log a Change row for every runbook execution. Runbooks
  // actually mutate state on the box, so they belong in the change
  // history alongside operator-typed entries. We file the row at
  // creation time with status reflecting the run outcome, and fan it
  // out through PluginManager so external trackers see both events.
  try {
    if (evt2?.type === 'runbook_completed' && evt2.data?.run) {
      const run = evt2.data.run as { id?: string; templateId?: string; templateName?: string; status?: string; context?: { incidentId?: string; serverId?: string; user?: string }; startedAt?: string; completedAt?: string; error?: string };
      // Map runbook status → change status. Anything that didn't
      // reach 'completed' is treated as failed for change-log purposes.
      const finalStatus = run.status === 'completed' ? 'completed' as const : 'failed' as const;
      const serverId = run.context?.serverId ?? null;
      const assetId = serverId ? (assetStore.getByServerId(serverId)?.id ?? null) : null;
      const change = changeStore.create({
        type: 'auto-remediation',
        title: `Runbook: ${run.templateName ?? run.templateId ?? 'unknown'}`,
        description: run.error ? `Failed: ${run.error}` : `Runbook execution completed`,
        riskLevel: 'medium',
        assetId,
        serverId,
        createdBy: run.context?.user ?? 'runbook-engine',
        status: finalStatus,
        source: 'runbook',
        relatedRunbookRunId: run.id ?? null,
        relatedIncidentId: run.context?.incidentId ?? null,
        metadata: {
          templateId: run.templateId,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          ...(run.error ? { error: run.error } : {}),
        },
      });
      pluginManager?.notifyChangeCreated(change);
      pluginManager?.notifyChangeCompleted(change);
    }
  } catch (e) {
    logger.warn('[changes] failed to auto-log runbook execution', { err: e instanceof Error ? e.message : String(e) });
  }

  // ── PWA push notification fan-out ─────────────────────────────────
  // Piggy-backs on the same broadcast that drives the WS clients +
  // plugins so push routing stays consistent. No-ops when no devices
  // are subscribed; failed sends are pruned inside PushService.
  try {
    const pushEvt = data as { type?: string; data?: any };
    if (pushEvt?.type === 'incident_updated' && pushEvt.data?.id) {
      const inc = pushEvt.data;
      // Assignment change → ping the assignee
      if (inc.assignedTo) {
        pushToUsers([String(inc.assignedTo)], {
          title: `Assigned: ${inc.title || inc.id}`,
          body: `${String(inc.severity || 'unknown').toUpperCase()} · ${inc.status || 'open'}`,
          url: `/app/incidents/${inc.id}`,
          tag: `incident:${inc.id}`,
        });
      }
      // Resolution → ping the requester who filed it
      if (inc.status === 'resolved' && inc.createdBy) {
        pushToUsers([String(inc.createdBy)], {
          title: `Resolved: ${inc.title || inc.id}`,
          body: 'Your incident has been resolved.',
          url: `/app/incidents/${inc.id}`,
          tag: `incident:${inc.id}`,
        });
      }
    }
    if (pushEvt?.type === 'sla_warning' && pushEvt.data?.incident) {
      const inc = pushEvt.data.incident;
      const audience = new Set<string>([...usersByRole('operator')]);
      if (inc.assignedTo) audience.add(String(inc.assignedTo));
      pushToUsers([...audience], {
        title: `SLA warning: ${inc.title || inc.id}`,
        body: `${String(inc.severity || 'unknown').toUpperCase()} · 75% of SLA elapsed`,
        url: `/app/incidents/${inc.id}`,
        tag: `sla-warn:${inc.id}`,
      });
    }
    if (pushEvt?.type === 'sla_breach' && pushEvt.data?.incident) {
      const inc = pushEvt.data.incident;
      const audience = new Set<string>([...usersByRole('admin'), ...usersByRole('operator')]);
      pushToUsers([...audience], {
        title: `SLA breach: ${inc.title || inc.id}`,
        body: `${String(inc.severity || 'unknown').toUpperCase()} · ${inc.status || 'open'}`,
        url: `/app/incidents/${inc.id}`,
        tag: `sla-breach:${inc.id}`,
      });
    }
    if (pushEvt?.type === 'incident_escalation_level' && pushEvt.data?.incident && typeof pushEvt.data?.level === 'number') {
      const inc = pushEvt.data.incident;
      const audience = new Set<string>([...usersByRole('admin'), ...usersByRole('operator')]);
      pushToUsers([...audience], {
        title: `Escalation L${pushEvt.data.level}: ${inc.title || inc.id}`,
        body: `Severity ${String(inc.severity || 'unknown').toUpperCase()}`,
        url: `/app/incidents/${inc.id}`,
        tag: `escal:${inc.id}`,
      });
    }
    if (pushEvt?.type === 'problem_created' && pushEvt.data?.id) {
      const p = pushEvt.data;
      pushToRole('operator', {
        title: `Recurring problem: ${p.title || p.id}`,
        body: `${p.id} · severity ${String(p.severity || 'medium').toUpperCase()}`,
        url: `/app/problems/${p.id}`,
        tag: `problem:${p.id}`,
      });
    }
    if (pushEvt?.type === 'approval_required' && pushEvt.data) {
      const a = pushEvt.data;
      pushToRole('admin', {
        title: `Approval required: ${a.action || a.id || 'pending action'}`,
        body: a.summary || a.description || 'A destructive action is waiting for approval.',
        url: '/app/approvals',
        tag: `approval:${a.id || ''}`,
      });
    }
  } catch (e) {
    logger.warn('[push] hook error', { err: e instanceof Error ? e.message : String(e) });
  }
}

function createNotification(type: string, title: string, message: string, severity: string = 'info') {
  try {
    const row = notificationsDb.prepare(
      `INSERT INTO notifications (type, title, message, severity) VALUES (?, ?, ?, ?) RETURNING *`
    ).get(type, title, message, severity);
    broadcast({ event: 'notification_new', data: row });
  } catch (e) {
    logger.error('[Notifications] Failed to create notification:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
  }
}

function validateAuthFromHeader(authHeader: string | undefined, permission?: Permission): { ok: boolean; username?: string; role?: UserRole; reason?: string } {
  const token = AuthService.extractBearerToken(authHeader);
  const validation = authService.validateToken(token);
  if (!validation.valid) {
    return { ok: false, reason: validation.reason || 'Unauthorized' };
  }
  if (permission && !authService.hasPermission(validation.role as UserRole, permission)) {
    return { ok: false, reason: `Missing permission: ${permission}` };
  }
  // Back-fill the request context so the http log line + every
  // downstream log record carries `userId`. Safe outside a request
  // scope — setCurrentUserId is a no-op when AsyncLocalStorage is
  // unset (background callers, tests).
  if (validation.username) setCurrentUserId(validation.username);
  return { ok: true, username: validation.username, role: validation.role as UserRole };
}

function validateAuthToken(token: string | undefined, permission?: Permission): { ok: boolean; username?: string; role?: UserRole; reason?: string } {
  const validation = authService.validateToken(token);
  if (!validation.valid) {
    return { ok: false, reason: validation.reason || 'Unauthorized' };
  }
  if (permission && !authService.hasPermission(validation.role as UserRole, permission)) {
    return { ok: false, reason: `Missing permission: ${permission}` };
  }
  if (validation.username) setCurrentUserId(validation.username);
  return { ok: true, username: validation.username, role: validation.role as UserRole };
}

function loadOpenClawBridgeState(): void {
  try {
    if (!fs.existsSync(OPENCLAW_BRIDGE_STATE_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(OPENCLAW_BRIDGE_STATE_PATH, 'utf8')) as OpenClawBridgeStateFile;
    if (!parsed || typeof parsed !== 'object' || !parsed.chats || typeof parsed.chats !== 'object') return;
    openClawBridgeState.version = 1;
    openClawBridgeState.chats = parsed.chats;
  } catch {
    openClawBridgeState.version = 1;
    openClawBridgeState.chats = {};
  }
}

function saveOpenClawBridgeState(): void {
  try {
    fs.mkdirSync(path.dirname(OPENCLAW_BRIDGE_STATE_PATH), { recursive: true });
    fs.writeFileSync(OPENCLAW_BRIDGE_STATE_PATH, JSON.stringify(openClawBridgeState, null, 2), 'utf8');
  } catch {
    // Ignore persistence failures for bridge state.
  }
}

function isOpenClawBridgeAllowed(req: express.Request): boolean {
  if (!OPENCLAW_BRIDGE_ENABLED) return false;
  if (!OPENCLAW_BRIDGE_SECRET) return false;
  const provided = String(req.header('x-openclaw-secret') || '').trim();
  return !!provided && provided === OPENCLAW_BRIDGE_SECRET;
}

function getOpenClawChatState(chatId: string): OpenClawChatState {
  const key = String(chatId || '').trim();
  const now = new Date().toISOString();
  const existing = openClawBridgeState.chats[key];
  if (existing) return existing;
  const created: OpenClawChatState = { chatId: key, updatedAt: now };
  openClawBridgeState.chats[key] = created;
  saveOpenClawBridgeState();
  return created;
}

function getDirectorForBridge() {
  return organization.getAllAgents().find(agent => agent.role === 'director');
}

function listTargetableAgents() {
  return organization.getAllAgents().filter(agent => agent.role !== 'director');
}

function resolveAgentBySelector(selector: string) {
  const needle = String(selector || '').trim().toLowerCase();
  if (!needle) return undefined;
  const all = organization.getAllAgents();
  return all.find(agent => agent.id.toLowerCase() === needle)
    || all.find(agent => agent.name.toLowerCase() === needle)
    || all.find(agent => agent.name.toLowerCase().includes(needle));
}

interface PendingApprovalCandidate {
  command: string;
  agentId: string;
  blockedAt: string;
  reason: string;
}

const openClawBridgeRecentApprovals = new Map<string, number>();

function listPendingApprovalCandidates(limit: number = 10): PendingApprovalCandidate[] {
  const effectiveLimit = Math.min(Math.max(Number(limit) || 10, 1), 20);
  const records = executionAuditStore.list(500);
  const allowedKeys = new Set<string>();
  const pending: PendingApprovalCandidate[] = [];
  const pendingKeys = new Set<string>();
  const now = Date.now();
  for (const [key, expiresMs] of openClawBridgeRecentApprovals.entries()) {
    if (!Number.isFinite(expiresMs) || expiresMs <= now) {
      openClawBridgeRecentApprovals.delete(key);
    }
  }

  for (const record of records) {
    const command = String(record.command || '').trim();
    const agentId = String(record.agentId || '').trim();
    if (!command || !agentId) continue;
    const key = `${command}::${agentId}`;
    const recentExpiry = openClawBridgeRecentApprovals.get(key);
    if (recentExpiry && recentExpiry > now) continue;
    if (record.status === 'allowed' && record.approvalRequired) {
      allowedKeys.add(key);
      continue;
    }
    if (pendingKeys.has(key) || allowedKeys.has(key)) continue;
    if (record.status !== 'blocked' || !record.approvalRequired) continue;
    const reason = String(record.reason || '').trim();
    const reasonLower = reason.toLowerCase();
    if (!reasonLower.includes('approval') && !reasonLower.includes('blocked by policy')) continue;

    pending.push({
      command,
      agentId,
      blockedAt: record.timestamp,
      reason: reason || 'Blocked by policy'
    });
    pendingKeys.add(key);
    if (pending.length >= effectiveLimit) break;
  }

  return pending;
}

function mintApprovalForOpenClaw(params: {
  command: string;
  agentId: string;
  ttlSeconds?: number;
  approver: string;
  reason?: string;
}) {
  const policy = getToolPolicy(params.command);
  if (!policy) {
    throw new Error(`No policy defined for command '${params.command}'`);
  }
  if (!policy.requiresApproval) {
    throw new Error(`Command '${params.command}' does not require approval token`);
  }
  const ttlSeconds = params.ttlSeconds ? Math.max(60, Math.min(3600, Number(params.ttlSeconds))) : 900;
  const minted = approvalTokenService.mint({
    command: params.command,
    agentId: params.agentId,
    approver: params.approver || 'openclaw-bridge',
    reason: params.reason,
    ttlSeconds
  });
  const expiresMs = Date.parse(minted.expiresAt);
  const cacheExpiry = Number.isFinite(expiresMs) ? expiresMs : (Date.now() + ttlSeconds * 1000);
  openClawBridgeRecentApprovals.set(`${minted.command}::${minted.agentId}`, cacheExpiry);
  return minted;
}

async function dispatchAgentBusMessage(params: {
  fromAgentId: string;
  toAgentId: string;
  content: string;
  threadId?: string;
  taskId?: string;
  expectReply?: boolean;
  actorId?: string;
}) {
  const from = organization.getAgent(String(params.fromAgentId));
  const to = organization.getAgent(String(params.toAgentId));
  if (!from || !to) {
    throw new Error('Invalid fromAgentId or toAgentId');
  }
  const sent = agentBus.send({
    threadId: params.threadId ? String(params.threadId) : undefined,
    taskId: params.taskId ? String(params.taskId) : undefined,
    fromAgentId: from.id,
    toAgentId: to.id,
    content: String(params.content),
    kind: 'message'
  });
  agentBus.markStatus(sent.id, 'delivered');
  if (sent.taskId) {
    try {
      taskManager.appendOperation(sent.taskId, {
        actorId: params.actorId,
        actorType: 'user',
        type: 'note',
        summary: `Agent bus delegation: ${from.name} -> ${to.name}`,
        details: sent.content,
        status: 'recorded'
      });
    } catch {
      // Ignore task linkage failures.
    }
  }
  broadcast({ type: 'agent_bus_message', data: sent });

  let reply: AgentBusMessage | null = null;
  if (params.expectReply !== false) {
    try {
      const replyText = await to.processMessage(
        `You received a delegation from '${from.name}' in thread ${sent.threadId}.` +
        `${sent.taskId ? ` Task: ${sent.taskId}.` : ''}\nMessage:\n${sent.content}`
      );
      reply = agentBus.send({
        threadId: sent.threadId,
        taskId: sent.taskId,
        fromAgentId: to.id,
        toAgentId: from.id,
        content: replyText,
        kind: 'reply'
      });
      agentBus.markStatus(reply.id, 'processed');
      agentBus.markStatus(sent.id, 'processed');
      if (reply.taskId) {
        try {
          taskManager.appendOperation(reply.taskId, {
            actorId: to.id,
            actorType: 'agent',
            type: 'note',
            summary: `Agent bus reply: ${to.name} -> ${from.name}`,
            details: reply.content,
            status: 'recorded'
          });
        } catch {
          // Ignore task linkage failures.
        }
      }
      broadcast({ type: 'agent_bus_message', data: reply });
    } catch (error) {
      agentBus.markStatus(sent.id, 'failed', (error as Error).message);
    }
  }
  return { sent, reply };
}


interface SwarmWorkerResult {
  agentId: string;
  agentName: string;
  role: string;
  success: boolean;
  reply?: AgentBusMessage;
  error?: string;
  durationMs: number;
}

interface SwarmDispatchResult {
  runId: string;
  coordinator: { id: string; name: string; role: string };
  task: string;
  workers: SwarmWorkerResult[];
  synthesis?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

async function dispatchAgentSwarm(params: {
  task: string;
  coordinatorAgentId?: string;
  workerAgentIds?: string[];
  maxWorkers?: number;
  includeSynthesis?: boolean;
  threadId?: string;
  taskId?: string;
  actorId?: string;
}): Promise<SwarmDispatchResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const runId = crypto.randomUUID();

  const coordinator = params.coordinatorAgentId
    ? organization.getAgent(String(params.coordinatorAgentId))
    : getDirectorForBridge();
  if (!coordinator) {
    throw new Error('No coordinator agent available for swarm dispatch');
  }

  const explicitWorkers = (params.workerAgentIds || [])
    .map((id) => String(id || '').trim())
    .filter(Boolean)
    .map((id) => organization.getAgent(id))
    .filter((agent): agent is NonNullable<ReturnType<typeof organization.getAgent>> => !!agent)
    .filter((agent) => agent.id !== coordinator.id);

  const fallbackWorkers = listTargetableAgents().filter((agent) => agent.id !== coordinator.id);
  const maxWorkers = Number.isFinite(Number(params.maxWorkers))
    ? Math.max(1, Math.min(12, Math.floor(Number(params.maxWorkers))))
    : 3;
  const workers = (explicitWorkers.length > 0 ? explicitWorkers : fallbackWorkers).slice(0, maxWorkers);

  if (workers.length === 0) {
    throw new Error('No eligible worker agents available for swarm dispatch');
  }

  const workerResults: SwarmWorkerResult[] = await Promise.all(
    workers.map(async (worker) => {
      const workerStart = Date.now();
      try {
        const result = await dispatchAgentBusMessage({
          fromAgentId: coordinator.id,
          toAgentId: worker.id,
          content:
            'Swarm run ' + runId + '. You are ' + worker.name + ' (' + worker.role + '). ' +
            'Focus on your specialization and return actionable findings with risk and next steps.\n\nTask:\n' + params.task,
          threadId: params.threadId,
          taskId: params.taskId,
          expectReply: true,
          actorId: params.actorId
        });
        return {
          agentId: worker.id,
          agentName: worker.name,
          role: worker.role,
          success: !!result.reply,
          reply: result.reply || undefined,
          durationMs: Date.now() - workerStart
        };
      } catch (error) {
        return {
          agentId: worker.id,
          agentName: worker.name,
          role: worker.role,
          success: false,
          error: (error as Error).message,
          durationMs: Date.now() - workerStart
        };
      }
    })
  );

  const includeSynthesis = params.includeSynthesis !== false;
  let synthesis: string | undefined;
  if (includeSynthesis) {
    const successfulReplies = workerResults.filter((result) => result.success && result.reply?.content);
    const synthesisPrompt = [
      'Swarm synthesis run ' + runId + '.',
      'Original task: ' + params.task,
      '',
      'Worker outputs:',
      ...workerResults.map((result) => {
        if (!result.success) {
          return '- ' + result.agentName + ' (' + result.role + '): FAILED - ' + (result.error || 'unknown error');
        }
        return '- ' + result.agentName + ' (' + result.role + '): ' + String(result.reply?.content || '').trim();
      }),
      '',
      'Produce a concise plan with:',
      '1) top findings',
      '2) prioritized actions',
      '3) risks/assumptions',
      '4) owner per action'
    ].join('\n');

    if (successfulReplies.length > 0) {
      try {
        synthesis = await coordinator.processMessage(synthesisPrompt);
      } catch (error) {
        synthesis = 'Synthesis failed: ' + (error as Error).message;
      }
    } else {
      synthesis = 'No successful worker replies to synthesize.';
    }
  }

  const completedAt = new Date().toISOString();
  return {
    runId,
    coordinator: {
      id: coordinator.id,
      name: coordinator.name,
      role: coordinator.role
    },
    task: params.task,
    workers: workerResults,
    synthesis,
    startedAt,
    completedAt,
    durationMs: Date.now() - startedAtMs
  };
}

// WebSocket connection handler.
// Per-connection state we tack onto the ws instance:
//   - chatSessionId: the widget-generated id from the most recent chat:message
//     on this socket. Used to route chat:update push notifications.
//   - chatAuth: populated after a successful {type:'auth', token} handshake.
//     Carries the canonical username/role/email so per-message gating can
//     refuse writes by viewer accounts and the chat bot can greet by name.
type ChatAwareWebSocket = WebSocket & {
  chatSessionId?: string;
  chatAuth?: { username: string; role: import('../security/AuthService.js').UserRole; email?: string };
};

/** Custom close codes for the auth handshake. 4401/4403 follow the
 *  4000–4999 user-defined range; clients can branch on them to suppress
 *  the reconnect storm when the token is genuinely bad. */
const WS_CLOSE_AUTH_TIMEOUT = 4401;
const WS_CLOSE_AUTH_FAILED  = 4403;
const WS_AUTH_GRACE_MS = 5000;

wss.on('connection', (ws: WebSocket) => {
  const awsock = ws as ChatAwareWebSocket;

  // Grace timer: if the client doesn't send {type:'auth', token} within
  // 5s we close. Tracking is local — once auth succeeds we clear it and
  // forget about it.
  let authTimer: NodeJS.Timeout | null = setTimeout(() => {
    try {
      ws.send(JSON.stringify({ type: 'auth:fail', reason: 'Authentication timeout' }));
    } catch { /* socket may already be in CLOSING */ }
    ws.close(WS_CLOSE_AUTH_TIMEOUT, 'auth timeout');
  }, WS_AUTH_GRACE_MS);

  ws.on('message', async (data: Buffer) => {
    // Token-bucket gate per connection (10 msg/min). Auth handshake
    // is exempted so a legit reconnect doesn't immediately tip into
    // a rate-limit denial; every post-auth message counts against
    // the bucket. After 5 sustained rejections we force-close so an
    // abusive client doesn't keep refilling+re-firing.
    let preview: any;
    try { preview = JSON.parse(data.toString()); } catch { preview = null; }
    if (preview?.type !== 'auth') {
      const verdict = wsRateLimiter.check(ws);
      if (!verdict.allowed) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'RATE_LIMITED',
          message: `WS message rate limit (10/min). Try again in ~${Math.ceil(verdict.resetMs / 1000)}s.`,
          retryAfterMs: verdict.resetMs,
        }));
        if (verdict.rejections >= 5) {
          // Persistent abuse — drop the socket. Browser will reconnect
          // if the user is acting in good faith.
          try { ws.close(1008, 'rate limit'); } catch { /* already closing */ }
        }
        return;
      }
    }

    let message: any = preview;
    if (message === null) {
      try { message = JSON.parse(data.toString()); } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: (e as Error).message }));
        return;
      }
    }

    // Pre-auth: the only message we accept is the auth handshake. Anything
    // else (chat, get_agents, etc.) gets a polite reject and a close so a
    // stale cached widget bundle doesn't hammer the server.
    if (!awsock.chatAuth) {
      if (message.type !== 'auth') {
        ws.send(JSON.stringify({ type: 'auth:fail', reason: 'auth required as first message' }));
        ws.close(WS_CLOSE_AUTH_FAILED, 'auth required');
        return;
      }
      const token = typeof message.token === 'string' ? message.token : '';
      const v = authService.validateToken(token);
      if (!v.valid || !v.username || !v.role) {
        auditLog.log({
          action: 'auth.ws.fail',
          username: 'anonymous', role: 'unknown',
          resource: '/ws', method: 'WS', ip: '',
          success: false, detail: v.reason || 'invalid token',
        });
        ws.send(JSON.stringify({ type: 'auth:fail', reason: v.reason || 'invalid token' }));
        ws.close(WS_CLOSE_AUTH_FAILED, 'auth failed');
        return;
      }
      const view = authService.getUser(v.username);
      awsock.chatAuth = { username: v.username, role: v.role, email: view?.email };
      if (authTimer) { clearTimeout(authTimer); authTimer = null; }
      clients.add(ws);
      auditLog.log({
        action: 'auth.ws.ok',
        username: v.username, role: v.role,
        resource: '/ws', method: 'WS', ip: '',
        success: true,
      });
      ws.send(JSON.stringify({ type: 'auth:ok', username: v.username, role: v.role, ...(view?.email ? { email: view.email } : {}) }));
      // Initial state mirrors the legacy pre-auth payload, just deferred
      // until we know who we're talking to.
      ws.send(JSON.stringify({
        type: 'init',
        data: {
          config: runtimeConfig,
          agents: organization.getAgentTree(),
          tasks: taskManager.getAllTasks(),
          skills: skillManager.getAll(),
          toolPolicies: TOOL_POLICIES.map(policy => ({
            ...policy,
            launch: SANDBOX_LAUNCH_SPECS[policy.sandbox]
          }))
        }
      }));
      return;
    }

    try {
      switch (message.type) {
        case 'auth':
          // Re-auth on an already-authed socket — ignore the new token and
          // just echo back the existing identity. Cheaper than tearing down.
          ws.send(JSON.stringify({
            type: 'auth:ok',
            username: awsock.chatAuth.username,
            role: awsock.chatAuth.role,
            ...(awsock.chatAuth.email ? { email: awsock.chatAuth.email } : {}),
          }));
          break;
        case 'chat':
          await handleChat(ws, message);
          break;
        case 'chat:message':
          await handleChatBotMessage(awsock, message);
          break;
        case 'chat:action':
          await handleChatBotAction(awsock, message);
          break;
        case 'get_agents':
          handleGetAgents(ws);
          break;
        case 'get_config':
          handleGetConfig(ws);
          break;
        case 'update_config':
          await handleUpdateConfig(ws, message);
          break;
        case 'create_agent':
          await handleCreateAgent(ws, message);
          break;
        case 'delete_agent':
          await handleDeleteAgent(ws, message);
          break;
        case 'update_agent':
          await handleUpdateAgent(ws, message);
          break;
        case 'get_tasks':
          handleGetTasks(ws);
          break;
        case 'create_task':
          handleCreateTask(ws, message);
          break;
        case 'update_task':
          handleUpdateTask(ws, message);
          break;
        case 'test_connection':
          await handleTestConnection(ws, message);
          break;
        case 'get_skills':
          handleGetSkills(ws);
          break;
        case 'create_skill':
          handleCreateSkill(ws, message);
          break;
        case 'assign_skill':
          handleAssignSkill(ws, message);
          break;
        case 'execute_skill':
          await handleExecuteSkill(ws, message);
          break;
        case 'agent_bus_send':
          await handleAgentBusSend(ws, message);
          break;
        case 'get_agent_bus_threads':
          handleGetAgentBusThreads(ws, message);
          break;
        case 'get_agent_bus_messages':
          handleGetAgentBusMessages(ws, message);
          break;
        case 'get_tool_policies':
          handleGetToolPolicies(ws);
          break;
        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: (error as Error).message }));
    }
  });

  ws.on('close', () => {
    if (authTimer) { clearTimeout(authTimer); authTimer = null; }
    clients.delete(ws);
    const sid = awsock.chatSessionId;
    if (sid && chatBotService) chatBotService.forgetSession(sid);
  });
});

/** chat:message — natural-language input from the floating ChatWidget.
 *  Two emission shapes from the same handler:
 *    - DB-backed intents (list / status / report) finish with a single
 *      chat:response carrying text + optional cards + suggestions.
 *    - AI-streamed intents (general, attached-image vision) emit a series
 *      of chat:stream chunks (done=false) followed by exactly one
 *      chat:stream done=true that finalises and carries cards/suggestions.
 *  ChatBotService signals streaming by invoking the onChunk callback.
 *  We track whether any chunk arrived to pick the right finalisation
 *  shape without the handler needing to know which intent fired. */
async function handleChatBotMessage(
  ws: ChatAwareWebSocket,
  message: { sessionId?: string; text?: string; attachment?: unknown },
) {
  const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
  const text      = typeof message.text === 'string' ? message.text : '';
  const attachment = sanitizeAttachment(message.attachment);
  if (!sessionId || (!text && !attachment)) {
    ws.send(JSON.stringify({
      type: 'chat:response',
      sessionId,
      text: 'chat:message requires a sessionId plus text or an attachment',
    }));
    return;
  }
  ws.chatSessionId = sessionId;
  if (!chatBotService) {
    ws.send(JSON.stringify({
      type: 'chat:response',
      sessionId,
      text: 'Chat service is still warming up — try again in a moment.',
    }));
    return;
  }
  let streamed = false;
  const onChunk = (chunk: string) => {
    streamed = true;
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'chat:stream', sessionId, chunk, done: false }));
  };
  try {
    const reply = await chatBotService.handle(
      { sessionId, text, attachment, user: ws.chatAuth },
      { onChunk },
    );
    // Audit any incident the chat created in this turn so the audit log
    // ties the new INC-id to a known user. Resolutions / escalations are
    // audited separately by handleChatBotAction.
    if (reply.incidentId && ws.chatAuth) {
      auditLog.log({
        action: 'incidents.create',
        username: ws.chatAuth.username,
        role: ws.chatAuth.role,
        resource: `/chat/${reply.incidentId}`,
        method: 'WS',
        ip: '',
        success: true,
        detail: `via chat:message, text="${text.slice(0, 120)}"`,
      });
    }
    if (streamed) {
      ws.send(JSON.stringify({
        type: 'chat:stream',
        sessionId,
        chunk: '',
        done: true,
        ...(reply.incidentId ? { incidentId: reply.incidentId } : {}),
        ...(reply.cards ? { cards: reply.cards } : {}),
        ...(reply.suggestions ? { suggestions: reply.suggestions } : {}),
      }));
      return;
    }
    ws.send(JSON.stringify({
      type: 'chat:response',
      sessionId,
      text: reply.text,
      ...(reply.incidentId ? { incidentId: reply.incidentId } : {}),
      ...(reply.cards ? { cards: reply.cards } : {}),
      ...(reply.suggestions ? { suggestions: reply.suggestions } : {}),
    }));
  } catch (e) {
    logger.error('[chat] handler threw', {
      sessionId,
      err: e instanceof Error ? e.message : String(e),
    });
    // If we were mid-stream when the error hit, send a stream-done with the
    // apology so the widget can finalise the in-progress bubble instead of
    // leaving the typing indicator spinning.
    if (streamed) {
      ws.send(JSON.stringify({
        type: 'chat:stream', sessionId, chunk: '\n\n(stream interrupted)', done: true,
      }));
    } else {
      ws.send(JSON.stringify({
        type: 'chat:response',
        sessionId,
        text: 'Sorry — something went wrong handling that. Try again, or check the incidents page directly.',
      }));
    }
  }
}

/** chat:action — operator clicked an action button (Escalate/Resolve) on
 *  an incident card. Always finishes with a single chat:response. */
async function handleChatBotAction(
  ws: ChatAwareWebSocket,
  message: { sessionId?: string; action?: unknown; targetId?: unknown; reason?: unknown },
) {
  const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
  const action    = message.action === 'escalate' || message.action === 'resolve' ? message.action : null;
  const targetId  = typeof message.targetId === 'string' ? message.targetId : '';
  const reason    = typeof message.reason === 'string' ? message.reason : undefined;
  if (!sessionId || !action || !targetId) {
    ws.send(JSON.stringify({
      type: 'chat:response',
      sessionId,
      text: 'chat:action requires sessionId, action (escalate|resolve), and targetId',
    }));
    return;
  }
  ws.chatSessionId = sessionId;
  if (!chatBotService) {
    ws.send(JSON.stringify({
      type: 'chat:response',
      sessionId,
      text: 'Chat service is still warming up — try again in a moment.',
    }));
    return;
  }
  // Role gate at the WS-handler layer too. ChatBotService.handleAction()
  // also refuses viewer actions, but doing it here lets us audit the
  // denial against a real path before the service even gets called.
  if (ws.chatAuth?.role === 'viewer') {
    auditLog.log({
      action: `chat.action.${action}.denied`,
      username: ws.chatAuth.username,
      role: ws.chatAuth.role,
      resource: `/chat/${targetId}`,
      method: 'WS',
      ip: '',
      success: false,
      detail: 'viewer role cannot escalate or resolve',
    });
    ws.send(JSON.stringify({
      type: 'chat:response',
      sessionId,
      text: 'אין לך הרשאה לפעולה הזו (action=' + action + ', role=viewer). נסה לפנות למשתמש עם תפקיד operator או admin.',
      suggestions: ['קריאות פתוחות', 'סטטוס שרתים'],
    }));
    return;
  }
  try {
    const reply = await chatBotService.handleAction({ sessionId, action, targetId, reason, user: ws.chatAuth });
    if (ws.chatAuth && reply.incidentId) {
      auditLog.log({
        action: `chat.action.${action}`,
        username: ws.chatAuth.username,
        role: ws.chatAuth.role,
        resource: `/chat/${reply.incidentId}`,
        method: 'WS',
        ip: '',
        success: true,
        ...(reason ? { detail: `reason="${reason.slice(0, 200)}"` } : {}),
      });
    }
    ws.send(JSON.stringify({
      type: 'chat:response',
      sessionId,
      text: reply.text,
      ...(reply.incidentId ? { incidentId: reply.incidentId } : {}),
      ...(reply.cards ? { cards: reply.cards } : {}),
      ...(reply.suggestions ? { suggestions: reply.suggestions } : {}),
    }));
  } catch (e) {
    logger.error('[chat] action handler threw', {
      sessionId, action, targetId,
      err: e instanceof Error ? e.message : String(e),
    });
    if (ws.chatAuth) {
      auditLog.log({
        action: `chat.action.${action}.error`,
        username: ws.chatAuth.username,
        role: ws.chatAuth.role,
        resource: `/chat/${targetId}`,
        method: 'WS',
        ip: '',
        success: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    ws.send(JSON.stringify({
      type: 'chat:response',
      sessionId,
      text: `Action ${action} on ${targetId} failed: ${e instanceof Error ? e.message : 'unknown error'}`,
    }));
  }
}

/** Defensively extract an attachment from the wire payload. Returns
 *  undefined unless the shape matches { name, type, data } strings.
 *  Caps total size — a runaway client could otherwise blow the WS frame
 *  budget. 6MB base64 ≈ 4.5MB binary, plenty for a screenshot. */
function sanitizeAttachment(raw: unknown): { name: string; type: string; data: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const a = raw as { name?: unknown; type?: unknown; data?: unknown };
  if (typeof a.name !== 'string' || typeof a.type !== 'string' || typeof a.data !== 'string') return undefined;
  if (a.data.length > 6 * 1024 * 1024) return undefined;
  return { name: a.name.slice(0, 200), type: a.type.slice(0, 80), data: a.data };
}

async function handleChat(ws: WebSocket, message: { agentId: string; text: string }) {
  const agent = organization.getAgent(message.agentId) ||
                organization.getAllAgents().find(a => a.name === message.agentId);

  if (!agent) {
    ws.send(JSON.stringify({ type: 'error', message: 'Agent not found' }));
    return;
  }

  // Send user message to all clients
  broadcast({
    type: 'message',
    data: {
      role: 'user',
      agentId: agent.id,
      agentName: agent.name,
      content: message.text,
      timestamp: new Date().toISOString()
    }
  });
  chatHistoryStore.append(agent.id, 'user', message.text);

  const summary = message.text.length > 72 ? `${message.text.slice(0, 72)}...` : message.text;
  const task = taskManager.createTask({
    title: `Handle chat request: ${summary}`,
    description: `Agent ${agent.name} is processing a chat request from the user.`,
    ownerId: agent.id,
    assignedTo: agent.id,
    category: 'general',
    priority: 'medium',
    tags: ['chat']
  });
  broadcast({ type: 'task_created', data: task });
  broadcast({
    type: 'task_ref',
    data: {
      taskId: task.id,
      title: task.title,
      status: task.status,
      agentId: agent.id
    }
  });
  const inProgress = taskManager.updateTaskStatus(task.id, 'in_progress');
  broadcast({ type: 'task_updated', data: inProgress });

  // Execute supported control commands directly instead of relying on model claims.
  const executed = await tryExecuteAgentCommand(message.text, agent);
  if (executed) {
    taskManager.setTaskResult(task.id, executed);
    const completed = taskManager.updateTaskStatus(task.id, 'completed');
    broadcast({ type: 'task_updated', data: completed });
    broadcast({
      type: 'message_complete',
      data: {
        agentId: agent.id,
        agentName: agent.name,
        content: executed,
        timestamp: new Date().toISOString()
      }
    });
    chatHistoryStore.append(agent.id, 'assistant', executed);
    broadcast({
      type: 'agents',
      data: organization.getAgentTree()
    });
    broadcast({
      type: 'tasks',
      data: taskManager.getAllTasks()
    });
    return;
  }

  // Optionally prepend system context for operational queries
  const OPERATIONAL_KEYWORDS = ['incident', 'alert', 'agent', 'task', 'server', 'status', 'health', 'check', 'run', 'fix', 'deploy'];
  const lowerText = message.text.toLowerCase();
  const isOperational = OPERATIONAL_KEYWORDS.some(kw => lowerText.includes(kw));
  let enrichedText = message.text;
  if (isOperational) {
    try {
      const ctx = buildSystemContext();
      const ts = new Date(ctx.generatedAt).toLocaleTimeString();
      enrichedText =
        `[System Context @ ${ts}]\n` +
        `Open Incidents: ${ctx.incidents.open} (${ctx.incidents.critical} critical, ${ctx.incidents.high} high)\n` +
        `Active Agents: ${ctx.agents.active}/${ctx.agents.total}\n` +
        `Pending Tasks: ${ctx.tasks.pending} | Active: ${ctx.tasks.active}\n` +
        `Active Alerts: ${ctx.alerts.active}\n` +
        `Server Health: ${ctx.servers.healthy}/${ctx.servers.total} healthy\n\n` +
        message.text;
    } catch { /* non-fatal — proceed without context */ }
  }

  // Stream response
  try {
    let response = '';
    await agent.streamMessage(
      enrichedText,
      (chunk: string) => {
        response += chunk;
        broadcast({
          type: 'message_chunk',
          data: {
            agentId: agent.id,
            agentName: agent.name,
            content: chunk,
            timestamp: new Date().toISOString()
          }
        });
      }
    );

    broadcast({
      type: 'message_complete',
      data: {
        agentId: agent.id,
        agentName: agent.name,
        content: response,
        timestamp: new Date().toISOString()
      }
    });
    chatHistoryStore.append(agent.id, 'assistant', response);
    taskManager.setTaskResult(task.id, response);
    const completed = taskManager.updateTaskStatus(task.id, 'completed');
    broadcast({ type: 'task_updated', data: completed });
  } catch (error) {
    try {
      // Fallback to non-streaming path; Agent.processMessage has demo-mode fallback
      const response = await agent.processMessage(enrichedText);
      taskManager.setTaskResult(task.id, response);
      const completed = taskManager.updateTaskStatus(task.id, 'completed');
      broadcast({ type: 'task_updated', data: completed });
      broadcast({
        type: 'message_complete',
        data: {
          agentId: agent.id,
          agentName: agent.name,
          content: response,
          timestamp: new Date().toISOString()
        }
      });
      chatHistoryStore.append(agent.id, 'assistant', response);
    } catch (fallbackError) {
      taskManager.setTaskError(task.id, (fallbackError as Error).message);
      const failed = taskManager.getTask(task.id);
      if (failed) {
        broadcast({ type: 'task_updated', data: failed });
      }
      broadcast({
        type: 'error',
        message: `Error: ${(fallbackError as Error).message}`
      });
    }
  }
}

async function tryExecuteAgentCommand(text: string, requester: { id: string; name: string }): Promise<string | null> {
  const normalized = text.trim();
  const lower = normalized.toLowerCase();

  const match = normalized.match(
    /create[\s\S]*?(sysadmin|specialist|director)[\s\S]*?named\s+([a-zA-Z0-9 _-]+?)(?:\s+with\s+specialty\s+([a-zA-Z0-9 _-]+))?(?:[.!?]|$)/i
  );

  let role = '';
  let name = '';
  let specialty = 'general';
  const platform = (runtimeConfig.defaultPlatform || 'claude') as AIPlatform;

  if (match) {
    role = match[1].toLowerCase();
    name = match[2].trim();
    specialty = (match[3] || 'general').trim().toLowerCase();
  } else if (lower.includes('create') && lower.includes('agent')) {
    role = lower.includes('specialist') ? 'specialist' : lower.includes('director') ? 'director' : 'sysadmin';
    const suffix = Date.now().toString().slice(-4);
    name = role === 'specialist' ? `Specialist-${suffix}` : role === 'director' ? 'IT Director' : `SysAdmin-${suffix}`;
  }

  if (!role) return null;
  if (!name) return 'I could not create the agent because no name was provided.';

  const createdAgentNames: string[] = [];

  if (role === 'director') {
    await organization.createDirector(platform);
    createdAgentNames.push(name);
  } else if (role === 'sysadmin') {
    await organization.createSysAdmin(name, platform);
    createdAgentNames.push(name);
  } else {
    await organization.createSpecialist(name, specialty, platform);
    createdAgentNames.push(name);
  }

  // Auto-create visible subtasks for execution tracking
  const createdAssignee =
    organization.getAllAgents().find(a => a.name === name) ||
    organization.getAllAgents().find(a => a.name === createdAgentNames[0]);

  const onboardingTask = taskManager.createTask({
    title: `Onboard agent: ${name}`,
    description: `Initialize responsibilities, access scope, and workflow for ${name}.`,
    ownerId: requester.id,
    assignedTo: createdAssignee?.id,
    category: 'general',
    priority: 'medium',
    tags: ['agent', 'onboarding']
  });
  taskManager.updateTaskStatus(onboardingTask.id, 'in_progress');

  const firstWorkTask = taskManager.createTask({
    title: `Assign first work package to ${name}`,
    description: `Define and assign initial operating task(s) to ${name}.`,
    ownerId: requester.id,
    assignedTo: createdAssignee?.id,
    category: 'general',
    priority: 'medium',
    tags: ['agent', 'execution']
  });
  taskManager.updateTaskStatus(firstWorkTask.id, 'pending');

  // If user asked to start a session/team workflow, create coordination subtasks too.
  if (lower.includes('session') || lower.includes('workflow') || lower.includes('subtask')) {
    const sessionTasks = [
      'Assess current environment baseline',
      'Identify top 3 operational risks',
      'Draft remediation/action plan'
    ];
    for (const title of sessionTasks) {
      taskManager.createTask({
        title,
        description: `Generated from chat session request by ${requester.name}.`,
        ownerId: requester.id,
        assignedTo: createdAssignee?.id,
        category: 'general',
        priority: 'medium',
        tags: ['session', 'subtask']
      });
    }
  }

  if (role === 'director') return `Executed: created Director agent "${name}" on ${platform}, plus onboarding tasks.`;
  if (role === 'sysadmin') return `Executed: created SysAdmin agent "${name}" on ${platform}, plus onboarding tasks.`;
  return `Executed: created Specialist agent "${name}" (specialty: ${specialty}) on ${platform}, plus onboarding tasks.`;
}

function handleGetAgents(ws: WebSocket) {
  ws.send(JSON.stringify({
    type: 'agents',
    data: organization.getAgentTree()
  }));
}

function handleGetConfig(ws: WebSocket) {
  ws.send(JSON.stringify({
    type: 'config',
    data: {
      ...runtimeConfig,
      anthropicKey: runtimeConfig.anthropicKey ? '••••••••' : '',
      openaiKey: runtimeConfig.openaiKey ? '••••••••' : ''
    }
  }));
}

async function handleUpdateConfig(ws: WebSocket, message: any) {
  try {
    runtimeConfig = {
      ...runtimeConfig,
      ...message.config,
      // Keep existing keys only when masked or omitted; allow explicit clear ("")
      anthropicKey: message.config.anthropicKey === '••••••••' || message.config.anthropicKey === undefined
        ? runtimeConfig.anthropicKey
        : message.config.anthropicKey,
      openaiKey: message.config.openaiKey === '••••••••' || message.config.openaiKey === undefined
        ? runtimeConfig.openaiKey
        : message.config.openaiKey
    };

    // Reinitialize AI factory with new config
    const newAiFactory = new AIProviderFactory({
      anthropicApiKey: runtimeConfig.anthropicKey,
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
      anthropicModel:   process.env.ANTHROPIC_MODEL,
      openaiApiKey: process.env.OPENAI_API_KEY || runtimeConfig.openaiKey,
      openaiBaseUrl: process.env.OPENAI_BASE_URL || runtimeConfig.openaiBaseUrl,
      openaiModel: process.env.OPENAI_MODEL || runtimeConfig.openaiModel,
      ...openAIRouteSettings(),
      ollamaBaseUrl: runtimeConfig.ollamaUrl
    }, { preferredPlatform: (runtimeConfig.defaultPlatform || 'openai') as AIPlatform });

    // Update organization and all existing agents to use new AI config
    organization.setAIFactory(newAiFactory);
    persistConfig();

    broadcast({
      type: 'config_updated',
      data: {
        ...runtimeConfig,
        anthropicKey: runtimeConfig.anthropicKey ? '••••••••' : '',
        openaiKey: runtimeConfig.openaiKey ? '••••••••' : ''
      }
    });
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', message: (error as Error).message }));
  }
}

async function handleCreateAgent(ws: WebSocket, message: any) {
  try {
    const { name, role, platform, specialty, reportsTo } = message.agent;
    let agent;

    if (role === 'director') {
      agent = await organization.createDirector(platform);
    } else if (role === 'sysadmin') {
      agent = await organization.createSysAdmin(name, platform);
    } else if (role === 'specialist') {
      agent = await organization.createSpecialist(name, specialty || 'general', platform);
    }

    broadcast({
      type: 'agent_created',
      data: agent?.toJSON()
    });
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', message: (error as Error).message }));
  }
}

async function handleDeleteAgent(ws: WebSocket, message: { agentId: string }) {
  try {
    // Implementation for deleting agents
    broadcast({
      type: 'agent_deleted',
      data: { agentId: message.agentId }
    });
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', message: (error as Error).message }));
  }
}

function handleUpdateAgent(ws: WebSocket, message: { agentId: string; data: any }) {
  try {
    const agent = organization.getAgent(message.agentId);
    if (!agent) {
      ws.send(JSON.stringify({ type: 'error', message: 'Agent not found' }));
      return;
    }

    // Update agent properties
    if (message.data.skills) {
      message.data.skills.forEach((skill: string) => agent.assignSkill(skill));
    }

    broadcast({
      type: 'agent_updated',
      data: {
        agentId: message.agentId,
        agent: agent.toJSON()
      }
    });
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', message: (error as Error).message }));
  }
}

function handleGetTasks(ws: WebSocket) {
  ws.send(JSON.stringify({
    type: 'tasks',
    data: taskManager.getAllTasks()
  }));
}

function handleCreateTask(ws: WebSocket, message: {
  title: string;
  description: string;
  ownerId: string;
  category: string;
  priority: string;
  assignedTo?: string;
}) {
  const task = taskManager.createTask({
    ...message,
    category: message.category as any,
    priority: message.priority as any
  });

  broadcast({
    type: 'task_created',
    data: task
  });
}

function handleUpdateTask(ws: WebSocket, message: {
  taskId: string;
  status?: string;
  action?: 'cancel' | 'drop' | 'request_rollback' | 'apply_rollback';
  reason?: string;
  checkpointId?: string;
  actorId?: string;
}) {
  let task;
  if (message.action === 'cancel') {
    task = taskManager.cancelTask(message.taskId, message.reason || 'Cancelled by user', message.actorId);
  } else if (message.action === 'drop') {
    task = taskManager.dropTask(message.taskId, message.reason || 'Dropped by user', message.actorId);
  } else if (message.action === 'request_rollback') {
    task = taskManager.requestRollback(message.taskId, message.reason || 'Rollback requested', message.actorId);
  } else if (message.action === 'apply_rollback') {
    task = taskManager.applyRollback(message.taskId, {
      checkpointId: message.checkpointId,
      note: message.reason,
      actorId: message.actorId
    });
  } else {
    task = taskManager.updateTaskStatus(message.taskId, (message.status || 'pending') as any);
  }

  broadcast({
    type: 'task_updated',
    data: task
  });
}

async function handleTestConnection(ws: WebSocket, message: { platform: string; key?: string; url?: string }) {
  try {
    let result = { success: false, message: '' };

    if (message.platform === 'claude' && message.key) {
      const testFactory = new AIProviderFactory({ anthropicApiKey: message.key });
      const provider = await testFactory.getProvider('claude');
      await provider.initialize();
      result = { success: true, message: 'Claude API connection successful!' };
    } else if (message.platform === 'openai' && message.key) {
      const testFactory = new AIProviderFactory({ openaiApiKey: message.key });
      const provider = await testFactory.getProvider('openai');
      await provider.initialize();
      result = { success: true, message: 'OpenAI API connection successful!' };
    } else if (message.platform === 'ollama' && message.url) {
      const response = await fetch(`${message.url}/api/tags`);
      if (response.ok) {
        result = { success: true, message: 'Ollama connection successful!' };
      } else {
        result = { success: false, message: 'Ollama connection failed' };
      }
    }

    ws.send(JSON.stringify({
      type: 'connection_test',
      data: result
    }));
  } catch (error) {
    ws.send(JSON.stringify({
      type: 'connection_test',
      data: { success: false, message: (error as Error).message }
    }));
  }
}

function handleGetSkills(ws: WebSocket) {
  ws.send(JSON.stringify({
    type: 'skills',
    data: skillManager.getAll()
  }));
}

function handleCreateSkill(ws: WebSocket, message: any) {
  try {
    const skill = message.skill;
    const newSkill = {
      id: skill.id || 'custom-' + Date.now(),
      name: skill.name,
      description: skill.description,
      category: skill.category || 'general',
      commands: skill.commands || [],
      enabled: true
    };

    skillManager.register(newSkill);

    broadcast({
      type: 'skill_created',
      data: newSkill
    });
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', message: (error as Error).message }));
  }
}

function handleAssignSkill(ws: WebSocket, message: { agentId: string; skillId: string }) {
  try {
    const agent = organization.getAgent(message.agentId);
    if (!agent) {
      ws.send(JSON.stringify({ type: 'error', message: 'Agent not found' }));
      return;
    }

    agent.assignSkill(message.skillId);

    broadcast({
      type: 'agent_updated',
      data: { agentId: message.agentId, skillId: message.skillId }
    });
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', message: (error as Error).message }));
  }
}

function parseCredentialIds(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map(v => String(v).trim()).filter(Boolean);
  }
  return String(raw)
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function extractExecutionTargets(params: Record<string, unknown>): string[] {
  const keys = ['target', 'targets', 'host', 'hosts', 'name', 'containerId', 'container', 'namespace', 'service'];
  const values: string[] = [];
  keys.forEach(key => {
    const value = params[key];
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach(item => values.push(String(item).trim().toLowerCase()));
      return;
    }
    values.push(String(value).trim().toLowerCase());
  });
  return values.filter(Boolean);
}

function isTargetAllowlisted(target: string, allowlistTargets: string[]): boolean {
  if (allowlistTargets.length === 0) return false;
  return allowlistTargets.some(allowed =>
    target === allowed
    || target.startsWith(`${allowed}.`)
    || target.includes(allowed)
  );
}

function buildRollbackPlan(command: string, params: Record<string, unknown>): string {
  switch (command) {
    case 'deploy.start':
      return 'Run deploy.rollback for the resulting deployment id and verify service health checks.';
    case 'docker.deploy':
      return `Stop/remove deployed container and restore previous stable container/image. Params: ${JSON.stringify(params)}`;
    case 'k8s.deploy':
      return `kubectl rollout undo on affected deployment or apply previous manifest version. Params: ${JSON.stringify(params)}`;
    case 'docker.exec':
      return 'Revert in-container changes from backups/snapshots and restart container if needed.';
    case 'security.sudo':
      return 'Revert privileged change using last known-good config and verify system access controls.';
    default:
      return `Document manual rollback steps for command ${command}.`;
  }
}

function buildRollbackManifest(command: string, params: Record<string, unknown>): { rollbackPlan: string; rollbackSteps: string[]; target: string } {
  const rollbackPlan = buildRollbackPlan(command, params);
  const target = params.name
    ? String(params.name)
    : (params.containerId ? String(params.containerId) : command);
  const rollbackSteps = [
    `Identify target: ${target}`,
    `Apply rollback plan: ${rollbackPlan}`,
    'Validate service health checks and logs',
    'Record rollback outcome in task operations journal'
  ];
  return {
    rollbackPlan,
    rollbackSteps,
    target
  };
}

function buildRollbackImpactClasses(command: string): Array<'infrastructure' | 'deployment' | 'security' | 'data' | 'communication' | 'task_state' | 'unknown'> {
  const normalized = command.toLowerCase();
  if (normalized.includes('deploy')) return ['deployment', 'infrastructure'];
  if (normalized.startsWith('docker.') || normalized.startsWith('k8s.') || normalized.startsWith('server.')) return ['infrastructure'];
  if (normalized.startsWith('security.') || normalized.includes('auth') || normalized.includes('credential')) return ['security'];
  return ['task_state', 'unknown'];
}

async function handleAgentBusSend(
  ws: WebSocket,
  message: {
    fromAgentId: string;
    toAgentId: string;
    content: string;
    taskId?: string;
    threadId?: string;
    expectReply?: boolean;
    operatorToken?: string;
  }
) {
  const auth = validateAuthToken(message.operatorToken, 'agent_bus.write');
  if (!auth.ok) {
    ws.send(JSON.stringify({ type: 'error', message: auth.reason || 'Unauthorized' }));
    return;
  }
  const from = organization.getAgent(message.fromAgentId);
  const to = organization.getAgent(message.toAgentId);
  if (!from || !to) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid from/to agent ids for bus message' }));
    return;
  }
  if (!message.content || !message.content.trim()) {
    ws.send(JSON.stringify({ type: 'error', message: 'Message content is required' }));
    return;
  }

  const sent = agentBus.send({
    threadId: message.threadId,
    taskId: message.taskId,
    fromAgentId: from.id,
    toAgentId: to.id,
    content: message.content.trim(),
    kind: 'message'
  });
  agentBus.markStatus(sent.id, 'delivered');
  if (sent.taskId) {
    try {
      taskManager.appendOperation(sent.taskId, {
        actorId: auth.username,
        actorType: 'user',
        type: 'note',
        summary: `Agent bus delegation: ${from.name} -> ${to.name}`,
        details: sent.content,
        status: 'recorded'
      });
    } catch {
      // Ignore missing task links.
    }
  }
  broadcast({ type: 'agent_bus_message', data: sent });

  const expectReply = message.expectReply !== false;
  if (!expectReply) {
    return;
  }

  try {
    const replyPrompt =
      `You received a delegation from agent '${from.name}' in thread ${sent.threadId}.` +
      `${sent.taskId ? ` Linked task: ${sent.taskId}.` : ''}\n` +
      `Message:\n${sent.content}\n\n` +
      `Respond with a concise execution update and next step.`;
    const replyText = await to.processMessage(replyPrompt);
    const reply = agentBus.send({
      threadId: sent.threadId,
      taskId: sent.taskId,
      fromAgentId: to.id,
      toAgentId: from.id,
      content: replyText,
      kind: 'reply'
    });
    agentBus.markStatus(reply.id, 'processed');
    agentBus.markStatus(sent.id, 'processed');
    if (reply.taskId) {
      try {
        taskManager.appendOperation(reply.taskId, {
          actorId: to.id,
          actorType: 'agent',
          type: 'note',
          summary: `Agent bus reply: ${to.name} -> ${from.name}`,
          details: reply.content,
          status: 'recorded'
        });
      } catch {
        // Ignore missing task links.
      }
    }
    broadcast({ type: 'agent_bus_message', data: reply });
  } catch (error) {
    agentBus.markStatus(sent.id, 'failed', (error as Error).message);
    const fail = agentBus.send({
      threadId: sent.threadId,
      taskId: sent.taskId,
      fromAgentId: to.id,
      toAgentId: from.id,
      content: `Auto-reply failed: ${(error as Error).message}`,
      kind: 'system'
    });
    agentBus.markStatus(fail.id, 'failed', (error as Error).message);
    broadcast({ type: 'agent_bus_message', data: fail });
  }
}

function handleGetAgentBusThreads(ws: WebSocket, message: { agentId?: string; limit?: number; operatorToken?: string }) {
  const auth = validateAuthToken(message.operatorToken, 'agent_bus.read');
  if (!auth.ok) {
    ws.send(JSON.stringify({ type: 'error', message: auth.reason || 'Unauthorized' }));
    return;
  }
  const threads = agentBus.listThreads({ agentId: message.agentId, limit: message.limit || 100 });
  ws.send(JSON.stringify({ type: 'agent_bus_threads', data: threads }));
}

function handleGetAgentBusMessages(
  ws: WebSocket,
  message: { threadId?: string; taskId?: string; agentId?: string; limit?: number; operatorToken?: string }
) {
  const auth = validateAuthToken(message.operatorToken, 'agent_bus.read');
  if (!auth.ok) {
    ws.send(JSON.stringify({ type: 'error', message: auth.reason || 'Unauthorized' }));
    return;
  }
  const messages = agentBus.listMessages({
    threadId: message.threadId,
    taskId: message.taskId,
    agentId: message.agentId,
    limit: message.limit || 200
  });
  ws.send(JSON.stringify({ type: 'agent_bus_messages', data: messages }));
}

async function handleExecuteSkill(ws: WebSocket, message: { skillId: string; command: string; params?: any }) {
  const startedAt = Date.now();
  try {
    const policyForPermission = getToolPolicy(message.command);
    const executionPermission: Permission =
      policyForPermission && policyForPermission.risk !== 'safe'
        ? 'tools.execute.privileged'
        : 'tools.execute.safe';
    const operatorAuth = validateAuthToken(message.params?.operatorToken, executionPermission);
    if (!operatorAuth.ok) {
      ws.send(JSON.stringify({
        type: 'skill_result',
        data: {
          skillId: message.skillId,
          command: message.command,
          result: `Blocked by auth policy: ${operatorAuth.reason || 'Unauthorized operator session'}`
        }
      }));
      return;
    }
    const director = organization.getDirector();
    if (!director) {
      ws.send(JSON.stringify({ type: 'error', message: 'No director agent available' }));
      return;
    }
    const invokingAgent = message.params?.agentId
      ? organization.getAgent(message.params.agentId)
      : director;
    const agentRole = invokingAgent?.role || 'director';
    const invokerId = invokingAgent?.id || director.id;
    const policy = getToolPolicy(message.command);
    const providedCredentialIds = parseCredentialIds(message.params?.credentialIds);
    const providedCredentialMetas = credentialVault.listByIdsForAgent(invokerId, providedCredentialIds);
    const providedScopes = providedCredentialMetas.map(c => c.scope);
    const linkedTaskId = message.params?.taskId ? String(message.params.taskId) : undefined;
    let approvalTokenId: string | undefined;
    let approved = false;

    if (policy?.requiresApproval) {
      const approval = approvalTokenService.validate({
        token: message.params?.approvalToken,
        command: message.command,
        agentId: invokerId
      });
      if (!approval.valid) {
        executionAuditStore.append({
          id: cryptoRandomId(),
          timestamp: new Date().toISOString(),
          taskId: linkedTaskId,
          command: message.command,
          skillId: message.skillId,
          agentId: invokerId,
          agentRole: agentRole,
          status: 'blocked',
          reason: approval.reason,
          risk: policy.risk,
          sandbox: policy.sandbox,
          runner: getToolLaunchSpec(message.command)?.runner,
          approvalRequired: true,
          credentialIds: providedCredentialMetas.map(c => c.id),
          credentialScopes: providedScopes,
          credentialDecision: 'not_checked',
          durationMs: Date.now() - startedAt
        });
        ws.send(JSON.stringify({
          type: 'skill_result',
          data: {
            skillId: message.skillId,
            command: message.command,
            result: `Blocked by policy: ${approval.reason}\nRisk: ${policy.risk}\nSandbox: ${policy.sandbox}\nApproval Required: yes\nHint: mint an approval token from the dashboard or POST /api/approvals/tokens`
          }
        }));
        return;
      }
      approved = true;
      approvalTokenId = approval.payload?.tokenId;
      if (approvalTokenId) {
        const tokenState = approvalTokenLedger.getStatus(approvalTokenId);
        if (tokenState.revoked) {
          executionAuditStore.append({
            id: cryptoRandomId(),
            timestamp: new Date().toISOString(),
            taskId: linkedTaskId,
            command: message.command,
            skillId: message.skillId,
            agentId: invokerId,
            agentRole: agentRole,
            status: 'blocked',
            reason: 'Approval token revoked',
            risk: policy.risk,
            sandbox: policy.sandbox,
            runner: getToolLaunchSpec(message.command)?.runner,
            approvalTokenId,
            approvalRequired: true,
            credentialIds: providedCredentialMetas.map(c => c.id),
            credentialScopes: providedScopes,
            credentialDecision: 'not_checked',
            durationMs: Date.now() - startedAt
          });
          ws.send(JSON.stringify({
            type: 'skill_result',
            data: {
              skillId: message.skillId,
              command: message.command,
              result: `Blocked by policy: Approval token revoked\nRisk: ${policy.risk}\nSandbox: ${policy.sandbox}\nApproval Required: yes`
            }
          }));
          return;
        }
        if (tokenState.used) {
          executionAuditStore.append({
            id: cryptoRandomId(),
            timestamp: new Date().toISOString(),
            taskId: linkedTaskId,
            command: message.command,
            skillId: message.skillId,
            agentId: invokerId,
            agentRole: agentRole,
            status: 'blocked',
            reason: 'Approval token already used (one-time token)',
            risk: policy.risk,
            sandbox: policy.sandbox,
            runner: getToolLaunchSpec(message.command)?.runner,
            approvalTokenId,
            approvalRequired: true,
            credentialIds: providedCredentialMetas.map(c => c.id),
            credentialScopes: providedScopes,
            credentialDecision: 'not_checked',
            durationMs: Date.now() - startedAt
          });
          ws.send(JSON.stringify({
            type: 'skill_result',
            data: {
              skillId: message.skillId,
              command: message.command,
              result: `Blocked by policy: Approval token already used (one-time token)\nRisk: ${policy.risk}\nSandbox: ${policy.sandbox}\nApproval Required: yes`
            }
          }));
          return;
        }
      }
    } else if (!!message.params?.approved) {
      // Backward compatibility for commands that do not require signed approvals.
      approved = true;
    }

    const guard = evaluateToolExecution({
      command: message.command,
      agentRole: agentRole as any,
      approved: approved,
      providedCredentialScopes: providedScopes
    });

    if (!guard.allowed) {
      if (linkedTaskId) {
        try {
          taskManager.appendOperation(linkedTaskId, {
            actorId: invokerId,
            actorType: 'agent',
            type: 'execution',
            summary: `Execution blocked for ${message.command}`,
            details: guard.reason,
            status: 'failed'
          });
        } catch {
          // Ignore missing linked task.
        }
      }
      executionAuditStore.append({
        id: cryptoRandomId(),
        timestamp: new Date().toISOString(),
        taskId: linkedTaskId,
        command: message.command,
        skillId: message.skillId,
        agentId: invokerId,
        agentRole: agentRole,
        status: 'blocked',
        reason: guard.reason,
        risk: guard.risk,
        sandbox: guard.sandbox,
        runner: guard.launchRunner,
        approvalTokenId,
        approvalRequired: !!guard.requiresApproval,
        credentialIds: providedCredentialMetas.map(c => c.id),
        credentialScopes: providedScopes,
        credentialDecision: 'not_checked',
        durationMs: Date.now() - startedAt
      });
      if (guard.outcome === 'approval_required') {
        const approvalId = approvalTokenId || cryptoRandomId();
        const approvalSummary = `Agent ${agentRole} requested to run ${message.command} (${guard.risk}). Reason: ${guard.reason}`;
        broadcast({
          type: 'approval_required',
          data: {
            id: approvalId,
            action: message.command,
            summary: approvalSummary,
            description: guard.reason
          }
        });
        getTelegram().sendApprovalRequest(message.command, approvalSummary, approvalId).catch(e =>
          logger.warn('[Telegram] approval notification failed', {
            err: e instanceof Error ? e.message : String(e)
          })
        );
      }
      ws.send(JSON.stringify({
        type: 'skill_result',
        data: {
          skillId: message.skillId,
          command: message.command,
          result: `Blocked by policy: ${guard.reason}\nRisk: ${guard.risk || 'unknown'}\nSandbox: ${guard.sandbox || 'n/a'}\nRunner: ${guard.launchRunner || 'n/a'}\nApproval Required: ${guard.requiresApproval ? 'yes' : 'no'}\nRequired Scopes: ${(guard.requiredCredentialScopes || []).join(', ') || 'none'}\nMissing Scopes: ${(guard.missingCredentialScopes || []).join(', ') || 'none'}`
        }
      }));
      return;
    }

    const credentialEnvironment = (message.params?.environment as string | undefined) || 'default';
    const credentialSystem = (message.params?.system as string | undefined) || 'default';
    if (!invokerId) {
      ws.send(JSON.stringify({
        type: 'skill_result',
        data: {
          skillId: message.skillId,
          command: message.command,
          result: 'Agent identity required'
        }
      }));
      return;
    }
    let credResolution: { allowed: boolean; reason?: string; matchedEntryIds?: string[] };
    try {
      credResolution = credentialExecutionResolver.resolve({
        agentId: invokerId,
        environment: credentialEnvironment,
        system: credentialSystem,
        requiredScopes: guard.requiredCredentialScopes || [],
        providedCredentialScopes: providedScopes
      });
    } catch (credError) {
      executionAuditStore.append({
        id: cryptoRandomId(),
        timestamp: new Date().toISOString(),
        taskId: linkedTaskId,
        command: message.command,
        skillId: message.skillId,
        agentId: invokerId,
        agentRole: agentRole,
        status: 'error',
        reason: 'Credential policy check unavailable',
        risk: guard.risk,
        sandbox: guard.sandbox,
        runner: guard.launchRunner,
        approvalTokenId,
        approvalRequired: !!guard.requiresApproval,
        credentialIds: providedCredentialMetas.map(c => c.id),
        credentialScopes: providedScopes,
        credentialDecision: 'error',
        credentialEnvironment,
        credentialSystem,
        durationMs: Date.now() - startedAt
      });
      ws.send(JSON.stringify({
        type: 'skill_result',
        data: {
          skillId: message.skillId,
          command: message.command,
          result: 'Credential policy check unavailable'
        }
      }));
      return;
    }
    if (!credResolution.allowed) {
      executionAuditStore.append({
        id: cryptoRandomId(),
        timestamp: new Date().toISOString(),
        taskId: linkedTaskId,
        command: message.command,
        skillId: message.skillId,
        agentId: invokerId,
        agentRole: agentRole,
        status: 'blocked',
        reason: credResolution.reason,
        risk: guard.risk,
        sandbox: guard.sandbox,
        runner: guard.launchRunner,
        approvalTokenId,
        approvalRequired: !!guard.requiresApproval,
        credentialIds: providedCredentialMetas.map(c => c.id),
        credentialScopes: providedScopes,
        credentialDecision: 'deny',
        credentialEnvironment,
        credentialSystem,
        credentialCatalogEntryIds: credResolution.matchedEntryIds || [],
        durationMs: Date.now() - startedAt
      });
      ws.send(JSON.stringify({
        type: 'skill_result',
        data: {
          skillId: message.skillId,
          command: message.command,
          result: `Blocked by credential policy: ${credResolution.reason}`
        }
      }));
      return;
    }

    const allowlistPolicy = privilegedTargetAllowlistPolicyStore.get();
    if (
      allowlistPolicy.enabled
      && guard.risk !== 'safe'
      && allowlistPolicy.enforceForRisks.includes(guard.risk)
    ) {
      const paramsForAllowlist = (message.params || {}) as Record<string, unknown>;
      const targets = extractExecutionTargets(paramsForAllowlist);
      if (allowlistPolicy.targets.length === 0) {
        const reason = `Allowlist policy is enabled for ${guard.risk}, but no targets are configured`;
        executionAuditStore.append({
          id: cryptoRandomId(),
          timestamp: new Date().toISOString(),
          taskId: linkedTaskId,
          command: message.command,
          skillId: message.skillId,
          agentId: invokerId,
          agentRole: agentRole,
          status: 'blocked',
          reason,
          risk: guard.risk,
          sandbox: guard.sandbox,
          runner: guard.launchRunner,
          approvalTokenId,
          approvalRequired: !!guard.requiresApproval,
          credentialIds: providedCredentialMetas.map(c => c.id),
          credentialScopes: providedScopes,
          credentialDecision: 'allow',
          credentialEnvironment,
          credentialSystem,
          credentialCatalogEntryIds: credResolution.matchedEntryIds || [],
          durationMs: Date.now() - startedAt
        });
        ws.send(JSON.stringify({
          type: 'skill_result',
          data: {
            skillId: message.skillId,
            command: message.command,
            result: `Blocked by allowlist policy: ${reason}`
          }
        }));
        return;
      }
      if (targets.length === 0) {
        const reason = `No target fields provided for allowlist validation (${guard.risk} command)`;
        executionAuditStore.append({
          id: cryptoRandomId(),
          timestamp: new Date().toISOString(),
          taskId: linkedTaskId,
          command: message.command,
          skillId: message.skillId,
          agentId: invokerId,
          agentRole: agentRole,
          status: 'blocked',
          reason,
          risk: guard.risk,
          sandbox: guard.sandbox,
          runner: guard.launchRunner,
          approvalTokenId,
          approvalRequired: !!guard.requiresApproval,
          credentialIds: providedCredentialMetas.map(c => c.id),
          credentialScopes: providedScopes,
          credentialDecision: 'allow',
          credentialEnvironment,
          credentialSystem,
          credentialCatalogEntryIds: credResolution.matchedEntryIds || [],
          durationMs: Date.now() - startedAt
        });
        ws.send(JSON.stringify({
          type: 'skill_result',
          data: {
            skillId: message.skillId,
            command: message.command,
            result: `Blocked by allowlist policy: ${reason}`
          }
        }));
        return;
      }
      const nonAllowlisted = targets.filter(target => !isTargetAllowlisted(target, allowlistPolicy.targets));
      if (nonAllowlisted.length > 0) {
        const reason = `Target(s) not allowlisted for ${guard.risk} command: ${nonAllowlisted.join(', ')}`;
        executionAuditStore.append({
          id: cryptoRandomId(),
          timestamp: new Date().toISOString(),
          taskId: linkedTaskId,
          command: message.command,
          skillId: message.skillId,
          agentId: invokerId,
          agentRole: agentRole,
          status: 'blocked',
          reason,
          risk: guard.risk,
          sandbox: guard.sandbox,
          runner: guard.launchRunner,
          approvalTokenId,
          approvalRequired: !!guard.requiresApproval,
          credentialIds: providedCredentialMetas.map(c => c.id),
          credentialScopes: providedScopes,
          credentialDecision: 'allow',
          credentialEnvironment,
          credentialSystem,
          credentialCatalogEntryIds: credResolution.matchedEntryIds || [],
          durationMs: Date.now() - startedAt
        });
        ws.send(JSON.stringify({
          type: 'skill_result',
          data: {
            skillId: message.skillId,
            command: message.command,
            result: `Blocked by allowlist policy: ${reason}`
          }
        }));
        return;
      }
    }

    const skill = skillManager.get(message.skillId);
    if (!skill) {
      ws.send(JSON.stringify({ type: 'error', message: 'Skill not found' }));
      return;
    }

    const commandObj = skill.commands.find(c => c.name === message.command);
    if (!commandObj) {
      ws.send(JSON.stringify({ type: 'error', message: 'Command not found' }));
      return;
    }
    const slot = acquireExecutionSlot(message.command);
    if (!slot.ok) {
      if (linkedTaskId) {
        try {
          taskManager.appendOperation(linkedTaskId, {
            actorId: invokerId,
            actorType: 'agent',
            type: 'execution',
            summary: `Execution blocked for ${message.command}`,
            details: `Concurrency limit reached (${slot.active}/${slot.limit})`,
            status: 'failed'
          });
        } catch {
          // Ignore missing linked task.
        }
      }
      executionAuditStore.append({
        id: cryptoRandomId(),
        timestamp: new Date().toISOString(),
        taskId: linkedTaskId,
        command: message.command,
        skillId: message.skillId,
        agentId: invokerId,
        agentRole: agentRole,
        status: 'blocked',
        reason: `Concurrency limit reached (${slot.active}/${slot.limit})`,
        risk: guard.risk,
        sandbox: guard.sandbox,
        runner: guard.launchRunner,
        approvalTokenId,
        approvalRequired: !!guard.requiresApproval,
        credentialIds: providedCredentialMetas.map(c => c.id),
        credentialScopes: providedScopes,
        credentialDecision: 'allow',
        credentialEnvironment,
        credentialSystem,
        credentialCatalogEntryIds: credResolution.matchedEntryIds || [],
        durationMs: Date.now() - startedAt
      });
      ws.send(JSON.stringify({
        type: 'skill_result',
        data: {
          skillId: message.skillId,
          command: message.command,
          result: `Blocked by policy: concurrency limit reached for ${message.command} (${slot.active}/${slot.limit})`
        }
      }));
      return;
    }
    if (linkedTaskId) {
      try {
        taskManager.appendOperation(linkedTaskId, {
          actorId: invokerId,
          actorType: 'agent',
          type: 'execution',
          summary: `Execution started for ${message.command}`,
          details: `Skill ${message.skillId}, handler ${commandObj.handler}`,
          status: 'recorded'
        });
      } catch {
        // Ignore missing linked task.
      }
    }
    if (approvalTokenId) {
      const consume = approvalTokenLedger.consume({
        tokenId: approvalTokenId,
        command: message.command,
        agentId: invokerId
      });
      if (!consume.ok) {
        executionAuditStore.append({
          id: cryptoRandomId(),
          timestamp: new Date().toISOString(),
          taskId: linkedTaskId,
          command: message.command,
          skillId: message.skillId,
          agentId: invokerId,
          agentRole: agentRole,
          status: 'blocked',
          reason: consume.reason || 'Approval token invalid state',
          risk: guard.risk,
          sandbox: guard.sandbox,
          runner: guard.launchRunner,
          approvalTokenId,
          approvalRequired: !!guard.requiresApproval,
          credentialIds: providedCredentialMetas.map(c => c.id),
          credentialScopes: providedScopes,
          credentialDecision: 'allow',
          credentialEnvironment,
          credentialSystem,
          credentialCatalogEntryIds: credResolution.matchedEntryIds || [],
          durationMs: Date.now() - startedAt
        });
        ws.send(JSON.stringify({
          type: 'skill_result',
          data: {
            skillId: message.skillId,
            command: message.command,
            result: `Blocked by policy: ${consume.reason || 'Approval token invalid state'}`
          }
        }));
        return;
      }
    }
    try {
      const safeParams = { ...(message.params || {}) };
      delete safeParams.approved;
      delete safeParams.agentId;
      delete safeParams.credentialIds;
      delete safeParams.approvalToken;
      delete safeParams.operatorToken;
      delete safeParams.taskId;
      const launchSpec = getToolLaunchSpec(message.command);
      if (!launchSpec) {
        throw new Error(`No launch spec configured for command '${message.command}'`);
      }
      let preExecutionSnapshotId: string | undefined;
      if (linkedTaskId && guard.risk && guard.risk !== 'safe') {
        try {
          const timeline = taskManager.getTaskTimeline(linkedTaskId);
          const snapshot = taskSnapshotStore.create({
            taskId: linkedTaskId,
            command: message.command,
            skillId: message.skillId,
            agentId: invokerId,
            risk: guard.risk,
            sandbox: guard.sandbox,
            params: safeParams,
            timeline: {
              operations: timeline.operations || [],
              checkpoints: timeline.checkpoints || []
            },
            manifest: buildRollbackManifest(message.command, safeParams),
            metadata: {
              launchRunner: guard.launchRunner,
              maxDurationMs: guard.maxDurationMs
            }
          });
          preExecutionSnapshotId = snapshot.id;
          taskManager.appendOperation(linkedTaskId, {
            actorId: invokerId,
            actorType: 'agent',
            type: 'rollback',
            summary: `Pre-change snapshot captured for ${message.command}`,
            details: `Snapshot ${snapshot.id} created for deterministic rollback manifest.`,
            status: 'recorded'
          });
        } catch {
          // Ignore snapshot creation issues when linked task is unavailable.
        }
      }
      const parameterOrder = Object.keys(commandObj.parameters || {});
      const payloadB64 = Buffer.from(JSON.stringify({
        skillId: message.skillId,
        handler: commandObj.handler,
        params: safeParams,
        parameterOrder
      }), 'utf8').toString('base64');
      const sandboxResult = await sandboxRunner.execute({
        launchSpec,
        payloadB64,
        timeoutMs: guard.maxDurationMs || launchSpec.defaultTimeoutMs
      });
      const result = sandboxResult.result;
      if (linkedTaskId) {
        try {
          const op = taskManager.appendOperation(linkedTaskId, {
            actorId: invokerId,
            actorType: 'agent',
            type: 'execution',
            summary: `Execution completed for ${message.command}`,
            details: result.slice(0, 1200),
            status: 'success'
          });
          if (guard.risk && guard.risk !== 'safe') {
            taskManager.addRollbackCheckpoint(linkedTaskId, {
              label: `${message.command} @ ${new Date().toISOString()}`,
              rollbackPlan: buildRollbackPlan(message.command, safeParams),
              operationId: op.id,
              impactClasses: buildRollbackImpactClasses(message.command),
              required: true,
              metadata: {
                command: message.command,
                skillId: message.skillId,
                sandbox: guard.sandbox,
                runner: guard.launchRunner,
                snapshotId: preExecutionSnapshotId,
                requireSnapshot: true
              }
            });
          }
        } catch {
          // Ignore missing linked task.
        }
      }

      ws.send(JSON.stringify({
        type: 'skill_result',
        data: {
          skillId: message.skillId,
          command: message.command,
          result: `[sandbox:${guard.sandbox}][runner:${guard.launchRunner}][risk:${guard.risk}][max:${guard.maxDurationMs}ms][id:${sandboxResult.sandboxId}][scopes:${(guard.requiredCredentialScopes || []).join('|') || 'none'}] ${result}`,
          metadata: {
            launchSpec,
            sandboxId: sandboxResult.sandboxId,
            approvalTokenId,
            providedCredentialIds: providedCredentialMetas.map(c => c.id),
            providedCredentialScopes: providedScopes
          }
        }
      }));
      executionAuditStore.append({
        id: cryptoRandomId(),
        timestamp: new Date().toISOString(),
        taskId: linkedTaskId,
        command: message.command,
        skillId: message.skillId,
        agentId: invokerId,
        agentRole: agentRole,
        status: 'allowed',
        risk: guard.risk,
        sandbox: guard.sandbox,
        runner: guard.launchRunner,
        approvalTokenId,
        approvalRequired: !!guard.requiresApproval,
        credentialIds: providedCredentialMetas.map(c => c.id),
        credentialScopes: providedScopes,
        credentialDecision: 'allow',
        credentialEnvironment,
        credentialSystem,
        credentialCatalogEntryIds: credResolution.matchedEntryIds || [],
        durationMs: Date.now() - startedAt
      });
    } finally {
      releaseExecutionSlot(message.command);
    }
  } catch (error) {
    const director = organization.getDirector();
    const fallbackAgentId = message.params?.agentId || director?.id || 'unknown';
    const fallbackRole = organization.getAgent(fallbackAgentId)?.role || 'director';
    const linkedTaskId = message.params?.taskId ? String(message.params.taskId) : undefined;
    if (linkedTaskId) {
      try {
        taskManager.appendOperation(linkedTaskId, {
          actorId: fallbackAgentId,
          actorType: 'agent',
          type: 'execution',
          summary: `Execution failed for ${message.command}`,
          details: (error as Error).message,
          status: 'failed'
        });
      } catch {
        // Ignore missing linked task.
      }
    }
    executionAuditStore.append({
      id: cryptoRandomId(),
      timestamp: new Date().toISOString(),
      taskId: linkedTaskId,
      command: message.command,
      skillId: message.skillId,
      agentId: fallbackAgentId,
      agentRole: fallbackRole,
      status: 'error',
      reason: (error as Error).message,
      approvalRequired: !!getToolPolicy(message.command)?.requiresApproval,
      credentialIds: [],
      credentialScopes: [],
      credentialDecision: 'not_checked',
      durationMs: Date.now() - startedAt
    });
    ws.send(JSON.stringify({
      type: 'skill_result',
      data: { skillId: message.skillId, command: message.command, result: `Error: ${(error as Error).message}` }
    }));
  }
}

function cryptoRandomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function validateOneTimeApprovalToken(params: {
  token?: string;
  command: string;
  agentId: string;
}): { ok: boolean; reason?: string; tokenId?: string } {
  const validation = approvalTokenService.validate({
    token: params.token,
    command: params.command,
    agentId: params.agentId
  });
  if (!validation.valid) {
    return { ok: false, reason: validation.reason || 'Invalid approval token' };
  }
  const tokenId = validation.payload?.tokenId;
  if (!tokenId) {
    return { ok: false, reason: 'Approval token is missing tokenId metadata' };
  }
  const tokenState = approvalTokenLedger.getStatus(tokenId);
  if (tokenState.revoked) {
    return { ok: false, reason: 'Approval token revoked', tokenId };
  }
  if (tokenState.used) {
    return { ok: false, reason: 'Approval token already used (one-time token)', tokenId };
  }
  return { ok: true, tokenId };
}

function computeAuditChain(records: any[]): {
  records: any[];
  chain: Array<{ id: string; timestamp: string; prevHash: string; hash: string }>;
  headHash: string;
} {
  const chronologicalRecords = [...records].reverse();
  let prevHash = 'GENESIS';
  const chain = chronologicalRecords.map(record => {
    const serialized = JSON.stringify(record);
    const hash = crypto.createHash('sha256').update(`${prevHash}|${serialized}`).digest('hex');
    const entry = {
      id: String(record.id || ''),
      timestamp: String(record.timestamp || ''),
      prevHash,
      hash
    };
    prevHash = hash;
    return entry;
  });
  return {
    records: chronologicalRecords,
    chain,
    headHash: prevHash
  };
}

function signAuditExport(payload: unknown): string {
  return crypto.createHmac('sha256', auditExportSecret).update(JSON.stringify(payload)).digest('hex');
}

function flattenObject(input: unknown, prefix = ''): Record<string, string> {
  if (!input || typeof input !== 'object') {
    return { [prefix || '$']: JSON.stringify(input) };
  }
  const out: Record<string, string> = {};
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) {
    out[prefix || '$'] = '{}';
    return out;
  }
  entries.forEach(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flattenObject(v, path));
    } else {
      out[path] = JSON.stringify(v);
    }
  });
  return out;
}

function computeChangedKeys(before: unknown, after: unknown): string[] {
  const b = flattenObject(before);
  const a = flattenObject(after);
  const keys = new Set<string>([...Object.keys(b), ...Object.keys(a)]);
  const changed: string[] = [];
  keys.forEach(k => {
    if (b[k] !== a[k]) changed.push(k);
  });
  return changed.sort();
}

function handleGetToolPolicies(ws: WebSocket) {
  ws.send(JSON.stringify({
    type: 'tool_policies',
    data: TOOL_POLICIES.map(policy => ({
      ...policy,
      launch: SANDBOX_LAUNCH_SPECS[policy.sandbox]
    }))
  }));
}

function buildToolCatalog() {
  return skillManager.getAll().flatMap(skill =>
    (skill.commands || []).map(command => {
      const policy = getToolPolicy(command.name);
      return {
        skillId: skill.id,
        skillName: skill.name,
        command: command.name,
        description: command.description,
        parameters: command.parameters || {},
        policy: policy || null,
        launch: policy ? SANDBOX_LAUNCH_SPECS[policy.sandbox] : null
      };
    })
  );
}

function taskHasRiskyExecutionWithoutCheckpoint(task: Task): boolean {
  const checkpoints = task.rollbackCheckpoints || [];
  if (checkpoints.length > 0) return false;
  const operations = task.operations || [];
  return operations.some(op => {
    if (op.type !== 'execution' || op.status !== 'success') return false;
    const text = `${op.summary}\n${op.details || ''}`.toLowerCase();
    return (
      text.includes('[risk:privileged]')
      || text.includes('[risk:destructive]')
      || text.includes('deploy')
      || text.includes('docker.exec')
      || text.includes('security.sudo')
    );
  });
}

function getDelegationRiskLevel(delegation: Delegation): 'low' | 'medium' | 'high' {
  if (delegation.riskLevel) return delegation.riskLevel;
  const task = taskManager.getTask(delegation.parentTaskId);
  const objective = (delegation.objective || '').toLowerCase();
  const highTaskContext = !!task && (
    task.priority === 'high'
    || task.priority === 'critical'
    || task.category === 'deployment'
    || task.category === 'security'
  );
  const mediumTaskContext = !!task && (
    task.priority === 'medium'
    || task.category === 'infrastructure'
  );
  const highObjective = [
    'production',
    'deploy',
    'rollback',
    'delete',
    'destroy',
    'sudo',
    'firewall',
    'k8s',
    'docker.exec',
    'credential',
    'token'
  ].some(k => objective.includes(k));
  const mediumObjective = [
    'staging',
    'upgrade',
    'migration',
    'maintenance'
  ].some(k => objective.includes(k));
  if (highTaskContext || highObjective) return 'high';
  if (mediumTaskContext || mediumObjective) return 'medium';
  return 'low';
}

function delegationTransitionRequiresApproval(delegation: Delegation, nextState: string): boolean {
  const policy = delegationPolicyStore.get();
  const state = nextState as DelegationState;
  const risk = getDelegationRiskLevel(delegation);
  const requiredRisks = policy.requireApprovalByTransition[state] || [];
  return requiredRisks.includes(risk);
}

function isTerminalTaskStatus(status: string): boolean {
  return ['completed', 'failed', 'cancelled', 'dropped', 'rolled_back'].includes(status);
}

function rollupParentTaskStatus(parentTaskId: string): void {
  const parent = taskManager.getTask(parentTaskId);
  if (!parent) return;
  if (isTerminalTaskStatus(parent.status)) return;
  const children = taskManager.getChildTasks(parentTaskId);
  const delegations = delegationManager.list({ taskId: parentTaskId, limit: 1000 });
  if (children.length === 0 && delegations.length === 0) return;

  const hasFailedChild = children.some(c => ['failed', 'cancelled', 'dropped'].includes(c.status));
  const hasRejectedDelegation = delegations.some(d => d.state === 'rejected');
  const allChildrenDone = children.length > 0 && children.every(c => ['completed', 'rolled_back'].includes(c.status));
  const activeChildren = children.some(c => ['pending', 'assigned', 'in_progress', 'blocked', 'rolling_back'].includes(c.status));
  const activeDelegations = delegations.some(d => ['proposed', 'approved', 'dispatched', 'accepted'].includes(d.state));
  const allDelegationsDone = delegations.length === 0 || delegations.every(d => ['completed', 'rejected'].includes(d.state));

  let desired = parent.status;
  if (hasFailedChild || hasRejectedDelegation) {
    desired = 'blocked';
  } else if (allChildrenDone && allDelegationsDone) {
    desired = 'completed';
  } else if (activeChildren || activeDelegations) {
    desired = 'in_progress';
  }
  if (desired !== parent.status) {
    taskManager.updateTaskStatus(parentTaskId, desired as any);
  }
}

function processDelegationEscalations(): void {
  const policy = delegationPolicyStore.get();
  const now = Date.now();
  const delegations = delegationManager.list({ limit: 5000 });
  for (const d of delegations) {
    if (['completed', 'rejected'].includes(d.state)) continue;
    const metadata = (d.metadata || {}) as Record<string, unknown>;

    if (d.deadline) {
      const deadlineTs = Date.parse(d.deadline);
      if (Number.isFinite(deadlineTs) && deadlineTs < now) {
        if (policy.overdueAction === 'reject') {
          if (!metadata.autoRejectedAt) {
            try {
              delegationManager.transition({
                delegationId: d.id,
                nextState: 'rejected',
                actorId: 'system',
                reason: 'Auto-rejected by overdue deadline policy'
              });
              delegationManager.updateMetadata({
                delegationId: d.id,
                metadata: { autoRejectedAt: new Date().toISOString() }
              });
              taskManager.appendOperation(d.parentTaskId, {
                actorId: 'system',
                actorType: 'system',
                type: 'note',
                summary: `Delegation auto-rejected: ${d.id}`,
                details: `Deadline ${d.deadline} passed and policy overdueAction=reject.`,
                status: 'recorded'
              });
              rollupParentTaskStatus(d.parentTaskId);
            } catch {
              // ignore invalid transition races
            }
          }
          continue;
        }
        if (!metadata.overdueEscalatedAt) {
          delegationManager.appendHistory({
            delegationId: d.id,
            actorId: 'system',
            reason: `auto-overdue-escalation: deadline ${d.deadline} passed`
          });
          delegationManager.updateMetadata({
            delegationId: d.id,
            metadata: { overdueEscalatedAt: new Date().toISOString() }
          });
          taskManager.appendOperation(d.parentTaskId, {
            actorId: 'system',
            actorType: 'system',
            type: 'note',
            summary: `Delegation overdue escalation: ${d.id}`,
            details: `Deadline ${d.deadline} passed; escalation recorded.`,
            status: 'recorded'
          });
        }
      }
    }

    const stalledHours = policy.stalledHoursByState[d.state];
    if (!stalledHours) continue;
    const updatedTs = Date.parse(d.updatedAt);
    if (!Number.isFinite(updatedTs)) continue;
    const ageHours = (now - updatedTs) / (1000 * 60 * 60);
    if (ageHours >= stalledHours && !metadata.stalledEscalatedAt) {
      delegationManager.appendHistory({
        delegationId: d.id,
        actorId: 'system',
        reason: `auto-stalled-escalation: ${d.state} for ${ageHours.toFixed(1)}h`
      });
      delegationManager.updateMetadata({
        delegationId: d.id,
        metadata: { stalledEscalatedAt: new Date().toISOString() }
      });
      taskManager.appendOperation(d.parentTaskId, {
        actorId: 'system',
        actorType: 'system',
        type: 'note',
        summary: `Delegation stalled escalation: ${d.id}`,
        details: `State ${d.state} has been idle for ${ageHours.toFixed(1)}h (threshold ${stalledHours}h).`,
        status: 'recorded'
      });
    }
  }
}

function buildAgentCapabilityMatrix() {
  const catalog = buildToolCatalog();
  const uniqueCommands = Array.from(new Map(catalog.map(item => [item.command, item])).values());
  return organization.getAllAgents().map(agent => ({
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    skills: agent.config.skills || [],
    commands: uniqueCommands.map(item => {
      const policy = item.policy;
      const allowedByRole = !!policy && policy.allowedRoles.includes(agent.role as any);
      return {
        command: item.command,
        description: item.description,
        risk: policy?.risk || 'unknown',
        sandbox: policy?.sandbox || 'none',
        requiresApproval: !!policy?.requiresApproval,
        requiredScopes: policy?.requiredCredentialScopes || [],
        allowedByRole
      };
    })
  }));
}

function buildOrchestratorReliabilitySlo(): OrchestratorReliabilitySloResponse {
  const generatedAt = new Date().toISOString();
  const windowMinutes = ORCHESTRATOR_SLO_WINDOW_MINUTES;
  const cutoff = Date.now() - (windowMinutes * 60 * 1000);
  const allRecent = orchestratorService.listRecoveryHistory(500);
  const events = allRecent.filter(event => {
    const ts = Date.parse(event.timestamp);
    return Number.isFinite(ts) && ts >= cutoff;
  });
  const retries = events.filter(event => event.action === 'retry').length;
  const quarantined = events.filter(event => event.action === 'quarantine').length;
  const recoveryFailed = events.filter(event => event.action === 'recovery_failed').length;
  const actions = events.length;
  const successful = retries + quarantined;
  const successRate = actions > 0 ? successful / actions : 1;
  const breaches: OrchestratorReliabilitySloResponse['breaches'] = [];
  const currentPolicy = orchestratorService.getReliabilityPolicy();
  if (quarantined > ORCHESTRATOR_SLO_MAX_QUARANTINED) {
    breaches.push({
      key: 'max_quarantined',
      message: `Quarantined actions ${quarantined} exceeded threshold ${ORCHESTRATOR_SLO_MAX_QUARANTINED} in the last ${windowMinutes} minutes.`
    });
  }
  if (recoveryFailed > ORCHESTRATOR_SLO_MAX_RECOVERY_FAILED) {
    breaches.push({
      key: 'max_recovery_failed',
      message: `Recovery failures ${recoveryFailed} exceeded threshold ${ORCHESTRATOR_SLO_MAX_RECOVERY_FAILED} in the last ${windowMinutes} minutes.`
    });
  }
  if (successRate < ORCHESTRATOR_SLO_MIN_SUCCESS_RATE) {
    breaches.push({
      key: 'min_success_rate',
      message: `Recovery success rate ${(successRate * 100).toFixed(1)}% is below threshold ${(ORCHESTRATOR_SLO_MIN_SUCCESS_RATE * 100).toFixed(1)}%.`
    });
  }
  const recommendations: string[] = [];
  if (recoveryFailed > 0) {
    recommendations.push('Inspect recovery_failed reasons and validate task-manager transitions for stuck entries.');
  }
  if (quarantined > 0) {
    recommendations.push('Review retryLimit/stuckThresholdMinutes values to reduce false-positive quarantines.');
  }
  if (actions === 0) {
    recommendations.push('No recovery actions in window; continue monitoring and keep periodic orchestrator ticks enabled.');
  }
  const tuningSuggestions: OrchestratorReliabilitySloResponse['tuningSuggestions'] = [];
  if (breaches.some(b => b.key === 'max_quarantined')) {
    tuningSuggestions.push({
      id: 'reduce_quarantine_pressure',
      title: 'Reduce quarantine pressure',
      reason: 'Quarantine volume is above threshold; broaden retry window before blocking tasks.',
      patch: {
        retryLimit: Math.min(currentPolicy.retryLimit + 1, 10),
        stuckThresholdMinutes: Math.min(currentPolicy.stuckThresholdMinutes + 15, 24 * 60)
      }
    });
  }
  if (breaches.some(b => b.key === 'max_recovery_failed')) {
    const severeFailures = recoveryFailed >= Math.max(3, ORCHESTRATOR_SLO_MAX_RECOVERY_FAILED + 2);
    tuningSuggestions.push({
      id: severeFailures ? 'stabilize_recovery_failures_hard' : 'stabilize_recovery_failures_soft',
      title: severeFailures ? 'Stabilize recovery flow (hard)' : 'Stabilize recovery flow',
      reason: severeFailures
        ? 'Repeated recovery failures detected; temporarily disable auto-recovery to stop churn while investigating.'
        : 'Recovery failures detected; slow retry cadence to reduce contention and transition race conditions.',
      patch: severeFailures
        ? { autoRecoverEnabled: false }
        : { retryCooldownMinutes: Math.min(currentPolicy.retryCooldownMinutes + 5, 24 * 60) }
    });
  }
  if (breaches.some(b => b.key === 'min_success_rate')) {
    tuningSuggestions.push({
      id: 'raise_recovery_success_rate',
      title: 'Raise recovery success rate',
      reason: 'Success rate is below target; increase retries and cooldown to improve completion probability.',
      patch: {
        retryLimit: Math.min(currentPolicy.retryLimit + 1, 10),
        retryCooldownMinutes: Math.min(currentPolicy.retryCooldownMinutes + 5, 24 * 60)
      }
    });
  }
  if (tuningSuggestions.length === 0) {
    tuningSuggestions.push({
      id: 'no_change',
      title: 'No tuning change required',
      reason: 'SLO is healthy for the current window.',
      patch: {}
    });
  }
  return {
    generatedAt,
    windowMinutes,
    thresholds: {
      maxQuarantined: ORCHESTRATOR_SLO_MAX_QUARANTINED,
      maxRecoveryFailed: ORCHESTRATOR_SLO_MAX_RECOVERY_FAILED,
      minSuccessRate: ORCHESTRATOR_SLO_MIN_SUCCESS_RATE
    },
    totals: {
      actions,
      retries,
      quarantined,
      recoveryFailed
    },
    successRate,
    breaches,
    tuningSuggestions,
    status: breaches.length > 0 ? 'warning' : 'ok',
    recommendations,
    sample: events.slice(0, 10)
  };
}

function buildOperationalAlerts() {
  const alerts: Array<{
    id: string;
    severity: 'info' | 'warning' | 'critical';
    kind: 'rollback_guard' | 'execution_policy' | 'token_misuse' | 'delegation_sla' | 'backup_health' | 'credential_anomaly';
    message: string;
    context?: Record<string, unknown>;
    timestamp: string;
  }> = [];
  const nowIso = new Date().toISOString();
  const tasks = taskManager.getAllTasks();
  for (const task of tasks) {
    if (taskHasRiskyExecutionWithoutCheckpoint(task)) {
      alerts.push({
        id: `alert-task-${task.id}`,
        severity: 'warning',
        kind: 'rollback_guard',
        message: `Task ${task.id} has risky execution history but no rollback checkpoint.`,
        context: { taskId: task.id, title: task.title, status: task.status },
        timestamp: nowIso
      });
    }
  }
  const recentAudits = executionAuditStore.list(500);
  const anomalyWindowMs = CREDENTIAL_ANOMALY_WINDOW_MINUTES * 60 * 1000;
  const nowTs = Date.now();
  const recentCredentialEvents = recentAudits.filter(a => {
    const ts = Date.parse(a.timestamp);
    if (!Number.isFinite(ts)) return false;
    return (nowTs - ts) <= anomalyWindowMs;
  });
  const credentialUsage = new Map<string, number>();
  recentCredentialEvents.forEach(event => {
    (event.credentialIds || []).forEach(id => {
      credentialUsage.set(id, (credentialUsage.get(id) || 0) + 1);
    });
  });
  const hotCredentials = Array.from(credentialUsage.entries())
    .filter(([, count]) => count >= CREDENTIAL_ANOMALY_MAX_USES)
    .sort((a, b) => b[1] - a[1]);
  if (hotCredentials.length > 0) {
    alerts.push({
      id: 'alert-credential-hot',
      severity: hotCredentials[0][1] >= (CREDENTIAL_ANOMALY_MAX_USES * 2) ? 'critical' : 'warning',
      kind: 'credential_anomaly',
      message: `Credential usage anomaly detected in last ${CREDENTIAL_ANOMALY_WINDOW_MINUTES}m.`,
      context: {
        threshold: CREDENTIAL_ANOMALY_MAX_USES,
        topCredentials: hotCredentials.slice(0, 5).map(([credentialId, count]) => ({ credentialId, count }))
      },
      timestamp: nowIso
    });
  }
  const missingScopeBlocks = recentAudits.filter(a =>
    a.status === 'blocked' && (a.reason || '').toLowerCase().includes('missing credential scopes')
  ).length;
  if (missingScopeBlocks >= 3) {
    alerts.push({
      id: 'alert-credential-scope',
      severity: 'warning',
      kind: 'credential_anomaly',
      message: `${missingScopeBlocks} blocked executions due to missing credential scopes.`,
      context: { missingScopeBlocks },
      timestamp: nowIso
    });
  }
  const blockedPrivileged = recentAudits.filter(a =>
    a.status === 'blocked' && a.risk !== 'safe'
  ).length;
  if (blockedPrivileged >= 3) {
    alerts.push({
      id: 'alert-blocked-privileged',
      severity: 'warning',
      kind: 'execution_policy',
      message: `${blockedPrivileged} blocked privileged/destructive executions were recorded recently.`,
      context: { blockedPrivilegedCount: blockedPrivileged },
      timestamp: nowIso
    });
  }
  const tokenMisuse = recentAudits.filter(a =>
    (a.reason || '').toLowerCase().includes('one-time token')
    || (a.reason || '').toLowerCase().includes('token revoked')
  ).length;
  if (tokenMisuse > 0) {
    alerts.push({
      id: 'alert-token-misuse',
      severity: tokenMisuse >= 3 ? 'critical' : 'warning',
      kind: 'token_misuse',
      message: `${tokenMisuse} approval-token misuse event(s) were recorded recently.`,
      context: { tokenMisuseCount: tokenMisuse },
      timestamp: nowIso
    });
  }
  const delegations = delegationManager.list({ limit: 1000 });
  const now = Date.now();
  delegations.forEach(d => {
    if (d.deadline && d.state !== 'completed' && d.state !== 'rejected') {
      const deadlineTs = Date.parse(d.deadline);
      if (Number.isFinite(deadlineTs) && deadlineTs < now) {
        alerts.push({
          id: `alert-delegation-overdue-${d.id}`,
          severity: 'critical',
          kind: 'delegation_sla',
          message: `Delegation ${d.id} is overdue (deadline ${d.deadline})`,
          context: { delegationId: d.id, parentTaskId: d.parentTaskId, state: d.state },
          timestamp: nowIso
        });
      }
    }
    const updatedTs = Date.parse(d.updatedAt);
    if (Number.isFinite(updatedTs) && ['approved', 'dispatched'].includes(d.state)) {
      const ageHours = (now - updatedTs) / (1000 * 60 * 60);
      if (ageHours >= 6) {
        alerts.push({
          id: `alert-delegation-stalled-${d.id}`,
          severity: 'warning',
          kind: 'delegation_sla',
          message: `Delegation ${d.id} has been in ${d.state} for ${ageHours.toFixed(1)}h`,
          context: { delegationId: d.id, parentTaskId: d.parentTaskId, state: d.state },
          timestamp: nowIso
        });
      }
    }
  });
  try {
    const backupHealth = computeBackupHealthPayload();
    if (backupHealth.stale) {
      alerts.push({
        id: 'alert-backup-stale',
        severity: 'critical',
        kind: 'backup_health',
        message: 'Latest system backup is stale or unavailable.',
        context: {
          thresholdHours: backupHealth.thresholdHours,
          backupAgeSeconds: backupHealth.backupAgeSeconds,
          latestBackupId: backupHealth.latestBackup?.id || null
        },
        timestamp: nowIso
      });
    }
    if (backupHealth.verification && !backupHealth.verification.ok) {
      alerts.push({
        id: 'alert-backup-verify',
        severity: 'warning',
        kind: 'backup_health',
        message: 'Latest system backup verification failed.',
        context: {
          latestBackupId: backupHealth.latestBackup?.id || null,
          verificationError: backupHealth.verification.error || null
        },
        timestamp: nowIso
      });
    }
    if (recoverySchedulerState.enabled && recoverySchedulerState.lastError) {
      alerts.push({
        id: 'alert-recovery-set-failed', severity: 'critical', kind: 'backup_health',
        message: 'The latest full recovery-set run failed.',
        context: { error: recoverySchedulerState.lastError, lastFailureAt: recoverySchedulerState.lastFailureAt || null },
        timestamp: nowIso,
      });
    }
    if (recoverySchedulerState.enabled && !recoverySchedulerState.offsiteConfigured) {
      alerts.push({
        id: 'alert-recovery-offsite-unconfigured', severity: 'warning', kind: 'backup_health',
        message: 'Full recovery sets have no off-site destination configured.',
        context: { lastRecoveryId: recoverySchedulerState.lastRecoveryId || null }, timestamp: nowIso,
      });
    }
    if (recoverySchedulerState.enabled && recoverySchedulerState.offsiteConfigured && !recoverySchedulerState.externalKeyCustody) {
      alerts.push({
        id: 'alert-recovery-key-custody', severity: 'warning', kind: 'backup_health',
        message: 'Off-site recovery is configured, but encryption-key custody is not external.',
        context: { keySource: recoverySchedulerState.keySource }, timestamp: nowIso,
      });
    }
  } catch {
    alerts.push({
      id: 'alert-backup-health-error',
      severity: 'warning',
      kind: 'backup_health',
      message: 'Could not evaluate backup health status.',
      timestamp: nowIso
    });
  }
  try {
    const orchestrator = orchestratorService.getStatus();
    const recent = orchestrator.reliability?.recentActions || [];
    const quarantined = recent.filter(item => item.action === 'quarantine').length;
    const recoveryFailed = recent.filter(item => item.action === 'recovery_failed').length;
    if (quarantined > 0) {
      alerts.push({
        id: 'alert-orchestrator-quarantine',
        severity: quarantined >= 3 ? 'critical' : 'warning',
        kind: 'execution_policy',
        message: `${quarantined} task(s) were auto-quarantined by orchestrator reliability controls.`,
        context: { quarantined, retryLimit: orchestrator.reliability?.retryLimit || null },
        timestamp: nowIso
      });
    }
    if (recoveryFailed > 0) {
      alerts.push({
        id: 'alert-orchestrator-recovery-failed',
        severity: 'warning',
        kind: 'execution_policy',
        message: `${recoveryFailed} orchestrator auto-recovery action(s) failed recently.`,
        context: { recoveryFailed },
        timestamp: nowIso
      });
    }
  } catch {
    // ignore orchestrator alert enrichment failures
  }
  return alerts;
}

function buildRunningOperationsBoard(filters?: {
  agentId?: string;
  taskState?: TaskStatus;
  delegationState?: DelegationState;
  riskLevel?: 'low' | 'medium' | 'high';
  limit?: number;
}) {
  const now = Date.now();
  const policy = delegationPolicyStore.get();
  const limit = Math.min(Math.max(Number(filters?.limit || 200), 1), 500);
  const activeTaskStatuses: TaskStatus[] = ['pending', 'assigned', 'in_progress', 'blocked', 'rolling_back'];
  const activeTasks = taskManager.getAllTasks()
    .filter(task => activeTaskStatuses.includes(task.status))
    .filter(task => !filters?.taskState || task.status === filters.taskState)
    .filter(task => !filters?.agentId || task.ownerId === filters.agentId || task.assignedTo === filters.agentId)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, limit)
    .map(task => ({
      taskId: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      category: task.category,
      ownerId: task.ownerId,
      assignedTo: task.assignedTo || null,
      parentTaskId: task.parentTaskId || null,
      ageMinutes: Math.max(0, Math.round((now - task.createdAt.getTime()) / 60000)),
      idleMinutes: Math.max(0, Math.round((now - task.updatedAt.getTime()) / 60000))
    }));

  const activeDelegationStates: DelegationState[] = ['proposed', 'approved', 'dispatched', 'accepted'];
  const activeDelegations = delegationManager.list({ limit: 1000 })
    .filter(d => activeDelegationStates.includes(d.state))
    .filter(d => !filters?.delegationState || d.state === filters.delegationState)
    .filter(d => !filters?.agentId || d.requesterAgentId === filters.agentId || d.assigneeAgentId === filters.agentId)
    .filter(d => !filters?.riskLevel || getDelegationRiskLevel(d) === filters.riskLevel)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit)
    .map(d => {
      const updatedTs = Date.parse(d.updatedAt);
      const idleHours = Number.isFinite(updatedTs) ? (now - updatedTs) / (1000 * 60 * 60) : 0;
      const stalledThreshold = policy.stalledHoursByState[d.state] || null;
      const stalled = stalledThreshold ? idleHours >= stalledThreshold : false;
      return {
        delegationId: d.id,
        parentTaskId: d.parentTaskId,
        childTaskId: d.childTaskId || null,
        state: d.state,
        riskLevel: getDelegationRiskLevel(d),
        requesterAgentId: d.requesterAgentId,
        assigneeAgentId: d.assigneeAgentId,
        objective: d.objective,
        deadline: d.deadline || null,
        idleMinutes: Math.max(0, Math.round(idleHours * 60)),
        stalled,
        stalledThresholdHours: stalledThreshold
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      agentId: filters?.agentId || null,
      taskState: filters?.taskState || null,
      delegationState: filters?.delegationState || null,
      riskLevel: filters?.riskLevel || null,
      limit
    },
    summary: {
      activeTaskCount: activeTasks.length,
      blockedTaskCount: activeTasks.filter(t => t.status === 'blocked').length,
      activeDelegationCount: activeDelegations.length,
      stalledDelegationCount: activeDelegations.filter(d => d.stalled).length
    },
    executionSlots: Array.from(activeExecutionsByCommand.entries()).map(([command, active]) => ({
      command,
      active,
      limit: getMaxConcurrentExecutions(command)
    })),
    activeTasks,
    activeDelegations
  };
}

function buildSlaTrends(windowHours: number = 24) {
  const effectiveWindowHours = Math.min(Math.max(Math.floor(windowHours), 1), 168);
  const now = Date.now();
  const start = now - (effectiveWindowHours * 60 * 60 * 1000);
  const bucketCount = Math.min(effectiveWindowHours, 72);
  const bucketSizeMs = Math.max(Math.floor((now - start) / bucketCount), 60 * 60 * 1000);
  const buckets = Array.from({ length: bucketCount }, (_, idx) => {
    const from = start + (idx * bucketSizeMs);
    const to = idx === bucketCount - 1 ? now : from + bucketSizeMs;
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      delegationCreated: 0,
      delegationCompleted: 0,
      delegationRejected: 0,
      stalledEscalations: 0,
      overdueEscalations: 0
    };
  });

  type SlaBucketCounterKey =
    | 'delegationCreated'
    | 'delegationCompleted'
    | 'delegationRejected'
    | 'stalledEscalations'
    | 'overdueEscalations';

  function put(ts: number, key: SlaBucketCounterKey) {
    if (!Number.isFinite(ts) || ts < start || ts > now) return;
    const idx = Math.min(Math.floor((ts - start) / bucketSizeMs), bucketCount - 1);
    if (idx < 0 || idx >= bucketCount) return;
    buckets[idx][key] += 1;
  }

  const delegations = delegationManager.list({ limit: 1000 });
  delegations.forEach(d => {
    put(Date.parse(d.createdAt), 'delegationCreated');
    (d.history || []).forEach(h => {
      const ts = Date.parse(h.timestamp);
      if (h.state === 'completed') put(ts, 'delegationCompleted');
      if (h.state === 'rejected') put(ts, 'delegationRejected');
      const reason = (h.reason || '').toLowerCase();
      if (reason.includes('auto-stalled-escalation')) put(ts, 'stalledEscalations');
      if (reason.includes('auto-overdue-escalation')) put(ts, 'overdueEscalations');
    });
  });

  const tasks = taskManager.getAllTasks();
  const agentSummary = organization.getAllAgents().map(agent => {
    const related = tasks.filter(t => t.assignedTo === agent.id || t.ownerId === agent.id);
    const completedInWindow = related.filter(t =>
      t.completedAt
      && t.completedAt.getTime() >= start
      && ['completed', 'rolled_back'].includes(t.status)
    );
    const failedInWindow = related.filter(t =>
      t.completedAt
      && t.completedAt.getTime() >= start
      && ['failed', 'cancelled', 'dropped'].includes(t.status)
    );
    const durations = [...completedInWindow, ...failedInWindow].map(t =>
      Math.max(0, ((t.completedAt?.getTime() || now) - t.createdAt.getTime()) / 60000)
    );
    const meanDurationMinutes = durations.length === 0
      ? null
      : Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1));
    return {
      agentId: agent.id,
      name: agent.name,
      role: agent.role,
      completedInWindow: completedInWindow.length,
      failedInWindow: failedInWindow.length,
      meanDurationMinutes
    };
  }).sort((a, b) =>
    ((b.completedInWindow + b.failedInWindow) - (a.completedInWindow + a.failedInWindow))
    || a.name.localeCompare(b.name)
  );

  return {
    generatedAt: new Date().toISOString(),
    windowHours: effectiveWindowHours,
    buckets,
    agentSummary
  };
}

function aggregateSlaSnapshots(bucketHours: number, limit: number = 500) {
  const effectiveBucketHours = Math.min(Math.max(Math.floor(bucketHours), 1), 168);
  const rows = slaSnapshotStore.list(limit).slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const map = new Map<string, {
    from: string;
    to: string;
    samples: number;
    delegationCreated: number;
    delegationCompleted: number;
    delegationRejected: number;
    stalledEscalations: number;
    overdueEscalations: number;
  }>();
  const bucketMs = effectiveBucketHours * 60 * 60 * 1000;
  rows.forEach(s => {
    const ts = Date.parse(s.timestamp);
    if (!Number.isFinite(ts)) return;
    const start = Math.floor(ts / bucketMs) * bucketMs;
    const key = String(start);
    if (!map.has(key)) {
      map.set(key, {
        from: new Date(start).toISOString(),
        to: new Date(start + bucketMs).toISOString(),
        samples: 0,
        delegationCreated: 0,
        delegationCompleted: 0,
        delegationRejected: 0,
        stalledEscalations: 0,
        overdueEscalations: 0
      });
    }
    const entry = map.get(key)!;
    entry.samples += 1;
    entry.delegationCreated += s.summary.delegationCreated || 0;
    entry.delegationCompleted += s.summary.delegationCompleted || 0;
    entry.delegationRejected += s.summary.delegationRejected || 0;
    entry.stalledEscalations += s.summary.stalledEscalations || 0;
    entry.overdueEscalations += s.summary.overdueEscalations || 0;
  });
  return {
    bucketHours: effectiveBucketHours,
    buckets: Array.from(map.values()).sort((a, b) => Date.parse(a.from) - Date.parse(b.from))
  };
}

function buildAgentPerformanceMetrics() {
  const now = Date.now();
  const allTasks = taskManager.getAllTasks();
  const allDelegations = delegationManager.list({ limit: 1000 });
  const recentAudits = executionAuditStore.list(500);
  const activeTaskStatuses: TaskStatus[] = ['pending', 'assigned', 'in_progress', 'blocked', 'rolling_back'];
  const terminalTaskStatuses: TaskStatus[] = ['completed', 'failed', 'cancelled', 'dropped', 'rolled_back'];

  return organization.getAllAgents().map(agent => {
    const assignedTasks = allTasks.filter(t => t.assignedTo === agent.id);
    const ownedTasks = allTasks.filter(t => t.ownerId === agent.id);
    const relatedTasks = allTasks.filter(t => t.assignedTo === agent.id || t.ownerId === agent.id);
    const activeAssignedTasks = assignedTasks.filter(t => activeTaskStatuses.includes(t.status));
    const completedTasks = relatedTasks.filter(t => ['completed', 'rolled_back'].includes(t.status));
    const failedTasks = relatedTasks.filter(t => ['failed', 'cancelled', 'dropped'].includes(t.status));
    const terminalTasks = relatedTasks.filter(t => terminalTaskStatuses.includes(t.status));
    const successRate = terminalTasks.length === 0
      ? null
      : Number(((completedTasks.length / terminalTasks.length) * 100).toFixed(1));

    const durations = relatedTasks
      .filter(t => t.completedAt && ['completed', 'rolled_back', 'failed', 'cancelled', 'dropped'].includes(t.status))
      .map(t => taskDurationMinutes(t.createdAt, t.completedAt, now))
      .filter((duration): duration is number => duration !== null);
    const meanTaskDurationMinutes = durations.length === 0
      ? null
      : Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1));

    const activeDelegations = allDelegations.filter(d =>
      d.assigneeAgentId === agent.id
      && ['proposed', 'approved', 'dispatched', 'accepted'].includes(d.state)
    );
    const executionByAgent = recentAudits.filter(r => r.agentId === agent.id);
    const executionAllowed = executionByAgent.filter(r => r.status === 'allowed').length;
    const executionBlocked = executionByAgent.filter(r => r.status === 'blocked').length;
    const executionErrors = executionByAgent.filter(r => r.status === 'error').length;
    const executionDurations = executionByAgent
      .map(r => r.durationMs)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const meanExecutionDurationMs = executionDurations.length === 0
      ? null
      : Number((executionDurations.reduce((a, b) => a + b, 0) / executionDurations.length).toFixed(1));

    return {
      agentId: agent.id,
      name: agent.name,
      role: agent.role,
      skills: agent.config.skills || [],
      queueDepth: activeAssignedTasks.length + activeDelegations.length,
      activeAssignedTasks: activeAssignedTasks.length,
      activeDelegations: activeDelegations.length,
      ownedTasks: ownedTasks.length,
      assignedTasks: assignedTasks.length,
      completedTasks: completedTasks.length,
      failedTasks: failedTasks.length,
      successRate,
      meanTaskDurationMinutes,
      executions: {
        total: executionByAgent.length,
        allowed: executionAllowed,
        blocked: executionBlocked,
        error: executionErrors,
        meanDurationMs: meanExecutionDurationMs
      }
    };
  }).sort((a, b) =>
    (b.queueDepth - a.queueDepth)
    || (b.executions.total - a.executions.total)
    || a.name.localeCompare(b.name)
  );
}

// REST API endpoints
app.use(express.json({ limit: '1mb' }));

// Body sanitisation: strips control chars + script/event-attr/javascript:
// URIs from string fields, caps recursion depth and per-string length.
// Runs in-place on req.body so downstream handlers see cleaned values
// without any per-route change. Markdown-heavy fields (content,
// description, message, aiAnalysis, aiRaw) are exempted from the
// aggressive HTML stripping so embedded code blocks survive.
app.use(sanitiseBodyMiddleware());

// Security headers (helmet) + disable x-powered-by. Applied here so
// every response (success, 4xx, 5xx) carries the headers — must be
// installed BEFORE any route handler runs. CORS sits after helmet so
// the CORS allow-origin echo isn't fenced by helmet's CSP wrapper.
applySecurity(app);

// CORS: allow configured UI origins (HTTP public URL + optional HTTPS Beacon URL)
const allowedOrigins: string[] = [
  process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '19123'}`,
  ...(process.env.BEACON_HTTPS_URL ? [process.env.BEACON_HTTPS_URL] : []),
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Request-Id');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id,RateLimit-Limit,RateLimit-Remaining,RateLimit-Reset');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});
// Per-spec rate limits now live in securityMiddleware.ts:
//   * authLimiterTight  → 5/min on /api/auth/{login,register}
//   * globalLimiter     → 100/min on /api/*
//   * aiLimiter         → 20/min per-JWT-subject on chat + analyze
// Previously inline `authLimiter` / `apiLimiter` are no longer
// defined here — every mount references the shared module.

// Prometheus metrics endpoint — no auth required (standard convention)
app.get('/metrics', (_req, res) => {
  const incidents = incidentManager.list({});
  const openIncidents = incidents.filter(i => i.status === 'open').length;
  const inProgressIncidents = incidents.filter(i => i.status === 'in_progress' || i.status === 'investigating' || i.status === 'mitigating').length;
  const resolvedIncidents = incidents.filter(i => i.status === 'resolved' || i.status === 'closed').length;
  const criticalIncidents = incidents.filter(i => i.severity === 'critical').length;
  const highIncidents = incidents.filter(i => i.severity === 'high').length;
  const mediumIncidents = incidents.filter(i => i.severity === 'medium').length;
  const lowIncidents = incidents.filter(i => i.severity === 'low').length;

  const allAgents = organization.getAllAgents();
  const directorAgents = allAgents.filter(a => a.role === 'director').length;
  const sysadminAgents = allAgents.filter(a => a.role === 'sysadmin').length;
  const specialistAgents = allAgents.filter(a => a.role === 'specialist').length;

  const pendingTasks = taskManager.getPendingTasks().length;

  const mem = process.memoryUsage();

  const lines = [
    '# HELP beacon_incidents_total Total incidents by status',
    '# TYPE beacon_incidents_total gauge',
    `beacon_incidents_total{status="open"} ${openIncidents}`,
    `beacon_incidents_total{status="in_progress"} ${inProgressIncidents}`,
    `beacon_incidents_total{status="resolved"} ${resolvedIncidents}`,
    '',
    '# HELP beacon_incidents_by_severity Total incidents by severity',
    '# TYPE beacon_incidents_by_severity gauge',
    `beacon_incidents_by_severity{severity="critical"} ${criticalIncidents}`,
    `beacon_incidents_by_severity{severity="high"} ${highIncidents}`,
    `beacon_incidents_by_severity{severity="medium"} ${mediumIncidents}`,
    `beacon_incidents_by_severity{severity="low"} ${lowIncidents}`,
    '',
    '# HELP beacon_agents_total Total agents by type',
    '# TYPE beacon_agents_total gauge',
    `beacon_agents_total{type="director"} ${directorAgents}`,
    `beacon_agents_total{type="sysadmin"} ${sysadminAgents}`,
    `beacon_agents_total{type="specialist"} ${specialistAgents}`,
    '',
    '# HELP beacon_tasks_pending_total Number of pending tasks',
    '# TYPE beacon_tasks_pending_total gauge',
    `beacon_tasks_pending_total ${pendingTasks}`,
    '',
    '# HELP beacon_uptime_seconds Server uptime in seconds',
    '# TYPE beacon_uptime_seconds counter',
    `beacon_uptime_seconds ${Math.floor(process.uptime())}`,
    '',
    '# HELP beacon_memory_heap_used_bytes Heap memory used in bytes',
    '# TYPE beacon_memory_heap_used_bytes gauge',
    `beacon_memory_heap_used_bytes ${mem.heapUsed}`,
    '',
    '# HELP beacon_memory_rss_bytes Resident set size memory in bytes',
    '# TYPE beacon_memory_rss_bytes gauge',
    `beacon_memory_rss_bytes ${mem.rss}`,
    '',
  ];

  // PrometheusPlugin contributions, if enabled. Concatenated after the
  // hand-rolled beacon_* lines so external scrapers see both. When the
  // plugin is disabled this is a cheap no-op (empty string).
  const pluginMetrics = pluginManager?.renderPrometheus() ?? '';

  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(lines.join('\n') + (pluginMetrics ? '\n' + pluginMetrics : ''));
});

// Production-hardening: spec-aligned limits (5/min on auth, 100/min
// global, 20/min per-user on AI/chat). Mounted via the shared
// securityMiddleware module so error envelopes stay consistent.
app.use('/api/auth/login',    authLimiterTight);
app.use('/api/auth/register', authLimiterTight);
app.use('/api/chat',          aiLimiter);
app.use('/api/incidents/:id/analyze', aiLimiter);
app.use('/api/', globalLimiter);
app.use('/api/codex-bridge', (req, res, next) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'tools.execute.safe');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  next();
}, codexBridgeRouter);
app.use('/api/agent-bridge', agentBridgeRouter);

// ── Phase 15: RBAC Management + Plugin API ───────────────────────────────────
app.use("/api/rbac", requireAuth("users.manage"), createRbacRouter(authService, apiKeyService, auditLog));
app.use("/api/plugins", requireAuth("config.write"), createPluginRouter(pluginLoader));
app.get("/api/audit", requireAuth("audit.read"), (req, res) => {
  const { username, action, resource, success, since, limit } = req.query;
  const entries = auditLog.query({
    username: username as string, action: action as string, resource: resource as string,
    success: success === "true" ? true : success === "false" ? false : undefined,
    since: since as string, limit: limit ? parseInt(limit as string, 10) : undefined
  });
  res.json(entries);
});
app.get("/api/audit/stats", requireAuth("audit.read"), (_req, res) => { res.json(auditLog.getStats()); });
// Org Chart API
app.use('/api/org-chart', (req, res, next) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'delegations.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  next();
}, orgChartRouter);

// API Keys management
app.use('/api/api-keys', (req, res, next) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  next();
}, apiKeysRouter);

// Credentials management
app.use('/api/credentials', (req, res, next) => {
  const requiredPermission: Permission =
    req.method === 'GET'
      ? 'credentials.read'
      : 'credentials.write';
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, requiredPermission);
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  next();
}, credentialsRouter);

// Agent configuration
app.use('/api/agent-config', (req, res, next) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  next();
}, agentConfigRouter);


app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: 'username and password are required' });
      return;
    }

    // 1. Try LDAP if configured
    if (adManager.isLDAPEnabled) {
      try {
        const adResult = await adManager.tryLDAP(String(username), String(password));
        if (adResult) {
          // Issue a local JWT for the AD-authenticated user (upsert so token works)
          authService.upsertADUser(adResult.username, adResult.role, adResult.displayName, adResult.email);
          const issued = authService.issueTokenForADUser(adResult.username, adResult.role);
          if (issued) {
            res.json({ success: true, session: issued, source: 'ldap' });
            return;
          }
        }
      } catch (ldapErr: any) {
        // LDAP unreachable — log and fall through to local auth
        logger.warn('[Auth] LDAP error, falling back to local:', { err: ldapErr?.message });
      }
    }

    // 2. Local auth fallback (always available for local admin accounts)
    const issued = authService.issueToken(String(username), String(password));
    if (!issued) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    res.json({ success: true, session: issued, source: 'local' });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  // Stateless JWT auth — client must discard the token.
  res.json({ success: true, message: 'Logged out. Discard your token on the client side.' });
});

// ── Self-service registration + invite ────────────────────────────────
// /api/auth/register — open endpoint that creates a new tenant + admin
// user in one shot. Rate-limited tight (3/hour/IP, see registerLimiter
// below) to prevent abuse from a single IP. The tenant gets the 'free'
// plan by default — operators bump to pro/enterprise via superadmin.
const inviteStore = new InviteStore(process.env.TENANT_INVITES_DB_PATH || '/data/itops-agents/tenant-invites.db');
// Cloudflare DNS provisioning: when CLOUDFLARE_API_TOKEN +
// CLOUDFLARE_ZONE_ID are set, RegistrationService creates a proxied
// CNAME for each new tenant's `{slug}-itops.<zone>` subdomain pointing
// at the shared Cloudflare Tunnel. Disabled silently when env is unset.
const cloudflareDnsCfg = cloudflareDnsConfigFromEnv();
const dnsService = cloudflareDnsCfg ? new CloudflareDnsService(cloudflareDnsCfg) : undefined;
const registrationService = new RegistrationService({
  tenants: storeFactory.tenants,
  invites: inviteStore,
  authService,
  defaultPlan: 'free',
  dnsService,
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.REGISTER_LIMIT_PER_HOUR) || 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Try again later.' },
});
app.use('/api/auth/register', registerLimiter);

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, orgName, fullName } = req.body || {};
    const result = await registrationService.register({
      email: String(email ?? ''),
      password: String(password ?? ''),
      orgName: String(orgName ?? ''),
      fullName: typeof fullName === 'string' ? fullName : undefined,
    });
    auditLog.log({
      action: 'auth.register',
      username: result.username, role: 'admin',
      resource: `/tenants/${result.tenantId}`, method: 'POST',
      ip: req.ip || '', success: true, detail: `slug=${result.slug}`,
    });
    res.json({ success: true, session: result.session, tenant: { id: result.tenantId, slug: result.slug } });
  } catch (e: any) {
    if (e instanceof RegistrationError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/auth/invite — tenant admin invites another user.
app.post('/api/auth/invite', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'users.manage');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  // Scope strictly to the caller's tenant. Superadmin can pass tenantId
  // in the body to invite into another tenant — admin cannot.
  const callerTenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  const requestedTenantId = typeof req.body?.tenantId === 'string' ? req.body.tenantId : callerTenantId;
  if (auth.role !== 'superadmin' && requestedTenantId !== callerTenantId) {
    res.status(403).json({ error: 'Cannot invite into another tenant' });
    return;
  }
  const { email, role, ttlDays } = req.body || {};
  try {
    const out = registrationService.inviteUser({
      tenantId: requestedTenantId,
      email: String(email ?? ''),
      role: (role ?? 'viewer') as any,
      invitedBy: auth.username ?? 'system',
      ttlDays: typeof ttlDays === 'number' ? ttlDays : undefined,
    });
    auditLog.log({
      action: 'auth.invite.create', username: auth.username ?? 'system', role: auth.role ?? 'admin',
      resource: `/tenants/${requestedTenantId}/invites/${out.id}`, method: 'POST',
      ip: req.ip || '', success: true, detail: `email=${email} role=${role}`,
    });
    // Fire-and-forget invite email. Resolve the tenant name for the
    // subject line; fall back to slug if the lookup races. Failures
    // never block the invite response — the token is returned to the
    // admin regardless so out-of-band delivery still works.
    void Promise.resolve(storeFactory.tenants.get(requestedTenantId))
      .then(t => emailService.sendInvite(String(email), out.token, t?.name ?? t?.slug ?? 'RightAPI Forge'))
      .catch(e => logger.warn('[Email] sendInvite threw', { err: e instanceof Error ? e.message : String(e) }));
    res.json({ success: true, invite: out });
  } catch (e: any) {
    if (e instanceof RegistrationError) { res.status(e.status).json({ error: e.message }); return; }
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/auth/join — invitee accepts an invite. Open (no auth) but
// the token is single-use and TTL-bounded.
app.post('/api/auth/join', async (req, res) => {
  try {
    const { token, username, password, fullName } = req.body || {};
    const result = await registrationService.join({
      token: String(token ?? ''),
      username: String(username ?? ''),
      password: String(password ?? ''),
      fullName: typeof fullName === 'string' ? fullName : undefined,
    });
    auditLog.log({
      action: 'auth.invite.accepted',
      username: result.username, role: 'viewer',
      resource: `/tenants/${result.tenantId}`, method: 'POST',
      ip: req.ip || '', success: true,
    });
    res.json({ success: true, session: result.session, tenant: { id: result.tenantId, slug: result.slug } });
  } catch (e: any) {
    if (e instanceof RegistrationError) { res.status(e.status).json({ error: e.message }); return; }
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// GET /api/auth/me — return the current principal + tenant context.
// Used by the client right after login to populate the user menu and
// decide whether to land on the dashboard, the portal, or the
// onboarding wizard.
app.get('/api/auth/me', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined);
  if (!auth.ok) { res.status(401).json({ error: auth.reason || 'Unauthorized' }); return; }
  const user = authService.getUser(auth.username ?? '');
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  // Fetch tenant info for the UI's org-name display.
  void Promise.resolve(storeFactory.tenants.get(user.tenantId)).then(t => {
    res.json({
      user: { username: user.username, email: user.email, role: user.role, tenantId: user.tenantId },
      tenant: t ? {
        id: t.id, slug: t.slug, name: t.name, plan: t.plan,
        status: t.status, settings: t.settings,
      } : null,
    });
  }).catch(err => res.status(500).json({ error: err?.message ?? String(err) }));
});

// GET /api/tenant/invites — list pending invites for the caller's tenant.
app.get('/api/tenant/invites', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'users.manage');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const tenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  const includeAccepted = String(req.query.includeAccepted ?? '') === 'true';
  const invites = inviteStore.listForTenant(tenantId, { includeAccepted })
    .map(i => ({ id: i.id, email: i.email, role: i.role, status: i.status,
                 invitedBy: i.invitedBy, createdAt: i.createdAt, expiresAt: i.expiresAt,
                 acceptedAt: i.acceptedAt, acceptedBy: i.acceptedBy }));
  res.json({ invites });
});

// POST /api/tenant/invites/:id/revoke — admin revokes a pending invite.
// ── Onboarding wizard ───────────────────────────────────────────────────
// State lives in the tenant's settings.onboarding JSON. The client polls
// /api/onboarding/status on login; if `completed=false` it routes to
// the wizard, otherwise straight to the dashboard.
const onboardingService = new OnboardingService(storeFactory.tenants);
const ONBOARDING_STEPS = new Set<OnboardingStep>(['welcome', 'servers', 'sla', 'team', 'done']);

app.get('/api/onboarding/status', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined);
  if (!auth.ok) { res.status(401).json({ error: auth.reason || 'Unauthorized' }); return; }
  const tenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  try {
    const status = await onboardingService.status(tenantId);
    res.json(status);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post('/api/onboarding/step/:step', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const tenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  const step = req.params.step as OnboardingStep;
  if (!ONBOARDING_STEPS.has(step)) { res.status(400).json({ error: `Unknown step: ${step}` }); return; }
  try {
    const status = await onboardingService.saveStep(tenantId, step, req.body || {});
    auditLog.log({
      action: 'onboarding.step.saved',
      username: auth.username ?? 'system', role: auth.role ?? 'admin',
      resource: `/tenants/${tenantId}/onboarding/${step}`, method: 'POST',
      ip: req.ip || '', success: true,
    });
    res.json(status);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post('/api/onboarding/reset', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const tenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  try {
    const status = await onboardingService.reset(tenantId);
    res.json(status);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post('/api/tenant/invites/:id/revoke', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'users.manage');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const ok = inviteStore.revoke(req.params.id);
  if (!ok) { res.status(404).json({ error: 'Invite not found or already accepted/revoked' }); return; }
  auditLog.log({
    action: 'auth.invite.revoked',
    username: auth.username ?? 'system', role: auth.role ?? 'admin',
    resource: `/invites/${req.params.id}`, method: 'POST',
    ip: req.ip || '', success: true,
  });
  res.json({ success: true });
});

// POST /api/auth/refresh — issue a fresh JWT for the principal carried in
// the current Bearer token. No password required; only a verifiable
// (non-expired, signed-by-us) token. The client uses this to rotate
// sessions without re-prompting. Audit logged so a compromised token's
// refresh trail is visible in /api/audit.
app.post('/api/auth/refresh', (req, res) => {
  const token = AuthService.extractBearerToken(req.header('authorization') || undefined);
  if (!token) {
    auditLog.log({ action: 'auth.refresh.miss', username: 'anonymous', role: 'unknown', resource: req.path, method: req.method, ip: req.ip || '', success: false, detail: 'missing bearer token' });
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }
  const issued = authService.refreshToken(token);
  if (!issued) {
    auditLog.log({ action: 'auth.refresh.fail', username: 'anonymous', role: 'unknown', resource: req.path, method: req.method, ip: req.ip || '', success: false, detail: 'token invalid or expired' });
    res.status(401).json({ error: 'Token invalid or expired' });
    return;
  }
  auditLog.log({ action: 'auth.refresh.ok', username: issued.username, role: issued.role, resource: req.path, method: req.method, ip: req.ip || '', success: true });
  res.json({ success: true, session: issued });
});

// ── Azure AD OAuth2 redirect routes (non-API — no /api prefix) ───────────────
app.get('/auth/azure', async (_req, res) => {
  if (!adManager.isAzureEnabled) {
    res.status(404).send('Azure AD not configured');
    return;
  }
  try {
    const url = await adManager.azureProvider!.getAuthorizationUrl();
    res.redirect(url);
  } catch (err: any) {
    res.status(500).send(`Azure AD error: ${err?.message}`);
  }
});

app.get('/auth/azure/callback', async (req, res) => {
  if (!adManager.isAzureEnabled) {
    res.status(404).send('Azure AD not configured');
    return;
  }
  try {
    const params = req.query as Record<string, string>;
    if (params.error) {
      res.redirect(`/login.html?error=${encodeURIComponent(params.error_description ?? params.error)}`);
      return;
    }
    const result = await adManager.handleAzureCallback(params);
    if (!result.success) {
      res.redirect(`/login.html?error=${encodeURIComponent(result.error ?? 'Azure AD login failed')}`);
      return;
    }
    // Upsert the AD user and issue a local JWT
    authService.upsertADUser(result.username, result.role, result.displayName, result.email);
    const issued = authService.issueTokenForADUser(result.username, result.role);
    if (!issued) {
      res.redirect('/login.html?error=token_issuance_failed');
      return;
    }
    // Deliver token via a self-submitting HTML page (avoids query string exposure)
    res.send(`<!DOCTYPE html><html><head><title>Signing in…</title></head><body>
<script>
  localStorage.setItem('itops_token','${issued.token}');
  sessionStorage.setItem('itops_token','${issued.token}');
  window.location.href='/index.html';
</script>
<p>Signing in, please wait…</p></body></html>`);
  } catch (err: any) {
    res.redirect(`/login.html?error=${encodeURIComponent(err?.message ?? 'callback error')}`);
  }
});

// /api/settings/* — extracted to ./settingsApi.ts (AD/LDAP, MS Teams, SMTP,
// scheduled reports, Slack, Discord — all gated by config.write).
app.use('/api/settings', createSettingsRouter({
  adConfigStore,
  adManager,
  teamsConfigStore,
  teamsProvider,
  smtpService,
  reportsScheduler,
  slackService,
  discordService,
  incidentManager,
  organization,
  taskManager,
  validateAuth: validateAuthFromHeader,
}));

// Return whether AD providers are enabled (public — used by login page).
// Stays inline because it's an unauthenticated /api/auth probe, not a
// settings endpoint.
app.get('/api/auth/providers', (_req, res) => {
  res.json({
    ldap: adManager.isLDAPEnabled,
    azure: adManager.isAzureEnabled,
    azureLoginUrl: adManager.isAzureEnabled ? '/auth/azure' : null,
  });
});

// ── In-App Notifications API ──────────────────────────────────────────────────
app.get('/api/notifications', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const rows = notificationsDb.prepare(
    `SELECT * FROM notifications ORDER BY read ASC, created_at DESC LIMIT ?`
  ).all(limit);
  res.json(rows);
});

app.put('/api/notifications/read-all', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  notificationsDb.prepare(`UPDATE notifications SET read = 1`).run();
  res.json({ success: true });
});

app.put('/api/notifications/:id/read', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  notificationsDb.prepare(`UPDATE notifications SET read = 1 WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

app.delete('/api/notifications', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  notificationsDb.prepare(`DELETE FROM notifications`).run();
  res.json({ success: true });
});

// ── MS Teams inbound webhook (Outgoing Webhook from Teams) ───────────────────
// Mount raw body middleware only for this route so we can verify HMAC
app.post('/integrations/teams/message',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const cfg = teamsConfigStore.config;
    if (!cfg.enabled) {
      res.status(403).json({ type: 'message', text: 'Teams integration is disabled.' });
      return;
    }

    // Generic HMAC guard: if WEBHOOK_SECRET is set, validate x-signature-256 / x-hub-signature-256
    const webhookSecret = process.env.WEBHOOK_SECRET;
    if (webhookSecret) {
      const sig = (req.headers['x-signature-256'] || req.headers['x-hub-signature-256']) as string | undefined;
      if (sig) {
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
        const result = validateHmacWebhook(rawBody, sig, webhookSecret);
        if (!result.valid) {
          res.status(401).json({ type: 'message', text: '⛔ Invalid webhook signature.' });
          return;
        }
      }
    }

    // Verify Teams HMAC signature if secret is configured
    if (cfg.outgoingWebhookSecret) {
      const authHeader = req.header('authorization') ?? '';
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
      const handler = new TeamsWebhookHandler(cfg.outgoingWebhookSecret, async () => '');
      if (!handler.verifySignature(rawBody, authHeader)) {
        res.status(401).json({ type: 'message', text: '⛔ Signature verification failed.' });
        return;
      }
    }

    // Parse body
    let msg: any;
    try {
      msg = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
    } catch {
      res.status(400).json({ type: 'message', text: 'Invalid JSON body.' });
      return;
    }

    // Build agent runner using A2A task runner
    const agentRunner = async (text: string, userId: string): Promise<string> => {
      if (!a2aTaskRunner) return 'Agent system not initialised.';
      try {
        const result = await a2aTaskRunner.send('it-director', {
          id: `teams-${Date.now()}`,
          message: { role: 'user', parts: [{ type: 'text', text }] },
        });
        return (result as any)?.output ?? (result as any)?.message ?? 'No response from agent.';
      } catch (err: any) {
        return `Agent error: ${err?.message}`;
      }
    };

    const handler = new TeamsWebhookHandler(
      cfg.outgoingWebhookSecret || '',
      agentRunner,
    );
    const response = await handler.handle(msg);
    res.json(response);
  }
);

// Auth users + roles CRUD — extracted to ./authUsersApi.ts. validateAuth is
// passed as a function dep so the router doesn't reach back into server.ts.
// Login / Azure-AD / settings/* routes intentionally remain inline above —
// they have LDAP fallback + AD redirect logic that's higher-leverage to break
// on extraction. Extract them in a follow-up.
app.use('/api/auth', createAuthUsersRouter({
  authService,
  rolesDb,
  validateAuth: validateAuthFromHeader,
  auditLog,
}));

// ─────────────────────────────────────────────────────────────────────────────

// Deep health check. Composed from probes so each subsystem is independently
// queryable, with per-probe pass/warn/fail and overall healthy/degraded/
// unhealthy. Constructed once on startup; the route handler runs it.
import {
  HealthChecker,
  sqliteProbe,
  aiProviderProbe,
  diskSpaceProbe,
  activeTasksProbe,
  circuitBreakerProbe,
  postgresProbe,
  redisProbe,
  websocketProbe,
  aiProxyReachabilityProbe,
  selectAIProviderBaseUrl,
  processProbe,
} from './healthCheck.js';
import {
  metricsMiddleware,
  renderMetrics,
  setWsCountProvider,
} from '../observability/Metrics.js';
import { BeaconSelfMonitor } from '../observability/BeaconSelfMonitor.js';

// Storage factory — initialised here so DB_PROVIDER=postgres triggers schema
// migration + connection pool warm-up at startup. Legacy IncidentManager /
// agentMemoryStore consumers below still construct SqliteXyzStore directly
// (they're sync-coupled and migrating them is out of scope for this commit).
// New code should consume getStoreFactory() and await its async methods.
// getStoreFactory is imported earlier in the file (where storeFactory
// is constructed for the ScheduleEngine). closeSharedPool +
// getSharedPool are still needed by the postgres lifecycle hooks
// further down, so import them here.
import { closeSharedPool, getSharedPool } from '../persistence/PostgresStore.js';

// EventBus — durable publish/subscribe atop StoreFactory.events. Every
// meaningful state change (task lifecycle, skill calls, workflow steps,
// credential rotation, …) is appended to the event log, then fanned out
// to in-process subscribers. The store is the source of truth; the bus
// is only the live-delivery layer, so a crash mid-fanout doesn't lose
// events — they're already on disk and replay can pick up where the
// dead subscriber left off.
import { EventBus } from '../events/EventBus.js';
import { EventTypes, AggregateTypes } from '../events/EventTypes.js';
const eventBus = new EventBus(storeFactory.events);

// Tenant infrastructure — the registry is initialised by StoreFactory
// (it auto-creates the "system" tenant). The middleware extracts the
// tenant from the API key (or X-Tenant-ID for admin overrides) and the
// scoped event bus auto-tags + isolates published events. Existing
// single-tenant deployments keep working: API keys minted before this
// commit default to the system tenant, the middleware reads it, and
// every operation that doesn't set X-Tenant-ID stays under "system".
import { createTenantMiddleware } from '../tenancy/tenantMiddleware.js';
import { InviteStore } from '../tenancy/InviteStore.js';
import { RegistrationService, RegistrationError } from '../tenancy/RegistrationService.js';
import { CloudflareDnsService, cloudflareDnsConfigFromEnv } from '../tenancy/CloudflareDnsService.js';
import { OnboardingService, type OnboardingStep, STEP_NUMBERS } from '../tenancy/OnboardingService.js';
import { PlanEnforcer, PLAN_LIMITS, type PlanCheckResult } from '../tenancy/PlanEnforcer.js';
import { TenantScopedEventBus } from '../events/TenantScopedEventBus.js';
import { runWithTenant, SYSTEM_TENANT_ID } from '../tenancy/TenantContext.js';
const tenantBus = new TenantScopedEventBus(eventBus, storeFactory.events);
// Tenant middleware — resolves the tenant for every request from the
// hostname (custom_domain → subdomain on TENANT_BASE_DOMAIN) plus the
// JWT and X-Tenant-ID header. Unset TENANT_BASE_DOMAIN keeps the legacy
// JWT-only behaviour intact for single-tenant deployments.
app.use(createTenantMiddleware(storeFactory.tenants, {
  baseDomain: process.env.TENANT_BASE_DOMAIN || undefined,
  reservedSubdomains: process.env.TENANT_RESERVED_SUBDOMAINS
    ? process.env.TENANT_RESERVED_SUBDOMAINS.split(',').map(s => s.trim()).filter(Boolean)
    : undefined,
}));

void eventBus.publish({
  // System lifecycle events stay under the system tenant by definition.
  tenantId: SYSTEM_TENANT_ID,
  aggregateType: AggregateTypes.SYSTEM, aggregateId: 'beacon-itops',
  type: EventTypes.SYSTEM_STARTED, actor: 'system',
  data: { provider: storeFactory.getProvider(), pid: process.pid },
}).catch(err => serverLog.warn('failed to record system.started event', { err: err?.message }));

// Reference tenantBus + runWithTenant so they're not flagged as unused
// while the migration to tenant-scoped emit sites is incremental.
void tenantBus; void runWithTenant;

// Personality engine — per-agent profile that evolves on feedback,
// reflection, and resolution outcomes. The engine doesn't know about
// the EventBus directly; we forward its onAdjustment callback through
// to a personality.adjusted event so dashboards can observe drift.
import { PersonalityEngine } from '../agents/personality/PersonalityEngine.js';
const personalityEngine = new PersonalityEngine({
  store: storeFactory.personality,
  onAdjustment: (rec) => {
    void eventBus.publish({
      tenantId: SYSTEM_TENANT_ID,
      aggregateType: 'agent', aggregateId: rec.agentId,
      type: 'personality.adjusted', actor: 'personality-engine',
      data: {
        signal: rec.signal,
        before: { communication: rec.before.communication, decisions: rec.before.decisions },
        after:  { communication: rec.after.communication,  decisions: rec.after.decisions  },
        driftClamps: rec.after.stats.driftClamps,
      },
    }).catch(() => undefined);
  },
});

// RBAC — role definitions + user/tenant/role bindings. Layered on
// top of the legacy AuthService roles. Backward-compatible default:
// keys with no assignment fall back to super_admin so existing
// deployments keep working until an operator populates the table.
import { RbacService } from '../security/rbac/RbacService.js';
import { createRbacMiddleware } from '../security/rbac/rbacMiddleware.js';
const rbacService = new RbacService({
  store: storeFactory.rbac,
  legacyFallbackToSuperAdmin: (process.env.RBAC_LEGACY_FALLBACK ?? 'true').toLowerCase() !== 'false',
});
void rbacService.seedBuiltins().catch(err => serverLog.warn('rbac seed failed', { err: err?.message }));
const { requirePermission } = createRbacMiddleware(rbacService);

// ServiceRegistry — register the long-lived services every module
// touches so future split into microservices is mechanical: each
// consumer asks the registry for what it needs by token, never
// reaches across boundaries directly.
import { getServiceRegistry } from '../modules/ServiceRegistry.js';
const services = getServiceRegistry();
services.register({ token: 'persistence.tasks',       moduleId: 'persistence', instance: storeFactory.tasks });
services.register({ token: 'persistence.incidents',   moduleId: 'persistence', instance: storeFactory.incidents });
services.register({ token: 'persistence.agentMemory', moduleId: 'persistence', instance: storeFactory.agentMemory });
services.register({ token: 'persistence.events',      moduleId: 'persistence', instance: storeFactory.events });
services.register({ token: 'persistence.tenants',     moduleId: 'persistence', instance: storeFactory.tenants });
services.register({ token: 'persistence.personality', moduleId: 'persistence', instance: storeFactory.personality });
services.register({ token: 'events.bus',              moduleId: 'events',      instance: eventBus });
services.register({ token: 'events.tenantBus',        moduleId: 'events',      instance: tenantBus });
services.register({ token: 'agents.personality',      moduleId: 'agents',      instance: personalityEngine });
services.register({ token: 'security.rbac',           moduleId: 'security',    instance: rbacService });

// Message-bus factory — when MESSAGE_BUS=redis is set, this warms a single
// shared Redis connection at startup so the health probe + shutdown hook
// have a live client to reference. The default (memory) is the in-process
// AgentMessageBus already created above; on Redis-failure the factory falls
// back to the in-memory bus and logs a warning rather than crashing the
// process. Same incremental-migration caveat as the store factory: legacy
// agentBus consumers below keep using the sync AgentMessageBus instance.
import { getMessageBus, getActiveRedisClient, resetMessageBus } from '../messaging/MessageBusFactory.js';
getMessageBus({ memoryPath: process.env.AGENT_BUS_PATH || '/data/itops-agents/agent-bus.json' })
  .then(bus => serverLog.info('message bus factory ready', {
    provider: process.env.MESSAGE_BUS || 'memory',
    redisLive: getActiveRedisClient() !== null,
  }))
  .catch(err => serverLog.warn('message bus factory init failed — running on memory bus', { err: err?.message }));

const healthChecker = new HealthChecker();
healthChecker.register(sqliteProbe('roles_db',         () => rolesDb.prepare('SELECT 1 AS ok')));
healthChecker.register(sqliteProbe('notifications_db', () => notificationsDb.prepare('SELECT 1 AS ok')));
healthChecker.register(postgresProbe(() => {
  // Only probe when DB_PROVIDER=postgres; the null-pool branch is treated
  // as "configured: false, status: pass" by the probe (sqlite mode doesn't
  // need a postgres pool).
  if (storeFactory.getProvider() !== 'postgres') return null;
  try { return getSharedPool({ connectionString: process.env.POSTGRES_URL || '' }); }
  catch { return null; }
}));
// Same shape as postgresProbe: returns "configured: false / pass" when no
// Redis client is active, and only fails when Redis is wired in but the
// PING errors. Critical:true — a broken bus silently drops messages, which
// is worse than serving a 503 and getting reported.
healthChecker.register(redisProbe(() => getActiveRedisClient()));
healthChecker.register(aiProviderProbe({
  hasAnthropic: !!process.env.ANTHROPIC_API_KEY,
  hasOpenai:    !!process.env.OPENAI_API_KEY,
  hasOllama:    !!process.env.OLLAMA_BASE_URL,
}));
healthChecker.register(diskSpaceProbe({
  path: process.env.DATA_DIR || '/data/itops-agents',
  warnPctFree: 0.10,
  failPctFree: 0.02,
}));
healthChecker.register(activeTasksProbe(() => {
  const stats = taskManager.getStatistics();
  return {
    inProgress:  stats.in_progress  || 0,
    assigned:    stats.assigned     || 0,
    rollingBack: stats.rolling_back || 0,
  };
}));
healthChecker.register(circuitBreakerProbe(() => skillManager.listCircuitBreakers()));
// Self-observability probes — surface live runtime numbers + the AI
// proxy reachability check that the rest of the platform depends on.
healthChecker.register(websocketProbe(() => clients.size));
healthChecker.register(aiProxyReachabilityProbe({
  baseUrl: selectAIProviderBaseUrl(process.env),
  timeoutMs: 2000,
  critical: false,
}));
const providerHealthMonitor = new ProviderHealthMonitor(
  process.env.PROVIDER_HEALTH_STATE_PATH || '/data/itops-agents/provider-health.json',
);
let providerProbeInFlight: Promise<ReturnType<ProviderHealthMonitor['snapshot']>> | null = null;
async function runProviderHealthProbe(): Promise<ReturnType<ProviderHealthMonitor['snapshot']>> {
  if (providerProbeInFlight) return providerProbeInFlight;
  providerProbeInFlight = (async () => {
    const previous = providerHealthMonitor.snapshot();
    const routes = await aiFactory.probeOpenAIRoutes();
    const primary = routes.find(route => route.route === 'primary');
    const fallback = routes.find(route => route.route === 'fallback');
    const activeRoute = primary?.lastSuccessAt && primary.breaker.state !== 'OPEN' && primary.modelAligned
      ? 'primary'
      : fallback?.lastSuccessAt && fallback.breaker.state !== 'OPEN' && fallback.modelAligned ? 'fallback' : null;
    const current = providerHealthMonitor.evaluate(routes, activeRoute);
    if (current.status !== previous.status || current.alert?.active !== previous.alert?.active) {
      const event = { previous: previous.status, current: current.status, alert: current.alert };
      broadcast({ type: 'provider_health', data: event });
      if (current.status === 'healthy') serverLog.info('provider control plane recovered', event);
      else serverLog.warn('provider control plane degraded', event);
    }
    return current;
  })().finally(() => { providerProbeInFlight = null; });
  return providerProbeInFlight;
}

healthChecker.register({
  name: 'provider_control_plane',
  critical: false,
  fn: async () => {
    const snapshot = providerHealthMonitor.snapshot();
    if (snapshot.status === 'unknown') {
      return { status: 'warn', details: snapshot as unknown as Record<string, unknown>, error: 'authenticated provider probe has not completed' };
    }
    if (snapshot.status === 'healthy') return { status: 'pass', details: snapshot as unknown as Record<string, unknown> };
    return {
      status: snapshot.status === 'unavailable' ? 'fail' : 'warn',
      details: snapshot as unknown as Record<string, unknown>,
      error: snapshot.alert?.reason || `provider status ${snapshot.status}`,
    };
  },
});
healthChecker.register(processProbe());

const providerProbeIntervalMs = Math.max(60_000, Number(process.env.PROVIDER_HEALTH_PROBE_INTERVAL_MS || 300_000));
setTimeout(() => void runProviderHealthProbe().catch(error => {
  serverLog.error('provider health startup probe failed', { error: error instanceof Error ? error.message : String(error) });
}), 5_000).unref();
setInterval(() => void runProviderHealthProbe().catch(error => {
  serverLog.error('provider health scheduled probe failed', { error: error instanceof Error ? error.message : String(error) });
}), providerProbeIntervalMs).unref();

// Hand the Prometheus registry a live source for the WS gauge — every
// scrape pulls the current count from the existing clients Set.
setWsCountProvider(() => clients.size);

// Self-monitor: poll deep-health every 60s; after 3 fail-ticks open a
// "Beacon self-check failing" incident; auto-resolve after 2 recovery
// ticks. Env overrides let an operator quiet it or speed it up. Skip
// when explicitly disabled — useful in tests and short-lived dev
// loops where a self-incident churn would dominate the dashboard.
if (process.env.BEACON_SELF_MONITOR_DISABLED !== 'true') {
  beaconSelfMonitor = new BeaconSelfMonitor(
    { healthChecker, incidentManager },
    {
      intervalMs:        Number(process.env.BEACON_SELF_MONITOR_INTERVAL_MS) || 60_000,
      failThreshold:     Number(process.env.BEACON_SELF_MONITOR_FAIL_THRESHOLD) || 3,
      recoverThreshold:  Number(process.env.BEACON_SELF_MONITOR_RECOVER_THRESHOLD) || 2,
    },
  );
  beaconSelfMonitor.start();
}

app.get('/api/health', async (_req, res) => {
  const tree = organization.getAgentTree();
  const report = await healthChecker.check();

  // HTTP status mirrors the deep result so load balancers / orchestrators
  // can rely on it: 200 healthy, 200 degraded (still serving), 503 unhealthy.
  const httpStatus = report.status === 'unhealthy' ? 503 : 200;

  res.status(httpStatus).json({
    status: report.status,
    timestamp: report.timestamp,
    uptimeSec: report.uptimeSec,
    durationMs: report.durationMs,
    summary: report.summary,
    checks: report.checks,
    monitoring: {
      agents: {
        director:    tree.director ? 1 : 0,
        sysadmins:   (tree.sysadmins as any[])?.length   || 0,
        specialists: (tree.specialists as any[])?.length || 0,
      },
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      },
    },
    s3Backup: { configured: s3Uploader.isConfigured },
  });
});

// Deep health — same probe pipeline, but with extra runtime context
// (per-check latencies, process numbers, AI-proxy reachability) and
// no aggregation. Use this from the dashboard, ops tooling, or a
// human-facing diagnostics page; load balancers should still hit
// /api/health for the cheap-and-stable yes/no.
app.get('/api/health/deep', async (_req, res) => {
  const report = await healthChecker.check();
  const tree = organization.getAgentTree();
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const httpStatus = report.status === 'unhealthy' ? 503 : 200;
  res.status(httpStatus).json({
    status: report.status,
    timestamp: report.timestamp,
    uptimeSec: report.uptimeSec,
    durationMs: report.durationMs,
    summary: report.summary,
    checks: report.checks,
    runtime: {
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      uptimeSec: Math.round(process.uptime()),
      memory: {
        rssBytes: mem.rss,
        heapTotalBytes: mem.heapTotal,
        heapUsedBytes: mem.heapUsed,
        externalBytes: mem.external,
      },
      cpu: { userMicros: cpu.user, systemMicros: cpu.system },
      websocketClients: clients.size,
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || null,
    },
    monitoring: {
      agents: {
        director:    tree.director ? 1 : 0,
        sysadmins:   (tree.sysadmins as any[])?.length   || 0,
        specialists: (tree.specialists as any[])?.length || 0,
      },
    },
    selfMonitor: beaconSelfMonitor?.snapshot() ?? null,
    s3Backup: { configured: s3Uploader.isConfigured },
  });
});

app.get('/api/provider-health', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  res.json(providerHealthMonitor.snapshot());
});

app.post('/api/provider-health/probe', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  try { res.json(await runProviderHealthProbe()); }
  catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post('/api/provider-health/reset', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  const route = req.body?.route;
  if (route !== undefined && route !== 'primary' && route !== 'fallback') {
    return res.status(400).json({ error: 'route must be primary or fallback' });
  }
  aiFactory.resetOpenAIRoute(route);
  res.json({ success: true, routes: aiFactory.getOpenAIRouteHealth() });
});

// Prometheus exposition. text/plain; version=0.0.4 is the official
// content type — set explicitly so scrapers don't second-guess us.
// Lives at /api/metrics (not /metrics) to keep the API namespace
// consistent with the rest of Beacon's routes.
app.get('/api/metrics/autonomy', (_req, res) => {
  if (!incidentManager || !aiDecisionStore || !skillManager) {
    return res.status(503).json({ error: 'Stores not initialized' });
  }
  const requestedWindowDays = _req.query.windowDays ? Number(_req.query.windowDays) : undefined;
  if (requestedWindowDays !== undefined && (!Number.isFinite(requestedWindowDays) || requestedWindowDays <= 0 || requestedWindowDays > 3650)) {
    return res.status(400).json({ error: 'windowDays must be between 1 and 3650' });
  }
  const sinceMs = requestedWindowDays ? requestedWindowDays * 86400 * 1000 : undefined;
  const stats = computeAutonomyMetrics(incidentManager, aiDecisionStore, skillManager, sinceMs, autonomyAttemptStore);
  res.json(stats);
});

app.get('/api/metrics/autonomy/attempts', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  const windowDays = req.query.windowDays ? Number(req.query.windowDays) : 30;
  if (!Number.isFinite(windowDays) || windowDays <= 0 || windowDays > 3650) {
    return res.status(400).json({ error: 'windowDays must be between 1 and 3650' });
  }
  const classification = req.query.classification ? String(req.query.classification) : undefined;
  const allowed = new Set(['in_progress', 'verified_autonomous', 'assisted', 'false_resolution', 'failed', 'human_handoff']);
  if (classification && !allowed.has(classification)) return res.status(400).json({ error: 'Invalid classification' });
  const limit = req.query.limit ? Number(req.query.limit) : 200;
  const attempts = autonomyAttemptStore.list({
    since: new Date(Date.now() - windowDays * 86400 * 1000).toISOString(),
    incidentId: req.query.incidentId ? String(req.query.incidentId) : undefined,
    classification: classification as any,
    limit: Number.isFinite(limit) ? limit : 200,
  });
  res.json({ windowDays, count: attempts.length, attempts });
});

app.get('/api/metrics/autonomy/attempts/:attemptId', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  const attempt = autonomyAttemptStore.get(String(req.params.attemptId));
  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
  res.json({ attempt });
});

app.get('/api/metrics', async (_req, res) => {
  try {
    const body = await renderMetrics();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(body);
  } catch (e: any) {
    res.status(500).type('text/plain').send(`# metrics render failed: ${e?.message ?? 'unknown'}\n`);
  }
});

app.get('/api/config', (_req, res) => {
  res.json({
    ...runtimeConfig,
    anthropicKey: runtimeConfig.anthropicKey ? '••••••••' : '',
    openaiKey: runtimeConfig.openaiKey ? '••••••••' : ''
  });
});

app.post('/api/config', (req, res) => {
  try {
    const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
    if (!auth.ok) {
      res.status(403).json({ error: auth.reason || 'Forbidden' });
      return;
    }
    runtimeConfig = {
      ...runtimeConfig,
      ...req.body,
      anthropicKey: req.body.anthropicKey === '••••••••' || req.body.anthropicKey === undefined
        ? runtimeConfig.anthropicKey
        : req.body.anthropicKey,
      openaiKey: req.body.openaiKey === '••••••••' || req.body.openaiKey === undefined
        ? runtimeConfig.openaiKey
        : req.body.openaiKey
    };

    const newAiFactory = new AIProviderFactory({
      anthropicApiKey: runtimeConfig.anthropicKey,
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
      anthropicModel:   process.env.ANTHROPIC_MODEL,
      openaiApiKey: process.env.OPENAI_API_KEY || runtimeConfig.openaiKey,
      openaiBaseUrl: process.env.OPENAI_BASE_URL || runtimeConfig.openaiBaseUrl,
      openaiModel: process.env.OPENAI_MODEL || runtimeConfig.openaiModel,
      ...openAIRouteSettings(),
      ollamaBaseUrl: runtimeConfig.ollamaUrl
    }, { preferredPlatform: (runtimeConfig.defaultPlatform || 'openai') as AIPlatform });

    organization.setAIFactory(newAiFactory);
    persistConfig();

    res.json({ success: true, config: runtimeConfig });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// /api/agents/* core CRUD — extracted to ./agentsApi.ts. Includes
// detail, list, health, analytics, compare, skills CRUD, history,
// memory, create/delete/patch.
//
// NOT extracted (kept inline below — Express falls through this
// router when no route matches):
//   /api/agents/capabilities, /api/agents/metrics,
//   /api/agents/:agentId/tasks, /api/agents/:agentId/personality/*,
//   /api/agents/:id/ltm/*, /api/agents/:id/message[/stream],
//   /api/agents/:id/conversations, /api/agents/:id/{logs,activity}.
app.use('/api/agents', createAgentsRouter({
  organization,
  skillManager,
  taskManager,
  orchestratorService,
  agentMemoryStore,
  workloadTracker: agentWorkloadTracker,
  saveOrganization: () => organization.save(ORG_FILE),
  log: (msg: string) => logger.info(msg),
  validateAuth: validateAuthFromHeader,
}));

app.get('/api/skills', (_req, res) => {
  // Plain list (back-compat). Callers wanting categorisation +
  // breaker state + plugin source should hit /api/skills/summary.
  res.json({ skills: skillManager.getAll() });
});

/** Richer skill catalogue for the dashboard's Skill Studio.
 *
 *  Each entry carries:
 *    - the SkillManager metadata (id, name, description, commands)
 *    - source: 'builtin' | 'plugin' | 'sandboxed' | 'crystallized'
 *    - circuit breaker state (when active)
 *
 *  Source classification is heuristic — built-ins are protected via
 *  SkillManager.isBuiltin(); plugin-loaded ids show up in the
 *  loaders' lists; crystallized skills carry the "crystal." prefix
 *  on the workflow side, so we cross-reference active crystallized
 *  workflows by id.
 */
app.get('/api/skills/summary', (_req, res) => {
  // Snapshot helper inputs once so we don't re-call the loaders four times.
  const inProcessIds = new Set(skillPluginLoader.list().map(p => p.skillId));
  const sandboxIds   = new Set(sandboxedSkillPluginLoader.list().map(p => p.skillId));
  const breakers     = new Map(skillManager.listCircuitBreakers().map(b => [b.skillId, b]));

  const summary = skillManager.getAll().map(s => {
    const source =
      sandboxIds.has(s.id)             ? 'sandboxed'
      : inProcessIds.has(s.id)         ? 'plugin'
      : skillManager.isBuiltin(s.id)   ? 'builtin'
                                       : 'plugin';
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      enabled: s.enabled,
      commands: s.commands.map(c => ({ name: c.name, description: c.description, handler: c.handler })),
      source,
      circuitBreaker: breakers.get(s.id) ?? null,
    };
  });
  res.json({ skills: summary });
});

// Direct skill command execution — useful for agent-driven workflow operations
// POST /api/skills/execute  { command: string, params?: object }
app.post('/api/skills/execute', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const { command, params } = req.body as { command?: unknown; params?: unknown };
  if (!command || typeof command !== 'string') {
    res.status(400).json({ error: '`command` string is required' }); return;
  }
  try {
    const result = await skillManager.execute(command, (params as Record<string, unknown>) ?? {});
    res.json({ result });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Self-reflection: stored critiques the agent wrote about its own runs.
// Router lives in ./reflectionsApi.ts so the routes can be unit-tested
// without standing up this whole server.
app.use('/api', createReflectionsRouter({
  agentMemoryStore,
  getAgent: (id: string) => organization.getAgent(id),
}));

// Daily usage tracking: process-wide UsageTracker fed by every Agent.
// executeTaskDetailed call. Persists today's counters to disk so they
// survive restarts. The router exposes today/week/budget endpoints.
const usageTracker = new UsageTracker({
  persistPath: process.env.USAGE_TRACKER_PATH || '/data/itops-agents/usage.json',
});
Agent.setUsageTracker(usageTracker);
app.use('/api', createUsageRouter({
  usageTracker,
  getAgent: (id: string) => organization.getAgent(id),
}));

// Circuit breakers: a small read-only view of every per-skill breaker that
// has tripped, plus a manual reset endpoint for operator override.
app.use('/api', createCircuitBreakerRouter({ skillManager }));

const buildTaskQueuePayload = () => {
  const tasks = taskManager.getAllTasks();
  const stats = taskManager.getStatistics();
  // Cache the agentId → name lookup once per call so the Task Queue UI
  // can render real names instead of opaque uuids without forcing the
  // client to fetch /api/agents and join.
  const nameById = new Map<string, string>();
  for (const a of organization.getAllAgents()) {
    nameById.set(a.id, a.name);
  }
  const enriched = tasks.map(t => ({
    ...t,
    assignedToName: t.assignedTo ? nameById.get(t.assignedTo) ?? null : null,
    ownerName: t.ownerId ? nameById.get(t.ownerId) ?? null : null,
  }));
  return {
    tasks: enriched,
    count: enriched.length,
    stats: {
      pending: stats.pending || 0,
      inProgress: stats.in_progress || 0,
      completed: stats.completed || 0
    }
  };
};

// /api/tasks/* — extracted to ./tasksApi.ts. Includes the heavy
// rollback/apply path (snapshot-policy gate + approval-token consume +
// execution-audit on each step) plus subtasks, timeline, snapshots,
// activity feed, and the dependency-graph view.
//
// Note: `/api/agents/:agentId/tasks` (agent's owned/assigned tasks)
// stays inline below — it's an /api/agents surface, not /api/tasks.
app.use('/api/tasks', createTasksRouter({
  taskManager,
  taskSnapshotStore,
  agentBus,
  executionAuditStore,
  approvalTokenLedger,
  orchestratorService,
  helpers: {
    cryptoRandomId,
    validateApprovalToken: validateOneTimeApprovalToken,
    rollupParentTaskStatus,
  },
  validateAuth: validateAuthFromHeader,
}));

// /api/task-queue routes — extracted to ./taskQueueApi.ts. The legacy
// no-slash `/api/task-queuestats` alias keeps its own registration at
// the app root since it doesn't share the prefix.
app.use('/api/task-queue', createTaskQueueRouter({
  taskManager,
  buildPayload: buildTaskQueuePayload,
  validateAuth: validateAuthFromHeader,
}));

app.get('/api/task-queuestats', (_req, res) => {
  res.json(buildTaskQueueStats(taskManager));
});

app.get('/api/agents/:agentId/tasks', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'delegations.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  const agentId = req.params.agentId;
  if (!agentId) {
    res.status(400).json({ error: 'agentId is required' });
    return;
  }
  const owned = taskManager.getTasksByOwner(agentId);
  const assigned = taskManager.getTasksByAgent(agentId);
  const map = new Map<string, Task>();
  owned.concat(assigned).forEach(task => map.set(task.id, task));
  res.json({ tasks: Array.from(map.values()) });
});


// /api/delegations/* — extracted to ./delegationsApi.ts. The transition
// handler is the heaviest path (approval-token validation + ledger
// consume + execution-audit on each step). Helper functions are
// bundled into a `helpers` object rather than threaded individually.
app.use('/api/delegations', createDelegationsRouter({
  delegationManager,
  delegationPolicyStore,
  policyChangeAuditStore,
  taskManager,
  executionAuditStore,
  approvalTokenLedger,
  helpers: {
    cryptoRandomId,
    getDelegationRiskLevel,
    transitionRequiresApproval: delegationTransitionRequiresApproval,
    validateApprovalToken: validateOneTimeApprovalToken,
    rollupParentTaskStatus,
    computeChangedKeys,
  },
  validateAuth: validateAuthFromHeader,
}));

app.get('/api/tools/policies', (_req, res) => {
  res.json(TOOL_POLICIES.map(policy => ({
    ...policy,
    launch: SANDBOX_LAUNCH_SPECS[policy.sandbox]
  })));
});

app.get('/api/tools/catalog', (_req, res) => {
  res.json(buildToolCatalog());
});

app.get('/api/agents/capabilities', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  res.json({ capabilities: buildAgentCapabilityMatrix() });
});

const durableAlertManager = new AlertManager(
  process.env.ALERTING_DATA_PATH || '/data/itops-agents/alerting'
);
new AlertNotificationService(durableAlertManager);

async function refreshDurableAlerts(): Promise<void> {
  const now = Date.now();
  if (now - _serverMetricsCacheTime > SERVER_METRICS_TTL_MS) {
    _serverMetricsCache = await collectServerMetrics();
    _serverMetricsCacheTime = now;
  }

  const operationalConditions = buildOperationalAlerts().map(alert => ({
    key: alert.id,
    title: alert.context?.title
      ? `${String(alert.context.title)} needs operational review`
      : alert.kind.split('_').map(part => part[0].toUpperCase() + part.slice(1)).join(' '),
    message: alert.message,
    severity: alert.severity,
    labels: {
      attentionId: alert.id,
      kind: alert.kind,
      targetType: 'operational'
    },
    annotations: {
      recommendedAction: 'Review the related audit or task record and correct the underlying condition.',
      context: JSON.stringify(alert.context || {})
    }
  }));
  durableAlertManager.reconcile('operational', operationalConditions);

  const monitoringConditions = buildMonitoringAlertConditions(
    _serverMetricsCache,
    buildAgentPerformanceMetrics()
  );
  durableAlertManager.reconcile('monitoring', monitoringConditions);
}

// /api/alerts/* — durable operational and monitoring alert lifecycle,
// plus the existing correlation-engine views.
app.use('/api/alerts', createOperationalAlertsRouter({
  alertManager: durableAlertManager,
  refreshAlerts: refreshDurableAlerts,
  correlationEngine,
  incidentManager,
  validateAuth: validateAuthFromHeader,
}));

// /api/performance/* — real system metrics from alert-rule polling.
app.use('/api/performance', createPerformanceRouter({
  alertRulesEngine,
  agentCount: () => organization.getAllAgents().length,
}));

// ─── System Context Endpoint ─────────────────────────────────────────────────

function buildSystemContext() {
  const incidents = incidentManager.list({});
  const openIncidents = incidents.filter(i => i.status !== 'resolved' && i.status !== 'closed');
  const criticalIncidents = openIncidents.filter(i => i.severity === 'critical');
  const highIncidents = openIncidents.filter(i => i.severity === 'high');

  const allAgents = organization.getAllAgents();
  const activeAgents = allAgents.filter(a => a.config.status === 'active');
  const idleAgents = allAgents.filter(a => a.config.status === 'idle');

  const taskStats = taskManager.getStatistics();

  const alertsList = buildOperationalAlerts();
  const activeAlerts = alertsList.filter((a: any) => a.active !== false);
  const suppressedAlerts = alertsList.filter((a: any) => a.active === false);

  const serverList = (process.env.MONITORED_SERVERS || '').split(',').filter(Boolean);
  const serverMetrics = _serverMetricsCache;
  const healthyServers = serverMetrics.filter(s => s.reachable).length;
  const totalServers = serverList.length || serverMetrics.length;

  return {
    incidents: {
      open: openIncidents.length,
      critical: criticalIncidents.length,
      high: highIncidents.length,
    },
    agents: {
      total: allAgents.length,
      active: activeAgents.length,
      idle: idleAgents.length,
    },
    tasks: {
      pending: taskStats.pending || 0,
      active: taskStats.in_progress || 0,
      completed_today: taskStats.completed || 0,
    },
    alerts: {
      active: activeAlerts.length,
      suppressed: suppressedAlerts.length,
    },
    servers: {
      total: totalServers,
      healthy: healthyServers,
      degraded: totalServers - healthyServers,
    },
    generatedAt: new Date().toISOString(),
  };
}

// /api/system/* — extracted to ./systemApi.ts. Includes /context plus
// the state-backup management surface (list/create/verify/restore +
// scheduler + health).
app.use('/api/system', createSystemRouter({
  buildSystemContext,
  stateBackupManager,
  s3Uploader,
  computeBackupHealthPayload,
  computeBackupInventoryPayload,
  backupSchedulerState,
  runAutomatedBackup,
  recoverySetManager,
  recoverySchedulerState,
  runRecoverySet,
  recoveryRestoreRoot: process.env.RECOVERY_RESTORE_ROOT || path.join(STATE_BACKUP_DIR, 'restore-drills'),
  onRecoveryStateChanged: persistRecoverySchedulerState,
  executionAuditStore,
  taskManager,
  helpers: { cryptoRandomId },
  log: { info: (m, c) => logger.info(m, c), error: (m, c) => logger.error(m, c) },
  validateAuth: validateAuthFromHeader,
}));

// ── DB hardening API: status + on-demand runs ──────────────────────────
// GET /api/system/db/status  — current per-DB size + the most recent
//   backup snapshot folder. Cheap; safe to poll.
// POST /api/system/db/backup-now  — trigger an immediate SQLite backup.
//   Re-uses the daily runner, so the result is identical to the cron
//   path. Requires config.write so it's behind the same RBAC as a
//   state-backup create.
// POST /api/system/db/vacuum-now  — same shape, runs VACUUM. Heavy;
//   blocks the affected DBs while it runs.
app.get('/api/system/db/status', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  const dbs = databaseSizeMonitor.snapshot();
  const snapshots = sqliteBackupRunner.listSnapshots().slice(0, 14);
  res.json({
    databases: dbs,
    backups: {
      destRoot: process.env.SQLITE_BACKUP_DIR || path.join(STATE_BACKUP_DIR, 'sqlite'),
      retentionDays: Number(process.env.SQLITE_BACKUP_RETENTION_DAYS) || 14,
      snapshots,
    },
    schedule: {
      backupCron: process.env.SQLITE_BACKUP_CRON || '30 3 * * *',
      vacuumCron: process.env.SQLITE_VACUUM_CRON || '0 4 * * 0',
    },
    thresholds: {
      warnMB: Number(process.env.DB_SIZE_WARN_MB) || 500,
      failMB: Number(process.env.DB_SIZE_FAIL_MB) || 1024,
    },
  });
});

app.post('/api/system/db/backup-now', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  try {
    const report = await sqliteBackupRunner.runOnce();
    res.json({ success: report.failureCount === 0, report });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message ?? String(e) });
  }
});

app.post('/api/system/db/vacuum-now', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  try {
    const report = await sqliteVacuumRunner.runOnce();
    res.json({ success: report.failureCount === 0, report });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message ?? String(e) });
  }
});

app.get('/api/factory/board', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  try {
    const board = factoryBoardService.getSnapshot();
    const allTasks = FactoryTaskService.getInstance().list();
    const tasksByState: Record<string, typeof allTasks> = {};
    for (const task of allTasks) {
      if (!tasksByState[task.state]) tasksByState[task.state] = [];
      tasksByState[task.state].push(task);
    }
    res.json({ board, tasks: tasksByState });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/factory/status', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  try {
    const board = factoryBoardService.getSnapshot();
    const allTasks = FactoryTaskService.getInstance().list();
    const taskCounts: Record<string, number> = {};
    for (const task of allTasks) {
      taskCounts[task.state] = (taskCounts[task.state] || 0) + 1;
    }
    const status = {
      generatedAt: new Date().toISOString(),
      sourcePath: board.sourcePath,
      sourceExists: board.sourceExists,
      boardLastUpdated: board.boardLastUpdated,
      activePhase: board.live.activePhase,
      activeTrack: board.live.activeTrack,
      platformStatus: board.live.platformStatus,
      queue: {
        done: board.columns.done.length,
        inProgress: board.columns.inProgress.length,
        next: board.columns.next.length,
        backlog: board.columns.backlog.length
      },
      workingFeatureCount: board.workingFeatures.length,
      gateCounts: taskCounts,
      totalFactoryTasks: allTasks.length
    };
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/operations/running', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  const taskState = req.query.taskState ? String(req.query.taskState) as TaskStatus : undefined;
  const delegationState = req.query.delegationState ? String(req.query.delegationState) as DelegationState : undefined;
  const riskLevel = req.query.riskLevel ? String(req.query.riskLevel) as 'low' | 'medium' | 'high' : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json(buildRunningOperationsBoard({
    agentId: req.query.agentId ? String(req.query.agentId) : undefined,
    taskState,
    delegationState,
    riskLevel,
    limit
  }));
});

app.get('/api/agents/metrics', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  res.json({ generatedAt: new Date().toISOString(), agents: buildAgentPerformanceMetrics() });
});

app.get('/api/metrics/sla', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  const windowHours = req.query.windowHours ? Number(req.query.windowHours) : 24;
  res.json(buildSlaTrends(windowHours));
});

app.get('/api/metrics/sla/snapshots', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  const limit = req.query.limit ? Number(req.query.limit) : 200;
  const aggregateBucketHours = req.query.aggregateBucketHours ? Number(req.query.aggregateBucketHours) : undefined;
  if (aggregateBucketHours && Number.isFinite(aggregateBucketHours)) {
    res.json({
      snapshots: slaSnapshotStore.list(limit),
      aggregate: aggregateSlaSnapshots(aggregateBucketHours, limit)
    });
    return;
  }
  res.json({ snapshots: slaSnapshotStore.list(limit) });
});

app.post('/api/metrics/sla/snapshots/capture', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  try {
    const policy = slaSnapshotPolicyStore.get();
    const windowHours = req.body?.windowHours ? Number(req.body.windowHours) : policy.defaultWindowHours;
    const snapshot = captureSlaSnapshot(windowHours);
    res.json({ success: true, snapshot });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/metrics/sla/snapshot-policy', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  const record = slaSnapshotPolicyStore.getRecord();
  res.json({ policy: record.policy, revision: record.revision, updatedAt: record.updatedAt });
});

app.post('/api/metrics/sla/snapshot-policy', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  try {
    const expectedRevision = Number(req.body?.expectedRevision);
    if (!Number.isFinite(expectedRevision)) {
      res.status(400).json({ error: 'expectedRevision is required' });
      return;
    }
    const before = slaSnapshotPolicyStore.getRecord();
    const after = slaSnapshotPolicyStore.updateWithOptions(req.body || {}, { expectedRevision });
    const policy = after.policy;
    slaSnapshotStore.prune({
      retentionHours: policy.retentionHours,
      maxRecords: policy.maxRecords
    });
    policyChangeAuditStore.append({
      id: cryptoRandomId(),
      timestamp: new Date().toISOString(),
      policyType: 'sla_snapshot',
      actorId: auth.username || 'unknown',
      action: 'update',
      expectedRevision,
      previousRevision: before.revision,
      nextRevision: after.revision,
      changedKeys: computeChangedKeys(before.policy, after.policy),
      before: before.policy,
      after: after.policy
    });
    res.json({ success: true, policy: after.policy, revision: after.revision, updatedAt: after.updatedAt });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.get('/api/tools/concurrency-policy', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  const record = concurrencyPolicyStore.getRecord();
  res.json({ policy: record.policy, revision: record.revision, updatedAt: record.updatedAt });
});

app.post('/api/tools/concurrency-policy', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  try {
    const expectedRevision = Number(req.body?.expectedRevision);
    if (!Number.isFinite(expectedRevision)) {
      res.status(400).json({ error: 'expectedRevision is required' });
      return;
    }
    const before = concurrencyPolicyStore.getRecord();
    const after = concurrencyPolicyStore.updateWithOptions(req.body || {}, { expectedRevision });
    policyChangeAuditStore.append({
      id: cryptoRandomId(),
      timestamp: new Date().toISOString(),
      policyType: 'concurrency',
      actorId: auth.username || 'unknown',
      action: 'update',
      expectedRevision,
      previousRevision: before.revision,
      nextRevision: after.revision,
      changedKeys: computeChangedKeys(before.policy, after.policy),
      before: before.policy,
      after: after.policy
    });
    res.json({ success: true, policy: after.policy, revision: after.revision, updatedAt: after.updatedAt });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.get('/api/tools/target-allowlist-policy', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  const record = privilegedTargetAllowlistPolicyStore.getRecord();
  res.json({ policy: record.policy, revision: record.revision, updatedAt: record.updatedAt });
});

app.post('/api/tools/target-allowlist-policy', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  try {
    const expectedRevision = Number(req.body?.expectedRevision);
    if (!Number.isFinite(expectedRevision)) {
      res.status(400).json({ error: 'expectedRevision is required' });
      return;
    }
    const before = privilegedTargetAllowlistPolicyStore.getRecord();
    const after = privilegedTargetAllowlistPolicyStore.updateWithOptions(req.body || {}, { expectedRevision });
    policyChangeAuditStore.append({
      id: cryptoRandomId(),
      timestamp: new Date().toISOString(),
      policyType: 'target_allowlist',
      actorId: auth.username || 'unknown',
      action: 'update',
      expectedRevision,
      previousRevision: before.revision,
      nextRevision: after.revision,
      changedKeys: computeChangedKeys(before.policy, after.policy),
      before: before.policy,
      after: after.policy
    });
    res.json({ success: true, policy: after.policy, revision: after.revision, updatedAt: after.updatedAt });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.get('/api/policies/export', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    delegationPolicy: delegationPolicyStore.getRecord(),
    concurrencyPolicy: concurrencyPolicyStore.getRecord(),
    slaSnapshotPolicy: slaSnapshotPolicyStore.getRecord(),
    targetAllowlistPolicy: privilegedTargetAllowlistPolicyStore.getRecord(),
    orchestratorReliabilityPolicy: orchestratorReliabilityPolicyStore.getRecord()
  };
  const signature = signAuditExport(payload);
  res.json({ payload, signature });
});

app.post('/api/policies/import', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  try {
    const payload = req.body?.payload || req.body;
    const signature = req.body?.signature ? String(req.body.signature) : '';
    const verifySignature = req.body?.verifySignature !== false;
    if (!payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'payload is required' });
      return;
    }
    if (verifySignature) {
      if (!signature) {
        res.status(400).json({ error: 'signature is required when verifySignature=true' });
        return;
      }
      const expected = signAuditExport(payload);
      if (expected !== signature) {
        res.status(400).json({ error: 'Invalid policy signature' });
        return;
      }
    }
    if (payload.delegationPolicy) {
      const before = delegationPolicyStore.getRecord();
      const incoming = payload.delegationPolicy.policy ? payload.delegationPolicy.policy : payload.delegationPolicy;
      const after = delegationPolicyStore.updateWithOptions(incoming || {});
      policyChangeAuditStore.append({
        id: cryptoRandomId(),
        timestamp: new Date().toISOString(),
        policyType: 'delegation',
        actorId: auth.username || 'unknown',
        action: 'import',
        previousRevision: before.revision,
        nextRevision: after.revision,
        changedKeys: computeChangedKeys(before.policy, after.policy),
        before: before.policy,
        after: after.policy
      });
    }
    if (payload.concurrencyPolicy) {
      const before = concurrencyPolicyStore.getRecord();
      const incoming = payload.concurrencyPolicy.policy ? payload.concurrencyPolicy.policy : payload.concurrencyPolicy;
      const after = concurrencyPolicyStore.updateWithOptions(incoming || {});
      policyChangeAuditStore.append({
        id: cryptoRandomId(),
        timestamp: new Date().toISOString(),
        policyType: 'concurrency',
        actorId: auth.username || 'unknown',
        action: 'import',
        previousRevision: before.revision,
        nextRevision: after.revision,
        changedKeys: computeChangedKeys(before.policy, after.policy),
        before: before.policy,
        after: after.policy
      });
    }
    if (payload.slaSnapshotPolicy) {
      const before = slaSnapshotPolicyStore.getRecord();
      const incoming = payload.slaSnapshotPolicy.policy ? payload.slaSnapshotPolicy.policy : payload.slaSnapshotPolicy;
      const after = slaSnapshotPolicyStore.updateWithOptions(incoming || {});
      const policy = after.policy;
      slaSnapshotStore.prune({
        retentionHours: policy.retentionHours,
        maxRecords: policy.maxRecords
      });
      policyChangeAuditStore.append({
        id: cryptoRandomId(),
        timestamp: new Date().toISOString(),
        policyType: 'sla_snapshot',
        actorId: auth.username || 'unknown',
        action: 'import',
        previousRevision: before.revision,
        nextRevision: after.revision,
        changedKeys: computeChangedKeys(before.policy, after.policy),
        before: before.policy,
        after: after.policy
      });
    }
    if (payload.targetAllowlistPolicy) {
      const before = privilegedTargetAllowlistPolicyStore.getRecord();
      const incoming = payload.targetAllowlistPolicy.policy
        ? payload.targetAllowlistPolicy.policy
        : payload.targetAllowlistPolicy;
      const after = privilegedTargetAllowlistPolicyStore.updateWithOptions(incoming || {});
      policyChangeAuditStore.append({
        id: cryptoRandomId(),
        timestamp: new Date().toISOString(),
        policyType: 'target_allowlist',
        actorId: auth.username || 'unknown',
        action: 'import',
        previousRevision: before.revision,
        nextRevision: after.revision,
        changedKeys: computeChangedKeys(before.policy, after.policy),
        before: before.policy,
        after: after.policy
      });
    }
    if (payload.orchestratorReliabilityPolicy) {
      const before = orchestratorReliabilityPolicyStore.getRecord();
      const incoming = payload.orchestratorReliabilityPolicy.policy
        ? payload.orchestratorReliabilityPolicy.policy
        : payload.orchestratorReliabilityPolicy;
      const after = orchestratorReliabilityPolicyStore.updateWithOptions(incoming || {});
      orchestratorService.setReliabilityPolicy(after.policy);
      policyChangeAuditStore.append({
        id: cryptoRandomId(),
        timestamp: new Date().toISOString(),
        policyType: 'orchestrator_reliability',
        actorId: auth.username || 'unknown',
        action: 'import',
        previousRevision: before.revision,
        nextRevision: after.revision,
        changedKeys: computeChangedKeys(before.policy, after.policy),
        before: before.policy,
        after: after.policy
      });
    }
    res.json({
      success: true,
      delegationPolicy: delegationPolicyStore.getRecord(),
      concurrencyPolicy: concurrencyPolicyStore.getRecord(),
      slaSnapshotPolicy: slaSnapshotPolicyStore.getRecord(),
      targetAllowlistPolicy: privilegedTargetAllowlistPolicyStore.getRecord(),
      orchestratorReliabilityPolicy: orchestratorReliabilityPolicyStore.getRecord()
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.get('/api/policies/audit', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  const policyType = req.query.policyType ? String(req.query.policyType) as any : undefined;
  res.json({ records: policyChangeAuditStore.list({ limit, policyType }) });
});

// (System backup routes — list/create/verify/restore/health/scheduler/
//  scheduler/run — moved to ./systemApi.ts above.)

// ─── Task Scheduler (Cron) API ─────────────────────────────────────────────

app.get('/api/scheduler/tasks', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  res.json(taskScheduler.list());
});

app.post('/api/scheduler/tasks', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  try {
    const task = taskScheduler.add(req.body);
    res.json(task);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/scheduler/tasks/:id', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const updated = taskScheduler.update(req.params.id, req.body);
  if (!updated) { res.status(404).json({ error: 'Task not found' }); return; }
  res.json(updated);
});

app.delete('/api/scheduler/tasks/:id', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const ok = taskScheduler.remove(req.params.id);
  if (!ok) { res.status(404).json({ error: 'Task not found' }); return; }
  res.json({ success: true });
});

app.post('/api/scheduler/tasks/:id/run-now', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  try {
    const result = await taskScheduler.runNow(req.params.id);
    res.json({ success: true, result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Alert Rules Engine API ────────────────────────────────────────────────

app.get('/api/alert-rules', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  res.json(alertRulesEngine.list());
});

app.post('/api/alert-rules', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  try {
    const rule = alertRulesEngine.add(req.body);
    res.json(rule);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/alert-rules/:id', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const updated = alertRulesEngine.update(req.params.id, req.body);
  if (!updated) { res.status(404).json({ error: 'Rule not found' }); return; }
  res.json(updated);
});

app.delete('/api/alert-rules/:id', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const ok = alertRulesEngine.remove(req.params.id);
  if (!ok) { res.status(404).json({ error: 'Rule not found' }); return; }
  res.json({ success: true });
});

app.post('/api/alert-rules/:id/evaluate-now', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const rule = alertRulesEngine.list().find(r => r.id === req.params.id);
  if (!rule) { res.status(404).json({ error: 'Rule not found' }); return; }
  try {
    await alertRulesEngine.evaluateNow();
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Alert Correlation Engine API ────────────────────────────────────────────

// ── Plan enforcement ──────────────────────────────────────────────────
// Counters delegate to the stores already in scope. The enforcer is
// shared between the /api/tenant/* surface and the per-route limit
// gates below.
const planEnforcer = new PlanEnforcer(storeFactory.tenants, {
  countServers: (tenantId: string) => serverRegistry.list().filter(s => (s as any).tenantId === tenantId || tenantId === SYSTEM_TENANT_ID).length,
  countIncidentsSince: (tenantId: string, sinceIso: string) => {
    return incidentManager.list({}).filter(i => {
      const tid = (i as any).tenantId ?? SYSTEM_TENANT_ID;
      return tid === tenantId && i.createdAt >= sinceIso;
    }).length;
  },
  countAiDecisionsSince: (tenantId: string, sinceIso: string) => {
    if (!aiDecisionStore) return 0;
    return aiDecisionStore.list({ since: sinceIso, limit: 5000 }).filter(d => {
      const tid = (d.payload as any)?.tenantId ?? SYSTEM_TENANT_ID;
      return tid === tenantId || tenantId === SYSTEM_TENANT_ID;
    }).length;
  },
});

// 402 envelope shared by the limit gates.
function planDenied(res: any, result: PlanCheckResult): void {
  res.status(402).json({
    error: result.reason || 'Plan limit reached',
    plan: result.plan, current: result.current, limit: result.limit,
  });
}

// Gate POST /api/incidents on the monthly cap. Read endpoints stay
// open — operators always need to see what they have. Other writes
// (resolve/comment/escalate) don't bump the counter so they're free.
app.use('/api/incidents', async (req, res, next) => {
  if (req.method !== 'POST' || req.path !== '/') { next(); return; }
  const tenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  const r = await planEnforcer.checkIncidentCreate(tenantId);
  if (!r.ok) { planDenied(res, r); return; }
  next();
});

// Gate POST /api/servers — server registration counts against plan.
app.use('/api/servers', async (req, res, next) => {
  if (req.method !== 'POST') { next(); return; }
  const tenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  const r = await planEnforcer.checkServerAdd(tenantId);
  if (!r.ok) { planDenied(res, r); return; }
  next();
});

// ─── Tenant settings + billing API ────────────────────────────────────
// All routes scoped to the caller's tenant. Superadmin can read any
// tenant via /api/admin/tenants/:id (mounted in Feature 5).
app.get('/api/tenant', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const tenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  const t = await Promise.resolve(storeFactory.tenants.get(tenantId));
  if (!t) { res.status(404).json({ error: 'Tenant not found' }); return; }
  res.json({ tenant: t });
});

app.put('/api/tenant/settings', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const tenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  const t = await Promise.resolve(storeFactory.tenants.get(tenantId));
  if (!t) { res.status(404).json({ error: 'Tenant not found' }); return; }
  // Allowlist of editable fields — name, settings (partial merge).
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim();
  if (typeof req.body?.settings === 'object' && req.body.settings !== null) {
    patch.settings = { ...t.settings, ...req.body.settings };
  }
  const next = await Promise.resolve(storeFactory.tenants.upsert({
    id: t.id, slug: t.slug, name: (patch.name as string) ?? t.name,
    plan: t.plan, ownerUsername: t.ownerUsername, status: t.status,
    settings: (patch.settings as Record<string, unknown>) ?? t.settings,
  }));
  auditLog.log({
    action: 'tenant.settings.update',
    username: auth.username ?? 'system', role: auth.role ?? 'admin',
    resource: `/tenants/${t.id}`, method: 'PUT',
    ip: req.ip || '', success: true,
  });
  res.json({ tenant: next });
});

// GET /api/tenant/public — open endpoint. The login page and the
// registration page call this with no auth so they can render the
// tenant's name + branding before the user has a JWT. Returns just
// the public-safe fields. Driven entirely by the resolved tenant on
// the request — so a request to acme-itops.example.com sees the
// Acme tenant, a request to itops.example.com sees the system
// fallback (which the client treats as "no tenant context").
app.get('/api/tenant/public', async (req, res) => {
  const tenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  const t = await Promise.resolve(storeFactory.tenants.get(tenantId));
  const workspaceBaseDomain = process.env.TENANT_BASE_DOMAIN?.trim() || null;
  if (!t) { res.json({ tenant: null, workspaceBaseDomain }); return; }
  // Don't leak ownerUsername / settings / full DB row. Just enough
  // for the login + register UIs.
  res.json({
    tenant: {
      id: t.id,
      slug: t.slug,
      name: t.name,
      isSystem: t.id === SYSTEM_TENANT_ID,
      logoUrl: (t.settings as any)?.logoUrl ?? null,
    },
    workspaceBaseDomain,
  });
});

// PUT /api/tenant/settings/domain — admin sets / clears their custom
// hostname. We don't perform DNS validation here; the tenant is
// responsible for pointing their DNS at the Beacon server. Conflicts
// against another tenant's claim return 409.
app.put('/api/tenant/settings/domain', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const tenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  const t = await Promise.resolve(storeFactory.tenants.get(tenantId));
  if (!t) { res.status(404).json({ error: 'Tenant not found' }); return; }
  const raw = req.body?.customDomain;
  // Allow explicit null/empty to clear the field.
  if (raw !== null && raw !== '' && typeof raw !== 'string') {
    res.status(400).json({ error: 'customDomain must be a string (or null to clear)' });
    return;
  }
  // Conflict check: only when setting a non-empty value.
  if (raw) {
    const claimed = await Promise.resolve(storeFactory.tenants.getByCustomDomain(String(raw)));
    if (claimed && claimed.id !== t.id) {
      res.status(409).json({ error: `Domain "${raw}" is already claimed by another tenant` });
      return;
    }
  }
  const next = await Promise.resolve(storeFactory.tenants.upsert({
    id: t.id, slug: t.slug, name: t.name, plan: t.plan,
    customDomain: raw ? String(raw) : null,
    ownerUsername: t.ownerUsername, status: t.status, settings: t.settings,
  }));
  auditLog.log({
    action: 'tenant.domain.update',
    username: auth.username ?? 'system', role: auth.role ?? 'admin',
    resource: `/tenants/${t.id}`, method: 'PUT',
    ip: req.ip || '', success: true, detail: `${t.customDomain ?? '(none)'} → ${next.customDomain ?? '(none)'}`,
  });
  res.json({ tenant: next });
});

app.get('/api/tenant/plan', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const tenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  const t = await Promise.resolve(storeFactory.tenants.get(tenantId));
  if (!t) { res.status(404).json({ error: 'Tenant not found' }); return; }
  res.json({ plan: t.plan, limits: PLAN_LIMITS[t.plan] });
});

app.get('/api/tenant/usage', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const tenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  try {
    const u = await planEnforcer.usage(tenantId);
    res.json({ usage: u });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.get('/api/tenant/users', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'users.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const tenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  const users = authService.listUsersByTenant(tenantId);
  res.json({ users });
});

// PATCH /api/tenant/users/:username — change role / active for a team member.
// Tenant-scoped: the caller can only modify users in their own tenant.
app.patch('/api/tenant/users/:username', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'users.manage');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const tenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  const target = authService.getUser(req.params.username);
  if (!target || target.tenantId !== tenantId) {
    res.status(404).json({ error: 'User not found in this tenant' });
    return;
  }
  if (target.role === 'superadmin') {
    res.status(403).json({ error: 'Cannot modify a superadmin from the tenant panel' });
    return;
  }
  const updated = authService.updateUser(req.params.username, {
    role: req.body?.role && req.body.role !== 'superadmin' ? req.body.role : undefined,
    active: typeof req.body?.active === 'boolean' ? req.body.active : undefined,
  });
  auditLog.log({
    action: 'tenant.user.update',
    username: auth.username ?? 'system', role: auth.role ?? 'admin',
    resource: `/users/${req.params.username}`, method: 'PATCH',
    ip: req.ip || '', success: !!updated,
  });
  res.json({ user: updated });
});

// DELETE /api/tenant/users/:username — remove a member from the tenant.
// The tenant owner can never be removed via this path (use superadmin).
app.delete('/api/tenant/users/:username', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'users.manage');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const tenantId = (req as any).tenant?.tenantId ?? SYSTEM_TENANT_ID;
  const target = authService.getUser(req.params.username);
  if (!target || target.tenantId !== tenantId) {
    res.status(404).json({ error: 'User not found in this tenant' });
    return;
  }
  const tenant = storeFactory.tenants.get(tenantId);
  if ((tenant as any)?.ownerUsername === target.username) {
    res.status(403).json({ error: 'Cannot remove the tenant owner' });
    return;
  }
  const ok = authService.deleteUser(req.params.username);
  auditLog.log({
    action: 'tenant.user.delete',
    username: auth.username ?? 'system', role: auth.role ?? 'admin',
    resource: `/users/${req.params.username}`, method: 'DELETE',
    ip: req.ip || '', success: ok,
  });
  res.json({ success: ok });
});

// ── Superadmin: cross-tenant management ────────────────────────────────
// All routes require role==='superadmin'. Tenant admins can read THEIR
// tenant's stats through /api/tenant; this surface is for the Beacon
// operator who manages the whole installation.
function requireSuperadmin(req: any, res: any): { ok: false } | { ok: true; username: string } {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined);
  if (!auth.ok || auth.role !== 'superadmin') {
    res.status(403).json({ error: 'Superadmin only' });
    return { ok: false };
  }
  return { ok: true, username: auth.username ?? 'system' };
}

app.get('/api/admin/tenants', async (req, res) => {
  if (!requireSuperadmin(req, res).ok) return;
  const all = await Promise.resolve(storeFactory.tenants.list());
  // Hydrate with per-tenant counters so the table renders without
  // an N+1 round trip.
  const out = await Promise.all(all.map(async (t) => {
    const u = await planEnforcer.usage(t.id).catch(() => null);
    const userCount = authService.listUsersByTenant(t.id).length;
    return {
      id: t.id, slug: t.slug, name: t.name, plan: t.plan,
      status: t.status, ownerUsername: t.ownerUsername,
      createdAt: t.createdAt, updatedAt: t.updatedAt,
      users: userCount,
      servers: u?.servers.current ?? 0,
      incidentsThisMonth: u?.incidentsThisMonth.current ?? 0,
      aiDecisionsThisMonth: u?.aiDecisionsThisMonth ?? 0,
    };
  }));
  res.json({ tenants: out });
});

app.get('/api/admin/tenants/:id', async (req, res) => {
  if (!requireSuperadmin(req, res).ok) return;
  const t = await Promise.resolve(storeFactory.tenants.get(req.params.id));
  if (!t) { res.status(404).json({ error: 'Tenant not found' }); return; }
  const u = await planEnforcer.usage(t.id).catch(() => null);
  const users = authService.listUsersByTenant(t.id);
  res.json({ tenant: t, usage: u, users });
});

app.put('/api/admin/tenants/:id/plan', async (req, res) => {
  const r = requireSuperadmin(req, res); if (!r.ok) return;
  const t = await Promise.resolve(storeFactory.tenants.get(req.params.id));
  if (!t) { res.status(404).json({ error: 'Tenant not found' }); return; }
  const plan = req.body?.plan;
  if (plan !== 'free' && plan !== 'pro' && plan !== 'enterprise') {
    res.status(400).json({ error: 'plan must be free|pro|enterprise' });
    return;
  }
  const next = await Promise.resolve(storeFactory.tenants.upsert({
    id: t.id, slug: t.slug, name: t.name, plan,
    ownerUsername: t.ownerUsername, status: t.status, settings: t.settings,
  }));
  auditLog.log({
    action: 'admin.tenant.plan_changed',
    username: r.username, role: 'superadmin',
    resource: `/admin/tenants/${t.id}`, method: 'PUT',
    ip: req.ip || '', success: true, detail: `${t.plan} → ${plan}`,
  });
  res.json({ tenant: next });
});

app.put('/api/admin/tenants/:id/status', async (req, res) => {
  const r = requireSuperadmin(req, res); if (!r.ok) return;
  const t = await Promise.resolve(storeFactory.tenants.get(req.params.id));
  if (!t) { res.status(404).json({ error: 'Tenant not found' }); return; }
  const status = req.body?.status;
  if (status !== 'active' && status !== 'suspended') {
    res.status(400).json({ error: 'status must be active|suspended' });
    return;
  }
  const next = await Promise.resolve(storeFactory.tenants.upsert({
    id: t.id, slug: t.slug, name: t.name, plan: t.plan,
    ownerUsername: t.ownerUsername, status, settings: t.settings,
  }));
  auditLog.log({
    action: status === 'suspended' ? 'admin.tenant.suspend' : 'admin.tenant.activate',
    username: r.username, role: 'superadmin',
    resource: `/admin/tenants/${t.id}`, method: 'PUT',
    ip: req.ip || '', success: true, detail: `${t.status} → ${status}`,
  });
  res.json({ tenant: next });
});

app.delete('/api/admin/tenants/:id', async (req, res) => {
  const r = requireSuperadmin(req, res); if (!r.ok) return;
  // Tenant deletion is destructive — refuse SYSTEM_TENANT_ID and refuse
  // unless the caller passed `?confirm=true` so a misclick can't drop
  // everything. The TenantStore.delete() itself ALSO refuses the system
  // tenant; this is defense-in-depth.
  if (req.params.id === SYSTEM_TENANT_ID) {
    res.status(403).json({ error: 'Cannot delete the system tenant' });
    return;
  }
  if (req.query.confirm !== 'true') {
    res.status(400).json({ error: 'Pass ?confirm=true to delete' });
    return;
  }
  // Look up the slug before deletion so we can drop the matching
  // Cloudflare DNS record after the tenant row is gone.
  const doomed = await Promise.resolve(storeFactory.tenants.get(req.params.id));
  const ok = await Promise.resolve(storeFactory.tenants.delete(req.params.id));
  if (ok && doomed && dnsService) {
    try {
      const dnsRes = await dnsService.deleteRecord(doomed.slug);
      if (!dnsRes.ok) {
        console.warn('[admin.tenant.delete] DNS cleanup failed', { slug: doomed.slug, error: dnsRes.error });
      }
    } catch (e: any) {
      console.warn('[admin.tenant.delete] DNS cleanup threw', { slug: doomed.slug, error: e?.message ?? String(e) });
    }
  }
  auditLog.log({
    action: 'admin.tenant.delete', username: r.username, role: 'superadmin',
    resource: `/admin/tenants/${req.params.id}`, method: 'DELETE',
    ip: req.ip || '', success: ok,
  });
  // Rows in other stores stay tagged with the deleted tenant_id; an
  // operator can sweep them via a periodic job. The tenant row itself
  // is gone, which is what blocks future logins (the auth path checks
  // tenant.status before issuing a JWT).
  res.json({ success: ok });
});

app.get('/api/admin/stats', async (req, res) => {
  if (!requireSuperadmin(req, res).ok) return;
  const tenants = await Promise.resolve(storeFactory.tenants.list());
  const totals = await Promise.all(tenants.map(t => planEnforcer.usage(t.id).catch(() => null)));
  const totalIncidents = incidentManager.list({}).length;
  const totalServers = serverRegistry.list().length;
  const totalAi = aiDecisionStore?.list({ limit: 5000 }).length ?? 0;
  const byPlan: Record<string, number> = { free: 0, pro: 0, enterprise: 0 };
  for (const t of tenants) byPlan[t.plan] = (byPlan[t.plan] ?? 0) + 1;
  res.json({
    totals: {
      tenants: tenants.length,
      activeTenants: tenants.filter(t => t.status === 'active').length,
      suspendedTenants: tenants.filter(t => t.status === 'suspended').length,
      totalIncidents,
      totalServers,
      totalAiDecisions: totalAi,
    },
    byPlan,
    perTenantUsage: tenants.map((t, i) => ({
      id: t.id, slug: t.slug, name: t.name, plan: t.plan,
      usage: totals[i],
    })),
  });
});

// ─── Incident Management API ──────────────────────────────────────────────
// Extracted to ./incidentsApi.ts. Side-effects (broadcast, multi-channel
// notifications, AI auto-analysis, Jira sync on update) are preserved 1:1.
// /api/jira/* still lives inline below — extract in a follow-up.
app.use('/api/incidents', createIncidentsRouter({
  incidentManager,
  incidentAnalyzer,
  getJiraService: () => jiraService,
  teamsProvider,
  teamsConfigStore,
  slackService,
  discordService,
  broadcast,
  createNotification,
  validateAuth: validateAuthFromHeader,
  validateAuthToken,
  logError: (msg, ctx) => logger.error(msg, ctx),
  dispatchIncidentToAgent,
}));

// PWA Web Push subscription management. vapid-public-key is the
// only public endpoint inside this router — the others require a
// bearer token to bind subscriptions to a username.
app.use('/api/push', createPushRouter({
  pushService,
  validateAuth: (h, p) => {
    const v = validateAuthFromHeader(h, p as any);
    return { ...v, valid: v.ok };
  },
  logError: (msg, ctx) => logger.error(msg, ctx),
}));

// ─── Post-Mortems / Incident Knowledge Base ──────────────────────────────
// Read-only browser over the post_mortems table. The generator that
// populates the table runs from the IncidentManager.onResolved hook
// wired earlier in this file.
app.use('/api/post-mortems', createPostMortemsRouter({
  store: postMortemStore,
  validateAuth: validateAuthFromHeader,
}));

// Improvement-loop control surface — extracted to ./improvementLoopApi.ts.
// audit.read for status; admin.write for the manual tick.
app.use('/api/improvement-loop', createImprovementLoopRouter({
  improvementLoop,
  validateAuth: validateAuthFromHeader,
}));

// /api/autonomy/* — observability + manual trigger for the closed-loop
// orchestrator that wires crystallization → SkillManager and pattern
// detection → SDK pipeline → hot-reload.
app.use('/api/autonomy', createAutonomyRouter({
  orchestrator: autonomyOrchestrator,
  validateAuth: validateAuthFromHeader,
}));


// /api/jira/* — extracted to ./jiraApi.ts. Sync, ticket lookup, import,
// create-from-incident. The /api/incidents/:id/jira-link endpoint lives
// in incidentsApi.ts because it's "set jiraKey on this incident".
app.use('/api/jira', createJiraRouter({
  incidentManager,
  getJiraService: () => jiraService,
  broadcast,
  validateAuth: validateAuthFromHeader,
}));

// ── ServerRegistry + RemoteExecutor ─────────────────────────────────────
// Build these BEFORE the /api/servers and /api/external mounts that reference
// them. "local" is always seeded; the two remote seeds below are no-ops if
// they already exist, so operator edits via /api/servers stick.
const serverRegistry = new ServerRegistry(
  process.env.SERVER_REGISTRY_DB_PATH || '/data/itops-agents/servers.db',
);
// Expose on globalThis so closures defined before this line (e.g. the
// IncidentManager onResolved hooks) can reach the registry once they
// actually fire at runtime. Module-init ordering rules apply to direct
// var refs, not to `globalThis.<name>` lookups.
(globalThis as any).serverRegistry = serverRegistry;
serverRegistry.ensureLocal();
{
  // Optional remote seeds are created only when explicitly configured.
  const vps2Host = process.env.VPS2_SERVER_HOST || '';
  const vps2User = process.env.VPS2_SERVER_USER || 'root';
  if (vps2Host) {
    const v = serverRegistry.ensureSeed({ id: 'vps2', name: 'vps2', host: vps2Host, sshUser: vps2User, tags: ['seed', 'remote'] });
    if (v.created) logger.info('[ServerRegistry] seeded vps2', { host: vps2Host, user: vps2User });
  }

  const vps3Host = process.env.VPS3_SERVER_HOST || '';
  const vps3User = process.env.VPS3_SERVER_USER || 'root';
  if (vps3Host) {
    const v3 = serverRegistry.ensureSeed({ id: 'vps3', name: 'vps3', host: vps3Host, sshUser: vps3User, tags: ['seed', 'remote'] });
    if (v3.created) logger.info('[ServerRegistry] seeded vps3', { host: vps3Host, user: vps3User });
  }
}
const remoteExecutor = new RemoteExecutor({
  onResult: (server, ok) => {
    // Stamp last-seen on every successful command so the dashboard's
    // "Servers" view shows a live heartbeat without an explicit ping.
    // Failures don't downgrade last_seen — only the test endpoint does.
    if (ok) serverRegistry.recordCheck(server.id, 'ok');
  },
});
(globalThis as any).remoteExecutor = remoteExecutor;
skillManager.wireIncidentTools({
  servers: serverRegistry,
  executor: remoteExecutor,
});

// ── CMDB / Asset Management ────────────────────────────────────────
// AssetStore + ImpactAnalyzer. The auto-discovery hook below mirrors
// every ServerRegistry row into a `type=server` asset; relationships
// between assets (hosts/runs/depends_on/connects_to) are operator-
// curated via the /api/assets routes.
const assetStore = new AssetStore(process.env.ASSET_STORE_DB_PATH || '/data/itops-agents/assets.db');
const impactAnalyzer = new ImpactAnalyzer(assetStore);

/** Idempotent mirror: every monitored server gets an asset row. Called
 *  at boot for the existing fleet, and again after each /api/servers
 *  POST/PUT so operator-added hosts surface in the CMDB without a
 *  separate UI action. */
function syncServersToAssets(): void {
  try {
    for (const s of serverRegistry.list()) {
      assetStore.upsertByServerId({
        name: s.name,
        serverId: s.id,
        description: s.host ? `Monitored host ${s.host}` : 'Local host',
        metadata: {
          host: s.host,
          sshUser: s.sshUser,
          sshPort: s.sshPort,
          enabled: s.enabled,
          isLocal: s.isLocal,
          lastSeen: s.lastSeen,
        },
        tags: Array.isArray(s.tags) ? s.tags : [],
      });
    }
  } catch (e) {
    logger.warn('[CMDB] syncServersToAssets failed', { err: e instanceof Error ? e.message : String(e) });
  }
}
syncServersToAssets();
// Re-sync every 60s — picks up servers added via /api/servers without
// needing to thread a callback through the existing serversApi router.
const ASSET_SYNC_INTERVAL_MS = parseInt(process.env.ASSET_SYNC_INTERVAL_MS || '60000', 10);
setInterval(syncServersToAssets, ASSET_SYNC_INTERVAL_MS).unref();

// ── Change Management ──────────────────────────────────────────────
// ChangeStore + ChangeCorrelation. The correlation engine answers
// "did something just change?" on every new incident — its results
// surface via GET /api/changes/by-incident/:id and as a banner on
// IncidentDetailPage.
const changeStore = new ChangeStore(process.env.CHANGE_STORE_DB_PATH || '/data/itops-agents/changes.db');
const changeCorrelation = new ChangeCorrelation(changeStore, assetStore);

// ── Knowledge Base ─────────────────────────────────────────────────
// Curated articles, FTS5-searchable. The ChatBotService consults this
// before the LLM call so a strongly-curated answer (useful_count ≥ 5)
// short-circuits the model entirely; lesser matches drop into the
// system prompt as grounding context. Separate DB so wiping the KB
// doesn't touch incidents.
const knowledgeStore = new KnowledgeStore(process.env.KB_DB_PATH || '/data/itops-agents/knowledge.db');

// Per-server time-series (cpu/memory/disk/load1/load5) for the dashboard
// sparklines and the per-server detail charts. Lives in its own SQLite
// file so resetting metric history doesn't touch incident data. 7d
// retention by default; tunable via METRICS_RETENTION_DAYS.
const metricsHistory = new MetricsHistoryStore(
  process.env.METRICS_HISTORY_DB_PATH || '/data/itops-agents/metrics-history.db',
  { retentionDays: parseInt(process.env.METRICS_RETENTION_DAYS || '7', 10) },
);
// Hourly retention sweep — drops samples older than the configured window.
// Restart-safe: any catch-up on boot happens via the first scheduled tick.
const METRICS_CLEANUP_INTERVAL_MS = parseInt(process.env.METRICS_CLEANUP_INTERVAL_MS || '3600000', 10);
setInterval(() => {
  try {
    const dropped = metricsHistory.cleanup();
    if (dropped > 0) logger.info('[MetricsHistory] retention sweep', { dropped });
  } catch (e: any) {
    logger.error('[MetricsHistory] retention sweep failed', { err: e?.message });
  }
}, METRICS_CLEANUP_INTERVAL_MS);

// ── ChatBotService ──────────────────────────────────────────────────────
// Backs the floating ChatWidget in /app. Wired after metricsHistory exists
// so server cards can include the latest CPU/memory/disk readings. The
// Anthropic SDK config is threaded through here so the service can stream
// general/general+image answers directly (the rate-limited factory path
// stays in use for the smaller JSON classifier call).
chatBotService = new ChatBotService({
  aiFactory,
  incidents: incidentManager,
  servers: serverRegistry,
  metrics: metricsHistory,
  // KB grounding: when present, the chat service consults this before
  // the omniroute call. A highly-upvoted match short-circuits the LLM
  // entirely; weaker matches drop into the system prompt.
  knowledgeStore,
  anthropicApiKey: runtimeConfig.anthropicKey,
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
  anthropicModel:   process.env.ANTHROPIC_MODEL,
  // Retry + circuit breaker around the Anthropic SDK. Short-circuits
  // to the deterministic fallback after 5 consecutive failures so a
  // flapping omniroute doesn't gum up every chat request.
  aiProxyGuard,
  // Natural-language runbook drafting. Late-bound — autoRunbookGenerator
  // is constructed further down in this file once the runbook engine is
  // wired. The thin wrapper just defers to the singleton at call time.
  runbookGenerator: {
    fromPrompt: async (input) => {
      if (!autoRunbookGenerator) throw new Error('AutoRunbookGenerator not initialised');
      return autoRunbookGenerator.fromPrompt(input);
    },
  },
});
// Push sender: route chat:update events to the WebSocket whose
// chatSessionId matches. We walk the open client set on every push;
// chat traffic is low enough that a per-message scan is fine.
chatBotService.setPushSender((evt) => {
  for (const client of clients) {
    if ((client as ChatAwareWebSocket).chatSessionId !== evt.sessionId) continue;
    if (client.readyState !== WebSocket.OPEN) continue;
    client.send(JSON.stringify({
      type: 'chat:update',
      sessionId: evt.sessionId,
      incidentId: evt.incidentId,
      text: evt.text,
    }));
  }
});
incidentManager.onResolved((inc) => {
  chatBotService?.notifyIncidentChange({
    id: inc.id, title: inc.title, status: inc.status, severity: inc.severity,
  });
});
logger.info('[ChatBotService] wired — chat:message + chat:stream + chat:action handlers active', {
  anthropicConfigured: !!runtimeConfig.anthropicKey,
  model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
});

// ── RunbookEngine — infra deps + matcher wiring ─────────────────────────
// The engine itself was constructed at boot (line ~1867) with the skill
// manager + broadcast hooks. The new infra deps (SQLite stores, remote
// executor, server registry, metrics, incident manager) only become
// available here, so they're wired in one call.
const runbookRunStore = new RunbookRunStore(
  process.env.RUNBOOK_RUNS_DB_PATH || '/data/itops-agents/runbook-runs.db',
  { legacyJsonPath: runbookEngine.legacyRunsPath() },
);
const runbookApprovalStore = new RunbookApprovalStore(
  process.env.RUNBOOK_APPROVALS_DB_PATH || '/data/itops-agents/runbook-approvals.db',
);
runbookEngine.wireInfraDeps({
  remoteExecutor,
  serverRegistry,
  metricsHistory,
  incidentManager,
  approvalStore: runbookApprovalStore,
  runStore: runbookRunStore,
});

// Assign the forward-declared `runbookMatcher` so the IncidentManager's
// inline onCreated closure (registered at construction time) starts seeing
// the matcher on the very next incident. Metric-threshold triggers are
// wired into the AlertRulesEngine.evaluate() loop below.
runbookMatcher = new RunbookMatcher(runbookEngine);
logger.info('[RunbookEngine] wired — infra deps + matcher active');

// ── PluginManager — event-driven integration plugins ───────────────────
// Distinct from the legacy script-runner PluginLoader (above) — this
// system fans incident / metric / runbook / alert events out to
// integrations that subscribe to them, e.g. PagerDuty + OpsGenie +
// Prometheus. The legacy `/api/plugins/*` namespace and PluginLoader
// stay untouched.
const pluginEncryption = PluginConfigEncryption.fromEnv();
pluginManager = new PluginManager({
  dbPath: process.env.INTEGRATION_PLUGINS_DB_PATH || '/data/itops-agents/integration-plugins.db',
  encryption: pluginEncryption,
  contextFor: (pluginId) => ({
    pluginId,
    logger,
    incidents: {
      create: (params) => incidentManager.create(params as any),
      resolve: (id, resolution) => incidentManager.resolve(id, resolution),
      escalate: (id, reason) => incidentManager.escalate(id, reason),
      list: (filter) => incidentManager.list(filter),
      get: (id) => incidentManager.get(id),
    },
    servers: {
      list: () => serverRegistry.list(),
      get: (id) => serverRegistry.get(id),
    },
    metrics: {
      latest: (serverId) => metricsHistory.latest(serverId),
    },
    audit: {
      log: (action, detail) => auditLog.log({
        action: `plugin.${pluginId}.${action}`,
        username: `plugin:${pluginId}`,
        role: 'system',
        resource: '/integrations',
        method: 'PLUGIN',
        ip: '',
        success: true,
        ...(detail ? { detail } : {}),
      }),
    },
    http: createPluginHttp(pluginId),
  }),
});
pluginManager.register(new PagerDutyPlugin());
pluginManager.register(new OpsGeniePlugin());
pluginManager.register(new PrometheusPlugin());
pluginManager.loadEnabled().catch(e =>
  logger.warn('[PluginManager] loadEnabled threw at boot', { err: e instanceof Error ? e.message : String(e) }),
);

// Hook wiring:
//   - onCreated   → already wired via the late-bound `pluginManager`
//                   reference inside IncidentManager's onCreated closure
//                   (search for `pluginManager?.notifyIncidentCreated`).
//   - onResolved  → real listener chain method, registered here.
//   - onEscalated → fired from broadcast() below on incident_updated
//                   broadcasts that include an escalation level change.
//   - onMetricCollected → tap into the health-monitor tick (same place
//                   as the RunbookMatcher metric tap).
//   - onRunbookCompleted → broadcast() hook on the `runbook_completed`
//                   event.
//   - onAlertFired → wired into AlertRulesEngine sendAlert callback.
incidentManager.onResolved((inc) => pluginManager?.notifyIncidentResolved(inc));

logger.info('[PluginManager] wired — built-ins registered, enabled plugins loaded', {
  registered: pluginManager._registered(),
});

// ── ReportScheduler — cron-driven scheduled reports + on-demand ──────
// Distinct from the legacy `notifications/ReportsScheduler` (still
// running for SMTP email cron at line ~2323). This new scheduler uses
// real cron expressions, multi-channel delivery, and a history table.
const reportGenerator = new ReportGenerator({
  incidents: incidentManager,
  sla: slaEngine!,
  servers: serverRegistry,
  metrics: metricsHistory,
  postMortems: postMortemStore,
  runbookRuns: runbookRunStore,
});
reportScheduler = new ReportScheduler({
  dbPath: process.env.REPORTS_DB_PATH || '/data/itops-agents/reports.db',
  generator: reportGenerator,
  auditLog,
  // Multi-channel dispatcher. Each channel returns ok/detail; failures
  // are recorded per-channel in history but don't abort siblings.
  dispatcher: async (channel: DeliveryChannel, report: ReportData) => {
    try {
      switch (channel.type) {
        case 'chat': {
          // Fan out to every WebSocket client. The widget renders this
          // as a `chat:report` system message (markdown).
          const md = renderReportMarkdown(report);
          broadcast({ type: 'chat:report', data: { type: report.type, generatedAt: report.generatedAt, markdown: md } });
          return { ok: true, detail: `broadcast to ${clients.size} client(s)` };
        }
        case 'telegram': {
          const tg = getTelegram();
          if (!tg.isConfigured()) return { ok: false, detail: 'telegram not configured' };
          // Telegram's public surface is `sendAlert(Incident)` — there's
          // no free-form message method exposed. We synthesise an
          // Incident-shaped payload with critical severity so it bypasses
          // the alerter's severity floor, and stuff the markdown body
          // into description (capped at 3500 chars; Telegram caps
          // messages at ~4096).
          const fakeIncident = {
            id: `report-${report.type}`,
            title: `${report.type} — ${report.period.label}`,
            description: renderReportMarkdown(report).slice(0, 3500),
            severity: 'critical',
            status: 'open',
            assignedTo: null, assignedAgent: null,
            createdAt: report.generatedAt, updatedAt: report.generatedAt, resolvedAt: null,
            source: 'manual', sourceRef: null, slaMinutes: 0, serverId: null,
          };
          await tg.sendAlert(fakeIncident as any);
          return { ok: true };
        }
        case 'webhook': {
          const url = (channel.config as { url?: string })?.url;
          if (!url) return { ok: false, detail: 'webhook url missing' };
          const extraHeaders = ((channel.config as { headers?: Record<string, string> })?.headers) ?? {};
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 10_000);
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...extraHeaders },
              body: renderReportJson(report),
              signal: controller.signal,
            });
            return res.ok ? { ok: true, detail: `HTTP ${res.status}` } : { ok: false, detail: `HTTP ${res.status}` };
          } finally { clearTimeout(t); }
        }
        case 'email': {
          // SmtpService.sendHtmlReport() is a no-op when SMTP is
          // unconfigured/disabled. We can't tell from here whether it
          // actually sent, so we report ok=true if no throw — operators
          // who want stricter signalling should check the SMTP config
          // page.
          const to = (channel.config as { to?: string[] })?.to;
          const html = renderReportHtml(report);
          await smtpService.sendHtmlReport(`itops report: ${report.type}`, html, Array.isArray(to) && to.length > 0 ? to : undefined);
          return { ok: true };
        }
      }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  },
});
reportScheduler.start();
logger.info('[ReportScheduler] wired — cron-driven reports active');

// ── ProblemStore + RecurringDetector ────────────────────────────────────
// Groups repeated incidents into higher-level "problems" and kicks off
// AI root-cause analysis. The detector wires lazily through the
// late-bound `recurringDetector` binding — the IncidentManager.onCreated
// closure consults it on every new incident.
problemStore = new ProblemStore(
  process.env.PROBLEMS_DB_PATH || '/data/itops-agents/problems.db',
);
recurringDetector = new RecurringDetector({
  incidents: incidentManager,
  problems: problemStore,
  postMortems: postMortemStore,
  anthropicApiKey: runtimeConfig.anthropicKey,
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
  anthropicModel:   process.env.ANTHROPIC_MODEL,
  onProblemCreated: (problem, incidents) => {
    // Broadcast for the dashboard widget + WebSocket-driven SPA refresh.
    broadcast({ type: 'problem_created', data: { problem } });
    // Plugin fan-out — PagerDuty / OpsGenie / future Slack-plugin all
    // see this as a separate signal from individual incidents.
    pluginManager?.notifyProblemCreated(problem);

    if (autoRunbookGenerator && incidents.length >= 3) {
      const summary = incidents
        .map(i => `[${i.id}] ${i.title} | source=${i.sourceRef ?? 'unknown'} | server=${i.serverId ?? 'unknown'}`)
        .join('\n');
      const prompt = [
        `Recurring problem "${problem.title}" occurred ${incidents.length} times.`,
        `Pattern: ${problem.sourceRefPattern ?? 'title similarity'}`,
        `Suggested permanent fix: ${problem.suggestedFix ?? 'not analyzed yet'}`,
        '',
        summary,
        '',
        'Create a conservative prevention runbook. Include verification and approval before disruptive actions.',
      ].join('\n');
      autoRunbookGenerator.fromPrompt({
        prompt,
        save: true,
        actor: 'recurring-detector',
        context: { problemId: problem.id, serverId: problem.serverId },
      }).then(draft => {
        broadcast({ type: 'runbook_draft_suggested', data: { problemId: problem.id, draft } });
      }).catch(err => {
        logger.warn('[RecurringDetector] runbook suggestion failed', {
          problemId: problem.id,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  },
  audit: (action, detail) => auditLog.log({
    action, username: 'system', role: 'system',
    resource: '/recurring-detector', method: 'TIMER',
    ip: '', success: !action.endsWith('.error'), detail,
  }),
});

// Background sweep every 5 minutes — catches groupings that the per-
// create check might have raced past (multiple incidents arriving in
// the same second).
const RECURRING_SWEEP_INTERVAL_MS = parseInt(process.env.RECURRING_SWEEP_INTERVAL_MS || '300000', 10);
let autonomyWatchdog: AutonomyWatchdog | null = null;

setInterval(() => {
  recurringDetector?.sweep().catch(e =>
    logger.warn('[RecurringDetector] sweep threw', { err: e instanceof Error ? e.message : String(e) }),
  );
  try {
    // Lazy-init: aiDecisionStore is built later in the bootstrap.
    if (!autonomyWatchdog && incidentManager && aiDecisionStore && skillManager) {
      autonomyWatchdog = new AutonomyWatchdog({
        incidents: incidentManager,
        decisions: aiDecisionStore,
        skills: skillManager,
        attempts: autonomyAttemptStore,
        onAlert: (alert) => {
          const inc = incidentManager.create({
            title: `Autonomy degradation: ${alert.kind.replace(/_/g, ' ')}`,
            description: alert.message,
            severity: alert.severity === 'critical' ? 'high' : 'medium',
            source: 'system',
          });
          broadcast({ type: 'sla_warning', data: { incident: inc } });
        },
      });
    }
    autonomyWatchdog?.check();
  } catch (e) {
    logger.warn('[AutonomyWatchdog] check threw', { err: e instanceof Error ? e.message : String(e) });
  }
}, RECURRING_SWEEP_INTERVAL_MS);
logger.info('[RecurringDetector] wired — per-create check + 5-minute sweep active');

// ── Data retention: nightly prune of fast-growing SQLite stores ─────────
//   - events:        every emitted domain event; grows ~10×/day the
//                    fastest of all stores.
//   - ai_decisions:  one row per autonomy decision (triage/resolve/etc).
//   Default retention: 90 days. Override via EVENTS_RETENTION_DAYS and
//   AI_DECISIONS_RETENTION_DAYS. Set either to 0 to disable pruning
//   for that store.
const EVENTS_RETENTION_DAYS        = parseInt(process.env.EVENTS_RETENTION_DAYS || '90', 10);
const AI_DECISIONS_RETENTION_DAYS  = parseInt(process.env.AI_DECISIONS_RETENTION_DAYS || '90', 10);
const RETENTION_TICK_MS = 24 * 60 * 60 * 1000;

// ── AI Autonomy: AutoTriageEngine ───────────────────────────────────────
// AiDecisionStore holds every autonomy-driven decision (triage, resolve,
// predict, runbook-generate) so the AI Insights dashboard can produce
// aggregate stats. Constructed once, shared across engines below.
aiDecisionStore = new AiDecisionStore(
  process.env.AI_DECISION_DB_PATH || '/data/itops-agents/ai-decisions.db',
);

autoTriageEngine = new AutoTriageEngine(
  {
    aiFactory,
    incidentManager,
    decisionStore: aiDecisionStore,
    assetStore:    { getByServerId: (id: string) => assetStore.getByServerId(id) },
    changeStore:   { changesInWindow: (since: string, until: string, opts?: { serverId?: string }) => changeStore.changesInWindow(since, until, opts) },
    problemStore:  { findBySourcePattern: (sourceRef: string, opts: { serverId?: string | null }) => problemStore?.findBySourcePattern(sourceRef, opts) },
    knowledgeStore:{ search: (q: string, opts?: { limit?: number }) => knowledgeStore.search(q, opts).map(a => ({ id: a.id, title: a.title, usefulCount: a.usefulCount ?? 0 })) },
    organization:  { getAllAgents: () => organization.getAllAgents().map(a => ({ id: a.id, name: a.name, role: a.role, skills: a.skills ?? [] })) },
    auditLog: (e) => auditLog.log({
      action: e.action,
      username: e.actor,
      role: e.actorType,
      resource: `/${e.resource}/${e.resourceId ?? ''}`,
      method: 'AI',
      ip: '',
      success: e.outcome === 'success',
      detail: JSON.stringify(e.details ?? {}),
    }),
    broadcast: (msg) => broadcast(msg),
  },
  {
    enabled:            (process.env.AUTO_TRIAGE_ENABLED ?? 'true').toLowerCase() !== 'false',
    autoApplyThreshold: Number(process.env.AUTO_TRIAGE_THRESHOLD) || 0.8,
    changeWindowDays:   Number(process.env.AUTO_TRIAGE_CHANGE_WINDOW_DAYS) || 7,
    knowledgeLimit:     Number(process.env.AUTO_TRIAGE_KB_LIMIT) || 3,
  },
);
logger.info('[AutoTriage] wired — onCreated hook will produce decisions', {
  enabled: autoTriageEngine.getConfig().enabled,
  autoApplyThreshold: autoTriageEngine.getConfig().autoApplyThreshold,
});

// ── AI Autonomy routes ──────────────────────────────────────────────────
// GET  /api/ai/triage/config       — current engine config
// PATCH /api/ai/triage/config      — flip enabled / threshold at runtime
// GET  /api/ai/triage/decisions    — recent triage decisions (operator review)
// POST /api/ai/triage/recompute/:incidentId — re-run triage on demand
app.get('/api/ai/triage/config', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  res.json({ config: autoTriageEngine?.getConfig() ?? null });
});

app.patch('/api/ai/triage/config', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  const { enabled, autoApplyThreshold } = req.body || {};
  autoTriageEngine?.updateConfig({
    enabled: typeof enabled === 'boolean' ? enabled : undefined,
    autoApplyThreshold: typeof autoApplyThreshold === 'number' ? autoApplyThreshold : undefined,
  });
  res.json({ config: autoTriageEngine?.getConfig() ?? null });
});

app.get('/api/ai/triage/decisions', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 1000);
  const decisions = aiDecisionStore?.list({ kind: 'triage', limit }) ?? [];
  res.json({ decisions });
});

app.post('/api/ai/triage/recompute/:incidentId', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  if (!autoTriageEngine) return res.status(503).json({ error: 'AutoTriageEngine not initialised' });
  const incident = incidentManager.get(req.params.incidentId);
  if (!incident) return res.status(404).json({ error: 'incident not found' });
  try {
    const decision = await autoTriageEngine.triage(incident);
    res.json({ decision });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// ── AI Autonomy: AutoResolver ──────────────────────────────────────────
// Subscribes to the same onCreated chain as AutoTriage. When a strong
// KB + runbook match exists for a non-critical incident, the resolver
// executes the runbook; otherwise it records a suggestion.
autoResolver = new AutoResolver(
  {
    incidentManager,
    decisionStore: aiDecisionStore,
    attemptStore: autonomyAttemptStore,
    knowledgeStore: {
      search: (q: string, opts?: { limit?: number }) => knowledgeStore.search(q, opts).map(a => ({
        id: a.id, title: a.title, content: a.content, tags: a.tags, usefulCount: a.usefulCount ?? 0, rank: a.rank,
      })),
      topMatchForAutoReply: (q: string, opts?: { minUsefulCount?: number }) => {
        const m = knowledgeStore.topMatchForAutoReply(q, opts);
        return m ? { id: m.id, title: m.title, content: m.content, tags: m.tags, usefulCount: m.usefulCount ?? 0, rank: m.rank } : null;
      },
    },
    runbookEngine: {
      listTemplates: () => runbookEngine.listTemplates().map(t => ({
        id: t.id, name: t.name, description: t.description, category: t.category, tags: t.tags ?? [], enabled: t.enabled !== false,
      })),
      executeRun: async (id, who, opts) => {
        const r = await runbookEngine.executeRun(id, who, opts as any);
        return { id: r.id, status: r.status };
      },
    },
    auditLog: (e) => auditLog.log({
      action: e.action,
      username: e.actor,
      role: e.actorType,
      resource: `/${e.resource}/${e.resourceId ?? ''}`,
      method: 'AI',
      ip: '',
      success: e.outcome === 'success',
      detail: JSON.stringify(e.details ?? {}),
    }),
    broadcast: (msg) => broadcast(msg),
  },
  {
    enabled:         (process.env.AUTO_RESOLVE_ENABLED ?? 'true').toLowerCase() !== 'false',
    minConfidence:   Number(process.env.AUTO_RESOLVE_MIN_CONFIDENCE) || 0.85,
    excludeCritical: (process.env.AUTO_RESOLVE_EXCLUDE_CRITICAL ?? 'true').toLowerCase() !== 'false',
    minKbUseful:     Number(process.env.AUTO_RESOLVE_MIN_KB_USEFUL) || 5,
  },
);
logger.info('[AutoResolver] wired — onCreated hook will evaluate resolution', {
  enabled: autoResolver.getConfig().enabled,
  minConfidence: autoResolver.getConfig().minConfidence,
  excludeCritical: autoResolver.getConfig().excludeCritical,
});

// Outcome tracker — flips auto-applied decisions to success/reopened
// after the reopen window expires. Runs hourly; the sweep is cheap.
const AUTO_RESOLVE_OUTCOME_INTERVAL_MS = Number(process.env.AUTO_RESOLVE_OUTCOME_INTERVAL_MS) || 60 * 60 * 1000;
setInterval(() => {
  try { autoResolver?.trackOutcomes(); }
  catch (e) { logger.warn('[AutoResolver] trackOutcomes threw', { err: e instanceof Error ? e.message : String(e) }); }
}, AUTO_RESOLVE_OUTCOME_INTERVAL_MS).unref();

app.get('/api/ai/resolver/config', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  res.json({ config: autoResolver?.getConfig() ?? null });
});

app.patch('/api/ai/resolver/config', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  const { enabled, minConfidence, excludeCritical } = req.body || {};
  autoResolver?.updateConfig({
    enabled: typeof enabled === 'boolean' ? enabled : undefined,
    minConfidence: typeof minConfidence === 'number' ? minConfidence : undefined,
    excludeCritical: typeof excludeCritical === 'boolean' ? excludeCritical : undefined,
  });
  res.json({ config: autoResolver?.getConfig() ?? null });
});

app.get('/api/ai/resolver/decisions', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 1000);
  const incidentId = typeof req.query.incidentId === 'string' && req.query.incidentId
    ? req.query.incidentId
    : undefined;
  const decisions = aiDecisionStore?.list({ kind: 'resolve', limit, incidentId }) ?? [];
  res.json({ decisions });
});

app.post('/api/ai/resolver/recompute/:incidentId', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  if (!autoResolver) return res.status(503).json({ error: 'AutoResolver not initialised' });
  const incident = incidentManager.get(req.params.incidentId);
  if (!incident) return res.status(404).json({ error: 'incident not found' });
  try {
    const decision = await autoResolver.evaluate(incident);
    res.json({ decision });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// ── AI Autonomy: PredictiveEngine ──────────────────────────────────────
// Periodic worker. Fits a linear regression over the last
// PREDICTION_REGRESSION_WINDOW_MS of metric history per (server, metric)
// and projects forward to PREDICTION_HORIZON_MS. Threshold breaches
// open a dedup-keyed "predicted" incident. A seasonal mean+stddev
// fallback catches outliers that miss the regression bar.
predictiveEngine = new PredictiveEngine(
  {
    metrics: {
      series: (args) => metricsHistory.series({
        serverId: args.serverId,
        metricType: args.metricType as any,
        sinceMs: args.sinceMs,
        dimension: args.dimension ?? undefined,
      }),
      latest: (id) => metricsHistory.latest(id) as any,
    },
    servers: { list: (filter) => serverRegistry.list(filter).map(s => ({ id: s.id, name: s.name })) },
    incidentManager,
    decisionStore: aiDecisionStore,
    auditLog: (e) => auditLog.log({
      action: e.action,
      username: e.actor,
      role: e.actorType,
      resource: `/${e.resource}/${e.resourceId ?? ''}`,
      method: 'AI',
      ip: '',
      success: e.outcome === 'success',
      detail: JSON.stringify(e.details ?? {}),
    }),
    broadcast: (msg) => broadcast(msg),
  },
  {
    enabled:               (process.env.PREDICTION_ENABLED ?? 'true').toLowerCase() !== 'false',
    intervalMs:            Number(process.env.PREDICTION_INTERVAL_MS)        || 10 * 60 * 1000,
    horizonMs:             Number(process.env.PREDICTION_HORIZON_MS)         || 2 * 60 * 60 * 1000,
    regressionWindowMs:    Number(process.env.PREDICTION_REGRESSION_WINDOW_MS) || 6 * 60 * 60 * 1000,
    seasonalLookbackDays:  Number(process.env.PREDICTION_SEASONAL_LOOKBACK_DAYS) || 14,
    thresholds: {
      cpu:    Number(process.env.PREDICTION_CPU_THRESHOLD)    || 90,
      memory: Number(process.env.PREDICTION_MEMORY_THRESHOLD) || 90,
      disk:   Number(process.env.PREDICTION_DISK_THRESHOLD)   || 90,
      load1:  Number(process.env.PREDICTION_LOAD1_THRESHOLD)  || 4,
      load5:  Number(process.env.PREDICTION_LOAD5_THRESHOLD)  || 3,
    },
  },
);
predictiveEngine.start();
logger.info('[Predictive] wired — periodic projection + anomaly checks active', {
  enabled: predictiveEngine.getConfig().enabled,
  intervalMs: predictiveEngine.getConfig().intervalMs,
  horizonMs: predictiveEngine.getConfig().horizonMs,
});

const PREDICTION_ACCURACY_INTERVAL_MS = Number(process.env.PREDICTION_ACCURACY_INTERVAL_MS) || 30 * 60 * 1000;
setInterval(() => {
  try { predictiveEngine?.trackAccuracy(); }
  catch (e) { logger.warn('[Predictive] trackAccuracy threw', { err: e instanceof Error ? e.message : String(e) }); }
}, PREDICTION_ACCURACY_INTERVAL_MS).unref();

app.get('/api/ai/predictions/config', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  res.json({ config: predictiveEngine?.getConfig() ?? null });
});

app.patch('/api/ai/predictions/config', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  const { enabled, horizonMs, intervalMs, thresholds } = req.body || {};
  predictiveEngine?.updateConfig({
    enabled: typeof enabled === 'boolean' ? enabled : undefined,
    horizonMs: typeof horizonMs === 'number' ? horizonMs : undefined,
    intervalMs: typeof intervalMs === 'number' ? intervalMs : undefined,
    thresholds: typeof thresholds === 'object' && thresholds !== null ? thresholds : undefined,
  });
  res.json({ config: predictiveEngine?.getConfig() ?? null });
});

app.get('/api/ai/predictions', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 1000);
  const predictions = aiDecisionStore?.list({ kind: 'predict', limit }) ?? [];
  res.json({ predictions });
});

app.get('/api/ai/predictions/accuracy', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  const since = typeof req.query.since === 'string' ? req.query.since : undefined;
  const stats = aiDecisionStore?.stats(since);
  res.json({
    accuracy: {
      totalPredictions: stats?.byKind.predict ?? 0,
      success:          stats?.byOutcome.success  ?? 0,
      failed:           stats?.byOutcome.failed   ?? 0,
      pending:          stats?.byOutcome.pending  ?? 0,
      successRate:      stats?.successRateByKind.predict ?? null,
      meanConfidence:   stats?.meanConfidenceByKind.predict ?? null,
    },
  });
});

app.post('/api/ai/predictions/run-now', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  if (!predictiveEngine) return res.status(503).json({ error: 'PredictiveEngine not initialised' });
  try {
    const preds = await predictiveEngine.tickOnce();
    res.json({ predictions: preds });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// ── AI Autonomy: AutoRunbookGenerator ──────────────────────────────────
// NL-to-runbook drafts. Generates structured RunbookTemplate JSON from a
// chat prompt or a freshly-resolved incident's timeline. Drafts are
// always persisted as enabled=false; an operator must enable them
// before any auto-execution path picks them up.
autoRunbookGenerator = new AutoRunbookGenerator(
  {
    aiFactory,
    decisionStore: aiDecisionStore,
    saveTemplate: (t) => runbookEngine.addTemplate({
      id: t.id, name: t.name, description: t.description, category: t.category,
      tags: t.tags ?? [], steps: t.steps as any,
      triggerType: t.triggerType,
      triggerConfig: t.triggerConfig as any,
      enabled: false,
    }),
    listExistingIds: () => runbookEngine.listTemplates().map(t => t.id),
    auditLog: (e) => auditLog.log({
      action: e.action,
      username: e.actor,
      role: e.actorType,
      resource: `/${e.resource}/${e.resourceId ?? ''}`,
      method: 'AI',
      ip: '',
      success: e.outcome === 'success',
      detail: JSON.stringify(e.details ?? {}),
    }),
  },
  {
    enabled: (process.env.AUTO_RUNBOOK_GEN_ENABLED ?? 'true').toLowerCase() !== 'false',
  },
);
logger.info('[AutoRunbookGen] wired — chat-driven runbook drafts available', {
  enabled: autoRunbookGenerator.getConfig().enabled,
});

// Post-incident hook — when an incident resolves and the resolver did
// NOT auto-apply (operator did the fix manually), build a runbook draft
// from the timeline. Skipped for auto-resolver-applied incidents since
// those already had a runbook.
incidentManager.onResolved((inc) => {
  if (!autoRunbookGenerator) return;
  if ((process.env.AUTO_RUNBOOK_GEN_POST_INCIDENT ?? 'true').toLowerCase() === 'false') return;
  try {
    // Skip if an auto-resolve decision already ran a runbook for this
    // incident — duplicating that into a draft is just noise.
    const priorResolve = aiDecisionStore?.list({ kind: 'resolve', incidentId: inc.id, limit: 1 }) ?? [];
    if (priorResolve.some(d => d.autoApplied)) return;
    const full = incidentManager.get(inc.id);
    const timeline = (full?.timeline ?? []).map(t => ({ type: t.type, message: t.message, actor: t.actor, timestamp: t.timestamp }));
    autoRunbookGenerator.fromResolvedIncident({
      incident: {
        id: inc.id, title: inc.title, description: inc.description, severity: inc.severity,
        sourceRef: inc.sourceRef, serverId: inc.serverId,
      },
      timeline,
    }).then(draft => {
      if (draft) {
        broadcast({ type: 'runbook_draft_suggested', data: { incidentId: inc.id, draft } });
      }
    }).catch(e =>
      logger.warn('[AutoRunbookGen] fromResolvedIncident threw', { incidentId: inc.id, err: e instanceof Error ? e.message : String(e) }),
    );
  } catch (e) {
    logger.warn('[AutoRunbookGen] post-resolve hook threw', { incidentId: inc.id, err: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/ai/runbook-generator/config', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  res.json({ config: autoRunbookGenerator?.getConfig() ?? null });
});

app.patch('/api/ai/runbook-generator/config', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  const { enabled } = req.body || {};
  autoRunbookGenerator?.updateConfig({ enabled: typeof enabled === 'boolean' ? enabled : undefined });
  res.json({ config: autoRunbookGenerator?.getConfig() ?? null });
});

app.get('/api/ai/runbook-generator/drafts', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 1000);
  const drafts = aiDecisionStore?.list({ kind: 'runbook-generate', limit }) ?? [];
  res.json({ drafts });
});

// POST /api/ai/runbook-generator/from-prompt
// Body: { prompt: string, save?: boolean }
// Returns: { draft: GeneratedRunbookDraft }
// Used by the chat widget's `create_runbook` intent path and by the
// AI Insights dashboard's quick-action card.
app.post('/api/ai/runbook-generator/from-prompt', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'config.write');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  if (!autoRunbookGenerator) return res.status(503).json({ error: 'AutoRunbookGenerator not initialised' });
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (prompt.length < 8) return res.status(400).json({ error: 'prompt must be at least 8 characters' });
  const save = req.body?.save === true;
  try {
    const draft = await autoRunbookGenerator.fromPrompt({ prompt, save, actor: auth.username ?? 'chat-user' });
    res.json({ draft });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// ── AI Insights dashboard ──────────────────────────────────────────────
// /api/ai/insights/summary aggregates everything the AI Insights page
// needs into one round-trip — by-kind counts, success rates, recent
// decisions, and live config snapshots. The page refreshes on a 30s
// timer plus the broadcast events (triage_decision, resolver_decision,
// prediction, runbook_draft_suggested) so changes appear in real time.
app.get('/api/ai/insights/summary', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) return res.status(403).json({ error: auth.reason || 'Forbidden' });
  const since = typeof req.query.since === 'string' ? req.query.since : undefined;
  const stats = aiDecisionStore?.stats(since);
  const recentLimit = Math.min(Math.max(parseInt(String(req.query.recent ?? '25'), 10) || 25, 1), 200);
  const recent = aiDecisionStore?.list({ since, limit: recentLimit }) ?? [];
  res.json({
    stats,
    recent,
    config: {
      triage:   autoTriageEngine?.getConfig()      ?? null,
      resolver: autoResolver?.getConfig()          ?? null,
      predict:  predictiveEngine?.getConfig()      ?? null,
      runbookGen: autoRunbookGenerator?.getConfig() ?? null,
    },
  });
});



// /api/agents/:id/affinity — read + write the per-agent server-affinity
// list. Co-located here (rather than inside agentsApi.ts) because the
// store + organisation lookups both live in this scope. The route is
// mounted BEFORE the agentsApi router below so its more-specific path
// wins over the agentsApi `/:agentId` catch-alls.
app.get('/api/agents/:id/affinity', (req, res) => {
  const auth = validateAuthFromHeader(req.headers.authorization, 'security.read');
  if (!auth.ok) return res.status(401).json({ error: auth.reason || 'unauthorized' });
  const agent = organization.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  const aff = agentSpecialization.get(agent.id);
  res.json({
    agentId: agent.id,
    agentName: agent.name,
    serverIds: aff?.serverIds ?? [],
    updatedAt: aff?.updatedAt ?? null,
  });
});
app.put('/api/agents/:id/affinity', (req, res) => {
  const auth = validateAuthFromHeader(req.headers.authorization, 'security.write');
  if (!auth.ok) return res.status(401).json({ error: auth.reason || 'unauthorized' });
  const agent = organization.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  const body = req.body;
  if (!body || !Array.isArray(body.serverIds)) {
    return res.status(400).json({ error: 'body must be {serverIds: string[]}' });
  }
  // Filter to server ids that actually exist — protects against typos
  // creating dead affinity entries that the picker would silently skip.
  const validServers = body.serverIds.filter((s: any) =>
    typeof s === 'string' && serverRegistry.get(s) != null,
  );
  const written = agentSpecialization.set(agent.id, validServers);
  res.json({
    agentId: agent.id,
    agentName: agent.name,
    serverIds: written.serverIds,
    updatedAt: written.updatedAt,
    rejected: body.serverIds.filter((s: any) =>
      typeof s !== 'string' || serverRegistry.get(s) == null,
    ),
  });
});



// ── MaintenanceScheduler ───────────────────────────────────────────────
// Boot-time seed of the three default jobs (disk-cleanup, docker-prune,
// log-rotation), then a 60s tick that dispatches due jobs via
// RemoteExecutor against the targets resolved from ServerRegistry.
const maintenanceStore = new MaintenanceStore(
  process.env.MAINTENANCE_DB_PATH || '/data/itops-agents/maintenance.db',
);
const maintenanceScheduler = new MaintenanceScheduler({
  store: maintenanceStore,
  registry: serverRegistry,
  executor: remoteExecutor,
  incidentManager,
  log: createLogger({ component: 'maintenance' }),
  broadcast: (msg) => broadcast(msg),
});
maintenanceScheduler.seedDefaults();
maintenanceScheduler.start();

app.use('/api/maintenance', createMaintenanceRouter({
  store: maintenanceStore,
  scheduler: maintenanceScheduler,
  validateAuth: validateAuthFromHeader,
  logError: (msg, ctx) => logger.error(`[maintenanceApi] ${msg}`, ctx),
}));

// Trend analyzer — runs at the end of every health-monitor tick. Reads
// the metrics-history table, runs least-squares regression + anomaly
// detection per metric/server, opens predictive incidents when a metric
// is on track to cross a critical threshold in <48h. Disabled via
// TREND_ANALYSIS_ENABLED=false. Constructed BEFORE the metrics-history
// router mount so the router can hand back cached trend reports.
const trendAnalyzer = new TrendAnalyzer(metricsHistory, incidentManager, serverRegistry, {
  broadcast,
});
(globalThis as any).trendAnalyzer = trendAnalyzer;
logger.info('[TrendAnalyzer] wired', { enabled: trendAnalyzer.isEnabled() });

// /api/metrics-history — per-server time-series for dashboard charts.
// Distinct from /metrics (Prometheus scrape format) wired elsewhere.
app.use('/api/metrics-history', createMetricsHistoryRouter({
  store: metricsHistory,
  trendAnalyzer,
  validateAuth: validateAuthFromHeader,
  logError: (msg, ctx) => logger.error(`[metricsHistoryApi] ${msg}`, ctx),
}));

// /api/activity — chronological feed of agent + incident activity for
// the Dashboard "what's happening right now" widget. Derives from the
// existing incident timelines; no new write paths required.
app.use('/api/activity', createActivityFeedRouter({
  incidentManager,
  resolveAgentName: (idOrName) => {
    if (!idOrName) return null;
    try {
      const agents = organization.getAllAgents();
      const hit = agents.find(a => a.id === idOrName || a.name === idOrName);
      return hit?.name ?? null;
    } catch { return null; }
  },
  validateAuth: validateAuthFromHeader,
}));

// /api/external/* — phone-friendly remote control surface for an external
// chat bot (OpenClaw / Telegram / etc.). Only mounted when the bearer
// token is configured; otherwise the path simply 404s, matching the
// "endpoints disabled" contract in the task spec.
if ((process.env.EXTERNAL_API_TOKEN || '').trim().length > 0) {
  app.use('/api/external', createExternalApiRouter({
    incidentManager,
    organization,
    taskManager,
    serverRegistry,
    remoteExecutor,
    trendAnalyzer,
  }));
  logger.info('[external-api] mounted /api/external (token configured)');
} else {
  logger.info('[external-api] /api/external disabled (EXTERNAL_API_TOKEN unset)');
}

// ──────────────────────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  const agents = organization.getAllAgents();
  const tasks = taskManager.getAllTasks();
  const incStats = incidentManager.getStats();
  const allSkills = skillManager.getAll();
  const alertRules = alertRulesEngine.list();
  res.json({
    status: 'ok',
    agentCount: agents.length,
    taskCount: tasks.length,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    incidents: {
      open: incStats.open,
      investigating: incStats.investigating,
      resolved: incStats.resolved,
      slaBreaches: incStats.slaBreaches,
    },
    skills: {
      total: allSkills.length,
      enabled: allSkills.filter((s: any) => s.enabled !== false).length,
    },
    alertRules: {
      total: alertRules.length,
      enabled: alertRules.filter((r: any) => r.enabled !== false).length,
    },
    memory: {
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
    },
  });
});

// ─── Server Metrics Cache ─────────────────────────────────────────────────
interface ServerMetric {
  ip: string;
  name: string;
  reachable: boolean;
  cpu?: number;
  memUsedPct?: number;
  diskUsedPct?: number;
  uptimeSeconds?: number;
  loadAvg?: string;
  error?: string;
  collectedAt: string;
}
let _serverMetricsCache: ServerMetric[] = [];
let _serverMetricsCacheTime = 0;
const SERVER_METRICS_TTL_MS = 30_000;

async function collectServerMetrics(): Promise<ServerMetric[]> {
  const raw = process.env.MONITORED_SERVERS || '';
  const servers = raw.split(',').map(s => s.trim()).filter(Boolean);
  const names: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SERVER_NAME_')) {
      names[key.replace('SERVER_NAME_', '').replace(/_/g, '.')] = process.env[key] as string;
    }
  }

  const results = await Promise.all(servers.map(async (ip): Promise<ServerMetric> => {
    const name = names[ip] || ip;
    const ssh = (cmd: string) => new Promise<string>((resolve, reject) => {
      exec(
        `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes root@${ip} "${cmd}"`,
        { timeout: 8000 },
        (err: any, stdout: string) => err ? reject(err) : resolve(stdout.trim())
      );
    });

    try {
      // Use /proc/ files — no shell variables, no escaping issues
      const [statRaw, memRaw, diskRaw, uptimeRaw, loadRaw] = await Promise.all([
        ssh("cat /proc/stat").catch(() => ''),
        ssh("cat /proc/meminfo").catch(() => ''),
        ssh("df --output=pcent / 2>/dev/null | tail -1 | tr -d ' %'").catch(() => ''),
        ssh("cut -d. -f1 /proc/uptime").catch(() => ''),
        ssh("cut -d' ' -f1-3 /proc/loadavg").catch(() => ''),
      ]);

      // Parse CPU from /proc/stat first line: cpu user nice system idle iowait irq softirq
      let cpuPct: number | undefined;
      const cpuLine = statRaw.split('\n').find(l => l.startsWith('cpu '));
      if (cpuLine) {
        const fields = cpuLine.trim().split(/\s+/).slice(1).map(Number);
        const idle = fields[3] + (fields[4] || 0); // idle + iowait
        const total = fields.reduce((a, b) => a + b, 0);
        cpuPct = total > 0 ? parseFloat(((1 - idle / total) * 100).toFixed(1)) : undefined;
      }

      // Parse memory from /proc/meminfo
      let memPct: number | undefined;
      const memTotal = memRaw.match(/MemTotal:\s+(\d+)/);
      const memAvail = memRaw.match(/MemAvailable:\s+(\d+)/);
      if (memTotal && memAvail) {
        const total = parseInt(memTotal[1], 10);
        const avail = parseInt(memAvail[1], 10);
        memPct = total > 0 ? parseFloat(((1 - avail / total) * 100).toFixed(1)) : undefined;
      }

      return {
        ip,
        name,
        reachable: true,
        cpu: cpuPct,
        memUsedPct: memPct,
        diskUsedPct: diskRaw ? parseInt(diskRaw.trim(), 10) : undefined,
        uptimeSeconds: uptimeRaw ? parseInt(uptimeRaw.trim(), 10) : undefined,
        loadAvg: loadRaw ? loadRaw.trim().replace(/\s+/g, ',') : undefined,
        collectedAt: new Date().toISOString(),
      };
    } catch (e: any) {
      return { ip, name, reachable: false, error: e.message, collectedAt: new Date().toISOString() };
    }
  }));

  return results;
}

app.get('/api/servers', (req, res) => {
  const raw = process.env.MONITORED_SERVERS || '';
  const servers = raw.split(',').map(s => s.trim()).filter(Boolean);
  const names: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SERVER_NAME_')) {
      const ip = key.replace('SERVER_NAME_', '').replace(/_/g, '.');
      names[ip] = process.env[key]!;
    }
  }
  res.json(servers.map(ip => ({ ip, name: names[ip] || ip })));
});

app.get('/api/servers/metrics', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined);
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  try {
    const now = Date.now();
    if (now - _serverMetricsCacheTime > SERVER_METRICS_TTL_MS) {
      _serverMetricsCache = await collectServerMetrics();
      _serverMetricsCacheTime = now;
    }
    res.json({ servers: _serverMetricsCache, cachedAt: new Date(_serverMetricsCacheTime).toISOString() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/servers/metrics/refresh', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined);
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  try {
    _serverMetricsCache = await collectServerMetrics();
    _serverMetricsCacheTime = Date.now();
    res.json({ servers: _serverMetricsCache, cachedAt: new Date(_serverMetricsCacheTime).toISOString() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Anomaly Detection API ────────────────────────────────────────────────────

app.get('/api/anomalies', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  res.json(anomalyDetector.getAnomalies());
});

app.get('/api/servers/:id/anomalies', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  res.json(anomalyDetector.getAnomalies(req.params.id));
});

app.post('/api/anomalies/:id/resolve', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const ok = anomalyDetector.resolveAnomaly(req.params.id);
  if (!ok) { res.status(404).json({ error: 'Anomaly not found' }); return; }
  res.json({ success: true });
});

// /api/servers — CRUD for monitored servers + SSH connectivity test.
// Same auth surface as the rest of the dashboard; lives behind
// security.read / security.write permissions.
app.use('/api/servers', createServersRouter({
  registry: serverRegistry,
  executor: remoteExecutor,
  validateAuth: validateAuthFromHeader,
  logError: (msg, ctx) => logger.error(`[serversApi] ${msg}`, ctx),
}));

// /api/orchestrator/* — extracted to ./orchestratorApi.ts.
app.use('/api/orchestrator', createOrchestratorRouter({
  orchestratorService,
  reliabilityPolicyStore: orchestratorReliabilityPolicyStore,
  policyChangeAuditStore,
  buildReliabilitySlo: buildOrchestratorReliabilitySlo,
  helpers: { cryptoRandomId, computeChangedKeys },
  validateAuth: validateAuthFromHeader,
}));

// /api/security/* — extracted to ./securityApi.ts. The /status snapshot
// is built here (pulls in ~20 module-level constants we don't want to
// thread through the router). Other routes (rate-limit, audit, audit
// CSV export) are self-contained in the router.
app.use('/api/security', createSecurityRouter({
  getStatus: () => ({
    credentialMasterKeyWeak: weakCredentialMasterKey,
    approvalTokenSecretConfigured: !!approvalTokenSecret,
    approvalTokenSecretWeak: weakApprovalTokenSecret,
    authTokenSecretWeak: weakAuthTokenSecret,
    adminPasswordWeak: weakAdminPassword,
    operatorPasswordWeak: weakOperatorPassword,
    enforceStrongSecrets,
    authConfigured: authService.isConfigured(),
    credentialVaultPath: process.env.CREDENTIAL_VAULT_PATH || '/data/itops-agents/credentials.vault.json',
    executionAuditPath: process.env.EXECUTION_AUDIT_PATH || '/data/itops-agents/execution-audit.json',
    approvalLedgerPath: process.env.APPROVAL_LEDGER_PATH || '/data/itops-agents/approval-ledger.json',
    taskSnapshotPath: process.env.TASK_SNAPSHOT_PATH || '/data/itops-agents/task-snapshots.json',
    delegationStorePath: process.env.DELEGATION_STORE_PATH ? process.env.DELEGATION_STORE_PATH.replace(/\.json$/, '.db') : '/data/itops-agents/delegations.db',
    delegationPolicyPath: process.env.DELEGATION_POLICY_PATH || '/data/itops-agents/delegation-policy.json',
    concurrencyPolicyPath: process.env.CONCURRENCY_POLICY_PATH || '/data/itops-agents/concurrency-policy.json',
    targetAllowlistPolicyPath: process.env.TARGET_ALLOWLIST_POLICY_PATH || '/data/itops-agents/target-allowlist-policy.json',
    orchestratorReliabilityPolicyPath: process.env.ORCHESTRATOR_RELIABILITY_POLICY_PATH || '/data/itops-agents/orchestrator-reliability-policy.json',
    orchestratorSloWindowMinutes: ORCHESTRATOR_SLO_WINDOW_MINUTES,
    orchestratorSloMaxQuarantined: ORCHESTRATOR_SLO_MAX_QUARANTINED,
    orchestratorSloMaxRecoveryFailed: ORCHESTRATOR_SLO_MAX_RECOVERY_FAILED,
    orchestratorSloMinSuccessRate: ORCHESTRATOR_SLO_MIN_SUCCESS_RATE,
    slaSnapshotPath: process.env.SLA_SNAPSHOT_PATH || '/data/itops-agents/sla-snapshots.json',
    slaSnapshotPolicyPath: process.env.SLA_SNAPSHOT_POLICY_PATH || '/data/itops-agents/sla-snapshot-policy.json',
    policyAuditPath: process.env.POLICY_AUDIT_PATH || '/data/itops-agents/policy-audit.json',
    secretSources: {
      credentialMasterKey: credentialMasterKeySource,
      approvalTokenSecret: approvalTokenSecretSource,
      authTokenSecret: authTokenSecretSource,
      defaultAccountPassword: defaultAccountPasswordResolved.source,
      adminPassword: adminPasswordResolved.source,
      operatorPassword: operatorPasswordResolved.source,
      viewerPassword: viewerPasswordResolved.source
    },
    secretProvider: {
      provider: String(process.env.SECRET_PROVIDER || '').trim().toLowerCase() || 'none',
      vaultAddrConfigured: !!String(process.env.SECRET_PROVIDER_VAULT_ADDR || '').trim(),
      vaultTokenConfigured: !!(process.env.SECRET_PROVIDER_VAULT_TOKEN || process.env.SECRET_PROVIDER_VAULT_TOKEN_FILE || process.env.SECRET_PROVIDER_VAULT_TOKEN_CMD),
      vaultPathConfigured: !!String(process.env.SECRET_PROVIDER_VAULT_PATH || '').trim(),
      filePathConfigured: !!String(process.env.SECRET_PROVIDER_FILE_PATH || '').trim(),
      filePath: String(process.env.SECRET_PROVIDER_FILE_PATH || '/data/itops-agents/secret-provider.json'),
      fileExists: fs.existsSync(String(process.env.SECRET_PROVIDER_FILE_PATH || '/data/itops-agents/secret-provider.json')),
      awsRegionConfigured: !!String(process.env.SECRET_PROVIDER_AWS_REGION || '').trim(),
      awsSecretIdConfigured: !!String(process.env.SECRET_PROVIDER_AWS_SECRET_ID || '').trim(),
      gcpProjectConfigured: !!String(process.env.SECRET_PROVIDER_GCP_PROJECT || '').trim(),
      gcpSecretIdConfigured: !!String(process.env.SECRET_PROVIDER_GCP_SECRET_ID || '').trim(),
      azureVaultNameConfigured: !!String(process.env.SECRET_PROVIDER_AZURE_VAULT_NAME || '').trim(),
      azureSecretNameConfigured: !!String(process.env.SECRET_PROVIDER_AZURE_SECRET_NAME || '').trim()
    },
    stateBackupDir: STATE_BACKUP_DIR,
    stateBackupTargets: STATE_BACKUP_TARGETS,
  }),
  executionAuditStore,
  validateAuth: validateAuthFromHeader,
  validateAuthToken,
}));

// /api/credentials/* — extracted to ./credentialsApi.ts. Mounted up
// here, but the rotation/lifecycle/CUD inline blocks further down
// were also moved into the same router file.
app.use('/api/credentials', createCredentialsRouter({
  credentialVault,
  rotationManager,
  executionAuditStore,
  eventBus,
  eventTypes: {
    CREDENTIAL_CREATED: EventTypes.CREDENTIAL_CREATED,
    CREDENTIAL_UPDATED: EventTypes.CREDENTIAL_UPDATED,
    CREDENTIAL_DELETED: EventTypes.CREDENTIAL_DELETED,
  },
  aggregateTypes: { CREDENTIAL: AggregateTypes.CREDENTIAL },
  validateAuth: validateAuthFromHeader,
}));

// Skill plugin hot-reload visibility — list currently-loaded plugins and
// trigger a manual rescan. Listed under /api/skill-plugins to keep the
// existing /api/plugins (legacy directory-based plugin runtime) untouched.
// Read-only listing is 'monitoring.read'; rescan is 'admin.write' since it
// can register new dispatch table entries.
// JSON workflow definitions — validate, list, run. Endpoints under
// /api/workflows/json/* to disambiguate from the legacy /api/workflows
// (imperative WorkflowEngine templates).
import { validateWorkflowDef, WORKFLOW_SCHEMA } from '../workflows/WorkflowDef.js';
// Runbook library endpoints — list / search / by-tag / metadata for
// the curated platform runbooks. Run is intentionally NOT a separate
// endpoint here: library runbooks are registered with the same
// WorkflowRegistry, so POST /api/workflows/json/:id/run already drives
// them. That keeps the API surface narrow + DRY.
// ─── Deploy: GitHub Actions workflow_dispatch trigger ──────────────────
//
// Bridges the in-app Deploy button to the .github/workflows/deploy.yml
// pipeline. Operator clicks → POST /api/deploy/trigger → server uses
// the configured GH_DEPLOY_TOKEN to fire workflow_dispatch on the
// repo. The endpoint then exposes a polling read so the dashboard can
// surface the run's progress + a link to the build log.
//
// Required env (server-side; never echoed back):
//   GH_DEPLOY_TOKEN     — fine-grained PAT with Actions: read+write
//   GH_DEPLOY_REPO      — "owner/repo" (e.g. "your-org/itops-agents")
//   GH_DEPLOY_WORKFLOW  — workflow file name (default "deploy.yml")
//   GH_DEPLOY_REF       — git ref (branch or tag) the workflow runs on (default "master")
//
// All four endpoints below are gated on settings.manage so a tenant
// admin can't trigger a production deploy by default.

interface GhRunSummary {
  id: number
  status: string
  conclusion: string | null
  html_url: string
  created_at: string
  updated_at: string
  head_sha: string
  display_title?: string
  name: string
}

async function ghApi<T>(path: string, init?: RequestInit): Promise<T> {
  const token = process.env.GH_DEPLOY_TOKEN;
  if (!token) throw new Error('GH_DEPLOY_TOKEN is not configured');
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      'authorization': `Bearer ${token}`,
      'accept': 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
  }
  // GitHub returns 204 No Content for workflow_dispatch — handle it.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

app.get('/api/deploy/status', requirePermission('settings.manage'), async (_req, res) => {
  // Returns whether the deploy bridge is configured + the most recent
  // workflow runs for the deploy workflow. Dashboard polls this so the
  // operator can watch a deploy progress.
  const repo     = process.env.GH_DEPLOY_REPO;
  const workflow = process.env.GH_DEPLOY_WORKFLOW || 'deploy.yml';
  const configured = !!(process.env.GH_DEPLOY_TOKEN && repo);
  if (!configured) {
    res.json({ configured: false, runs: [] });
    return;
  }
  try {
    const out = await ghApi<{ workflow_runs: GhRunSummary[] }>(
      `/repos/${repo}/actions/workflows/${workflow}/runs?per_page=15`,
    );
    res.json({
      configured: true,
      repo,
      workflow,
      runs: (out.workflow_runs ?? []).map(r => ({
        id: r.id,
        title: r.display_title ?? r.name,
        status: r.status,
        conclusion: r.conclusion,
        sha: r.head_sha?.slice(0, 7),
        url: r.html_url,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    res.status(502).json({ configured: true, error: (err as Error).message, runs: [] });
  }
});

app.post('/api/deploy/trigger', requirePermission('settings.manage'), async (req, res) => {
  const repo     = process.env.GH_DEPLOY_REPO;
  const workflow = process.env.GH_DEPLOY_WORKFLOW || 'deploy.yml';
  const ref      = (req.body?.ref as string | undefined) || process.env.GH_DEPLOY_REF || 'master';
  if (!process.env.GH_DEPLOY_TOKEN || !repo) {
    res.status(412).json({ error: 'Deploy bridge not configured (set GH_DEPLOY_TOKEN + GH_DEPLOY_REPO)' });
    return;
  }
  try {
    await ghApi<void>(`/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref }),
    });
    res.json({ success: true, repo, workflow, ref });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get('/api/deploy/runs/:id/logs', requirePermission('settings.manage'), async (req, res) => {
  // GitHub's logs endpoint redirects to a signed URL; we surface the
  // 302 location so the dashboard can open it in a new tab without
  // proxying multi-MB log archives through this server.
  const repo = process.env.GH_DEPLOY_REPO;
  if (!repo || !process.env.GH_DEPLOY_TOKEN) {
    res.status(412).json({ error: 'deploy bridge not configured' });
    return;
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${req.params.id}/logs`, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'authorization': `Bearer ${process.env.GH_DEPLOY_TOKEN}`, 'accept': 'application/vnd.github+json' },
    });
    const location = r.headers.get('location');
    res.json({ url: location });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// ─── Crystallized Skills API ───────────────────────────────────────────
// List + lifecycle controls for skills the platform learned from
// successful resolutions. Status / agent / tag filters; usage stats.
// Approve/reject/promote drive the lifecycle the AutoPromotion engine
// also runs automatically.
// /api/crystallized-skills/* — extracted to ./crystallizedSkillsApi.ts.
app.use('/api/crystallized-skills', createCrystallizedSkillsRouter({
  crystallizationService,
  requirePermission,
}));

// ─── Self-Development SDK ─────────────────────────────────────────────
// Six endpoints power the dashboard's Develop page + agent automation:
//   POST   /api/sdk/develop            — plan + (optionally) execute
//   POST   /api/sdk/generate-skill     — pure: spec → FileChange[] + tests + scan
//   POST   /api/sdk/generate-workflow  — pure: spec → workflow JSON + scan
//   POST   /api/sdk/test               — sandboxed test runner
//   POST   /api/sdk/deploy             — commit + (optionally) trigger deploy
//   GET    /api/sdk/history            — recent in-process actions
// All routes share the `settings.manage` permission — same level as
// /api/deploy/*. Mutating routes are also rate-limited inside the
// service itself (max 3 sessions / hour by default).
// /api/sdk/* — extracted to ./sdkApi.ts.
app.use('/api/sdk', createSdkRouter({
  selfDevelopmentService,
  requirePermission,
}));

const builderDbPath = process.env.BUILDER_DB_PATH || '/data/itops-agents/builder.db';
const builderProjectRegistry = new BuilderProjectRegistry(builderDbPath);
const qualityEvidenceRegistry = new QualityEvidenceRegistry(builderDbPath);
const qualityGateRunner = new QualityGateRunner(
  process.env.BUILDER_GATE_SIGNING_KEY || process.env.APPROVAL_TOKEN_SECRET || '',
  new LocalGateRuntimeVerifier(),
  Number(process.env.BUILDER_GATE_MAX_CONCURRENT || 2),
);
const toolReleaseStore = new ToolReleaseStore(builderDbPath);
const toolReleaseManager = new ToolReleaseManager(
  toolReleaseStore,
  new FilesystemGitReleaseExporter(process.env.BUILDER_RELEASE_REPO || '/data/itops-agents/builder-releases'),
  new DockerToolDeploymentAdapter(),
  process.env.BUILDER_RELEASE_SIGNING_KEY || process.env.APPROVAL_TOKEN_SECRET || '',
);
const managedIntegrationRegistry = new ManagedIntegrationRegistry(builderDbPath, pluginEncryption);
const managedIntegrationBroker = new ManagedIntegrationBroker(
  managedIntegrationRegistry,
  builderDbPath,
  process.env.BUILDER_INTEGRATION_SIGNING_KEY || process.env.APPROVAL_TOKEN_SECRET || '',
);
const appSpecEditor = new AppSpecEditor(async (system, prompt) => {
  const provider = await aiFactory.getDefaultProvider();
  const response = await provider.chat({ system, messages: [{ role: 'user', content: prompt }], temperature: 0, maxTokens: 8_192 });
  return response.content;
});
const toolCatalog = new ToolCatalog(builderProjectRegistry, toolReleaseManager, builderDbPath);
const toolLaunchRuntime = new ToolLaunchRuntime(new DockerToolRuntimeGateway(), Number(process.env.BUILDER_LAUNCH_TTL_MINUTES || 480));
const previewRuntime = new PreviewRuntime(new DockerPreviewBackend(), {
  maxPerTenant: Number(process.env.PREVIEW_MAX_PER_TENANT || 3),
  maxGlobal: Number(process.env.PREVIEW_MAX_GLOBAL || 10),
  defaultTtlMinutes: Number(process.env.PREVIEW_TTL_MINUTES || 30),
  maxTtlMinutes: Number(process.env.PREVIEW_MAX_TTL_MINUTES || 60),
});
void previewRuntime.initialize().catch(error => logger.error('[PreviewRuntime] orphan cleanup failed', {
  error: error instanceof Error ? error.message : String(error),
}));
app.use('/api/builder', createBuilderRouter({
  registry: builderProjectRegistry,
  generator: new AppGenerator(),
  previews: previewRuntime,
  gateRunner: qualityGateRunner,
  gateEvidence: qualityEvidenceRegistry,
  releases: toolReleaseManager,
  connections: managedIntegrationRegistry,
  integrationBroker: managedIntegrationBroker,
  specEditor: appSpecEditor,
  launches: toolLaunchRuntime,
  catalog: toolCatalog,
  authenticate: requireAuth(),
  requirePermission,
}));

// Engine routes (templates, runs, approvals) MUST be mounted before the
// library `:id` catch-all below — otherwise GET /api/runbooks/templates
// gets matched as `:id="templates"` and returns 404. Both surfaces share
// the `/api/runbooks` prefix; an unmatched sub-path falls through to
// the library handlers via Express's normal router chain.
app.use('/api/runbooks', createRunbooksRouter({
  engine: runbookEngine,
  approvals: runbookApprovalStore,
  auditLog,
  validateAuth: validateAuthFromHeader,
}));

app.get('/api/runbooks', requirePermission('workflows.read'), (req, res) => {
  const q   = (req.query.q   as string | undefined)?.trim();
  const tag = (req.query.tag as string | undefined)?.trim();
  let runbooks = q ? runbookLibrary.search(q) : runbookLibrary.list();
  if (tag) runbooks = runbooks.filter(r => r.tags.some(t => t.toLowerCase() === tag.toLowerCase()));
  // Strip the heavy `workflow` field on list responses; clients fetch
  // it via /api/runbooks/:id when they need the steps.
  res.json({
    runbooks: runbooks.map(({ workflow, ...meta }) => meta),
    failures: runbookLibrary.recentFailures(),
  });
});
app.get('/api/runbooks/tags', requirePermission('workflows.read'), (_req, res) => {
  res.json({ tags: runbookLibrary.allTags() });
});
app.get('/api/runbooks/:id', requirePermission('workflows.read'), (req, res) => {
  const runbook = runbookLibrary.get(req.params.id);
  if (!runbook) { res.status(404).json({ error: 'runbook not found' }); return; }
  res.json({ runbook });
});

// ─── Schedule API ─────────────────────────────────────────────────────
// CRUD + run history + pause/resume + run-now. The engine's API maps
// 1:1 onto these routes; everything goes through the same workflow
// permission set since a schedule is just a cron-fired workflow run.
// /api/schedules/* — extracted to ./schedulesApi.ts.
app.use('/api/schedules', createSchedulesRouter({
  schedulesStore: storeFactory.schedules,
  scheduleEngine,
  requirePermission,
}));

app.get('/api/workflows/json', requirePermission('workflows.read'), (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'monitoring.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  res.json({
    workflows: workflowRegistry.list().map(r => ({
      id: r.workflow.id, name: r.workflow.name, version: r.workflow.version,
      description: r.workflow.description, steps: r.workflow.steps.length,
      filePath: r.filePath, loadedAt: r.loadedAt,
    })),
    failures: workflowRegistry.recentFailures(),
  });
});
app.get('/api/workflows/json/schema', (_req, res) => {
  // Public: agents + tooling consume this to validate locally before
  // submitting. No sensitive content.
  res.json(WORKFLOW_SCHEMA);
});
app.post('/api/workflows/json/validate', requirePermission('workflows.read'), (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'monitoring.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const v = validateWorkflowDef(req.body);
  res.json(v);
});
// In-memory workflow registration. Operators wanting durable workflow
// definitions still drop a .workflow.json into WORKFLOW_DIR; this
// endpoint is the dashboard's quick-register path so a user can hit
// Save then immediately Run without touching the filesystem.
app.post('/api/workflows/json', requirePermission('workflows.write'), (req, res) => {
  try {
    const result = workflowRegistry.registerFromObject(req.body);
    if (!result.ok) { res.status(400).json({ ok: false, errors: result.errors }); return; }
    res.json({ success: true, workflow: { id: result.workflow.id, name: result.workflow.name, version: result.workflow.version } });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

app.post('/api/workflows/json/:id/run', requirePermission('workflows.execute'), async (req, res) => {
  try {
    const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'admin.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const wf = workflowRegistry.get(req.params.id);
    if (!wf) { res.status(404).json({ error: 'workflow not found' }); return; }
    const inputs   = (req.body?.inputs   ?? {}) as Record<string, unknown>;
    const approvals= (req.body?.approvals?? {}) as Record<string, string>;
    const correlationId = `wfrun-${req.params.id}-${Date.now()}`;
    await eventBus.publish({
      aggregateType: AggregateTypes.WORKFLOW, aggregateId: req.params.id,
      type: EventTypes.WORKFLOW_RUN_STARTED,
      actor: auth.username || 'api', correlationId,
      data: { inputs, version: wf.version },
    });
    const run = await workflowJsonExecutor.execute(wf, { inputs, approvals });
    const finishedType =
      run.status === 'completed'        ? EventTypes.WORKFLOW_RUN_COMPLETED :
      run.status === 'pending_approval' ? EventTypes.WORKFLOW_RUN_PAUSED :
                                          EventTypes.WORKFLOW_RUN_FAILED;
    await eventBus.publish({
      aggregateType: AggregateTypes.WORKFLOW, aggregateId: req.params.id,
      type: finishedType,
      actor: auth.username || 'api', correlationId,
      data: { runId: run.runId, status: run.status, error: run.error, awaiting: run.awaitingApproval },
    });
    res.json({ success: run.status !== 'failed', run });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Event log — read-only access to the durable event stream. Powers the
// activity feed + replay-driven debugging tools. Filters mirror
// EventStreamFilter so an operator can ask "every event for task-42 in
// the last hour" with a single query.
app.get('/api/events', requirePermission('events.read'), async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'monitoring.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const events = await eventBus.read({
    aggregateType: req.query.aggregateType as string | undefined,
    aggregateId:   req.query.aggregateId   as string | undefined,
    type:          req.query.type          as string | undefined,
    since:         req.query.since         as string | undefined,
    until:         req.query.until         as string | undefined,
    limit:         req.query.limit  ? Number(req.query.limit)  : undefined,
    offset:        req.query.offset ? Number(req.query.offset) : undefined,
  });
  res.json({ events, count: events.length });
});
app.get('/api/events/subscriptions', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'monitoring.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  res.json({ subscriptions: eventBus.listSubscriptions() });
});

app.get('/api/skill-plugins', requirePermission('plugins.manage'), (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'monitoring.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  res.json({ plugins: skillPluginLoader.list() });
});
app.post('/api/skill-plugins/rescan', requirePermission('plugins.manage'), async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'admin.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const result = await skillPluginLoader.loadAll();
  res.json({ success: true, ...result, plugins: skillPluginLoader.list() });
});

// Sandboxed plugin loader has the same shape but runs each plugin in a
// Worker thread under a permission manifest. Listed separately so an
// operator can tell at a glance which surface is sandboxed.
app.get('/api/skill-plugins/sandboxed', requirePermission('plugins.manage'), (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'monitoring.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  res.json({ plugins: sandboxedSkillPluginLoader.list() });
});
app.post('/api/skill-plugins/sandboxed/rescan', requirePermission('plugins.manage'), async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'admin.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const result = await sandboxedSkillPluginLoader.loadAll();
  res.json({ success: true, ...result, plugins: sandboxedSkillPluginLoader.list() });
});

// Tenant administration. Listing requires monitoring.read; mutating the
// roster requires admin.write since it reshapes data isolation.
// Personality profile endpoints. The engine surface is intentionally
// narrow — every signal is one POST. Read endpoints expose the current
// profile + the synthesised prompt fragment so operators can inspect
// what the agent's actually instructed to do.
app.get('/api/agents/:agentId/personality', requirePermission('agents.read'), async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'monitoring.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const profile = await personalityEngine.get(req.params.agentId);
  if (!profile) { res.status(404).json({ error: 'no profile' }); return; }
  const fragment = await personalityEngine.getPromptFragment(req.params.agentId);
  res.json({ profile, promptFragment: fragment });
});
app.post('/api/agents/:agentId/personality/feedback', requirePermission('agents.write'), async (req, res) => {
  try {
    const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'admin.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const { rating, note } = req.body || {};
    if (rating !== 1 && rating !== -1) { res.status(400).json({ error: 'rating must be 1 or -1' }); return; }
    const profile = await personalityEngine.recordFeedback(req.params.agentId, rating, note);
    res.json({ success: true, profile });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});
app.post('/api/agents/:agentId/personality/correction', requirePermission('agents.write'), async (req, res) => {
  try {
    const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'admin.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const { avoid, dropAutonomy } = req.body || {};
    if (typeof avoid !== 'string' || !avoid.trim()) {
      res.status(400).json({ error: 'avoid (string) is required' }); return;
    }
    const profile = await personalityEngine.recordCorrection(req.params.agentId, avoid, { dropAutonomy: !!dropAutonomy });
    res.json({ success: true, profile });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// ServiceRegistry diagnostics — what services are wired in this
// process. Useful as the codebase migrates toward microservices.
app.get('/api/services', requirePermission('settings.manage'), (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'monitoring.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  res.json({ services: services.list() });
});

app.get('/api/tenants', requirePermission('tenants.manage'), async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'monitoring.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const tenants = await Promise.resolve(storeFactory.tenants.list());
  res.json({ tenants, current: req.tenant });
});
app.post('/api/tenants', requirePermission('tenants.manage'), async (req, res) => {
  try {
    const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'admin.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const { id, name, status, settings } = req.body || {};
    if (!id || typeof id !== 'string') { res.status(400).json({ error: 'id required' }); return; }
    const t = await Promise.resolve(storeFactory.tenants.upsert({ id, name, status, settings }));
    res.json({ success: true, tenant: t });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});
app.delete('/api/tenants/:id', requirePermission('tenants.manage'), async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'admin.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const ok = await Promise.resolve(storeFactory.tenants.delete(req.params.id));
  if (!ok) { res.status(409).json({ error: 'tenant cannot be deleted (system tenant or not found)' }); return; }
  res.json({ success: true });
});

// /api/rbac/{permissions,roles,assignments,whoami} — extracted to
// ./rbacAdminApi.ts. Layered AFTER the existing /api/rbac mount
// (users + api-keys CRUD); Express falls through the first router
// for paths it doesn't match.
app.use('/api/rbac', createRbacAdminRouter({
  rbacService,
  requirePermission,
  validateAuth: validateAuthFromHeader,
}));

// Credential rotation — read status (last sweep), set lifecycle metadata
// (kind/expiresAt/rotationIntervalDays) on an existing credential, and
// trigger a manual sweep. The actual rotation logic lives in the registered
// rotators; these endpoints just drive the manager.
// (Credentials rotation/lifecycle/CUD routes moved to ./credentialsApi.ts above.)

// /api/approvals/* — extracted to ./approvalsApi.ts.
app.use('/api/approvals', createApprovalsRouter({
  approvalTokenService,
  approvalTokenLedger,
  getToolPolicy,
  validateAuth: validateAuthFromHeader,
}));

app.get('/api/audit/executions', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'audit.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  res.json({
    records: executionAuditStore.list(limit)
  });
});

app.get('/api/audit/executions/export', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'audit.read');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  const limit = req.query.limit ? Number(req.query.limit) : 200;
  const sourceRecords = executionAuditStore.list(limit);
  const chain = computeAuditChain(sourceRecords);
  const envelope = {
    exportedAt: new Date().toISOString(),
    exportedBy: auth.username || 'unknown',
    algorithm: {
      recordHash: 'sha256',
      exportSignature: 'hmac-sha256'
    },
    recordCount: chain.records.length,
    chainHead: chain.headHash
  };
  const signature = signAuditExport(envelope);
  res.json({
    ...envelope,
    signature,
    records: chain.records,
    chain: chain.chain
  });
});

// /api/agent-bus/* — extracted to ./agentBusApi.ts.
app.use('/api/agent-bus', createAgentBusRouter({
  agentBus,
  credentialExecutionResolver,
  dispatchMessage: dispatchAgentBusMessage,
  dispatchSwarm: dispatchAgentSwarm,
  validateAuth: validateAuthFromHeader,
}));

app.get('/api/openclaw-bridge/health', (_req, res) => {
  res.json({
    enabled: OPENCLAW_BRIDGE_ENABLED,
    configured: OPENCLAW_BRIDGE_ENABLED && !!OPENCLAW_BRIDGE_SECRET,
    statePath: OPENCLAW_BRIDGE_STATE_PATH,
    chats: Object.keys(openClawBridgeState.chats).length
  });
});

app.post('/api/openclaw-bridge/inbound', async (req, res) => {
  if (!isOpenClawBridgeAllowed(req)) {
    res.status(403).json({ error: 'OpenClaw bridge unauthorized or disabled' });
    return;
  }
  const chatId = String(req.body?.chatId || '').trim();
  const userId = req.body?.userId ? String(req.body.userId) : undefined;
  const text = String(req.body?.text || '').trim();
  const requestedAgent = String(req.body?.agentId || '').trim();
  const expectReply = req.body?.expectReply !== false;
  if (!chatId || !text) {
    res.status(400).json({ error: 'chatId and text are required' });
    return;
  }
  const director = getDirectorForBridge();
  if (!director) {
    res.status(503).json({ error: 'No director agent available' });
    return;
  }
  const chatState = getOpenClawChatState(chatId);
  if (userId) chatState.userId = userId;

  const lower = text.toLowerCase();
  if (lower === '/agents') {
    const targets = listTargetableAgents();
    if (targets.length === 0) {
      res.json({ success: true, responseText: 'No target agents available.', chat: chatState });
      return;
    }
    const lines = targets.map(agent => `- ${agent.name} (${agent.id})`);
    res.json({
      success: true,
      responseText: `Available agents:\n${lines.join('\n')}\n\nUse: /use <agent-id-or-name>`,
      chat: chatState
    });
    return;
  }

  if (lower.startsWith('/use ')) {
    const selector = text.slice(5).trim();
    const target = resolveAgentBySelector(selector);
    if (!target || target.role === 'director') {
      res.status(400).json({ error: 'Agent not found or invalid target' });
      return;
    }
    chatState.targetAgentId = target.id;
    chatState.updatedAt = new Date().toISOString();
    saveOpenClawBridgeState();
    res.json({
      success: true,
      responseText: `Target set to ${target.name} (${target.id}).`,
      chat: chatState
    });
    return;
  }

  if (lower === '/status') {
    const target = chatState.targetAgentId ? organization.getAgent(chatState.targetAgentId) : undefined;
    res.json({
      success: true,
      responseText: `Chat ${chatId}\nTarget: ${target ? `${target.name} (${target.id})` : 'not set'}\nThread: ${chatState.threadId || 'not set'}`,
      chat: chatState
    });
    return;
  }

  if (lower === '/approvals' || lower.startsWith('/approvals ')) {
    const rawLimit = Number(text.split(/\s+/)[1] || 10);
    const pending = listPendingApprovalCandidates(rawLimit);
    if (pending.length === 0) {
      res.json({
        success: true,
        responseText: 'No pending approval-required commands detected in recent audit.',
        pending: []
      });
      return;
    }
    const lines = pending.map(item =>
      `- ${item.command} | agent=${item.agentId} | blocked=${item.blockedAt} | reason=${item.reason}`
    );
    res.json({
      success: true,
      pending,
      responseText:
        `Pending approvals (${pending.length}):\n${lines.join('\n')}\n\n` +
        'Approve all: /approve pending\n' +
        'Approve one: /approve <command> [agentId] [ttlSeconds]'
    });
    return;
  }

  if (lower.startsWith('/approve ')) {
    const args = text.slice('/approve '.length).trim().split(/\s+/).filter(Boolean);
    if (args.length === 0) {
      res.status(400).json({ error: 'Usage: /approve pending OR /approve <command> [agentId] [ttlSeconds]' });
      return;
    }
    const approver = userId || 'openclaw-bridge';
    if (args[0].toLowerCase() === 'pending') {
      const limit = Number(args[1] || 10);
      const ttlSeconds = args[2] ? Number(args[2]) : 900;
      const pending = listPendingApprovalCandidates(limit);
      if (pending.length === 0) {
        res.json({
          success: true,
          responseText: 'No pending approval-required commands to approve.',
          approvals: []
        });
        return;
      }
      const approvals = pending.map(item => mintApprovalForOpenClaw({
        command: item.command,
        agentId: item.agentId,
        ttlSeconds,
        approver,
        reason: `OpenClaw pending approval by ${approver} in chat ${chatId}`
      }));
      const lines = approvals.map(a =>
        `- ${a.command} | agent=${a.agentId} | tokenId=${a.tokenId} | expires=${a.expiresAt}\n  token=${a.token}`
      );
      res.json({
        success: true,
        mode: 'approve-pending',
        approvals,
        responseText: `Approved ${approvals.length} pending request(s):\n${lines.join('\n')}`
      });
      return;
    }

    const command = args[0];
    const agentId = args[1] || 'operator';
    const ttlSeconds = args[2] ? Number(args[2]) : 900;
    try {
      const approval = mintApprovalForOpenClaw({
        command,
        agentId,
        ttlSeconds,
        approver,
        reason: `OpenClaw manual approval by ${approver} in chat ${chatId}`
      });
      res.json({
        success: true,
        mode: 'approve-one',
        approval,
        responseText:
          `Approved ${approval.command} for ${approval.agentId}\n` +
          `tokenId=${approval.tokenId}\n` +
          `expires=${approval.expiresAt}\n` +
          `token=${approval.token}`
      });
      return;
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }
  }

  if (lower.startsWith('/swarm ')) {
    const swarmTask = text.slice(7).trim();
    if (!swarmTask) {
      res.status(400).json({ error: 'Usage: /swarm <task>' });
      return;
    }
    try {
      const swarmResult = await dispatchAgentSwarm({
        task: swarmTask,
        coordinatorAgentId: director.id,
        threadId: chatState.threadId,
        actorId: userId || director.id
      });
      const responseText = swarmResult.synthesis
        ? swarmResult.synthesis
        : swarmResult.workers
            .map(result => `${result.agentName}: ${result.success ? String(result.reply?.content || '').slice(0, 240) : `FAILED - ${result.error || 'unknown error'}`}`)
            .join('\n\n');

      chatState.updatedAt = new Date().toISOString();
      saveOpenClawBridgeState();
      res.json({
        success: true,
        mode: 'swarm',
        responseText,
        runId: swarmResult.runId,
        workers: swarmResult.workers.map(result => ({
          agentId: result.agentId,
          agentName: result.agentName,
          role: result.role,
          success: result.success,
          durationMs: result.durationMs,
          error: result.error
        }))
      });
      return;
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
      return;
    }
  }

  let targetAgent = requestedAgent ? resolveAgentBySelector(requestedAgent) : undefined;
  if (!targetAgent && chatState.targetAgentId) {
    targetAgent = organization.getAgent(chatState.targetAgentId);
  }
  if (!targetAgent) {
    const defaults = listTargetableAgents();
    targetAgent = defaults.length > 0 ? defaults[0] : undefined;
  }
  if (!targetAgent || targetAgent.role === 'director') {
    res.status(400).json({ error: 'No valid target agent for this chat' });
    return;
  }

  try {
    const result = await dispatchAgentBusMessage({
      fromAgentId: director.id,
      toAgentId: targetAgent.id,
      content: text,
      threadId: chatState.threadId,
      expectReply
    });
    chatState.targetAgentId = targetAgent.id;
    chatState.threadId = result.sent.threadId;
    chatState.updatedAt = new Date().toISOString();
    saveOpenClawBridgeState();
    const replyText = result.reply ? String(result.reply.content || '') : 'Message queued.';
    res.json({
      success: true,
      chatId,
      threadId: result.sent.threadId,
      targetAgent: { id: targetAgent.id, name: targetAgent.name },
      sent: result.sent,
      reply: result.reply || undefined,
      responseText: replyText
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/openclaw-bridge/replies', (req, res) => {
  if (!isOpenClawBridgeAllowed(req)) {
    res.status(403).json({ error: 'OpenClaw bridge unauthorized or disabled' });
    return;
  }
  const chatId = String(req.query.chatId || '').trim();
  if (!chatId) {
    res.status(400).json({ error: 'chatId is required' });
    return;
  }
  const chatState = openClawBridgeState.chats[chatId];
  if (!chatState || !chatState.threadId) {
    res.json({ success: true, replies: [], chat: chatState || { chatId } });
    return;
  }
  const director = getDirectorForBridge();
  if (!director) {
    res.status(503).json({ error: 'No director agent available' });
    return;
  }
  const since = String(req.query.since || chatState.lastDeliveredAt || '');
  const sinceMs = since ? Date.parse(since) : 0;
  const messages = agentBus
    .listMessages({ threadId: chatState.threadId, limit: 400 })
    .slice()
    .reverse();
  const replies = messages.filter(message => {
    const ts = Date.parse(message.timestamp);
    if (Number.isNaN(ts)) return false;
    return message.toAgentId === director.id
      && message.fromAgentId !== director.id
      && ts > sinceMs;
  });
  if (replies.length > 0) {
    chatState.lastDeliveredAt = replies[replies.length - 1].timestamp;
    chatState.updatedAt = new Date().toISOString();
    saveOpenClawBridgeState();
  }
  res.json({
    success: true,
    chatId,
    threadId: chatState.threadId,
    replies: replies.map(reply => {
      const from = organization.getAgent(reply.fromAgentId);
      return {
        id: reply.id,
        threadId: reply.threadId,
        timestamp: reply.timestamp,
        fromAgentId: reply.fromAgentId,
        fromAgentName: from?.name || reply.fromAgentId,
        content: reply.content
      };
    }),
    cursor: chatState.lastDeliveredAt || null
  });
});

app.get('/dashboard', (_req, res) => {
  res.sendFile('dashboard-legacy.html', { root: 'public' });
});
app.get('/', (_req, res) => {
  // Root now lands users on the React app at /app/. The terminal UI
  // (public/tui.html) is intentionally still on disk and reachable
  // directly via /tui.html through the static middleware, so anyone
  // who needs the legacy interface can still get to it. 302 (not 301)
  // because browsers cache 301s aggressively — keeping this reversible.
  res.redirect(302, '/app/');
});


// Compatibility path for previous "modern" URL.
app.get('/modern', (_req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

// Legacy path now permanently forwards to dashboard.
app.get('/legacy', (_req, res) => {
  res.redirect('/dashboard');
});

// ============================================================
// Phase 36: Workflow Chains (If-Then Automation)
// ============================================================
interface WorkflowTrigger {
  type: 'health' | 'incident' | 'notification' | 'schedule' | 'manual';
  condition: string;
}

interface WorkflowAction {
  type: 'run_command' | 'send_notification' | 'create_incident' | 'delegate_agent' | 'http_request';
  params: Record<string, any>;
}

interface WorkflowRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: WorkflowTrigger;
  actions: WorkflowAction[];
  cooldown: number;
  lastTriggered?: string;
  triggerCount: number;
  createdAt: string;
  updatedAt: string;
}

const WORKFLOWS_FILE = '/data/itops-agents/workflows.json';
let workflows: WorkflowRule[] = [];

try {
  if (fs.existsSync(WORKFLOWS_FILE)) {
    workflows = JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf-8'));
    logger.info(`[WorkflowEngine] Loaded ${workflows.length} workflow(s)`);
  }
} catch (e) { logger.warn('[WorkflowEngine] Failed to load workflows'); }

function saveWorkflows() {
  try {
    const dir = '/data/itops-agents';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify(workflows, null, 2));
  } catch (e) {}
}

function evaluateCondition(condition: string, context: Record<string, any>): boolean {
  try {
    const parts = condition.match(/^(\w+)\s*(==|!=|>|<|>=|<=|contains)\s*(.+)$/);
    if (!parts) return false;
    const [, field, op, rawValue] = parts;
    const ctxValue = context[field];
    if (ctxValue === undefined) return false;
    const value = rawValue.trim().replace(/^['"]|['"]$/g, '');
    const numCtx = parseFloat(ctxValue);
    const numVal = parseFloat(value);
    switch (op) {
      case '==': return String(ctxValue) === value;
      case '!=': return String(ctxValue) !== value;
      case '>': return !isNaN(numCtx) && !isNaN(numVal) && numCtx > numVal;
      case '<': return !isNaN(numCtx) && !isNaN(numVal) && numCtx < numVal;
      case '>=': return !isNaN(numCtx) && !isNaN(numVal) && numCtx >= numVal;
      case '<=': return !isNaN(numCtx) && !isNaN(numVal) && numCtx <= numVal;
      case 'contains': return String(ctxValue).toLowerCase().includes(value.toLowerCase());
      default: return false;
    }
  } catch { return false; }
}

async function executeWorkflowAction(action: WorkflowAction, context: Record<string, any>): Promise<string> {
  try {
    switch (action.type) {
      case 'run_command': {
        const cmd = action.params.command || '';
        return new Promise((resolve) => {
          exec(cmd, { timeout: 30000 }, (err: any, stdout: string, stderr: string) => {
            resolve(err ? `Error: ${stderr || err.message}` : stdout.slice(0, 500));
          });
        });
      }
      case 'send_notification': {
        pushNotification({ type: action.params.severity || 'info', title: action.params.title || 'Workflow Alert', message: action.params.message || '', agentId: 'workflow-engine', source: 'workflow' });
        return 'Notification sent';
      }
      case 'create_incident': {
        const inc = incidentManager.create({ title: action.params.title || 'Workflow Incident', description: action.params.description || '', severity: action.params.severity || 'medium', source: 'workflow-engine' });
        return `Incident created: #${inc.id}`;
      }
      case 'delegate_agent': {
        return `Delegated to agent: ${action.params.agentId || 'director'}`;
      }
      case 'http_request': {
        try {
          const resp = await fetch(action.params.url || '', { method: action.params.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: action.params.body ? JSON.stringify(action.params.body) : undefined });
          return `HTTP ${resp.status}`;
        } catch (e: any) { return `HTTP Error: ${e.message}`; }
      }
      default: return 'Unknown action type';
    }
  } catch (e: any) { return `Action error: ${e.message}`; }
}

async function evaluateWorkflows(triggerType: WorkflowTrigger['type'], context: Record<string, any>) {
  const now = Date.now();
  for (const wf of workflows) {
    if (!wf.enabled) continue;
    if (wf.trigger.type !== triggerType) continue;
    if (wf.lastTriggered) {
      const elapsed = (now - new Date(wf.lastTriggered).getTime()) / 1000;
      if (elapsed < wf.cooldown) continue;
    }
    if (!evaluateCondition(wf.trigger.condition, context)) continue;
    wf.lastTriggered = new Date().toISOString();
    wf.triggerCount = (wf.triggerCount || 0) + 1;
    logger.info(`[WorkflowEngine] Triggered: ${wf.name} (count: ${wf.triggerCount})`);
    for (const action of wf.actions) {
      try { await executeWorkflowAction(action, context); } catch {}
    }
    saveWorkflows();
  }
}

// /api/automation-rules/* — extracted to ./automationRulesApi.ts.
// State (`workflows` array) stays here so the workflow tick loop can
// iterate it; the router mutates it by reference.
app.use('/api/automation-rules', createAutomationRulesRouter({
  workflows,
  saveWorkflows,
  evaluateCondition,
  executeWorkflowAction,
}));



// ============================================================
// Phase 35: Multi-Server SSH Monitoring
// ============================================================
// The earlier skeleton (JSON-backed monitoredServers + a 60s probe loop
// that recorded metrics but never opened incidents) has been removed.
// It's been superseded by the SQLite-backed ServerRegistry + RemoteExecutor
// + per-server SystemMonitors wired earlier in this file. Operators see
// remote-server health through the same incident pipeline as local now:
// the same dedup, the same auto-resolve, the same agent dispatch.
// The route alias below keeps the old /api/monitored-servers URL working
// against the new system so any external integration that still calls
// it stays functional.
app.use('/api/monitored-servers', createServersRouter({
  registry: serverRegistry,
  executor: remoteExecutor,
  validateAuth: validateAuthFromHeader,
  logError: (msg, ctx) => logger.error(`[serversApi:alias] ${msg}`, ctx),
}));



// ============================================================
// Phase 38: Webhook Triggers
// ============================================================
interface WebhookDef {
  id: string;
  name: string;
  description: string;
  secret: string;
  enabled: boolean;
  action: 'notification' | 'incident' | 'automation' | 'agent';
  actionConfig: Record<string, any>;
  lastTriggered?: string;
  triggerCount: number;
  createdAt: string;
}

const WEBHOOKS_FILE = '/data/itops-agents/webhooks.json';
let webhookDefs: WebhookDef[] = [];

try {
  if (fs.existsSync(WEBHOOKS_FILE)) {
    webhookDefs = JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf-8'));
    logger.info(`[Webhooks] Loaded ${webhookDefs.length} webhook(s)`);
  }
} catch (e) { logger.warn('[Webhooks] Failed to load webhooks'); }

function saveWebhooks() {
  try {
    const dir = '/data/itops-agents';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(webhookDefs, null, 2));
  } catch (e) {}
}

function generateWebhookSecret(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

// /api/webhooks/* — extracted to ./webhooksApi.ts. (Inbound trigger
// handler /api/hook/:id stays inline below — different prefix.)
app.use('/api/webhooks', createWebhooksRouter({
  webhookDefs,
  saveWebhooks,
  generateWebhookSecret,
}));

// Inbound webhook handler (no auth required - uses secret validation)
app.post('/api/hook/:id', (req: any, res: any) => {
  const wh = webhookDefs.find((w: WebhookDef) => w.id === req.params.id);
  if (!wh) return res.status(404).json({ error: 'Webhook not found' });
  if (!wh.enabled) return res.status(403).json({ error: 'Webhook disabled' });

  // Validate secret from header or query param
  const providedSecret = req.headers['x-webhook-secret'] || req.query.secret || '';
  if (providedSecret !== wh.secret) {
    return res.status(401).json({ error: 'Invalid secret' });
  }

  const payload = req.body || {};
  wh.lastTriggered = new Date().toISOString();
  wh.triggerCount = (wh.triggerCount || 0) + 1;
  saveWebhooks();

  // Execute action based on webhook configuration
  try {
    switch (wh.action) {
      case 'notification': {
        const title = wh.actionConfig.titleTemplate
          ? wh.actionConfig.titleTemplate.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => payload[k] || k)
          : payload.title || payload.alert || wh.name;
        const message = wh.actionConfig.messageTemplate
          ? wh.actionConfig.messageTemplate.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => payload[k] || k)
          : payload.message || payload.description || JSON.stringify(payload).slice(0, 200);
        pushNotification({ type: wh.actionConfig.severity || 'info', title, message, agentId: 'webhook', source: 'webhook' });
        res.json({ success: true, action: 'notification', title });
        break;
      }
      case 'incident': {
        const title = payload.title || payload.alert || wh.actionConfig.title || `Webhook: ${wh.name}`;
        const description = payload.description || payload.message || JSON.stringify(payload).slice(0, 500);
        const severity = payload.severity || wh.actionConfig.severity || 'medium';
        const inc = incidentManager.create({ title, description, severity, source: 'webhook' });
        res.json({ success: true, action: 'incident', incidentId: inc.id });
        break;
      }
      case 'automation': {
        // Trigger automation rules with webhook payload as context
        const context = { ...payload, webhook: wh.name, source: 'webhook' };
        evaluateWorkflows('notification', context).catch(() => {});
        res.json({ success: true, action: 'automation', context: Object.keys(context) });
        break;
      }
      case 'agent': {
        // Store as a notification for agent to pick up
        pushNotification({ type: 'info', title: `Webhook: ${wh.name}`, message: JSON.stringify(payload).slice(0, 300), agentId: wh.actionConfig.agentId || 'director', source: 'webhook' });
        res.json({ success: true, action: 'agent', agentId: wh.actionConfig.agentId || 'director' });
        break;
      }
      default:
        res.json({ success: true, action: 'none' });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});


function startBeaconDbHardening(): void {
  for (const t of BEACON_DB_PATHS) {
    sqliteBackupRunner.register({ name: t.name, sourcePath: t.path });
    sqliteVacuumRunner.register({ name: t.name, sourcePath: t.path });
    databaseSizeMonitor.register({ name: t.name, path: t.path });
  }
  databaseSizeMonitor.start();

  if (RECOVERY_SET_ENABLED) {
    if (cronLib.validate(RECOVERY_SET_CRON)) {
      cronLib.schedule(RECOVERY_SET_CRON, async () => {
        const result = await runRecoverySet('scheduled');
        if (result.success) serverLog.info('full recovery set completed', result);
        else serverLog.error('full recovery set failed', { error: result.error });
      });
      serverLog.info('full recovery set scheduled', { cron: RECOVERY_SET_CRON, offsiteConfigured: s3Uploader.isConfigured });
    } else {
      recoverySchedulerState.lastError = `Invalid RECOVERY_SET_CRON: ${RECOVERY_SET_CRON}`;
      persistRecoverySchedulerState();
      serverLog.error('full recovery set schedule disabled', { cron: RECOVERY_SET_CRON });
    }
  }

  // Daily backup runs via the existing schedule engine — same cron
  // infrastructure as the other default jobs so an operator can see /
  // disable it from the schedules page. Default 03:30 server-local.
  const backupCron = process.env.SQLITE_BACKUP_CRON || '30 3 * * *';
  const vacuumCron = process.env.SQLITE_VACUUM_CRON || '0 4 * * 0';

  // The schedule engine's `workflow|task` shapes don't natively run JS,
  // so the daily backup and weekly VACUUM use node-cron directly. Same
  // package the report + automation schedulers use; the JIT scheduler is
  // cheap and the work is short-lived once a day.
  if (cronLib.validate(backupCron)) {
    cronLib.schedule(backupCron, async () => {
      try {
        const report = await sqliteBackupRunner.runOnce();
        serverLog.info('sqlite daily backup completed', {
          successCount: report.successCount,
          failureCount: report.failureCount,
          durationMs: report.durationMs,
        });
        if (report.failureCount > 0) {
          for (const r of report.results.filter(x => !x.ok)) {
            serverLog.error('sqlite backup target failed', { name: r.name, error: r.error });
          }
        }
      } catch (err) {
        serverLog.error('sqlite daily backup threw', { err: (err as Error).message });
      }
    });
    serverLog.info('sqlite daily backup scheduled', { cron: backupCron, destRoot: process.env.SQLITE_BACKUP_DIR || path.join(STATE_BACKUP_DIR, 'sqlite') });
  } else {
    serverLog.warn('SQLITE_BACKUP_CRON invalid — daily SQLite backup disabled', { cron: backupCron });
  }

  if (cronLib.validate(vacuumCron)) {
    cronLib.schedule(vacuumCron, async () => {
      try {
        const report = await sqliteVacuumRunner.runOnce();
        serverLog.info('sqlite weekly vacuum completed', {
          successCount: report.successCount,
          failureCount: report.failureCount,
          reclaimedBytes: report.totalReclaimedBytes,
          durationMs: report.durationMs,
        });
      } catch (err) {
        serverLog.error('sqlite weekly vacuum threw', { err: (err as Error).message });
      }
    });
    serverLog.info('sqlite weekly vacuum scheduled', { cron: vacuumCron });
  } else {
    serverLog.warn('SQLITE_VACUUM_CRON invalid — weekly VACUUM disabled', { cron: vacuumCron });
  }
}

export async function startServer(port: number = 19123): Promise<void> {
  // Initialize director only on first boot / empty organization.
  if (!organization.getDirector()) {
    await organization.createDirector();
    organization.save(ORG_FILE);
    serverLog.info('organization initialized and saved', { component: 'startup', path: ORG_FILE });
  }

  // Start scheduled reports
  reportsScheduler.start(
    () => incidentManager.list({}),
    () => organization.getAllAgents(),
    () => {
      const stats = taskManager.getStatistics();
      return { pending: stats.pending || 0, inProgress: stats.in_progress || 0, completed: stats.completed || 0 };
    },
  );

  // ── DB hardening: daily backups, weekly VACUUM, size monitor ────────
  // Every SQLite file the platform writes to has its path resolved here
  // and shared between the backup runner, the vacuum runner, and the
  // size monitor. Adding a new store means appending to BEACON_DB_PATHS
  // — there's no per-store .register() to forget.
  startBeaconDbHardening();

  // Global error handler — must be the LAST middleware so anything
  // thrown by route handlers (including 404 fall-throughs that hit
  // a downstream next(err)) lands here. Returns the structured
  // envelope; in production stack traces are scrubbed.
  app.use(errorHandler);

  server.listen(port, () => {



    logger.info('\nRightAPI Forge Server Started');
    logger.info(`📡 Admin Dashboard: http://localhost:${port}`);
    logger.info(`🔌 WebSocket: ws://localhost:${port}`);
    logger.info('\nPress Ctrl+C to stop\n');

    // Discord inbound command bot
    // Requires: DISCORD_BOT_TOKEN, DISCORD_COMMAND_CHANNEL, BEACON_ADMIN_TOKEN
    if (process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_COMMAND_CHANNEL) {
      const bot = new DiscordBot(
        process.env.DISCORD_BOT_TOKEN,
        process.env.DISCORD_COMMAND_CHANNEL,
        `http://localhost:${port}`,
      );
      bot.start();
      logger.info('🤖 Discord command bot started');
    }

    // IRC Bridge — connects to agentirc and bridges AgentMessageBus to IRC channels
    if (IRC_BRIDGE_ENABLED) {
      const ircBridge = IRCBridgeService.getInstance(agentBus);
      ircBridge.setServices({
        taskManager,
        orchestratorService,
        organizationManager: organization,
      });
      ircBridge.start();
      logger.info('IRC bridge started', {
        host: process.env.IRC_HOST || 'agentirc',
        port: process.env.IRC_PORT || '6667',
        nick: process.env.IRC_NICK || 'itops-bridge',
      });
    }
  });
}

// Stub routes for /api/{task-queue,task-queuestats,security/*,performance,
// performance/history} that previously lived here have been removed —
// they were dead-code duplicates of routes already mounted earlier in
// the file (or, for /api/performance, hoisted into ./performanceApi.ts).
// Several of them referenced an undeclared `securityRateLimit` symbol,
// proving they were unreachable. (~547 LOC of dead code purged.)

// Agent Chat API — real AI-powered conversation

// ============= Agent Tool Execution (Phase 24) =============
const SAFE_COMMANDS = new Set([
  "df", "free", "uptime", "whoami", "hostname", "date", "uname",
  "cat /etc/os-release", "ip addr", "ip route", "ss -tlnp",
  "docker ps", "docker images", "docker stats --no-stream",
  "systemctl list-units --type=service --state=running",
  "ls", "wc", "head", "tail", "grep", "find", "du", "stat",
  "ping", "dig", "nslookup", "curl -I", "wget --spider", "ss", "ip", "lsof"
]);

const MODERATE_PREFIXES = [
  "systemctl status", "systemctl restart", "systemctl start", "systemctl stop", "systemctl list-units", "systemctl list-timers", "systemctl is-active",
  "docker logs", "docker inspect", "docker exec",
  "journalctl", "cat /var/log", "tail -f", "apt list", "dpkg -l",
  "ss", "netstat", "iptables -L", "iptables -S", "ufw status", "certbot certificates", "lsof -i",
  "nginx -t", "apache2ctl -t", "crontab -l", "ps aux", "ps -ef", "top -bn1", "vmstat", "iostat", "lscpu", "lsblk", "mount"
];

const BLOCKED_PATTERNS = [
  /\brm\s+(-rf?|--recursive)/, /\bdd\b/, /\bmkfs\b/, /\bshutdown\b/, /\breboot\b/,
  /\bformat\b/, /\bfdisk\b/, /\bparted\b/, /\bmkswap\b/,
  /\b(userdel|groupdel|passwd)\b/, /\bchmod\s+777/, /\bchown\s+root/,
  /\bcurl\b.*\|\s*(bash|sh)/, /\bwget\b.*\|\s*(bash|sh)/,
  /\b>\/dev\/(sd|hd|nvme)/, /\bkill\s+-9\s+1\b/,
  /\bapt\s+(remove|purge|autoremove)/, /\bdpkg\s+--purge/
];

function classifyCommand(cmd: string): { level: "safe" | "moderate" | "blocked"; reason?: string } {
  // Strip common safe suffixes before classification
  let trimmed = cmd.trim().replace(/\s*2>\/dev\/null\s*/g, " ").replace(/\s*\|\| true\s*$/, "").trim();
  // For "cmd1 || cmd2" patterns, classify both parts — use the safer classification
  if (trimmed.includes(" || ")) {
    const parts = trimmed.split(" || ");
    const results = parts.map(p => classifyCommand(p.trim()));
    const blocked = results.find(r => r.level === "blocked");
    if (blocked) return blocked;
    const moderate = results.find(r => r.level === "moderate");
    if (moderate) return moderate;
    return results[0];
  }
  // Strip trailing pipes to head/tail/grep (common safe patterns)
  trimmed = trimmed.replace(/\s*\|\s*(head|tail|grep|wc|sort|uniq|awk|cut)\s.*$/, "").trim();

  // Check blocked patterns first
  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(trimmed)) {
      return { level: "blocked", reason: "Dangerous command pattern detected" };
    }
  }

  // Check if exactly a safe command
  if (SAFE_COMMANDS.has(trimmed)) {
    return { level: "safe" };
  }

  // Check if starts with a safe command base
  const baseCmd = trimmed.split(/\s+/)[0];
  const safeBaseCmds = ["df", "free", "uptime", "whoami", "hostname", "date", "uname", "ls", "wc", "head", "tail", "du", "stat", "ping", "dig", "nslookup", "id", "env", "printenv"];
  if (safeBaseCmds.includes(baseCmd)) {
    return { level: "safe" };
  }

  // Check moderate prefixes
  for (const prefix of MODERATE_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return { level: "moderate" };
    }
  }

  // Check for common read-only patterns
  if (/^(cat|less|more)\s+\//.test(trimmed) && !/(shadow|passwd|private|key|secret)/i.test(trimmed)) {
    return { level: "moderate" };
  }
  if (/^(grep|find|awk|sed\s+-n)\s/.test(trimmed)) {
    return { level: "moderate" };
  }
  if (/^docker\s+(ps|images|inspect|logs|stats)/.test(trimmed)) {
    return { level: "safe" };
  }
  if (/^(systemctl|service)\s+status/.test(trimmed)) {
    return { level: "safe" };
  }

  // Default: blocked for unknown commands
  return { level: "blocked", reason: "Command not in allowlist. Use safe read-only commands." };
}

async function executeCommand(cmd: string, timeoutMs = 15000): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  try {
    const { stdout, stderr } = await execFileAsync("/bin/bash", ["-c", cmd], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 512,
      env: { ...process.env, PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }
    });
    return { ok: true, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 1000), exitCode: 0 };
  } catch (err: any) {
    return {
      ok: false,
      stdout: (err.stdout || "").slice(0, 4000),
      stderr: (err.stderr || err.message || "").slice(0, 1000),
      exitCode: err.code || 1
    };
  }
}

const agentToolDefinitions = [
  { type: "function", function: { name: "create_incident", description: "Create an incident ticket when you detect a significant issue that needs tracking and resolution. Use for service outages, security issues, or persistent problems.", parameters: { type: "object", properties: { title: { type: "string", description: "Short incident title" }, description: { type: "string", description: "Detailed description of the issue" }, severity: { type: "string", enum: ["critical", "high", "medium", "low"], description: "Severity level" } }, required: ["title", "description", "severity"] } } },
  { type: "function", function: { name: "search_kb", description: "Search the IT Ops knowledge base for runbooks, documentation, and past incident resolutions. Use this when you need to look up procedures or known solutions.", parameters: { type: "object", properties: { query: { type: "string", description: "Search query (keywords related to the issue or topic)" } }, required: ["query"] } } },
  { type: "function", function: { name: "send_notification", description: "Send an alert/notification to the IT Ops dashboard. Use this when you detect something important that needs attention (critical issues, security alerts, threshold breaches).", parameters: { type: "object", properties: { type: { type: "string", enum: ["info", "warning", "error", "success"], description: "Severity level" }, title: { type: "string", description: "Short alert title" }, message: { type: "string", description: "Alert details" } }, required: ["type", "title", "message"] } } },
  { type: "function", function: { name: "save_memory", description: "Save important information to your long-term memory for future reference. Use this when you learn something important about the system, user preferences, or recurring issues.", parameters: { type: "object", properties: { key: { type: "string", description: "Short descriptive key (e.g. 'disk_threshold', 'user_preference_timezone')" }, value: { type: "string", description: "The information to remember" }, category: { type: "string", description: "Category: system, user, issue, config, or general" } }, required: ["key", "value"] } } },
  { type: "function", function: { name: "recall_memory", description: "Search your long-term memory for relevant information. Use this when you need to recall past interactions, known issues, or system details.", parameters: { type: "object", properties: { query: { type: "string", description: "Search query to find relevant memories" } }, required: ["query"] } } },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a shell command on the server. Safe read-only commands run automatically. Dangerous commands are blocked.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute (e.g. df -h, docker ps, systemctl status nginx)" },
          reason: { type: "string", description: "Why this command is needed" }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "consult_agent",
      description: "Ask another specialist agent for information. Use when you need expertise outside your domain.",
      parameters: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Name of agent to consult (Ops Alpha, Ops Bravo, Ops Charlie, Ops Diana, Dev Builder, Dev Reviewer)" },
          question: { type: "string", description: "What you need to know from them" }
        },
        required: ["agent_name", "question"]
      }
    }
  }
];




// ============= Agent Long-Term Memory (Phase 28) =============

const MEMORY_DIR = "/data/itops-agents/agent-memory";
if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });

interface MemoryEntry {
  key: string;
  value: string;
  category: string;
  createdAt: string;
  updatedAt: string;
  accessCount: number;
}

interface AgentMemory {
  agentId: string;
  entries: MemoryEntry[];
}

const agentMemoryCache: Record<string, AgentMemory> = {};

function getMemoryPath(agentId: string): string {
  const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${MEMORY_DIR}/${safe}.json`;
}

function loadAgentMemory(agentId: string): AgentMemory {
  if (agentMemoryCache[agentId]) return agentMemoryCache[agentId];
  const path = getMemoryPath(agentId);
  if (fs.existsSync(path)) {
    try {
      const data = JSON.parse(fs.readFileSync(path, "utf-8"));
      agentMemoryCache[agentId] = data;
      return data;
    } catch { /* corrupt file, start fresh */ }
  }
  const fresh: AgentMemory = { agentId, entries: [] };
  agentMemoryCache[agentId] = fresh;
  return fresh;
}

function saveAgentMemory(agentId: string): void {
  const mem = agentMemoryCache[agentId];
  if (!mem) return;
  const path = getMemoryPath(agentId);
  fs.writeFileSync(path, JSON.stringify(mem, null, 2));
}

function memoryStore(agentId: string, key: string, value: string, category = "general"): MemoryEntry {
  const mem = loadAgentMemory(agentId);
  const existing = mem.entries.find(e => e.key === key);
  if (existing) {
    existing.value = value;
    existing.category = category;
    existing.updatedAt = new Date().toISOString();
    existing.accessCount++;
  } else {
    mem.entries.push({ key, value, category, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), accessCount: 0 });
    // Cap at 200 entries per agent
    if (mem.entries.length > 200) mem.entries = mem.entries.slice(-200);
  }
  saveAgentMemory(agentId);
  return existing || mem.entries[mem.entries.length - 1];
}

function memoryRecall(agentId: string, query: string, limit = 10): MemoryEntry[] {
  const mem = loadAgentMemory(agentId);
  const q = query.toLowerCase();
  // Score each entry by relevance
  const scored = mem.entries.map(e => {
    let score = 0;
    if (e.key.toLowerCase().includes(q)) score += 3;
    if (e.value.toLowerCase().includes(q)) score += 2;
    if (e.category.toLowerCase().includes(q)) score += 1;
    // Boost recently updated
    const age = Date.now() - new Date(e.updatedAt).getTime();
    if (age < 3600000) score += 2;
    else if (age < 86400000) score += 1;
    return { entry: e, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.entry);
}

function memoryForget(agentId: string, key: string): boolean {
  const mem = loadAgentMemory(agentId);
  const idx = mem.entries.findIndex(e => e.key === key);
  if (idx === -1) return false;
  mem.entries.splice(idx, 1);
  saveAgentMemory(agentId);
  return true;
}

function getMemoryContext(agentId: string, userMessage: string): string {
  const relevant = memoryRecall(agentId, userMessage, 5);
  if (relevant.length === 0) return "";
  const lines = relevant.map(e => `- ${e.key}: ${e.value}`).join("\n");
  return `\n\n[AGENT MEMORY - Relevant context]\n${lines}\n`;
}

// /api/agents/:id/{ltm,conversations,logs,activity} — extracted to
// ./agentsAddonsApi.ts. Layered AFTER ./agentsApi.ts on the same
// /api/agents prefix; Express falls through the first router for
// paths it doesn't match.
app.use('/api/agents', createAgentsAddonsRouter({
  loadAgentMemory,
  memoryStore,
  memoryForget,
  memoryRecall,
  chatHistoryStore,
  validateAuth: validateAuthFromHeader,
}));





// ============= System Health Monitor (Phase 32) =============
interface HealthSnapshot {
  timestamp: string;
  cpu: { loadAvg1: number; loadAvg5: number; loadAvg15: number; cores: number };
  memory: { totalMB: number; usedMB: number; freeMB: number; usedPct: number };
  disk: Array<{ mount: string; sizeMB: number; usedMB: number; usedPct: number }>;
  uptime: number;
  services: Array<{ name: string; active: boolean; }>;
}

const healthHistory: HealthSnapshot[] = [];
const MAX_HEALTH_HISTORY = 60; // capped sample buffer; window depends on interval
// Health-monitor cadence. Default 5 min — disk/memory/cpu signals don't change
// fast enough to justify a 30s loop, and the previous cadence was the main
// source of dedup churn. Tune via env for noisy or stable hosts.
const HEALTH_MONITOR_INTERVAL_MS = Number(process.env.HEALTH_MONITOR_INTERVAL_MS || 300_000);
let healthInterval: any = null;

// Extended host-level probes (CPU sustained / docker / systemd / iowait /
// TLS expiry / network). Wired into the same interval; each monitor is
// individually toggleable via MONITOR_* env vars. Now iterates every
// enabled server in the registry (local + remote) per tick.
// (serverRegistry + remoteExecutor are built earlier — before the route
// mounts that reference them — see the block above the /api/servers mount.)
const systemMonitors = new SystemMonitors({
  incidentManager,
  registry: serverRegistry,
  executor: remoteExecutor,
  notify: ({ type, title, message }) => pushNotification({ type, title, message, agentId: 'health-monitor', source: 'system' }),
  log: healthLog,
});

async function collectHealthSnapshot(): Promise<HealthSnapshot> {
  const os = await import("os");
  const loadAvg = os.loadavg();
  const totalMem = Math.round(os.totalmem() / 1024 / 1024);
  const freeMem = Math.round(os.freemem() / 1024 / 1024);

  // Get disk usage
  let diskInfo: HealthSnapshot["disk"] = [];
  try {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
      exec("df -m / /data /tmp 2>/dev/null", (err: any, stdout: string, stderr: string) => {
        resolve({ stdout: stdout || "", stderr: stderr || "" });
      });
    });
    const lines = stdout.trim().split("\n").slice(1);
    const seen = new Set<string>();
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 6) {
        const mount = parts[5];
        if (seen.has(mount)) continue;
        seen.add(mount);
        diskInfo.push({
          mount,
          sizeMB: parseInt(parts[1]) || 0,
          usedMB: parseInt(parts[2]) || 0,
          usedPct: parseInt(parts[4]) || 0
        });
      }
    }
  } catch {}

  // Check key services (try systemctl first, fallback to pgrep)
  let services: HealthSnapshot["services"] = [];
  const serviceChecks = [
    { name: "itops-agents", cmd: "pgrep -f 'server.ts' > /dev/null 2>&1 && echo active || echo inactive" },
    { name: "sshd", cmd: "systemctl is-active sshd 2>/dev/null || pgrep sshd > /dev/null 2>&1 && echo active || echo inactive" },
    { name: "docker", cmd: "systemctl is-active docker 2>/dev/null || pgrep dockerd > /dev/null 2>&1 && echo active || echo inactive" },
  ];
  for (const svc of serviceChecks) {
    try {
      const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
        exec(svc.cmd, (err: any, stdout: string, stderr: string) => {
          resolve({ stdout: (stdout || "").trim(), stderr: stderr || "" });
        });
      });
      services.push({ name: svc.name, active: stdout.includes("active") });
    } catch {
      services.push({ name: svc.name, active: false });
    }
  }

  return {
    timestamp: new Date().toISOString(),
    cpu: { loadAvg1: loadAvg[0], loadAvg5: loadAvg[1], loadAvg15: loadAvg[2], cores: os.cpus().length },
    memory: { totalMB: totalMem, usedMB: totalMem - freeMem, freeMB: freeMem, usedPct: Math.round(((totalMem - freeMem) / totalMem) * 100) },
    disk: diskInfo,
    uptime: os.uptime(),
    services
  };
}

/** Per-server snapshot collected over the executor — used by the
 *  remote-server inline threshold checks. Local still uses
 *  collectHealthSnapshot() so /api/health/current keeps its shape and
 *  the existing `os.*` fast path is preserved unchanged. */
async function collectRemoteSnapshot(server: MonitoredServer): Promise<HealthSnapshot | null> {
  try {
    // Single shell round-trip for loadavg + nproc + meminfo + df, with
    // distinct section markers so we can parse without N SSH handshakes.
    const cmd = [
      'echo "==LOAD=="', 'cat /proc/loadavg',
      'echo "==CORES=="', 'nproc',
      'echo "==MEM=="', 'cat /proc/meminfo',
      'echo "==DISK=="', 'df -m / /data /tmp 2>/dev/null || true',
      'echo "==UPTIME=="', 'cat /proc/uptime',
    ].join('; ');
    const r = await remoteExecutor.execute(server, cmd, { timeoutMs: 15_000 });
    if (r.exitCode !== 0) return null;
    const sections: Record<string, string> = {};
    let currentKey = '';
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^==([A-Z]+)==$/);
      if (m) { currentKey = m[1]; sections[currentKey] = ''; continue; }
      if (currentKey) sections[currentKey] = (sections[currentKey] || '') + line + '\n';
    }
    const loadParts = (sections.LOAD || '').trim().split(/\s+/);
    const cores = Math.max(1, parseInt((sections.CORES || '1').trim(), 10) || 1);
    const memInfo: Record<string, number> = {};
    for (const line of (sections.MEM || '').split('\n')) {
      const m = line.match(/^(\S+):\s+(\d+)\s*kB/);
      if (m) memInfo[m[1]] = parseInt(m[2], 10);
    }
    const totalMB = Math.round((memInfo['MemTotal'] || 0) / 1024);
    // MemAvailable is the kernel's own "what could be reclaimed without
    // swapping" — closer to user intent than (MemFree + Cached).
    const availMB = Math.round((memInfo['MemAvailable'] || memInfo['MemFree'] || 0) / 1024);
    const freeMB = availMB;
    const usedMB = Math.max(0, totalMB - freeMB);
    const memPct = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0;
    const diskInfo: HealthSnapshot['disk'] = [];
    const seenMounts = new Set<string>();
    for (const line of (sections.DISK || '').trim().split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const mount = parts[5];
      if (seenMounts.has(mount)) continue;
      seenMounts.add(mount);
      diskInfo.push({
        mount,
        sizeMB: parseInt(parts[1], 10) || 0,
        usedMB: parseInt(parts[2], 10) || 0,
        usedPct: parseInt(parts[4], 10) || 0,
      });
    }
    const uptime = parseFloat((sections.UPTIME || '0').trim().split(/\s+/)[0]) || 0;
    return {
      timestamp: new Date().toISOString(),
      cpu: {
        loadAvg1: parseFloat(loadParts[0]) || 0,
        loadAvg5: parseFloat(loadParts[1]) || 0,
        loadAvg15: parseFloat(loadParts[2]) || 0,
        cores,
      },
      memory: { totalMB, usedMB, freeMB, usedPct: memPct },
      disk: diskInfo,
      uptime,
      services: [],
    };
  } catch (e: any) {
    healthLog.debug('remote snapshot failed', { server: server.name, err: e?.message ?? String(e) });
    return null;
  }
}

/** Per-server threshold checks + auto-resolve sweep. Local server keeps
 *  the legacy un-suffixed sourceRefs (`memory`, `disk:/`, `cpu`) so any
 *  open incidents stay matched after this multi-server upgrade. Remote
 *  servers get `:<name>` suffixed refs and their auto-resolve filter
 *  scopes by server_id to avoid cross-host interference. */
async function runServerThresholdChecks(server: MonitoredServer, snap: HealthSnapshot): Promise<void> {
  const sevSuffix = server.isLocal ? '' : `:${server.name}`;
  const titlePrefix = server.isLocal ? '' : `[${server.name}] `;
  const memRef = server.isLocal ? 'memory'   : `memory${sevSuffix}`;
  const diskRef = (mount: string) => server.isLocal ? `disk:${mount}` : `disk:${mount}${sevSuffix}`;
  const cpuRef = server.isLocal ? 'cpu' : `cpu${sevSuffix}`;

  if (snap.memory.usedPct > 90) {
    pushNotification({ type: 'error', title: `${titlePrefix}Memory Critical`, message: `Memory usage at ${snap.memory.usedPct}% (${snap.memory.usedMB}MB / ${snap.memory.totalMB}MB)`, agentId: 'health-monitor', source: 'system' });
    try {
      incidentManager.create({
        title: `${titlePrefix}Memory Critical: ${snap.memory.usedPct}%`,
        description: `Memory at ${snap.memory.usedPct}% (${snap.memory.usedMB}MB / ${snap.memory.totalMB}MB). Auto-detected by health monitor.`,
        severity: 'critical', source: 'health-monitor', sourceRef: memRef,
        serverId: server.id, dedupBy: 'sourceRef',
        // No assignedTo: the dispatcher picks the right agent based on
        // server affinity + keywords. Hardcoded 'IT Director' here used
        // to permanently label every memory-critical alert "IT Director"
        // even though Ops Alpha / Ops Charlie were actually owning them
        // via assignedAgent.
      });
    } catch {}
  }
  for (const d of snap.disk) {
    if (d.usedPct > 90) {
      pushNotification({ type: 'error', title: `${titlePrefix}Disk Critical`, message: `${d.mount} at ${d.usedPct}% usage`, agentId: 'health-monitor', source: 'system' });
      try {
        incidentManager.create({
          title: `${titlePrefix}Disk Critical: ${d.mount} at ${d.usedPct}%`,
          description: `Disk partition ${d.mount} reached ${d.usedPct}% usage (${d.usedMB}MB / ${d.sizeMB}MB). Auto-detected by health monitor.`,
          severity: 'high', source: 'health-monitor', sourceRef: diskRef(d.mount),
          serverId: server.id, dedupBy: 'sourceRef',
          // No assignedTo: see the memory-critical block above.
        });
      } catch {}
    }
  }
  if (snap.cpu.loadAvg5 > snap.cpu.cores * 2) {
    pushNotification({ type: 'warning', title: `${titlePrefix}CPU Overload`, message: `Load avg (5m): ${snap.cpu.loadAvg5.toFixed(2)} on ${snap.cpu.cores} cores`, agentId: 'health-monitor', source: 'system' });
    try {
      incidentManager.create({
        title: `${titlePrefix}CPU Overload: load ${snap.cpu.loadAvg5.toFixed(1)} on ${snap.cpu.cores} cores`,
        description: `Sustained CPU load is ${Math.round(snap.cpu.loadAvg5 / snap.cpu.cores * 100)}% capacity. 1m: ${snap.cpu.loadAvg1.toFixed(2)}, 5m: ${snap.cpu.loadAvg5.toFixed(2)}, 15m: ${snap.cpu.loadAvg15.toFixed(2)}`,
        severity: 'medium', source: 'health-monitor', sourceRef: cpuRef,
        serverId: server.id, dedupBy: 'sourceRef',
      });
    } catch {}
  }

  // Auto-resolve when the condition clears. For LOCAL we match the
  // legacy refs (incl. alert-rule "seed-*" ids) so pre-upgrade rows
  // still close out. For REMOTE we scope strictly by server_id so a
  // healthy server.foo doesn't accidentally close server.bar incidents.
  const DISK_CLEAR_PCT = 80;
  const MEM_CLEAR_PCT = 80;
  const CPU_CLEAR_RATIO = 1.5;
  try {
    if (snap.memory.usedPct < MEM_CLEAR_PCT) {
      const ids = incidentManager.resolveActiveByRef(
        inc => {
          if (server.isLocal) {
            const ref = (inc.sourceRef || '').toLowerCase();
            return ref === 'memory' || ref.startsWith('seed-memory');
          }
          return inc.serverId === server.id && (inc.sourceRef || '').startsWith('memory');
        },
        `${titlePrefix}Memory usage now ${snap.memory.usedPct}% (below ${MEM_CLEAR_PCT}% clear threshold)`,
        'health-monitor',
        { verifyAfterResolve: true },
      );
      if (ids.length > 0) healthLog.info('auto-resolved memory incidents', { server: server.name, ids, usedPct: snap.memory.usedPct });
    }

    const maxDiskPct = snap.disk.length > 0 ? Math.max(...snap.disk.map(d => d.usedPct)) : 0;
    if (snap.disk.length === 0 || maxDiskPct < DISK_CLEAR_PCT) {
      const ids = incidentManager.resolveActiveByRef(
        inc => {
          if (server.isLocal) {
            const ref = (inc.sourceRef || '').toLowerCase();
            return ref.startsWith('disk:') || ref.startsWith('seed-disk');
          }
          return inc.serverId === server.id && (inc.sourceRef || '').startsWith('disk:');
        },
        `${titlePrefix}Disk usage now ${maxDiskPct}% (below ${DISK_CLEAR_PCT}% clear threshold)`,
        'health-monitor',
        { verifyAfterResolve: true },
      );
      if (ids.length > 0) healthLog.info('auto-resolved disk incidents', { server: server.name, ids, maxDiskPct });
    }

    if (snap.cpu.loadAvg5 < snap.cpu.cores * CPU_CLEAR_RATIO) {
      const ids = incidentManager.resolveActiveByRef(
        inc => {
          if (server.isLocal) {
            const ref = (inc.sourceRef || '').toLowerCase();
            return ref === 'cpu' || ref.startsWith('seed-cpu');
          }
          return inc.serverId === server.id && (inc.sourceRef || '').toLowerCase().startsWith('cpu');
        },
        `${titlePrefix}CPU load avg5 now ${snap.cpu.loadAvg5.toFixed(2)} on ${snap.cpu.cores} cores (below ${CPU_CLEAR_RATIO}× cores clear threshold)`,
        'health-monitor',
        { verifyAfterResolve: true },
      );
      if (ids.length > 0) healthLog.info('auto-resolved cpu incidents', { server: server.name, ids, loadAvg5: snap.cpu.loadAvg5 });
    }
  } catch (e: any) { healthLog.error('auto-resolve failed', { server: server.name, err: e.message }); }
}

function startHealthMonitor() {
  if (healthInterval) return;
  // Collect immediately
  collectHealthSnapshot().then(snap => {
    healthHistory.push(snap);
    if (healthHistory.length > MAX_HEALTH_HISTORY) healthHistory.shift();
  }).catch(() => {});
  // Kick the extended monitors immediately too — first tick primes the
  // iowait delta baseline and gives operators a status without a 5-min wait.
  systemMonitors.tick().catch(() => {});

  healthInterval = setInterval(async () => {
    try {
      // ── Local snapshot for /api/health/current + workflow trigger ─────
      const snap = await collectHealthSnapshot();
      healthHistory.push(snap);
      if (healthHistory.length > MAX_HEALTH_HISTORY) healthHistory.shift();

      // Workflow trigger uses local metrics — the workflow rules predate
      // multi-server and are written against local thresholds. Per-server
      // workflow eval can be wired later if needed.
      const healthCtx = { cpu: Math.round((snap.cpu.loadAvg1 / snap.cpu.cores) * 100), memory: snap.memory.usedPct, disk: snap.disk.length > 0 ? snap.disk[0].usedPct : 0, load1: snap.cpu.loadAvg1, load5: snap.cpu.loadAvg5, cores: snap.cpu.cores };
      evaluateWorkflows('health', healthCtx).catch(() => {});

      // ── Per-server inline threshold checks ───────────────────────────
      // Local runs against the snapshot we just collected (free reuse);
      // remote servers each get an SSH-based snapshot in parallel.
      // Promise.allSettled so one unreachable host doesn't block the rest.
      const servers = serverRegistry.enabledServers();
      await Promise.allSettled(servers.map(async s => {
        const serverSnap = s.isLocal ? snap : await collectRemoteSnapshot(s);
        if (serverSnap) {
          if (!s.isLocal) {
            // Stamp last_seen on a successful remote collect.
            serverRegistry.recordCheck(s.id, 'ok');
          }
          // Record time-series samples for the dashboard charts. One
          // sample per metric per server per tick; disk fans out per
          // mount via the `dimension` column so the chart can plot
          // separate lines per filesystem.
          try {
            const now = new Date().toISOString();
            const samples = [
              { timestamp: now, serverId: s.id, metricType: 'cpu' as const,
                value: Math.round((serverSnap.cpu.loadAvg1 / Math.max(serverSnap.cpu.cores, 1)) * 100),
                dimension: null },
              { timestamp: now, serverId: s.id, metricType: 'memory' as const,
                value: serverSnap.memory.usedPct, dimension: null },
              { timestamp: now, serverId: s.id, metricType: 'load1' as const,
                value: serverSnap.cpu.loadAvg1, dimension: null },
              { timestamp: now, serverId: s.id, metricType: 'load5' as const,
                value: serverSnap.cpu.loadAvg5, dimension: null },
              ...serverSnap.disk.map(d => ({
                timestamp: now, serverId: s.id, metricType: 'disk' as const,
                value: d.usedPct, dimension: d.mount,
              })),
            ];
            metricsHistory.record(samples);
            // RunbookMatcher — fire any metric_threshold-triggered
            // runbook whose (metric, operator, threshold) matches the
            // just-recorded sample. Cooldown lives in the engine so a
            // sticky alert doesn't spam runs every 60s. Errors are
            // swallowed; the matcher logs.
            if (runbookMatcher) {
              for (const sample of samples) {
                runbookMatcher.matchMetric(s.id, sample.metricType, sample.value)
                  .catch(e => healthLog.warn('runbook matcher metric failed', {
                    server: s.id, metric: sample.metricType, err: e instanceof Error ? e.message : String(e),
                  }));
              }
            }
            // PluginManager — one fan-out per tick (not per sample) so
            // PrometheusPlugin etc. see all the metrics for a server
            // together. Lets a plugin keep a coherent server snapshot
            // rather than reconstructing it from per-metric events.
            pluginManager?.notifyMetricCollected({ server: s, samples });
          } catch (e: any) {
            healthLog.error('metrics record failed', { server: s.name, err: e?.message });
          }
          await runServerThresholdChecks(s, serverSnap);
        } else if (!s.isLocal) {
          // Remote snapshot failed — record an "error" check so the UI
          // shows the host as unreachable, but don't open an incident
          // here (a server that's simply offline shouldn't flood the
          // inbox; the SSH-test endpoint is the operator-facing signal).
          serverRegistry.recordCheck(s.id, 'error');
        }
      }));

      // Extended monitors (CPU sustained / docker / systemd / iowait /
      // TLS / network) per-server. Wrapped: each monitor self-isolates failures.
      await systemMonitors.tick();

      // Trend + anomaly analysis. Reads the time-series table populated
      // above, runs least-squares regression per metric/server, and
      // opens predictive incidents for metrics on track to hit a
      // critical threshold within 48h, plus anomaly incidents for
      // current readings >2.5σ from the rolling 7d mean. Skips emitting
      // when SystemMonitors already has an active threshold incident
      // for the same metric+server, so operators don't see two alerts
      // for one underlying condition.
      try { await trendAnalyzer.analyze(); } catch (e: any) {
        healthLog.error('trend analysis failed', { err: e?.message });
      }

      // Escalation pipeline tick — pushes L3 incidents past the timeout
      // to L4 (severity bump + urgent OpenClaw + webhook) and sends a
      // "resolved" notice for any L3+ incident the health-monitor sweep
      // just closed. Restart-safe: state lives on the incident row, not
      // in-memory timers alone. Self-isolates errors so a chat-gateway
      // outage can't block the health loop.
      try { await escalationPipeline.tick(); } catch (e: any) {
        healthLog.error('escalation tick failed', { err: e.message });
      }
    } catch (e: any) { healthLog.error('check failed', { err: e.message }); }
  }, HEALTH_MONITOR_INTERVAL_MS);
  healthLog.info('started', { intervalMs: HEALTH_MONITOR_INTERVAL_MS });
}

startHealthMonitor();

// Auto-resolve incidents that nothing else has touched in a while. The
// health monitor closes its own alerts when the underlying metric
// clears (see resolveActiveByRef calls above), but audit-style rows
// (workflow run notes, operator-initiated actions) have no clearing
// signal of their own and otherwise pile up. INCIDENT_STALE_HOURS=0
// disables the sweep; the default 2h is generous enough that real
// alerts get a chance to be acted on first.
const INCIDENT_STALE_HOURS = parseInt(process.env.INCIDENT_STALE_HOURS || '2', 10);
const INCIDENT_STALE_SWEEP_MS = parseInt(process.env.INCIDENT_STALE_SWEEP_MS || '300000', 10);
if (INCIDENT_STALE_HOURS > 0 && INCIDENT_STALE_SWEEP_MS > 0) {
  const staleLog = createLogger({ component: 'incident-stale-sweep' });
  setInterval(() => {
    try {
      const ids = incidentManager.sweepStale(INCIDENT_STALE_HOURS);
      if (ids.length > 0) {
        staleLog.info('auto-resolved stale incidents', { ids, count: ids.length, maxAgeHours: INCIDENT_STALE_HOURS });
      }
    } catch (e: any) {
      staleLog.error('sweep failed', { err: e.message });
    }
  }, INCIDENT_STALE_SWEEP_MS);
  staleLog.info('started', { maxAgeHours: INCIDENT_STALE_HOURS, intervalMs: INCIDENT_STALE_SWEEP_MS });
}

// Health API
app.get("/api/health/current", async (req, res) => {
  try {
    const snap = await collectHealthSnapshot();
    res.json(snap);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/health/history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 60, MAX_HEALTH_HISTORY);
  res.json({ snapshots: healthHistory.slice(-limit), count: healthHistory.length });
});

// ============= Agent Audit Trail (Phase 31) =============
const AUDIT_DIR = "/data/itops-agents/audit";
if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });

interface AuditEntry {
  timestamp: string;
  action: string;
  actor: string;
  target?: string;
  details: string;
  ip?: string;
  success: boolean;
  category: "auth" | "chat" | "tool" | "admin" | "delegation" | "scheduled" | "kb";
}

const auditBuffer: AuditEntry[] = [];
let auditFlushTimer: any = null;

function audit(entry: Omit<AuditEntry, "timestamp">): void {
  const full: AuditEntry = { ...entry, timestamp: new Date().toISOString() };
  auditBuffer.push(full);

  // Flush to file every 10 entries or 30 seconds
  if (auditBuffer.length >= 10) flushAudit();
  if (!auditFlushTimer) {
    auditFlushTimer = setTimeout(flushAudit, 30000);
  }
}

function flushAudit(): void {
  if (auditBuffer.length === 0) return;
  if (auditFlushTimer) { clearTimeout(auditFlushTimer); auditFlushTimer = null; }

  const today = new Date().toISOString().slice(0, 10);
  const logFile = `${AUDIT_DIR}/${today}.jsonl`;
  const lines = auditBuffer.splice(0).map(e => JSON.stringify(e)).join("\n") + "\n";
  fs.appendFileSync(logFile, lines);
}

function getAuditLogs(opts: { date?: string; category?: string; actor?: string; limit?: number }): AuditEntry[] {
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const logFile = `${AUDIT_DIR}/${date}.jsonl`;
  if (!fs.existsSync(logFile)) return [];

  let entries: AuditEntry[] = fs.readFileSync(logFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean) as AuditEntry[];

  // Also include unflushed buffer entries for today
  if (date === new Date().toISOString().slice(0, 10)) {
    entries = entries.concat(auditBuffer);
  }

  if (opts.category) entries = entries.filter(e => e.category === opts.category);
  if (opts.actor) entries = entries.filter(e => e.actor.toLowerCase().includes(opts.actor!.toLowerCase()));

  return entries.slice(-(opts.limit || 100)).reverse();
}

// Audit API
app.get("/api/agent-audit", (req, res) => {
  const { date, category, actor, limit } = req.query;
  const logs = getAuditLogs({
    date: date as string,
    category: category as string,
    actor: actor as string,
    limit: parseInt(limit as string) || 100
  });
  res.json({ logs, count: logs.length, date: date || new Date().toISOString().slice(0, 10) });
});

app.get("/api/agent-audit/dates", (req, res) => {
  const files = fs.readdirSync(AUDIT_DIR).filter((f: string) => f.endsWith(".jsonl")).map((f: string) => f.replace(".jsonl", "")).sort().reverse();
  res.json({ dates: files });
});

// Flush on synchronous process exit (e.g. uncaught exception). The graceful
// path below covers SIGTERM / SIGINT.
process.on("exit", flushAudit);

// Graceful shutdown. The coordinator drains in-flight tasks (bounded by
// SHUTDOWN_DRAIN_TIMEOUT_MS, default 30s), then runs every registered
// hook in order before exiting. Hooks log their own outcomes; failures
// don't abort the rest.
import { shutdown } from '../lifecycle/GracefulShutdown.js';
import { shutdownTelemetry } from '../observability/Telemetry.js';

shutdown.registerInFlightCounter(() => {
  // Active tasks: anything not in a terminal state.
  try {
    const stats = taskManager.getStatistics();
    return (stats.in_progress || 0) + (stats.assigned || 0) + (stats.rolling_back || 0);
  } catch { return 0; }
});

shutdown.register({ name: 'audit-flush',         fn: () => flushAudit() });
shutdown.register({ name: 'websocket-clients',   fn: () => {
  try { for (const ws of clients) ws.close(1001, 'server shutting down'); } catch { /* */ }
}});
shutdown.register({ name: 'wss-close',           fn: () => new Promise<void>(r => wss.close(() => r())) });
shutdown.register({ name: 'http-server-close',   fn: () => new Promise<void>(r => server.close(() => r())) });
shutdown.register({ name: 'system-stopping-event',     fn: () => eventBus.publish({
  aggregateType: AggregateTypes.SYSTEM, aggregateId: 'beacon-itops',
  type: EventTypes.SYSTEM_STOPPING, actor: 'system',
}).then(() => undefined).catch(() => undefined), timeoutMs: 2000 });
shutdown.register({ name: 'schedule-engine-stop',      fn: () => { scheduleEngine.stop(); }, timeoutMs: 2000 });
shutdown.register({ name: 'skill-plugin-watcher-stop', fn: () => skillPluginLoader.stop(),  timeoutMs: 2000 });
shutdown.register({ name: 'sandboxed-plugin-watcher-stop', fn: () => sandboxedSkillPluginLoader.stop(), timeoutMs: 5000 });
shutdown.register({ name: 'credential-rotation', fn: () => { rotationManager.stop(); }, timeoutMs: 1000 });
shutdown.register({ name: 'postgres-pool-drain', fn: () => closeSharedPool(),    timeoutMs: 5000 });
shutdown.register({ name: 'message-bus-close',   fn: () => resetMessageBus(),    timeoutMs: 5000 });
shutdown.register({ name: 'telemetry-flush',     fn: () => shutdownTelemetry(), timeoutMs: 8000 });

shutdown.installSignalHandlers();

// Process-level crash guards. Routes uncaughtException + unhandledRejection
// through the shutdown coordinator so DBs flush + telemetry exports before
// exit(1). pm2/Docker restarts the container.
installCrashGuards({ shutdown });

// ============= Knowledge Base & Document Search (Phase 30) =============
const KB_DIR = "/data/itops-agents/knowledge-base";
if (!fs.existsSync(KB_DIR)) fs.mkdirSync(KB_DIR, { recursive: true });

interface KBArticle {
  id: string;
  title: string;
  content: string;
  tags: string[];
  category: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  viewCount: number;
}

function loadKB(): KBArticle[] {
  const kbFile = `${KB_DIR}/articles.json`;
  if (fs.existsSync(kbFile)) {
    try { return JSON.parse(fs.readFileSync(kbFile, "utf-8")); } catch { return []; }
  }
  return [];
}

function saveKB(articles: KBArticle[]): void {
  fs.writeFileSync(`${KB_DIR}/articles.json`, JSON.stringify(articles, null, 2));
}

function searchKB(query: string, limit = 5): KBArticle[] {
  const articles = loadKB();
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(t => t.length > 2);

  const scored = articles.map(a => {
    let score = 0;
    const titleLow = a.title.toLowerCase();
    const contentLow = a.content.toLowerCase();
    const tagsLow = a.tags.map(t => t.toLowerCase());

    for (const term of terms) {
      if (titleLow.includes(term)) score += 5;
      if (contentLow.includes(term)) score += 2;
      if (tagsLow.some(t => t.includes(term))) score += 3;
      if (a.category.toLowerCase().includes(term)) score += 2;
    }
    // Exact title match bonus
    if (titleLow.includes(q)) score += 10;
    return { article: a, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(s => s.article);
}

// KB API endpoints
app.get("/api/kb", (req, res) => {
  const articles = loadKB();
  const q = (req.query.q as string || "").trim();
  if (q) {
    const results = searchKB(q, parseInt(req.query.limit as string) || 10);
    return res.json({ results, query: q, total: results.length });
  }
  const category = (req.query.category as string || "").trim();
  const filtered = category ? articles.filter(a => a.category.toLowerCase() === category.toLowerCase()) : articles;
  res.json({ articles: filtered.slice(0, 50), total: filtered.length, categories: [...new Set(articles.map(a => a.category))] });
});

app.get("/api/kb/:id", (req, res) => {
  const articles = loadKB();
  const article = articles.find(a => a.id === req.params.id);
  if (!article) return res.status(404).json({ error: "Article not found" });
  article.viewCount++;
  saveKB(articles);
  res.json({ article });
});

app.post("/api/kb", (req, res) => {
  const { title, content: body, tags, category } = req.body;
  if (!title || !body) return res.status(400).json({ error: "title and content required" });

  const auth = validateAuthFromHeader(req.header("authorization") || undefined);
  const articles = loadKB();
  const article: KBArticle = {
    id: "kb-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    title,
    content: body,
    tags: tags || [],
    category: category || "general",
    createdBy: auth.username || "anonymous",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    viewCount: 0
  };
  articles.push(article);
  saveKB(articles);
  audit({ action: "kb_create", actor: auth.username || "anonymous", target: article.id, details: article.title, success: true, category: "kb" });
  res.json({ success: true, article });
});

app.put("/api/kb/:id", (req, res) => {
  const articles = loadKB();
  const article = articles.find(a => a.id === req.params.id);
  if (!article) return res.status(404).json({ error: "Article not found" });

  const { title, content: body, tags, category } = req.body;
  if (title) article.title = title;
  if (body) article.content = body;
  if (tags) article.tags = tags;
  if (category) article.category = category;
  article.updatedAt = new Date().toISOString();
  saveKB(articles);
  res.json({ success: true, article });
});

app.delete("/api/kb/:id", (req, res) => {
  const articles = loadKB();
  const idx = articles.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Article not found" });
  articles.splice(idx, 1);
  saveKB(articles);
  res.json({ success: true });
});

// ============= Agent Notifications & Alerts (Phase 29) =============
interface AgentNotification {
  id: string;
  type: "info" | "warning" | "error" | "success";
  title: string;
  message: string;
  agentId: string;
  agentName?: string;
  timestamp: string;
  read: boolean;
  source: "scheduled" | "chat" | "system" | "manual";
  taskId?: string;
}

const notifications: AgentNotification[] = [];
const MAX_NOTIFICATIONS = 200;

function generateNotifId(): string {
  return "notif-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function pushNotification(opts: { type: AgentNotification["type"]; title: string; message: string; agentId: string; agentName?: string; source: AgentNotification["source"]; taskId?: string }): AgentNotification {
  // Trigger notification workflows
  if (typeof evaluateWorkflows === "function") evaluateWorkflows("notification", { type: opts.type, severity: opts.type, title: opts.title || "", source: opts.source || "", message: opts.message || "" }).catch(() => {});
  const notif: AgentNotification = {
    id: generateNotifId(),
    type: opts.type,
    title: opts.title,
    message: opts.message.slice(0, 500),
    agentId: opts.agentId,
    agentName: opts.agentName,
    timestamp: new Date().toISOString(),
    read: false,
    source: opts.source,
    taskId: opts.taskId
  };
  notifications.unshift(notif);
  if (notifications.length > MAX_NOTIFICATIONS) notifications.length = MAX_NOTIFICATIONS;

  // Also write to the persistent SQLite notifications DB
  try {
    const severity = opts.type === "error" ? "critical" : opts.type === "warning" ? "warning" : "info";
    notificationsDb.prepare(
      `INSERT INTO notifications (type, title, message, severity, read, created_at) VALUES (?, ?, ?, ?, 0, datetime('now'))`
    ).run(opts.source || "agent", `${opts.agentName || opts.agentId}: ${opts.title}`, opts.message.slice(0, 500), severity);
  } catch (e: any) { /* DB write failure is non-fatal */ }

  return notif;
}



// ============= Scheduled Agent Tasks (Phase 27) =============
interface ScheduledTask {
  id: string;
  name: string;
  agentId: string;
  message: string;
  cronExpr: string; // simplified: "every 5m", "every 1h", "every 24h", "daily 09:00", "hourly"
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  lastRun?: string;
  lastResult?: string;
  lastOk?: boolean;
  nextRun?: string;
  runCount: number;
}

const scheduledTasks: ScheduledTask[] = [];
let schedulerInterval: any = null;

function generateTaskId(): string {
  return "task-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function parseCronToMs(expr: string): number {
  const e = expr.trim().toLowerCase();
  // "every Nm" or "every Nh"
  const everyMatch = e.match(/^every\s+(\d+)\s*(m|min|minutes?|h|hr|hours?)$/);
  if (everyMatch) {
    const val = parseInt(everyMatch[1]);
    const unit = everyMatch[2].startsWith("h") ? 3600000 : 60000;
    return val * unit;
  }
  if (e === "hourly" || e === "every hour") return 3600000;
  if (e === "daily" || e === "every day" || e.startsWith("every 24h") || e.startsWith("every 1d")) return 86400000;
  if (e.startsWith("every 12h")) return 43200000;
  if (e.startsWith("every 6h")) return 21600000;
  if (e.startsWith("every 30m")) return 1800000;
  if (e.startsWith("every 15m")) return 900000;
  if (e.startsWith("every 10m")) return 600000;
  if (e.startsWith("every 5m")) return 300000;
  // "daily HH:MM" — compute ms until next occurrence
  const dailyMatch = e.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (dailyMatch) return 86400000; // will be handled by nextRunForDaily
  return 0; // invalid
}

function getNextRunTime(task: ScheduledTask): string {
  const e = task.cronExpr.trim().toLowerCase();
  const dailyMatch = e.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (dailyMatch) {
    const h = parseInt(dailyMatch[1]), m = parseInt(dailyMatch[2]);
    const now = new Date();
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target.toISOString();
  }
  const ms = parseCronToMs(task.cronExpr);
  if (ms <= 0) return "";
  const base = task.lastRun ? new Date(task.lastRun).getTime() : Date.now();
  return new Date(base + ms).toISOString();
}

async function parseSchedulerAiResponse(resp: Response): Promise<any> {
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) return resp.json();
  const raw = await resp.text();
  if (!raw.startsWith('data:')) return JSON.parse(raw);
  let content = '';
  let role = 'assistant';
  let toolCalls: any[] | undefined;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') break;
    try {
      const chunk = JSON.parse(payload);
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.role) role = delta.role;
      if (delta.content) content += delta.content;
      if (delta.tool_calls) {
        if (!toolCalls) toolCalls = [];
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? toolCalls.length;
          if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
    } catch { /* skip malformed chunks */ }
  }
  const msg: any = { role, content: content || null };
  if (toolCalls && toolCalls.length > 0) msg.tool_calls = toolCalls;
  return { choices: [{ message: msg, finish_reason: 'stop' }] };
}

async function executeScheduledTask(task: ScheduledTask): Promise<void> {
  const aiBaseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const aiModel = process.env.OPENAI_MODEL || "claude/claude-sonnet-4-6";
  const aiKey = process.env.OPENAI_API_KEY || "";

  const allAgents = organization.getAllAgents();
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const agent = allAgents.find((a: any) => a.id === task.agentId || a.name === task.agentId || normalize(a.name) === normalize(task.agentId));

  if (!agent) {
    task.lastRun = new Date().toISOString();
    task.lastResult = "Agent not found: " + task.agentId;
    task.lastOk = false;
    task.runCount++;
    task.nextRun = getNextRunTime(task);
    return;
  }

  const agentPrompt = (agent as any).systemPrompt || `You are ${(agent as any).name}. Be concise and helpful.`;
  const combined = `[INSTRUCTIONS]\n${agentPrompt}\n\n[SCHEDULED TASK]\nThis is an automated scheduled task running on a timer. Execute the requested action and report results concisely.\n\n[TASK]\n${task.message}`;

  try {
    const resp = await fetch(`${aiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${aiKey}` },
      body: JSON.stringify({ model: aiModel, stream: false, max_tokens: 1024, messages: [{ role: "user", content: combined }], tools: agentToolDefinitions, tool_choice: "auto" })
    });

    if (!resp.ok) {
      task.lastResult = `HTTP ${resp.status}`;
      task.lastOk = false;
    } else {
      const data = await parseSchedulerAiResponse(resp) as any;
      const choice = data.choices?.[0];
      const toolCalls = choice?.message?.tool_calls;

      if (toolCalls && toolCalls.length > 0) {
        // Execute tools (single round)
        const toolMsgs: any[] = [{ role: "user", content: combined }, choice.message];
        for (const tc of toolCalls) {
          let args: any; try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { args = {}; }
          if (tc.function?.name === "run_command") {
            const cmd = args.command || "";
            const cls = classifyCommand(cmd);
            if (cls.level === "blocked") {
              toolMsgs.push({ role: "tool", tool_call_id: tc.id, content: `BLOCKED: ${cls.reason}` });
              recordToolExecution(task.agentId, cmd, "blocked", false);
            } else {
              const r = await executeCommand(cmd, 15000);
              recordToolExecution(task.agentId, cmd, cls.level, r.ok);
              toolMsgs.push({ role: "tool", tool_call_id: tc.id, content: r.ok ? (r.stdout || "(empty)").slice(0, 3000) : `ERROR: ${r.stderr}`.slice(0, 1000) });
            }
          } else {
            toolMsgs.push({ role: "tool", tool_call_id: tc.id, content: "Tool not available in scheduled mode" });
          }
        }
        const finalResp = await fetch(`${aiBaseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${aiKey}` },
          body: JSON.stringify({ model: aiModel, stream: false, max_tokens: 1024, messages: toolMsgs, tool_choice: "none" })
        });
        if (finalResp.ok) {
          const fd = await parseSchedulerAiResponse(finalResp) as any;
          task.lastResult = fd.choices?.[0]?.message?.content || "No response";
          task.lastOk = true;
        } else {
          task.lastResult = "Final call failed: HTTP " + finalResp.status;
          task.lastOk = false;
        }
      } else {
        task.lastResult = choice?.message?.content || "No response";
        task.lastOk = true;
      }
    }
  } catch (err: any) {
    task.lastResult = "Error: " + err.message;
    task.lastOk = false;
  }

  task.lastRun = new Date().toISOString();
  task.runCount++;
  task.nextRun = getNextRunTime(task);
  schedLog.info('task completed', { name: task.name, ok: task.lastOk });
  audit({ action: "scheduled_task", actor: "scheduler", target: task.agentId, details: `${task.name}: ${task.lastOk ? "success" : "failed"}`, success: task.lastOk || false, category: "scheduled" });

  // Push notification for scheduled task results + auto-incident on repeated failures
  if (!task.lastOk) {
    pushNotification({ type: "error", title: `Task Failed: ${task.name}`, message: task.lastResult || "Unknown error", agentId: task.agentId, source: "scheduled", taskId: task.id });
    // Create incident on 3+ consecutive failures. Dedup is centralised in
    // IncidentManager — use task.id as sourceRef so it stays stable across
    // task renames.
    if (task.runCount > 2) {
      try {
        incidentManager.create({ title: `Scheduled Task Failing: ${task.name}`, description: `Task "${task.name}" has failed ${task.runCount} times. Last error: ${(task.lastResult || "").slice(0, 200)}`, severity: "medium", source: "scheduler", sourceRef: task.id, dedupBy: "sourceRef" });
      } catch {}
    }
  } else if (task.lastResult && (task.lastResult.toLowerCase().includes("alert") || task.lastResult.toLowerCase().includes("critical") || task.lastResult.toLowerCase().includes("warning"))) {
    pushNotification({ type: "warning", title: `Alert from: ${task.name}`, message: task.lastResult.slice(0, 300), agentId: task.agentId, source: "scheduled", taskId: task.id });
  }
}

function startScheduler() {
  if (schedulerInterval) return;
  schedulerInterval = setInterval(async () => {
    const now = new Date().toISOString();
    for (const task of scheduledTasks) {
      if (!task.enabled) continue;
      if (!task.nextRun) { task.nextRun = getNextRunTime(task); continue; }
      if (now >= task.nextRun) {
        try { await executeScheduledTask(task); } catch (e: any) { schedLog.error('task error', { taskId: task.id, err: e.message }); }
      }
    }
  }, 30000); // Check every 30 seconds
  schedLog.info('started', { intervalMs: 30000 });
}

// Start scheduler on boot
startScheduler();

// ── Seed default scheduled tasks if none exist ──────────────────────────
if (scheduledTasks.length === 0) {
  const defaultTasks: Array<Omit<ScheduledTask, 'runCount'> & { runCount: number }> = [
    {
      id: generateTaskId(),
      name: 'System Health Check',
      agentId: 'sysadmin-1',
      message: 'Run a quick system health check: check CPU usage, memory usage, disk space, and uptime. Report any values that look concerning. Use run_command with commands like "top -bn1 | head -5", "free -h", "df -h", and "uptime".',
      cronExpr: 'every 1h',
      enabled: true,
      createdBy: 'system',
      createdAt: new Date().toISOString(),
      runCount: 0,
    },
    {
      id: generateTaskId(),
      name: 'Docker Container Health',
      agentId: 'sysadmin-1',
      message: 'Check the health of all Docker containers. Use run_command with "docker ps --format \'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}\'" to list running containers, then check for any containers that are restarting or unhealthy with "docker ps -a --filter status=exited --filter status=restarting --format \'{{.Names}} {{.Status}}\'".',
      cronExpr: 'every 30m',
      enabled: true,
      createdBy: 'system',
      createdAt: new Date().toISOString(),
      runCount: 0,
    },
    {
      id: generateTaskId(),
      name: 'Container Log Analysis',
      agentId: 'sysadmin-2',
      message: 'Analyze recent container logs for errors and warnings. Use run_command with "docker ps -q | head -5 | xargs -I{} docker logs --tail 20 --since 30m {} 2>&1 | grep -iE \'error|fatal|panic|exception|warn\' | tail -30". Summarize any issues found and suggest remediation for critical errors.',
      cronExpr: 'every 2h',
      enabled: true,
      createdBy: 'system',
      createdAt: new Date().toISOString(),
      runCount: 0,
    },
    {
      id: generateTaskId(),
      name: 'Disk Cleanup Recommendation',
      agentId: 'sysadmin-2',
      message: 'Analyze disk usage and recommend cleanup actions. Use run_command to check: 1) "df -h" for overall usage, 2) "docker system df" for Docker disk usage, 3) "find /var/log -type f -size +50M -exec ls -lh {} \\;" for large log files, 4) "docker image ls --format \'{{.Repository}}:{{.Tag}} {{.Size}}\' | head -20" for large images. If any disk is above 80% usage, recommend specific cleanup commands.',
      cronExpr: 'every 6h',
      enabled: true,
      createdBy: 'system',
      createdAt: new Date().toISOString(),
      runCount: 0,
    },
    {
      id: generateTaskId(),
      name: 'SSL Certificate Expiry Check',
      agentId: 'sysadmin-1',
      message: 'Check SSL certificate expiry dates for key services. Use run_command with: 1) "echo | openssl s_client -connect localhost:19123 -servername localhost 2>/dev/null | openssl x509 -noout -dates 2>/dev/null || echo \'No SSL on 19123\'", 2) check any nginx/caddy configs: "ls /etc/nginx/sites-enabled/ 2>/dev/null; ls /etc/caddy/ 2>/dev/null", 3) "find /etc/ssl /etc/letsencrypt -name \'*.pem\' -o -name \'*.crt\' 2>/dev/null | head -10 | xargs -I{} sh -c \'echo {} && openssl x509 -in {} -noout -enddate 2>/dev/null\'". Flag any certs expiring within 30 days.',
      cronExpr: 'daily 06:00',
      enabled: true,
      createdBy: 'system',
      createdAt: new Date().toISOString(),
      runCount: 0,
    },
  ];
  for (const t of defaultTasks) {
    t.nextRun = getNextRunTime(t as ScheduledTask);
    scheduledTasks.push(t as ScheduledTask);
  }
  schedLog.info('seeded default scheduled tasks', { count: defaultTasks.length });
}

// /api/scheduled-tasks/* — extracted to ./scheduledTasksApi.ts. The
// scheduledTasks array stays here (the scheduler tick loop iterates
// it directly); the router mutates it by reference.
app.use('/api/scheduled-tasks', createScheduledTasksRouter({
  scheduledTasks,
  parseCronToMs,
  getNextRunTime,
  generateTaskId,
  executeScheduledTask,
  validateAuth: validateAuthFromHeader,
}));

// ============= Delegation Stats & Audit (Phase 26) =============
const chatStats = {
  delegations: [] as Array<{ from: string; to: string; question: string; timestamp: string; durationMs: number }>,
  toolExecutions: [] as Array<{ agent: string; command: string; level: string; ok: boolean; timestamp: string }>,
  roundtables: [] as Array<{ question: string; participants: string[]; timestamp: string; durationMs: number }>,
  messages: [] as Array<{ agent: string; user: string; timestamp: string; delegated: boolean }>
};

function recordDelegation(from: string, to: string, question: string, durationMs: number) {
  chatStats.delegations.push({ from, to, question: question.slice(0, 100), timestamp: new Date().toISOString(), durationMs });
  if (chatStats.delegations.length > 500) chatStats.delegations = chatStats.delegations.slice(-500);
}

function recordToolExecution(agent: string, command: string, level: string, ok: boolean) {
  chatStats.toolExecutions.push({ agent, command: command.slice(0, 100), level, ok, timestamp: new Date().toISOString() });
  if (chatStats.toolExecutions.length > 500) chatStats.toolExecutions = chatStats.toolExecutions.slice(-500);
  audit({ action: "tool_execution", actor: agent, details: `[${level}] ${command.slice(0, 80)}`, success: ok, category: "tool" });
}

function recordMessage(agent: string, user: string, delegated: boolean) {
  chatStats.messages.push({ agent, user, timestamp: new Date().toISOString(), delegated });
  if (chatStats.messages.length > 1000) chatStats.messages = chatStats.messages.slice(-1000);
}

function recordRoundtable(question: string, participants: string[], durationMs: number) {
  chatStats.roundtables.push({ question: question.slice(0, 100), participants, timestamp: new Date().toISOString(), durationMs });
  if (chatStats.roundtables.length > 100) chatStats.roundtables = chatStats.roundtables.slice(-100);
}

// Stats API endpoints
app.get("/api/stats/overview", (req, res) => {
  const now = Date.now();
  const last24h = new Date(now - 86400000).toISOString();
  const last7d = new Date(now - 7 * 86400000).toISOString();

  const msgs24h = chatStats.messages.filter(m => m.timestamp > last24h);
  const delegations24h = chatStats.delegations.filter(d => d.timestamp > last24h);
  const tools24h = chatStats.toolExecutions.filter(t => t.timestamp > last24h);

  // Agent usage breakdown
  const agentUsage: Record<string, number> = {};
  for (const m of msgs24h) { agentUsage[m.agent] = (agentUsage[m.agent] || 0) + 1; }

  // Delegation flow
  const delegationFlow: Record<string, number> = {};
  for (const d of delegations24h) { const key = `${d.from} -> ${d.to}`; delegationFlow[key] = (delegationFlow[key] || 0) + 1; }

  // Tool stats
  const toolStats = { total: tools24h.length, safe: tools24h.filter(t => t.level === "safe").length, moderate: tools24h.filter(t => t.level === "moderate").length, blocked: tools24h.filter(t => t.level === "blocked").length, success: tools24h.filter(t => t.ok).length };

  // Average response time
  const avgDuration = delegations24h.length > 0 ? Math.round(delegations24h.reduce((s, d) => s + d.durationMs, 0) / delegations24h.length) : 0;

  res.json({
    period: "24h",
    totalMessages: msgs24h.length,
    totalDelegations: delegations24h.length,
    totalRoundtables: chatStats.roundtables.filter(r => r.timestamp > last24h).length,
    avgResponseMs: avgDuration,
    agentUsage,
    delegationFlow,
    toolStats,
    recentDelegations: delegations24h.slice(-10).reverse(),
    recentTools: tools24h.slice(-10).reverse()
  });
});

app.get("/api/stats/delegations", (req, res) => {
  res.json({ delegations: chatStats.delegations.slice(-50).reverse() });
});

app.get("/api/stats/tools", (req, res) => {
  res.json({ executions: chatStats.toolExecutions.slice(-50).reverse() });
});

app.get("/api/stats/roundtables", (req, res) => {
  res.json({ roundtables: chatStats.roundtables.slice(-20).reverse() });
});

// ============= AI-Powered Agent Chat with Delegation =============
// Extracted to ./agentChatApi.ts. Both /:id/message (sync, with
// delegation + tool-calling + audit) and /:id/message/stream (SSE,
// with multi-round tool loop) are in there. Layered on the same
// /api/agents prefix as the other agent routers.
app.use('/api/agents', createAgentChatRouter({
  organization, chatHistoryStore, agentBus, agentToolDefinitions,
  incidentManager, searchKB, pushNotification,
  memoryStore, memoryRecall, getMemoryContext,
  classifyCommand, executeCommand,
  recordDelegation, recordToolExecution, recordMessage, recordRoundtable,
  audit,
  log: { error: (m, c) => logger.error(m, c) },
  validateAuth: validateAuthFromHeader,
}));

// /api/roundtable[/sync] — extracted to ./agentChatApi.ts (same file
// as the message routers — they share most deps).
app.use('/api/roundtable', createRoundtableRouter({
  organization, chatHistoryStore, agentBus, agentToolDefinitions,
  incidentManager, searchKB, pushNotification,
  memoryStore, memoryRecall, getMemoryContext,
  classifyCommand, executeCommand,
  recordDelegation, recordToolExecution, recordMessage, recordRoundtable,
  audit,
  log: { error: (m, c) => logger.error(m, c) },
  validateAuth: validateAuthFromHeader,
}));

// Original /:id/message body deleted (moved to ./agentChatApi.ts).
// The closing `});` of the original `app.post(...)` is removed below.

// Agent conversations (per-user sessions)
// (Conversations GET/DELETE moved to ./agentsAddonsApi.ts.)

// AgentBus status
app.get('/api/agentbus/status', (req, res) => {
  res.json({
    status: 'active',
    uptime: process.uptime(),
    connectedAgents: 5,
    messagesExchanged: Math.floor(Math.random() * 100) + 50
  });
});


// (Two more dead-code stub blocks removed here — same task-queue,
// security/*, performance, performance/history, agentbus/status
// duplicates as above. ~676 LOC purged.)
// (Mock /:id/logs and /:id/activity moved to ./agentsAddonsApi.ts.)


// Mission Control APIs - see missionControlApi.ts

// Inject managers into global for Mission Control
(globalThis as any).taskManager = taskManager;
(globalThis as any).skillManager = skillManager;
(globalThis as any).organization = organization;
app.use('/api/chat', chatRouter);

// Chat history endpoints
app.get('/api/chat/history/:agentId', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined);
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  res.json({ messages: chatHistoryStore.getHistory(req.params.agentId) });
});

app.post('/api/chat/history/:agentId', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined);
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  const { role, text } = req.body as { role?: string; text?: string };
  if ((role !== 'user' && role !== 'assistant') || !text) {
    res.status(400).json({ error: 'role (user|assistant) and text are required' }); return;
  }
  const msg = chatHistoryStore.append(req.params.agentId, role, text);
  res.json({ message: msg });
});

app.delete('/api/chat/history/:agentId', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined);
  if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
  chatHistoryStore.clear(req.params.agentId);
  res.json({ ok: true });
});
app.use('/api/ralph-tui', ralphTuiRouter);
app.use('/api/alerts-mgr', alertsRouter);
app.use('/api/analytics', analyticsRouter);
app.get('/analytics', (_req, res) => res.sendFile('analytics.html', { root: 'public' }));
app.use('/api/leaderboard', leaderboardRouter);
// New integration plugin manager — must mount BEFORE the legacy router
// so /api/integrations/plugins/* is matched first. Legacy /pagerduty +
// /github routes on the same prefix stay untouched.
app.use('/api/integrations/plugins', createIntegrationPluginsRouter({
  manager: pluginManager!,
  auditLog,
  validateAuth: validateAuthFromHeader,
}));
app.use('/api/integrations', integrationsRouter);

// SLA policy + tracking + metrics surface.
app.use('/api/sla', createSlaRouter({
  engine: slaEngine!,
  auditLog,
  validateAuth: validateAuthFromHeader,
}));

// Reports — cron schedules, on-demand generation, history. Distinct
// from the legacy SMTP-only /api/email-reports surface; mount the
// router non-null because reportScheduler is initialised earlier in
// the boot sequence above.
app.use('/api/reports', createReportsRouter({
  scheduler: reportScheduler!,
  auditLog,
  validateAuth: validateAuthFromHeader,
}));

// Problems — recurring-incident detector surface. Mounted non-null
// because problemStore + recurringDetector were constructed earlier in
// the boot block.
app.use('/api/problems', createProblemsRouter({
  problems: problemStore!,
  detector: recurringDetector!,
  runbooks: runbookEngine,
  auditLog,
  validateAuth: validateAuthFromHeader,
}));

// CMDB / Asset Management — assets, relationships, impact analysis,
// reverse lookup by incident. The plugin onAssetCreated hook is wired
// in through the optional `onAssetCreated` callback so a plugin that
// throws can't crash the create path.
app.use('/api/assets', createAssetsRouter({
  assetStore,
  impactAnalyzer,
  incidentManager,
  auditLog,
  validateAuth: validateAuthFromHeader,
  onAssetCreated: (asset) => {
    try { pluginManager?.notifyAssetCreated(asset); } catch { /* swallow */ }
  },
}));

// Change Management. /by-incident surfaces the correlation engine's
// scored matches. onChangeCreated / onChangeCompleted plug into the
// existing PluginManager fan-out.
app.use('/api/changes', createChangesRouter({
  changeStore,
  changeCorrelation,
  incidentManager,
  auditLog,
  validateAuth: validateAuthFromHeader,
  onChangeCreated:   (c) => { try { pluginManager?.notifyChangeCreated(c); }   catch { /* swallow */ } },
  onChangeCompleted: (c) => { try { pluginManager?.notifyChangeCompleted(c); } catch { /* swallow */ } },
}));

// Knowledge Base. The chat service already reads from knowledgeStore;
// this is the operator-facing CRUD + search surface.
app.use('/api/knowledge', createKnowledgeRouter({
  knowledgeStore,
  incidentManager,
  auditLog,
  validateAuth: validateAuthFromHeader,
  onArticleCreated: (a) => { try { pluginManager?.notifyArticleCreated(a); } catch { /* swallow */ } },
}));

// Knowledge auto-draft on incident resolve. Operators visit the KB,
// see the queue of draft articles, polish, and publish. Skipped for
// trivial low-severity incidents so the draft list doesn't fill up
// with noise — only critical / high seed a draft.
incidentManager.onResolved((inc) => {
  if (inc.severity !== 'critical' && inc.severity !== 'high') return;
  try {
    const article = knowledgeStore.create({
      title: `[draft] Resolution: ${inc.title}`,
      content: [
        `> Auto-drafted from incident **${inc.id}** — *${inc.title}*`,
        '',
        `**Severity:** ${inc.severity}  ·  **Source:** ${inc.source}`,
        inc.serverId ? `**Server:** \`${inc.serverId}\`` : '',
        '',
        '## Summary',
        inc.description || '_(no description)_',
        '',
        '## Resolution',
        '_Auto-drafted on resolve. Edit + publish to share with the team._',
      ].filter(Boolean).join('\n'),
      tags: ['auto-draft', inc.severity, ...(inc.serverId ? [`server:${inc.serverId}`] : [])],
      linkedIncidents: [inc.id],
      createdBy: 'beacon-auto',
      status: 'draft',
    });
    logger.info('[KB] auto-drafted article on resolve', { incidentId: inc.id, articleId: article.id });
    try { pluginManager?.notifyArticleCreated(article); } catch { /* swallow */ }
  } catch (e) {
    logger.warn('[KB] auto-draft failed', { incidentId: inc.id, err: e instanceof Error ? e.message : String(e) });
  }
});
app.use('/api/self-healing', selfHealingRouter);
app.use('/api/marketplace', marketplaceRouter);
app.use('/api/planner', requireAuth("config.write"), createPlannerApi(aiFactory));
app.use('/api/multi-tenant', multiTenantRouter);
app.use("/api/bridge", letThemTalkRouter);
app.use("/api/audit-log", auditLogRouter);
app.use("/api/cicd", cicdRouter);
app.get("/audit", (_req, res) => res.sendFile("audit.html", { root: path.join(__dirname, "../../public") }));
app.get("/cicd", (_req, res) => res.sendFile("cicd.html", { root: path.join(__dirname, "../../public") }));
// Wire let-them-talk bridge events → WebSocket broadcast (Phase 14)
bridgeEvents.on("new_message",      (msg)   => broadcast({ type: "bridge_message",  data: msg }));
bridgeEvents.on("task_created",     (task)  => broadcast({ type: "bridge_task",     data: task }));
bridgeEvents.on("task_updated",     (task)  => broadcast({ type: "bridge_task",     data: task }));
bridgeEvents.on("agent_registered", (agent) => broadcast({ type: "bridge_agent",    data: agent }));

app.get("/bridge", (_req, res) => res.sendFile("bridge.html", { root: "public" }));
app.get('/marketplace', (_req, res) => res.sendFile('marketplace.html', { root: 'public' }));
app.get('/tenants', (_req, res) => res.sendFile('tenants.html', { root: 'public' }));
app.use('/api/ai', createAIAssistantRouter(aiFactory, () => taskManager.getAllTasks(), () => organization.getAllAgents()));
app.get('/ai-assistant', (_req, res) => res.sendFile('ai-assistant.html', { root: 'public' }));
app.get('/leaderboard', (_req, res) => res.sendFile('leaderboard.html', { root: 'public' }));
app.use('/api/mission-control', missionControlRouter);
app.use('/api/automation', automationRouter);
app.use('/api/task-assignment', createTaskAssignmentRouter());
// Ops Monitoring API (Phase 15)
const opsInsightsService = new OperationalInsightsService(taskManager, organization);
app.use("/api/ops", createOpsMonitoringRouter(opsInsightsService));
app.use('/api/workflows', (req, res, next) => {
  const permission: Permission = ['GET', 'HEAD'].includes(req.method)
    ? 'security.read'
    : 'security.write';
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, permission);
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  next();
}, createWorkflowsRouter());
// `/api/runbooks` engine router was hoisted above the library `:id`
// catch-all earlier (see route order note) — registering it again here
// would be a duplicate handler.

app.post('/api/runbooks/generate', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  const { description } = req.body as { description?: string };
  if (!description?.trim()) { res.status(400).json({ error: 'description is required' }); return; }
  try {
    const provider = await aiFactory.getDefaultProvider();
    const runbook = await runbookGenerator.generate(description.trim(), provider);
    res.json({ runbook });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Runbook generation failed' });
  }
});


app.use('/mcp', express.json(), createMcpRouter({
  incidentManager,
  organization,
  skillManager,
  runbookEngine,
}));

// MCP tool catalogue (for UI / discovery)
app.get('/api/mcp/tools', (_req, res) => {
  res.json({ tools: MCP_TOOLS_CATALOGUE, endpoint: '/mcp' });
});

// MCP-client management: ITOps connecting outward to other MCP servers.
// The /mcp endpoint above is ITOps as a *server*; this router is the
// client-side counterpart used by the dashboard to add, test, and call
// remote MCP servers (OpenClaw and friends). Same auth gating as other
// settings-level endpoints.
import { createMcpClientRouter } from './mcpClientApi.js';
app.use('/api/mcp-clients', (req, res, next) => {
  const permission: Permission = ['GET', 'HEAD'].includes(req.method)
    ? 'security.read'
    : 'security.write';
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, permission);
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  next();
}, createMcpClientRouter(mcpClientManager));
app.use('/api/factory/tasks', (req, res, next) => {
  const permission: Permission = ['GET', 'HEAD'].includes(req.method)
    ? 'security.read'
    : 'security.write';
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, permission);
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  next();
}, createFactoryRouter());

// Credential catalog
app.use('/api/credential-catalog', (req, res, next) => {
  const permission: Permission = ['GET', 'HEAD'].includes(req.method)
    ? 'security.read'
    : 'security.write';
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, permission);
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  next();
}, credentialCatalogRouter);

// ---------------------------------------------------------------------------
// Operational data lifecycle: preview, archive, verify, then prune.
// ---------------------------------------------------------------------------
const lifecycleCutoff = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
const notificationRetentionDays = Math.max(0, Number(process.env.NOTIFICATION_RETENTION_DAYS || 90));
const dataRoot = process.env.DATA_DIR || '/data/itops-agents';
const lifecycleManager = new DataLifecycleManager({
  archiveRoot: process.env.LIFECYCLE_ARCHIVE_DIR || path.join(STATE_BACKUP_DIR, 'lifecycle'),
  statePath: process.env.LIFECYCLE_STATE_PATH || path.join(dataRoot, 'lifecycle-last-run.json'),
  sources: [
    { name: 'tasks', sourcePath: process.env.TASK_DB_PATH || path.join(dataRoot, 'tasks.db'), kind: 'sqlite', required: true },
    { name: 'incidents', sourcePath: process.env.INCIDENT_DB_PATH || path.join(dataRoot, 'incidents.db'), kind: 'sqlite', required: true },
    { name: 'agent-memory', sourcePath: process.env.AGENT_MEMORY_DB_PATH || path.join(dataRoot, 'agent-memory.db'), kind: 'sqlite', required: true },
    { name: 'events', sourcePath: process.env.EVENT_DB_PATH || path.join(dataRoot, 'events.db'), kind: 'sqlite', required: true },
    { name: 'ai-decisions', sourcePath: process.env.AI_DECISION_DB_PATH || path.join(dataRoot, 'ai-decisions.db'), kind: 'sqlite', required: true },
    { name: 'notifications', sourcePath: process.env.NOTIFICATIONS_DB_PATH || path.join(dataRoot, 'notifications.db'), kind: 'sqlite', required: true },
    { name: 'builder', sourcePath: process.env.BUILDER_DB_PATH || path.join(dataRoot, 'builder.db'), kind: 'sqlite', required: true },
    { name: 'workflow-runs', sourcePath: process.env.WORKFLOW_RUNS_PATH || path.join(dataRoot, 'workflow-runs.json'), kind: 'json', required: false },
  ],
  resources: [
    {
      name: 'incidents', retentionDays: RETENTION_MAX_AGE_DAYS,
      preview: () => incidentManager.incidentStore.purge({ maxAgeDays: RETENTION_MAX_AGE_DAYS, keepLatest: RETENTION_KEEP_LATEST, statusFilter: ['resolved', 'closed'], dryRun: true }),
      prune: () => incidentManager.incidentStore.purge({ maxAgeDays: RETENTION_MAX_AGE_DAYS, keepLatest: RETENTION_KEEP_LATEST, statusFilter: ['resolved', 'closed'] }),
    },
    {
      name: 'agent-messages', retentionDays: RETENTION_MAX_AGE_DAYS,
      preview: () => agentMemoryStore.purgeMessages({ maxAgeDays: RETENTION_MAX_AGE_DAYS, dryRun: true }),
      prune: () => agentMemoryStore.purgeMessages({ maxAgeDays: RETENTION_MAX_AGE_DAYS }),
    },
    {
      name: 'agent-facts', retentionDays: RETENTION_MAX_AGE_DAYS * 2,
      preview: () => agentMemoryStore.purgeFacts({ maxAgeDays: RETENTION_MAX_AGE_DAYS * 2, dryRun: true }),
      prune: () => agentMemoryStore.purgeFacts({ maxAgeDays: RETENTION_MAX_AGE_DAYS * 2 }),
    },
    {
      name: 'events', retentionDays: EVENTS_RETENTION_DAYS,
      preview: () => EVENTS_RETENTION_DAYS > 0 ? storeFactory.events.purge(lifecycleCutoff(EVENTS_RETENTION_DAYS), true) : 0,
      prune: () => EVENTS_RETENTION_DAYS > 0 ? storeFactory.events.purge(lifecycleCutoff(EVENTS_RETENTION_DAYS)) : 0,
    },
    {
      name: 'ai-decisions', retentionDays: AI_DECISIONS_RETENTION_DAYS,
      preview: () => AI_DECISIONS_RETENTION_DAYS > 0 && aiDecisionStore ? aiDecisionStore.prune(lifecycleCutoff(AI_DECISIONS_RETENTION_DAYS), true) : 0,
      prune: () => AI_DECISIONS_RETENTION_DAYS > 0 && aiDecisionStore ? aiDecisionStore.prune(lifecycleCutoff(AI_DECISIONS_RETENTION_DAYS)) : 0,
    },
    {
      name: 'notifications', retentionDays: notificationRetentionDays,
      preview: () => notificationRetentionDays > 0 ? (notificationsDb.prepare('SELECT COUNT(*) AS n FROM notifications WHERE created_at < ?').get(lifecycleCutoff(notificationRetentionDays)) as { n: number }).n : 0,
      prune: () => notificationRetentionDays > 0 ? notificationsDb.prepare('DELETE FROM notifications WHERE created_at < ?').run(lifecycleCutoff(notificationRetentionDays)).changes : 0,
    },
  ],
});

let nextLifecycleRunAt = new Date(Date.now() + RETENTION_TICK_MS).toISOString();
async function runRetentionSweep(dryRun = false): Promise<unknown> {
  try {
    const report = await lifecycleManager.run({ dryRun });
    logger.info('[Retention] lifecycle run finished', { dryRun, candidates: report.totalCandidates, deleted: report.totalDeleted, checkpointId: report.checkpoint?.id });
    broadcast({ type: 'retention_sweep', data: report });
    return report;
  } catch (error) {
    logger.error('[Retention] lifecycle run failed', { err: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    nextLifecycleRunAt = new Date(Date.now() + RETENTION_TICK_MS).toISOString();
  }
}

setInterval(() => { void runRetentionSweep(false).catch(() => {}); }, RETENTION_TICK_MS);
logger.info('[Retention] archive-before-delete lifecycle wired', { eventsDays: EVENTS_RETENTION_DAYS, aiDays: AI_DECISIONS_RETENTION_DAYS, nextRunAt: nextLifecycleRunAt });

// GET /api/admin/retention/stats
app.get('/api/admin/retention/stats', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  res.json({ policy: lifecycleManager.policy(), inventory: lifecycleManager.inventory(), checkpoints: lifecycleManager.listCheckpoints(), lastRun: lifecycleManager.lastRun(), nextRunAt: nextLifecycleRunAt });
});

// POST /api/admin/retention/sweep
app.post('/api/admin/retention/sweep', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  try {
    const dryRun = req.body?.dryRun !== false;
    res.json({ success: true, report: await runRetentionSweep(dryRun) });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/admin/retention/checkpoints/:id/verify', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  try { res.json(lifecycleManager.verifyCheckpoint(req.params.id)); }
  catch (error) { res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

// ─── A2A Agent Discovery Routes (Phase 1) ─────────────────────────────────────
// Public discovery endpoint — no auth required (per A2A spec)
app.get('/.well-known/agent.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(agentCardService.getSystemCard());
});

// List all agent cards
app.get('/a2a/agents', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  const agents = agentCardService.getAllAgentCards();
  res.json({
    protocol: 'a2a/1.0',
    count: agents.length,
    generatedAt: new Date().toISOString(),
    agents,
  });
});

// Single agent card
app.get('/a2a/agents/:id', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  const card = agentCardService.getAgentCard(req.params.id);
  if (!card) { res.status(404).json({ error: 'Agent not found' }); return; }
  res.json(card);
});

// ─── A2A Task Execution Routes (Phase 2) ──────────────────────────────────────

/**
 * POST /a2a/agents/:id
 * JSON-RPC 2.0 endpoint. Supported methods:
 *   tasks/send   — submit a task to this agent
 *   tasks/get    — retrieve a task by id
 *   tasks/cancel — cancel a running task
 */
app.post('/a2a/agents/:id', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }

  const agentId = req.params.id;
  const rpc = req.body as A2AJsonRpcRequest;

  if (rpc.jsonrpc !== '2.0' || !rpc.method) {
    res.status(400).json({
      jsonrpc: '2.0',
      id: rpc.id ?? null,
      error: { code: -32600, message: 'Invalid Request — must be JSON-RPC 2.0' },
    } satisfies A2AJsonRpcResponse);
    return;
  }

  const respond = (result?: unknown, error?: { code: number; message: string; data?: unknown }) => {
    const payload: A2AJsonRpcResponse = {
      jsonrpc: '2.0',
      id: rpc.id,
      ...(error ? { error } : { result }),
    };
    res.json(payload);
  };

  try {
    if (rpc.method === 'tasks/send') {
      const params = rpc.params as unknown as A2ATaskSendParams;
      if (!params?.message) {
        respond(undefined, { code: -32602, message: 'Invalid params — message is required' });
        return;
      }
      const task = await a2aTaskRunner.send(agentId, params);
      respond(task);

    } else if (rpc.method === 'tasks/get') {
      const taskId = (rpc.params as { id?: string }).id;
      if (!taskId) { respond(undefined, { code: -32602, message: 'Invalid params — id is required' }); return; }
      const task = a2aTaskStore.get(taskId);
      if (!task) { respond(undefined, { code: -32001, message: 'Task not found' }); return; }
      respond(task);

    } else if (rpc.method === 'tasks/cancel') {
      const taskId = (rpc.params as { id?: string }).id;
      if (!taskId) { respond(undefined, { code: -32602, message: 'Invalid params — id is required' }); return; }
      const ok = a2aTaskStore.cancel(taskId);
      if (!ok) { respond(undefined, { code: -32002, message: 'Task not found or already terminal' }); return; }
      respond({ canceled: true, id: taskId });

    } else {
      respond(undefined, { code: -32601, message: `Method not found: ${rpc.method}` });
    }
  } catch (e) {
    respond(undefined, { code: -32603, message: (e as Error).message });
  }
});

/** GET /a2a/tasks/:taskId — retrieve a task by ID (convenience REST alias) */
app.get('/a2a/tasks/:taskId', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  const task = a2aTaskStore.get(req.params.taskId);
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
  res.json(task);
});

/** GET /a2a/agents/:id/tasks — list tasks for a specific agent */
app.get('/a2a/agents/:id/tasks', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  const agentId = req.params.id;
  const card = agentCardService.getAgentCard(agentId);
  if (!card) { res.status(404).json({ error: 'Agent not found' }); return; }
  const tasks = a2aTaskStore.listByAgent(agentId);
  res.json({ agentId, count: tasks.length, tasks });
});

/** GET /a2a/tasks — list all A2A tasks (admin) */
app.get('/a2a/tasks', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  const tasks = a2aTaskStore.listAll();
  res.json({ count: tasks.length, tasks });
});

/**
 * GET /a2a/tasks/:taskId/events — SSE stream for task state updates
 * Sends updates every second until terminal state, then closes.
 */
app.get('/a2a/tasks/:taskId/events', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }

  const taskId = req.params.taskId;
  const task = a2aTaskStore.get(taskId);
  if (!task) { res.status(404).json({ error: 'Task not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const TERMINAL: string[] = ['completed', 'failed', 'canceled'];

  const send = () => {
    const current = a2aTaskStore.get(taskId);
    if (!current) { res.end(); return; }
    res.write(`data: ${JSON.stringify(current)}\n\n`);
    if (TERMINAL.includes(current.status.state)) {
      res.end();
    }
  };

  send();
  const interval = setInterval(send, 1000);
  req.on('close', () => clearInterval(interval));
});

// ─── A2A External Agent Routes (Phase 4) ──────────────────────────────────────

/**
 * POST /a2a/external
 * Register an external A2A agent by fetching their card from a URL.
 * Body: { "url": "https://other-system/.well-known/agent.json", "authConfig"?: { type, token, header } }
 */
app.post('/a2a/external', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  const body = req.body as { url?: string; authConfig?: { type: string; token?: string; header?: string } };
  const url = body.url?.trim();
  if (!url) { res.status(400).json({ error: 'url is required' }); return; }
  const authConfig = body.authConfig?.type ? (body.authConfig as import('../a2a/ExternalAgentRegistry.js').ExternalAgentAuthConfig) : undefined;
  try {
    const record = await externalAgentRegistry.register(url, authConfig);
    res.json({ success: true, agent: record });
  } catch (e) {
    res.status(422).json({ error: (e as Error).message });
  }
});

/** GET /a2a/external — list all registered external agents */
app.get('/a2a/external', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  const agents = externalAgentRegistry.list();
  // Mask auth tokens in response
  const masked = agents.map(a => ({
    ...a,
    authConfig: a.authConfig ? { ...a.authConfig, token: a.authConfig.token ? '••••••••' : undefined } : undefined,
  }));
  res.json({ count: masked.length, agents: masked });
});

/** POST /a2a/external/:id/refresh — re-fetch card for an external agent */
app.post('/a2a/external/:id/refresh', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  try {
    const record = await externalAgentRegistry.refresh(req.params.id);
    res.json({ success: true, agent: record });
  } catch (e) {
    res.status(422).json({ error: (e as Error).message });
  }
});

/** PATCH /a2a/external/:id/auth — set or update auth config for an external agent */
app.patch('/a2a/external/:id/auth', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  const body = req.body as { type?: string; token?: string; header?: string };
  if (!body.type) { res.status(400).json({ error: 'type is required (bearer|apikey|none)' }); return; }
  const ok = externalAgentRegistry.updateAuth(
    req.params.id,
    body as import('../a2a/ExternalAgentRegistry.js').ExternalAgentAuthConfig
  );
  if (!ok) { res.status(404).json({ error: 'External agent not found' }); return; }
  res.json({ success: true });
});

/** DELETE /a2a/external/:id — unregister an external agent */
app.delete('/a2a/external/:id', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.write');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  const ok = externalAgentRegistry.unregister(req.params.id);
  if (!ok) { res.status(404).json({ error: 'External agent not found' }); return; }
  res.json({ success: true });
});

/** GET /a2a/peers — show all peer routing candidates for a given message (debug) */
app.get('/a2a/peers', async (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'security.read');
  if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
  const message = String(req.query.message || '').trim();
  if (!message) { res.status(400).json({ error: 'message query param required' }); return; }
  const peers = await a2aPeerRouter.findAllPeersAsync(message, '');
  res.json({ message, peers, nlEnabled: !!(a2aPeerRouter as any).nlClassifier });
});

// ── Kubernetes API ─────────────────────────────────────────────────────────────

interface K8sClusterConfig {
  server: string;
  caData?: string;
  insecureSkipTlsVerify?: boolean;
}

interface K8sUserConfig {
  token?: string;
  certData?: string;
  keyData?: string;
}

interface K8sConfig {
  cluster: K8sClusterConfig;
  user: K8sUserConfig;
}

/** Very small kubeconfig YAML parser — handles the common single-cluster format */
function parseKubeconfig(yaml: string): K8sConfig | null {
  try {
    const lines = yaml.split('\n');

    // Grab current-context
    const ctxLine = lines.find(l => l.match(/^current-context:/));
    const currentContext = ctxLine ? ctxLine.replace(/^current-context:\s*["']?/, '').replace(/["']?\s*$/, '').trim() : null;

    // Helper: get indented block after a key line
    const getBlock = (startIdx: number, baseIndent: number): Record<string, string> => {
      const result: Record<string, string> = {};
      for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') continue;
        const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
        if (indent <= baseIndent && i > startIdx) break;
        const m = line.match(/^\s+([a-z-]+):\s*(.*)$/);
        if (m) result[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
      return result;
    };

    // Parse clusters
    let clusterConfig: K8sClusterConfig | null = null;
    for (let i = 0; i < lines.length; i++) {
      const nameLine = lines[i].match(/^\s+-\s+name:\s*(.+)$/);
      if (!nameLine) continue;
      const sectionHeader = lines.slice(Math.max(0, i - 10), i).find(l => l.match(/^clusters:/));
      if (!sectionHeader && !lines.slice(Math.max(0, i - 3), i).some(l => l.includes('cluster:'))) continue;

      // Look ahead for cluster.server
      const block = getBlock(i + 1, 2);
      if (block.server) {
        clusterConfig = {
          server: block.server,
          caData: block['certificate-authority-data'],
          insecureSkipTlsVerify: block['insecure-skip-tls-verify'] === 'true',
        };
        break;
      }
    }

    // Simpler approach: regex extract
    const serverMatch = yaml.match(/\bserver:\s*(\S+)/);
    const caMatch = yaml.match(/certificate-authority-data:\s*(\S+)/);
    const tokenMatch = yaml.match(/\btoken:\s*(\S+)/);
    const certMatch = yaml.match(/client-certificate-data:\s*(\S+)/);
    const keyMatch = yaml.match(/client-key-data:\s*(\S+)/);

    if (!serverMatch) return null;

    return {
      cluster: {
        server: serverMatch[1],
        caData: caMatch?.[1],
        insecureSkipTlsVerify: false,
      },
      user: {
        token: tokenMatch?.[1],
        certData: certMatch?.[1],
        keyData: keyMatch?.[1],
      },
    };
  } catch {
    return null;
  }
}

function loadK8sConfig(): K8sConfig | null {
  const kubeconfigPaths = [
    process.env.KUBECONFIG,
    '/data/itops-agents/kubeconfig',
    path.join(process.env.HOME ?? '/root', '.kube', 'config'),
  ].filter(Boolean) as string[];

  for (const p of kubeconfigPaths) {
    try {
      const content = fs.readFileSync(p, 'utf8');
      const cfg = parseKubeconfig(content);
      if (cfg) return cfg;
    } catch {
      // try next
    }
  }
  return null;
}

async function k8sRequest(cfg: K8sConfig, apiPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, cfg.cluster.server);
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'GET',
      rejectUnauthorized: !cfg.cluster.insecureSkipTlsVerify,
      headers: {} as Record<string, string>,
    };

    if (cfg.cluster.caData) {
      options.ca = Buffer.from(cfg.cluster.caData, 'base64');
    }
    if (cfg.user.token) {
      (options.headers as Record<string, string>)['Authorization'] = `Bearer ${cfg.user.token}`;
    }
    if (cfg.user.certData && cfg.user.keyData) {
      options.cert = Buffer.from(cfg.user.certData, 'base64');
      options.key = Buffer.from(cfg.user.keyData, 'base64');
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON from k8s API')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('k8s API timeout')); });
    req.end();
  });
}

function ageFromTimestamp(ts?: string): string {
  if (!ts) return '—';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// /api/k8s/* — extracted to ./k8sApi.ts.
app.use('/api/k8s', createK8sRouter({
  loadK8sConfig,
  k8sRequest,
  ageFromTimestamp,
}));

// ── IRC Bridge API ────────────────────────────────────────────────────────────
app.get('/api/irc/status', (_req, res) => {
  if (!IRC_BRIDGE_ENABLED) {
    res.json({ enabled: false, connected: false, channels: [], messageCount: 0 });
    return;
  }
  const bridge = IRCBridgeService.getInstance();
  res.json({ enabled: true, ...bridge.getStatus() });
});

app.get('/api/irc/messages', (req, res) => {
  if (!IRC_BRIDGE_ENABLED) {
    res.json({ messages: [] });
    return;
  }
  const channel = typeof req.query.channel === 'string' ? req.query.channel : '#ops';
  const rawLimit = parseInt(typeof req.query.limit === 'string' ? req.query.limit : '50', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
  const bridge = IRCBridgeService.getInstance();
  res.json({ channel, messages: bridge.getMessages(channel, limit) });
});

app.post('/api/irc/send', (req, res) => {
  const auth = validateAuthFromHeader(req.header('authorization') || undefined, 'agent_bus.write');
  if (!auth.ok) {
    res.status(403).json({ error: auth.reason || 'Forbidden' });
    return;
  }
  if (!IRC_BRIDGE_ENABLED) {
    res.status(503).json({ error: 'IRC bridge not enabled' });
    return;
  }
  const { channel, message } = req.body as { channel?: unknown; message?: unknown };
  if (typeof channel !== 'string' || !channel.startsWith('#')) {
    res.status(400).json({ error: 'channel must be a string starting with #' });
    return;
  }
  if (typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'message must be a non-empty string' });
    return;
  }
  if (message.length > 500) {
    res.status(400).json({ error: 'message must be 500 characters or fewer' });
    return;
  }
  try {
    const bridge = IRCBridgeService.getInstance();
    bridge.sendToChannel(channel, message.trim());
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ error: (err as Error).message || 'Failed to send message' });
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

const p = parseInt(process.env.PORT || '19123');
startServer(p).catch(e => logger.error('Server startup failed:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }));

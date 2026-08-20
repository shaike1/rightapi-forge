# RightAPI Forge - Quick Reference Card

## 🚀 Quick Start
```bash
docker-compose up -d
# Dashboard: http://localhost:19123/dashboard
# Factory: http://localhost:19124
# Admin: admin / (see ADMIN_PASSWORD in env)
```

## 📊 System Status Commands
```bash
# Check containers
docker ps | grep itops

# View logs
docker logs itops-agents --tail 100 -f

# Test API health
curl http://localhost:19123/api/health

# Check orchestrator status
curl http://localhost:19123/api/orchestrator/status
```

## 🔑 Required Credentials
```env
ADMIN_PASSWORD=<unique-generated-password>
AUTH_TOKEN_SECRET=<unique-generated-secret>
APPROVAL_TOKEN_SECRET=<unique-generated-secret>
CREDENTIAL_MASTER_KEY=<unique-generated-secret>
```

Run `npm run secrets:generate` to create strong installation values. Never commit the generated environment file.

## 📡 API Endpoints (Top 20)
```
GET  /api/health                          # Health check
POST /api/auth/login                      # Authenticate
GET  /api/agent-config                    # List agents
POST /api/agent-config                    # Create agent
GET  /api/tasks                           # List tasks
POST /api/tasks                           # Create task
GET  /api/tasks/:id                       # Get task detail
POST /api/tasks/:id/status                # Update task status
GET  /api/orchestrator/status             # Orchestration queue
GET  /api/credentials                     # List credentials
POST /api/credentials                     # Store credential
GET  /api/agent-bus/messages              # Chat messages
POST /api/agent-bus/send                  # Send message
GET  /api/system/backups                  # List backups
POST /api/system/backups/create           # Create backup
GET  /api/org-chart                       # Org structure
PUT  /api/org-chart                       # Update org
```

## 🎯 Common Tasks

### Create an Agent
```bash
TOKEN=$(curl -s -X POST http://localhost:19123/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"ADMIN_PASSWORD"}' \
  | jq -r '.session.token')

curl -X POST http://localhost:19123/api/agent-config \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "agentId": "alice",
    "model": "openai/gpt-4",
    "skills": ["infrastructure", "monitoring"],
    "temperature": 0.7
  }'
```

### Create a Task
```bash
curl -X POST http://localhost:19123/api/tasks \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "title": "Monitor disk usage",
    "description": "Check disk space on prod-01",
    "ownerId": "director-id",
    "category": "monitoring",
    "priority": "high"
  }'
```

### Store a Credential
```bash
curl -X POST http://localhost:19123/api/credentials \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "agentId": "alice",
    "name": "ssh-prod-01",
    "scope": "production-server",
    "secret": "ssh-private-key-content"
  }'
```

### Send Agent Message
```bash
curl -X POST http://localhost:19123/api/agent-bus/send \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "fromAgentId": "director",
    "toAgentId": "alice",
    "content": "Check Docker container status"
  }'
```

### Create Backup
```bash
curl -X POST http://localhost:19123/api/system/backups/create \
  -H "Authorization: Bearer $TOKEN"
```

### View Backups
```bash
curl http://localhost:19123/api/system/backups \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Restore from Backup
```bash
curl -X POST http://localhost:19123/api/system/backups/backup-id/restore \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"dryRun": false}'
```

## 🔐 Security Operations

### Rotate Master Key
```bash
curl -X POST http://localhost:19123/api/security/master-key/rotate \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"nextMasterKey": "new-long-random-secret-at-least-32-chars"}'
```

### Check Master Key Status
```bash
curl http://localhost:19123/api/security/master-key/status \
  -H "Authorization: Bearer $TOKEN"
```

### Generate API Key
```bash
curl -X POST http://localhost:19123/api/api-keys \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"provider": "openai", "key": "sk-..."}'
```

## 📋 Data Files Location

| File | Location | Purpose |
|------|----------|---------|
| Agents | `/data/itops-agents/agents.json` | Agent configurations |
| Tasks | `/data/itops-agents/tasks.json` | Task definitions |
| Credentials | `/data/itops-agents/credentials.vault.json` | Encrypted secrets |
| Auth | `/data/itops-agents/auth-users.json` | User accounts |
| Backups | `/data/itops-agents/backups/` | State snapshots |
| Logs | `/data/itops-agents/logs/` | Application logs |

## 🐛 Troubleshooting

### Container won't start
```bash
docker logs itops-agents
# Check environment variables, especially API keys
# Verify /data/itops-agents directory exists with proper permissions
```

### API endpoints returning 401
```bash
# Ensure Authorization header has valid JWT token
# Token expires after 1 hour, get new one via /api/auth/login
# Verify user role has required permissions
```

### Tasks stuck/not progressing
```bash
# Check /api/orchestrator/status for stuck entries
# Auto-recovery kicks in after 90 minutes (configurable)
# Manual intervention: PATCH /api/tasks/:id with new status
```

### Credential access denied
```bash
# Verify credential catalog has mapping: agentId + environment + system + scope
# Check /api/credentials/catalog to see current mappings
# Ensure mapping is marked "active": true
```

### Out of disk space
```bash
# Backups take space
# Prune old backups: DELETE /api/system/backups/scheduler
# Or manually delete /data/itops-agents/backups/old-backup-id
```

## ⚙️ Configuration Reference

### Orchestrator
```env
ORCHESTRATOR_AUTO_RECOVER=true              # Auto-recover stuck tasks
ORCHESTRATOR_STUCK_THRESHOLD_MINUTES=90     # How long before "stuck"
ORCHESTRATOR_STUCK_RETRY_LIMIT=2            # Max retries
ORCHESTRATOR_STUCK_RETRY_COOLDOWN_MINUTES=15 # Wait between retries
```

### Backup
```env
BACKUP_AUTOMATION_ENABLED=true
BACKUP_AUTOMATION_INTERVAL_MINUTES=60       # How often to backup
BACKUP_AUTOMATION_RUN_ON_STARTUP=true       # Backup on container start
RETENTION_KEEP_LATEST=30                    # Keep this many backups
RETENTION_MAX_AGE_DAYS=14                   # Delete if older than X days
```

### Security
```env
REQUIRE_STRONG_SECRETS=false                # Enforce password rules
CREDENTIAL_ANOMALY_WINDOW_MINUTES=60        # Time window for anomaly detection
CREDENTIAL_ANOMALY_MAX_USES=10              # Max uses in window
```

### AI
```env
DEFAULT_AI_PLATFORM=claude                  # claude, openai, ollama, etc
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OLLAMA_BASE_URL=http://ollama:11434
```

## 📊 Skill Commands (Sample)

```
# Infrastructure
docker.list                 # List containers
docker.stats <container>    # Container stats
k8s.pods --namespace=prod   # List K8s pods

# Bash
bash.exec --command="ls -la /tmp"
bash.script --path="/scripts/deploy.sh"

# Monitoring
monitor.cpu                 # CPU usage
monitor.memory              # Memory usage
monitor.disk                # Disk usage

# Security
security.scan               # Run security scan
security.users              # List system users
security.firewall           # Show firewall rules

# Files
files.read --path="/etc/hosts"
files.write --path="/tmp/test" --content="hello"

# Network
network.ping --target="google.com"
network.dns --query="example.com"
```

## 🔗 Links

- **Dashboard**: http://localhost:19123/dashboard
- **Factory Board**: http://localhost:19124
- **API Docs**: See README.md (complete endpoint reference)
- **Full Analysis**: See COMPLETE_ANALYSIS.md (889 lines)
- **Roadmap**: See IMPLEMENTATION_ROADMAP.md

## 📞 Emergency Procedures

### Restore from Backup (Disaster Recovery)
```bash
# 1. List available backups
curl http://localhost:19123/api/system/backups \
  -H "Authorization: Bearer $TOKEN"

# 2. Verify backup integrity
curl http://localhost:19123/api/system/backups/backup-id/verify \
  -H "Authorization: Bearer $TOKEN"

# 3. Perform dry-run restore
curl -X POST http://localhost:19123/api/system/backups/backup-id/restore \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"dryRun": true}'

# 4. Execute actual restore (if dry-run succeeds)
curl -X POST http://localhost:19123/api/system/backups/backup-id/restore \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"dryRun": false}'

# 5. Restart container to reload state
docker restart itops-agents
```

### Reset Stuck Task
```bash
curl -X PATCH http://localhost:19123/api/tasks/task-id/status \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"status": "pending"}'
```

### Restart Services
```bash
docker-compose restart itops-agents
docker-compose restart itops-factory-dashboard
```

## ✨ Pro Tips

1. **WebSocket Connection**: Use dashboard for real-time updates (no polling)
2. **Token Caching**: Token valid for 1 hour; cache and reuse
3. **Batch Operations**: Consider batch task creation for bulk imports
4. **Credential Scope**: Use environment (dev/staging/prod) in scope for safety
5. **Backup Strategy**: Create backup before major changes
6. **Monitoring**: Check /api/orchestrator/status regularly for health

---

**Last Updated**: March 7, 2026 | **Version**: 1.0.0

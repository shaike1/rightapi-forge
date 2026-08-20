#!/usr/bin/env bash
#
# Backup Scheduler Installation Script
# Installs automated backup scheduler using cron or systemd
#
# Usage:
#   ./scripts/backup-scheduler-install.sh          # Interactive mode
#   ./scripts/backup-scheduler-install.sh --cron    # Force cron mode
#   ./scripts/backup-scheduler-install.sh --systemd # Force systemd mode
#   ./scripts/backup-scheduler-install.sh --dry-run # Show commands only
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(dirname "$SCRIPT_DIR")}"
BACKUP_SCRIPT="${BACKUP_SCRIPT:-$SCRIPT_DIR/backup-state.sh}"
LOG_FILE="${LOG_FILE:-/var/log/itops-backup.log}"
STATE_DIR="${STATE_DIR:-/data/itops-agents}"
SCHEDULE="${SCHEDULE:-15 * * * *}"
BASE_URL="${BASE_URL:-http://127.0.0.1:19123}"
RETENTION_KEEP_LATEST="${RETENTION_KEEP_LATEST:-48}"
RETENTION_MAX_AGE_DAYS="${RETENTION_MAX_AGE_DAYS:-14}"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_header() {
    echo
    echo "=========================================="
    echo "  RightAPI Forge - Backup Scheduler Setup"
    echo "=========================================="
    echo
}

check_prerequisites() {
    log_info "Checking prerequisites..."

    if [[ ! -f "$BACKUP_SCRIPT" ]]; then
        log_error "Backup script not found: $BACKUP_SCRIPT"
        exit 1
    fi

    if [[ ! -x "$BACKUP_SCRIPT" ]]; then
        log_warning "Making backup script executable..."
        chmod +x "$BACKUP_SCRIPT"
    fi

    # Check if BASE_URL is accessible
    if command -v curl &> /dev/null; then
        if ! curl -s -f "$BASE_URL/api/health" > /dev/null 2>&1; then
            log_warning "Cannot reach $BASE_URL - ensure service is running"
        else
            log_success "Service is reachable at $BASE_URL"
        fi
    fi

    log_success "Prerequisites checked"
}

confirm_credentials() {
    echo
    log_info "Backup scheduler requires operator credentials for API authentication."
    echo
    read -rp "Enter operator username [operator]: " OPERATOR_USERNAME
    OPERATOR_USERNAME=${OPERATOR_USERNAME:-operator}

    read -rsp "Enter operator password: " OPERATOR_PASSWORD
    echo
    if [[ -z "$OPERATOR_PASSWORD" ]]; then
        log_error "Password cannot be empty"
        exit 1
    fi

    # Verify credentials by attempting a login
    log_info "Verifying credentials..."
    if command -v curl &> /dev/null; then
        if ! curl -s -f -X POST "$BASE_URL/api/auth/login" \
            -H "Content-Type: application/json" \
            -d "{\"username\":\"$OPERATOR_USERNAME\",\"password\":\"$OPERATOR_PASSWORD\"}" \
            > /dev/null 2>&1; then
            log_warning "Could not verify credentials - ensure they are correct"
        else
            log_success "Credentials verified"
        fi
    fi
}

confirm_schedule() {
    echo
    log_info "Default schedule: $SCHEDULE (runs at 15 minutes past each hour)"
    read -rp "Enter custom cron schedule [press Enter for default]: " CUSTOM_SCHEDULE
    if [[ -n "$CUSTOM_SCHEDULE" ]]; then
        SCHEDULE="$CUSTOM_SCHEDULE"
    fi

    echo
    log_info "Retention settings:"
    echo "  - Keep latest: $RETENTION_KEEP_LATEST backups"
    echo "  - Maximum age: $RETENTION_MAX_AGE_DAYS days"
    read -rp "Customize retention? [y/N]: " CUSTOM_RETENTION
    if [[ "$CUSTOM_RETENTION" =~ ^[Yy]$ ]]; then
        read -rp "Keep latest backups [$RETENTION_KEEP_LATEST]: " NEW_KEEP
        RETENTION_KEEP_LATEST=${NEW_KEEP:-$RETENTION_KEEP_LATEST}
        read -rp "Maximum age in days [$RETENTION_MAX_AGE_DAYS]: " NEW_AGE
        RETENTION_MAX_AGE_DAYS=${NEW_AGE:-$RETENTION_MAX_AGE_DAYS}
    fi
}

detect_scheduler() {
    if [[ -d /etc/systemd/system ]] && command -v systemctl &> /dev/null; then
        echo "systemd"
    elif command -v crontab &> /dev/null; then
        echo "cron"
    else
        echo "none"
    fi
}

install_cron() {
    local cron_entry="$SCHEDULE BASE_URL=$BASE_URL OPERATOR_USERNAME=$OPERATOR_USERNAME OPERATOR_PASSWORD='$OPERATOR_PASSWORD' RETENTION_KEEP_LATEST=$RETENTION_KEEP_LATEST RETENTION_MAX_AGE_DAYS=$RETENTION_MAX_AGE_DAYS $BACKUP_SCRIPT run >> $LOG_FILE 2>&1"

    echo
    log_info "Cron entry to be installed:"
    echo "  $cron_entry"
    echo

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "DRY RUN - Skipping installation"
        log_info "To install manually, run:"
        echo "  (crontab -l 2>/dev/null; echo \"$cron_entry\") | crontab -"
        return
    fi

    read -rp "Install cron job? [y/N]: " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        log_info "Skipped cron installation"
        return
    fi

    # Check if entry already exists
    if crontab -l 2>/dev/null | grep -q "$BACKUP_SCRIPT run"; then
        log_warning "Cron entry already exists"
        read -rp "Replace existing entry? [y/N]: " REPLACE
        if [[ ! "$REPLACE" =~ ^[Yy]$ ]]; then
            log_info "Keeping existing entry"
            return
        fi
        # Remove existing entry
        crontab -l 2>/dev/null | grep -v "$BACKUP_SCRIPT run" | crontab -
    fi

    # Install new entry
    (crontab -l 2>/dev/null; echo "$cron_entry") | crontab -
    log_success "Cron job installed"
    log_info "Logs will be written to: $LOG_FILE"
}

install_systemd() {
    local service_name="itops-backup"
    local timer_name="itops-backup.timer"
    local service_file="/etc/systemd/system/$service_name.service"
    local timer_file="/etc/systemd/system/$timer_name"

    # Parse cron schedule for systemd
    # Simple parsing for "15 * * * *" format
    local minute hour day month dow
    read -r minute hour day month dow <<< "$SCHEDULE"

    echo
    log_info "Systemd service files to be created:"
    echo "  $service_file"
    echo "  $timer_file"
    echo

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "DRY RUN - Skipping installation"
        return
    fi

    read -rp "Install systemd timer? [y/N]: " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        log_info "Skipped systemd installation"
        return
    fi

    # Create service file
    log_info "Creating service file..."
    sudo tee "$service_file" > /dev/null <<EOF
[Unit]
Description=RightAPI Forge State Backup
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
WorkingDirectory=$PROJECT_DIR
Environment="BASE_URL=$BASE_URL"
Environment="OPERATOR_USERNAME=$OPERATOR_USERNAME"
Environment="OPERATOR_PASSWORD=$OPERATOR_PASSWORD"
Environment="RETENTION_KEEP_LATEST=$RETENTION_KEEP_LATEST"
Environment="RETENTION_MAX_AGE_DAYS=$RETENTION_MAX_AGE_DAYS"
ExecStart=$BACKUP_SCRIPT run
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE

[Install]
WantedBy=multi-user.target
EOF

    # Create timer file
    log_info "Creating timer file..."
    sudo tee "$timer_file" > /dev/null <<EOF
[Unit]
Description=RightAPI Forge Backup Timer
Requires=$service_name.service

[Timer]
OnCalendar=*-*-* $hour:$minute:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

    # Reload systemd and enable timer
    log_info "Reloading systemd daemon..."
    sudo systemctl daemon-reload

    log_info "Enabling and starting timer..."
    sudo systemctl enable "$timer_name"
    sudo systemctl start "$timer_name"

    log_success "Systemd timer installed and started"
    log_info "Check status with: systemctl status $timer_name"
    log_info "Logs will be written to: $LOG_FILE"
}

show_status() {
    echo
    log_info "Backup scheduler status:"
    echo

    # Check cron
    if command -v crontab &> /dev/null; then
        if crontab -l 2>/dev/null | grep -q "$BACKUP_SCRIPT run"; then
            log_success "Cron: Installed"
            crontab -l 2>/dev/null | grep "$BACKUP_SCRIPT run" | sed 's/^/  /'
        else
            log_info "Cron: Not installed"
        fi
    fi

    # Check systemd
    if command -v systemctl &> /dev/null; then
        if systemctl list-units --all | grep -q "itops-backup.timer"; then
            log_success "Systemd: Installed"
            echo "  Timer: $(systemctl is-active itops-backup.timer 2>/dev/null || echo 'inactive')"
            echo "  Next run: $(systemctl list-timers itops-backup.timer --no-pager 2>/dev/null | tail -n 1 | awk '{print $1, $2, $3, $4}' || echo 'unknown')"
        else
            log_info "Systemd: Not installed"
        fi
    fi

    # Check recent backups
    if [[ -d "$STATE_DIR/backups" ]]; then
        local backup_count=$(ls -1 "$STATE_DIR/backups"/*.json 2>/dev/null | wc -l)
        local latest_backup=$(ls -t "$STATE_DIR/backups"/*.json 2>/dev/null | head -1)
        echo
        log_info "Backup status:"
        echo "  Total backups: $backup_count"
        if [[ -n "$latest_backup" ]]; then
            echo "  Latest: $(basename "$latest_backup")"
            echo "  Created: $(stat -c %y "$latest_backup" 2>/dev/null | cut -d'.' -f1)"
        fi
    fi

    # Check logs
    if [[ -f "$LOG_FILE" ]]; then
        echo
        log_info "Recent log entries:"
        tail -5 "$LOG_FILE" 2>/dev/null | sed 's/^/  /' || echo "  No logs yet"
    fi
}

show_uninstall() {
    echo
    log_info "To uninstall backup scheduler:"
    echo
    echo "Cron:"
    echo "  crontab -l | grep -v '$BACKUP_SCRIPT run' | crontab -"
    echo
    echo "Systemd:"
    echo "  sudo systemctl stop itops-backup.timer"
    echo "  sudo systemctl disable itops-backup.timer"
    echo "  sudo rm -f /etc/systemd/system/itops-backup.*"
    echo "  sudo systemctl daemon-reload"
    echo
}

# Parse arguments
MODE=""
DRY_RUN=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --cron)
            MODE="cron"
            shift
            ;;
        --systemd)
            MODE="systemd"
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--cron|--systemd] [--dry-run] [--help]"
            echo
            echo "Options:"
            echo "  --cron      Force cron mode"
            echo "  --systemd   Force systemd mode"
            echo "  --dry-run   Show commands without installing"
            echo "  --help      Show this help message"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

print_header

# Auto-detect mode if not specified
if [[ -z "$MODE" ]]; then
    MODE=$(detect_scheduler)
    log_info "Detected scheduler: $MODE"
fi

check_prerequisites

if [[ "$DRY_RUN" != "true" ]]; then
    confirm_credentials
    confirm_schedule
fi

case $MODE in
    cron)
        install_cron
        ;;
    systemd)
        install_systemd
        ;;
    none)
        log_error "No scheduler found (cron or systemd)"
        log_info "Install cron or systemd, or use --cron/--systemd to force mode"
        exit 1
        ;;
    *)
        log_error "Unknown mode: $MODE"
        exit 1
        ;;
esac

if [[ "$DRY_RUN" != "true" ]]; then
    show_status
    show_uninstall
fi

echo
log_success "Backup scheduler setup complete!"
echo

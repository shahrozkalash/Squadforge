# SquadForge Database Backup & Disaster Recovery Guide

SquadForge persists application state in a transactional SQLite database configured with Write-Ahead Logging (WAL) and foreign keys, or an external PostgreSQL instance when `DATABASE_URL` is set.

---

## SQLite Database Backup Strategy

### 1. Online Hot Backup (Zero Downtime)
SQLite WAL mode allows safe online backups while the application server is actively running.

\`\`\`bash
# Create timestamped backup using sqlite3 CLI online backup API
sqlite3 squadforge.db ".backup squadforge_backup_$(date +%Y%m%d_%H%M%S).db"
\`\`\`

Alternatively, using copy with WAL checkpointing:
\`\`\`bash
# 1. Force WAL checkpoint
sqlite3 squadforge.db "PRAGMA wal_checkpoint(TRUNCATE);"

# 2. Safely copy the database file
cp squadforge.db squadforge_backup.db
\`\`\`

### 2. Automated Daily Backup Script
Add a cron job to automate backups to secure offsite storage:
\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/var/backups/squadforge"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
DB_PATH="/app/data/squadforge.db"

mkdir -p "$BACKUP_DIR"
sqlite3 "$DB_PATH" ".backup $BACKUP_DIR/squadforge_$TIMESTAMP.db"

# Compress backup
gzip -9 "$BACKUP_DIR/squadforge_$TIMESTAMP.db"

# Retain backups for 30 days
find "$BACKUP_DIR" -name "squadforge_*.db.gz" -mtime +30 -delete
\`\`\`

---

## Disaster Recovery Procedure

### 1. Restoring from SQLite Backup
1. Stop the application server:
   \`\`\`bash
   systemctl stop squadforge || docker stop squadforge
   \`\`\`
2. Move the damaged database files (including WAL and SHM):
   \`\`\`bash
   mv squadforge.db squadforge.db.corrupt
   rm -f squadforge.db-wal squadforge.db-shm
   \`\`\`
3. Restore backup file:
   \`\`\`bash
   cp /var/backups/squadforge/squadforge_backup_20261019.db squadforge.db
   \`\`\`
4. Verify database integrity:
   \`\`\`bash
   sqlite3 squadforge.db "PRAGMA integrity_check;"
   # Expected output: ok
   \`\`\`
5. Restart application server:
   \`\`\`bash
   systemctl start squadforge || docker start squadforge
   \`\`\`

---

## Encryption Key Management & Key Rotation
Sensitive tokens (such as user GitHub OAuth tokens) are encrypted with AES-256-GCM using `ENCRYPTION_SECRET`.

### Important Rules:
1. **Never commit `ENCRYPTION_SECRET` to source control.**
2. If `ENCRYPTION_SECRET` is lost, previously stored encrypted tokens cannot be decrypted, and users will be prompted to reconnect their GitHub accounts.
3. Backup your `ENCRYPTION_SECRET` in a secure password manager or cloud secret manager (AWS Secrets Manager, Google Secret Manager, HashiCorp Vault).

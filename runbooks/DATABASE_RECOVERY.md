# Database Recovery Runbook

## Purpose
Recover Myra AI Gemini data from corruption, loss, or accidental deletion.

## Data Architecture Overview

### Storage Locations
```
Primary Data (MYRA_DATA_DIR):
  /var/lib/myra-data/
    ├── projects/          # Project knowledge JSON files
    ├── interviews/        # Interview session JSON files  
    ├── reports/           # Assessment report JSON files
    └── metadata/          # System metadata (future)

Electron Data (Windows):
  %APPDATA%/myra/
    ├── approved-project-roots.json
    ├── config.json (future)
    └── logs/ (future)

Backup Location:
  /backup/myra/
    ├── daily/
    ├── weekly/
    └── monthly/
```

### Data Formats
```json
// Project file example
{
  "version": 1,
  "projectId": "proj_abc123def456",
  "name": "my-project",
  "source": { "kind": "local", "root": "/path/to/project" },
  "purpose": "A web application for...",
  // ... other fields
  "createdAt": "2026-11-23T10:05:00.000Z"
}

// Interview file example  
{
  "version": 1,
  "id": "itv_def456ghi789",
  "projectId": "proj_abc123def456",
  "status": "ended",
  // ... other fields
  "createdAt": "2026-11-23T10:10:00.000Z",
  "updatedAt": "2026-11-23T10:25:00.000Z"
}
```

## Recovery Scenarios

### Scenario 1: Accidental Deletion

**Symptoms**:
- Files missing from data directory
- Application reports "not found" errors
- Users report missing projects/interviews

**Immediate Actions**:
```bash
# 1. Stop application to prevent further damage
sudo systemctl stop myra-server

# 2. Check recycle bin/trash
# Windows: Check Recycle Bin
# Linux: Check ~/.local/share/Trash
# macOS: Check ~/.Trash

# 3. Check recent backups
ls -la /backup/myra/daily/

# 4. Identify what was deleted
# Compare with backup
diff -r /var/lib/myra-data /backup/myra/daily/latest
```

**Recovery Steps**:
```bash
# If files in trash
cp -r ~/.local/share/Trash/files/* /var/lib/myra-data/

# If recent backup exists
tar -xzf /backup/myra/daily/myra_data_$(date +%Y%m%d).tar.gz -C /var/lib/myra-data/

# If partial deletion
for file in $(find /backup/myra/daily/latest -name "*.json"); do
  dest=${file/\/backup\/myra\/daily\/latest/\/var\/lib\/myra-data}
  if [ ! -f "$dest" ]; then
    cp "$file" "$dest"
    echo "Restored: $file"
  fi
done
```

**Verification**:
```bash
# Verify restored files
find /var/lib/myra-data -name "*.json" | wc -l
# Should match backup count

# Test file integrity
for file in /var/lib/myra-data/**/*.json; do
  if ! jq empty "$file" 2>/dev/null; then
    echo "Corrupted: $file"
  fi
done

# Start application
sudo systemctl start myra-server

# Verify functionality
curl http://localhost:3000/api/intelligence/projects | jq '.projects | length'
```

### Scenario 2: File Corruption

**Symptoms**:
- JSON parsing errors
- Application crashes on data access
- Invalid data in UI

**Diagnostic Steps**:
```bash
# 1. Identify corrupted files
find /var/lib/myra-data -name "*.json" -exec jq empty {} \; 2>&1 | \
  grep -B1 "parse error" | \
  grep -o "/var/lib/myra-data/[^']*"

# 2. Check file sizes (0 byte files indicate corruption)
find /var/lib/myra-data -name "*.json" -size 0

# 3. Check for incomplete writes
# Files modified during crash may be truncated
for file in /var/lib/myra-data/**/*.json; do
  if [ $(tail -c 1 "$file" | od -An -t x1) != "0a" ]; then
    echo "Missing newline: $file"
  fi
done
```

**Recovery Steps**:
```bash
# 1. Attempt repair of corrupted JSON
for file in $(find_corrupted_files); do
  echo "Attempting repair of: $file"
  
  # Try to extract valid JSON
  grep -o '{.*}' "$file" | tail -1 > "${file}.repaired"
  
  # Validate repaired file
  if jq empty "${file}.repaired" 2>/dev/null; then
    mv "${file}.repaired" "$file"
    echo "Repaired: $file"
  else
    echo "Could not repair: $file"
    rm "${file}.repaired"
  fi
done

# 2. Restore from backup if repair fails
for file in $(find_corrupted_files); do
  backup_file="${file/\/var\/lib\/myra-data/\/backup\/myra\/daily\/latest}"
  if [ -f "$backup_file" ]; then
    cp "$backup_file" "$file"
    echo "Restored from backup: $file"
  fi
done

# 3. Rebuild index if needed
curl -X POST http://localhost:3000/api/admin/rebuild-index
```

**Prevention**:
```bash
# Implement atomic writes
# Instead of: echo "$data" > file.json
# Use: echo "$data" > file.json.tmp && mv file.json.tmp file.json

# Add checksums
for file in /var/lib/myra-data/**/*.json; do
  echo "$(sha256sum "$file" | cut -d' ' -f1)" > "${file}.sha256"
done

# Regular integrity checks
find /var/lib/myra-data -name "*.json" -exec validate_json {} \;
```

### Scenario 3: Disk Failure

**Symptoms**:
- I/O errors when accessing files
- Filesystem corruption errors
- Complete data directory inaccessible

**Immediate Actions**:
```bash
# 1. Check filesystem health
sudo fsck /dev/sdb1

# 2. Check disk SMART status
sudo smartctl -a /dev/sdb

# 3. Attempt data recovery
sudo ddrescue /dev/sdb /mnt/recovery/myra-data.img /mnt/recovery/logfile.log

# 4. Mount recovered image
sudo mount -o loop,ro /mnt/recovery/myra-data.img /mnt/recovered
```

**Recovery Steps**:
```bash
# If disk recoverable
# 1. Copy data to new disk
rsync -av --progress /var/lib/myra-data/ /new-disk/myra-data/

# 2. Update fstab
# Change /etc/fstab to point to new disk

# 3. Remount
sudo umount /var/lib/myra-data
sudo mount /new-disk/myra-data /var/lib/myra-data

# If disk unrecoverable
# 1. Restore from latest backup
sudo mkdir -p /var/lib/myra-data
sudo tar -xzf /backup/myra/latest_full.tar.gz -C /var/lib/myra-data

# 2. Apply incremental backups
for backup in /backup/myra/incremental/*.tar.gz; do
  sudo tar -xzf "$backup" -C /var/lib/myra-data
done

# 3. Rebuild any missing data
# Some data may be in memory cache
# This will be lost but can be regenerated
```

**Post-Recovery**:
```bash
# Verify all data restored
find /var/lib/myra-data -name "*.json" | wc -l
# Compare with backup count

# Test data integrity
sudo -u myra node -e "
const fs = require('fs');
const path = require('path');

const dataDir = '/var/lib/myra-data';
let valid = 0, invalid = 0;

function checkDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      checkDir(fullPath);
    } else if (file.endsWith('.json')) {
      try {
        JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        valid++;
      } catch (e) {
        invalid++;
        console.error('Invalid JSON:', fullPath);
      }
    }
  }
}

checkDir(dataDir);
console.log(\`Valid: \${valid}, Invalid: \${invalid}\`);
"

# Update backup strategy if needed
# Consider more frequent backups
# Consider off-site backups
```

### Scenario 4: Software Bug Causing Data Loss

**Symptoms**:
- Data disappearing after update
- Incorrect data modifications
- Systematic deletion patterns

**Diagnostic Steps**:
```bash
# 1. Identify bug pattern
grep -r "delete\|remove\|unlink" /opt/myra-production/src --include="*.ts" --include="*.js"

# 2. Check application logs for suspicious activity
grep -E "(deleted|removed|unlinked)" /var/log/myra/server.log

# 3. Analyze file timestamps
find /var/lib/myra-data -name "*.json" -exec stat -c "%n %y" {} \; | \
  sort -k2 | tail -20

# 4. Check for rollback segments
# Look for .bak, .old, .previous files
find /var/lib/myra-data -name "*.bak" -o -name "*.old" -o -name "*~"
```

**Recovery Steps**:
```bash
# 1. Stop application immediately
sudo systemctl stop myra-server

# 2. Restore from pre-bug backup
# Find backup before bug introduction
backup_date=$(find /backup/myra -name "*.tar.gz" -exec basename {} \; | \
  grep -o '[0-9]\{8\}' | \
  sort -r | \
  awk '$1 < "20261123"' | head -1)  # Date before bug

tar -xzf "/backup/myra/myra_data_${backup_date}.tar.gz" -C /var/lib/myra-data

# 3. Patch the bug
# Apply fix to prevent recurrence
cd /opt/myra-production
git checkout fix/data-loss-bug
npm ci --only=production
npm run build

# 4. Start with data validation
export DATA_VALIDATION=strict
sudo systemctl start myra-server
```

**Bug Fix Template**:
```typescript
// Before (buggy)
function deleteProject(projectId: string) {
  const filePath = path.join(DATA_DIR, 'projects', `${projectId}.json`);
  fs.unlinkSync(filePath);  // No validation!
}

// After (fixed)
function deleteProject(projectId: string) {
  // Validate projectId format
  if (!/^proj_[a-f0-9]{8,32}$/.test(projectId)) {
    throw new Error('Invalid project ID');
  }
  
  const filePath = path.join(DATA_DIR, 'projects', `${projectId}.json`);
  
  // Check file exists
  if (!fs.existsSync(filePath)) {
    throw new Error('Project not found');
  }
  
  // Move to trash instead of immediate delete
  const trashPath = path.join(DATA_DIR, '.trash', `${projectId}.json.${Date.now()}`);
  fs.renameSync(filePath, trashPath);
  
  // Log the deletion
  logger.info('Project moved to trash', { projectId, trashPath });
  
  return { success: true, trashPath };
}
```

## Backup Procedures

### Daily Backups
```bash
#!/bin/bash
# /etc/cron.daily/myra-backup
BACKUP_DIR="/backup/myra/daily"
DATA_DIR="/var/lib/myra-data"
DATE=$(date +%Y%m%d)

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Full backup on Sundays, incremental other days
if [ $(date +%u) -eq 7 ]; then
  # Full backup
  tar -czf "$BACKUP_DIR/myra_data_full_$DATE.tar.gz" \
    --exclude="*.tmp" \
    --exclude="*.lock" \
    -C "$DATA_DIR" .
  
  # Keep last 4 weekly backups
  find "$BACKUP_DIR" -name "myra_data_full_*.tar.gz" -mtime +28 -delete
else
  # Incremental backup
  tar -czf "$BACKUP_DIR/myra_data_incr_$DATE.tar.gz" \
    --newer-mtime="1 day ago" \
    --exclude="*.tmp" \
    --exclude="*.lock" \
    -C "$DATA_DIR" .
  
  # Keep last 7 daily incremental backups
  find "$BACKUP_DIR" -name "myra_data_incr_*.tar.gz" -mtime +7 -delete
fi

# Verify backup
if tar -tzf "$BACKUP_DIR/myra_data_${type}_$DATE.tar.gz" >/dev/null 2>&1; then
  echo "Backup successful: $DATE"
  # Create checksum
  sha256sum "$BACKUP_DIR/myra_data_${type}_$DATE.tar.gz" > \
    "$BACKUP_DIR/myra_data_${type}_$DATE.sha256"
else
  echo "Backup failed: $DATE"
  exit 1
fi
```

### Backup Verification
```bash
#!/bin/bash
# /etc/cron.weekly/myra-backup-verify
BACKUP_DIR="/backup/myra"

echo "=== Backup Verification $(date) ==="

# Check backup integrity
for backup in "$BACKUP_DIR"/**/*.tar.gz; do
  echo "Verifying: $(basename "$backup")"
  
  # Check checksum
  if [ -f "${backup}.sha256" ]; then
    if sha256sum -c "${backup}.sha256" >/dev/null 2>&1; then
      echo "  ✓ Checksum valid"
    else
      echo "  ✗ Checksum invalid"
    fi
  fi
  
  # Check tar integrity
  if tar -tzf "$backup" >/dev/null 2>&1; then
    echo "  ✓ Archive valid"
    
    # Sample restore test
    TEMP_DIR=$(mktemp -d)
    tar -xzf "$backup" -C "$TEMP_DIR" 2>/dev/null
    
    # Check JSON validity
    invalid_count=0
    for json_file in "$TEMP_DIR"/**/*.json; do
      if [ -f "$json_file" ]; then
        if ! jq empty "$json_file" 2>/dev/null; then
          invalid_count=$((invalid_count + 1))
        fi
      fi
    done
    
    if [ $invalid_count -eq 0 ]; then
      echo "  ✓ All JSON files valid"
    else
      echo "  ✗ $invalid_count invalid JSON files"
    fi
    
    rm -rf "$TEMP_DIR"
  else
    echo "  ✗ Archive corrupted"
  fi
  
  echo ""
done
```

### Off-site Backup
```bash
#!/bin/bash
# /etc/cron.monthly/myra-offsite-backup
BACKUP_DIR="/backup/myra"
OFFSITE="s3://myra-backups"
DATE=$(date +%Y%m)

# Upload to S3 (or other cloud)
aws s3 sync "$BACKUP_DIR" "$OFFSITE/monthly/$DATE/" \
  --exclude "*" \
  --include "myra_data_full_*.tar.gz" \
  --include "*.sha256"

# Verify upload
aws s3 ls "$OFFSITE/monthly/$DATE/" | wc -l

# Glacier deep archive for compliance
# Move backups older than 1 year to glacier
for backup in "$BACKUP_DIR"/myra_data_full_*.tar.gz; do
  backup_date=$(echo "$backup" | grep -o '[0-9]\{8\}')
  if [ $(date -d "$backup_date" +%s) -lt $(date -d "1 year ago" +%s) ]; then
    aws s3 cp "$backup" "$OFFSITE/glacier/" --storage-class GLACIER
  fi
done
```

## Data Migration Procedures

### Migration to New Server
```bash
#!/bin/bash
# migrate-data.sh
SOURCE_SERVER="old-server.myra.ai"
DEST_SERVER="new-server.myra.ai"
DATA_DIR="/var/lib/myra-data"

echo "=== Starting Data Migration ==="

# 1. Stop services on both servers
ssh "$SOURCE_SERVER" "sudo systemctl stop myra-server"
ssh "$DEST_SERVER" "sudo systemctl stop myra-server"

# 2. Create backup on source
ssh "$SOURCE_SERVER" "tar -czf /tmp/myra-migration.tar.gz -C $DATA_DIR ."

# 3. Copy backup to destination
scp "$SOURCE_SERVER:/tmp/myra-migration.tar.gz" /tmp/

# 4. Restore on destination
ssh "$DEST_SERVER" "mkdir -p $DATA_DIR"
scp /tmp/myra-migration.tar.gz "$DEST_SERVER:/tmp/"
ssh "$DEST_SERVER" "tar -xzf /tmp/myra-migration.tar.gz -C $DATA_DIR"

# 5. Fix permissions
ssh "$DEST_SERVER" "chown -R myra:myra $DATA_DIR"
ssh "$DEST_SERVER" "chmod -R 750 $DATA_DIR"

# 6. Verify data integrity
ssh "$DEST_SERVER" "find $DATA_DIR -name '*.json' | wc -l"
ssh "$SOURCE_SERVER" "find $DATA_DIR -name '*.json' | wc -l"

# 7. Start services
ssh "$DEST_SERVER" "sudo systemctl start myra-server"

# 8. Verify functionality
curl -f "http://$DEST_SERVER:3000/api/health" || exit 1
curl "http://$DEST_SERVER:3000/api/intelligence/projects" | jq '.projects | length'

echo "=== Migration Complete ==="
```

### Schema Migration
```bash
#!/bin/bash
# migrate-schema.sh
DATA_DIR="/var/lib/myra-data"
BACKUP_DIR="/backup/myra/schema-migration"
DATE=$(date +%Y%m%d_%H%M%S)

echo "=== Schema Migration v1 → v2 ==="

# 1. Backup current data
mkdir -p "$BACKUP_DIR"
tar -czf "$BACKUP_DIR/pre_migration_$DATE.tar.gz" -C "$DATA_DIR" .

# 2. Migration logic
for file in "$DATA_DIR"/**/*.json; do
  echo "Migrating: $file"
  
  # Read current version
  current_version=$(jq -r '.version // 1' "$file")
  
  case $current_version in
    1)
      # v1 → v2 migration
      jq '
        .version = 2 |
        .metadata = (.metadata // {}) |
        .metadata.migratedAt = now |
        .metadata.originalVersion = 1
      ' "$file" > "${file}.tmp"
      ;;
    *)
      echo "  Skipping: Already version $current_version"
      continue
      ;;
  esac
  
  # Validate migrated file
  if jq empty "${file}.tmp" 2>/dev/null; then
    mv "${file}.tmp" "$file"
    echo "  ✓ Migrated to v2"
  else
    echo "  ✗ Migration failed"
    rm "${file}.tmp"
  fi
done

# 3. Verify migration
migrated_count=$(grep -r '"version": 2' "$DATA_DIR" | wc -l)
total_count=$(find "$DATA_DIR" -name "*.json" | wc -l)

echo "Migrated: $migrated_count/$total_count files"

if [ $migrated_count -eq $total_count ]; then
  echo "=== Migration Successful ==="
else
  echo "=== Migration Incomplete ==="
  # Rollback option
  read -p "Rollback? (y/n): " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    tar -xzf "$BACKUP_DIR/pre_migration_$DATE.tar.gz" -C "$DATA_DIR"
    echo "Rollback complete"
  fi
fi
```

## Disaster Recovery

### Complete Disaster Recovery
```bash
#!/bin/bash
# disaster-recovery.sh
set -e

echo "=== DISASTER RECOVERY INITIATED ==="
echo "Timestamp: $(date)"
echo ""

# 1. Emergency stop (if anything is running)
systemctl stop myra-server 2>/dev/null || true
systemctl stop nginx 2>/dev/null || true

# 2. Prepare new environment
echo "Preparing environment..."
apt-get update
apt-get install -y nodejs npm nginx postgresql redis

# 3. Restore from latest off-site backup
echo "Restoring from backup..."
LATEST_BACKUP=$(aws s3 ls s3://myra-backups/monthly/ | sort -r | head -1 | awk '{print $NF}')
aws s3 cp "s3://myra-backups/monthly/$LATEST_BACKUP" /tmp/recovery.tar.gz

# 4. Extract backup
mkdir -p /var/lib/myra-data
tar -xzf /tmp/recovery.tar.gz -C /var/lib/myra-data

# 5. Restore application
echo "Restoring application..."
git clone https://github.com/your-org/myra-ai-gemini.git /opt/myra-production
cd /opt/myra-production
npm ci --only=production
npm run build

# 6. Configure environment
cp .env.example .env.production
# Set critical environment variables
echo "GEMINI_API_KEY=$GEMINI_API_KEY" >> .env.production
echo "MYRA_DATA_DIR=/var/lib/myra-data" >> .env.production
echo "NODE_ENV=production" >> .env.production

# 7. Start services
echo "Starting services..."
systemctl start myra-server
systemctl start nginx

# 8. Verify recovery
echo "Verifying recovery..."
sleep 10  # Allow services to start
for i in {1..10}; do
  if curl -f http://localhost:3000/api/health >/dev/null 2>&1; then
    echo "✓ Application healthy"
    break
  fi
  sleep 5
done

# 9. Notify
echo "Sending notifications..."
# Send SMS/Email/Slack notifications
# Update status page

echo ""
echo "=== DISASTER RECOVERY COMPLETE ==="
echo "Recovery time: $(($(date +%s) - START_TIME)) seconds"
```

### Recovery Time Objectives (RTO/RPO)
```
RTO (Recovery Time Objective):
- Critical: 1 hour
- Important: 4 hours  
- Normal: 24 hours

RPO (Recovery Point Objective):
- Critical: 15 minutes data loss max
- Important: 1 hour data loss max
- Normal: 24 hours data loss max

Backup Strategy:
- Critical data: Real-time replication + 15-minute backups
- Important data: Hourly backups + daily off-site
- Normal data: Daily backups + weekly off-site
```

## Monitoring & Alerting

### Data Health Monitoring
```bash
#!/bin/bash
# /etc/cron.hourly/myra-data-health
DATA_DIR="/var/lib/myra-data"

# Check data directory exists
if [ ! -d "$DATA_DIR" ]; then
  echo "ERROR: Data directory missing"
  exit 1
fi

# Check file count
file_count=$(find "$DATA_DIR" -name "*.json" | wc -l)
if [ "$file_count" -lt 10 ]; then
  echo "WARNING: Low file count: $file_count"
fi

# Check disk space
disk_usage=$(df "$DATA_DIR" | awk 'NR==2 {print $5}' | sed 's/%//')
if [ "$disk_usage" -gt 90 ]; then
  echo "CRITICAL: Disk usage: $disk_usage%"
fi

# Check JSON validity
invalid_files=0
for file in "$DATA_DIR"/**/*.json; do
  if ! jq empty "$file" 2>/dev/null; then
    invalid_files=$((invalid_files + 1))
    echo "ERROR: Invalid JSON: $file"
  fi
done

if [ "$invalid_files" -gt 0 ]; then
  echo "CRITICAL: $invalid_files invalid JSON files"
  exit 1
fi

echo "OK: Data health check passed"
```

### Alert Configuration
```yaml
# Prometheus alerts for data issues
groups:
  - name: data_alerts
    rules:
      - alert: DataDirectoryMissing
        expr: count(filesystem_free_bytes{mountpoint="/var/lib/myra-data"}) == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Data directory missing or unmounted"
          
      - alert: HighDataDiskUsage
        expr: (filesystem_size_bytes{mountpoint="/var/lib/myra-data"} - filesystem_free_bytes{mountpoint="/var/lib/myra-data"}) / filesystem_size_bytes{mountpoint="/var/lib/myra-data"} > 0.9
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Data disk >90% full"
          
      - alert: BackupFailed
        expr: time() - myra_backup_last_success_timestamp > 86400
        for: 1h
        labels:
          severity: critical
        annotations:
          summary: "No successful backup in 24 hours"
```

## Training & Documentation

### Recovery Team Training
1. **Quarterly Drills**: Simulate data loss scenarios
2. **Tool Familiarity**: Backup/restore tools practice
3. **Communication Protocols**: Stakeholder notification drills
4. **Decision Making**: Recovery priority exercises

### Documentation Updates
After each recovery:
1. Update this runbook with learnings
2. Document new recovery procedures
3. Update contact lists
4. Refresh backup configurations
5. Share post-mortem findings

### Knowledge Base
```
/docs/recovery/
  database-recovery.md
  backup-procedures.md
  migration-guides.md
  disaster-recovery.md
  
/docs/post-mortems/
  2026-11-24-data-loss.md
  2026-10-15-disk-failure.md
  2026-09-01-migration-issues.md
```

---

*Database Recovery Runbook v1.0*
*Last Updated: 2026-11-24*
*Based on Runbooks Prompt Framework*
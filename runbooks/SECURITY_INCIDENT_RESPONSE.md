# Security Incident Response Runbook

## Purpose
Detect, contain, and remediate security incidents affecting Myra AI Gemini.

## Security Incident Classification

### SEV-1: Critical Security Incident
- Active exploitation of critical vulnerability
- Unauthorized access to sensitive data
- Credential compromise with production access
- Ransomware or destructive malware

### SEV-2: Major Security Incident  
- Attempted exploitation of critical vulnerability
- Unauthorized access attempt to sensitive systems
- Credential compromise without production access
- Significant data exposure risk

### SEV-3: Minor Security Incident
- Security misconfiguration discovered
- Low-severity vulnerability exploitation
- Policy violation without data exposure
- Suspicious activity requiring investigation

### SEV-4: Security Observation
- Security best practice deviation
- Minor configuration issues
- Informational security findings
- False positive alerts

## Incident Response Team (IRT) Roles

### Incident Commander
- Overall responsibility for incident response
- Makes key decisions and approves actions
- Coordinates communication with stakeholders

### Technical Lead
- Leads technical investigation
- Coordinates technical team activities
- Provides technical guidance and solutions

### Communications Lead
- Manages internal and external communications
- Prepares status updates and notifications
- Coordinates with legal and PR teams

### Forensic Analyst
- Collects and preserves evidence
- Conducts detailed technical analysis
- Documents findings for investigation

### Legal/Compliance Advisor
- Provides legal guidance and requirements
- Ensures compliance with regulations
- Coordinates with law enforcement if needed

## Security Incident Response Process

### Phase 1: Preparation
```bash
# Pre-configured tools and scripts
# /opt/myra/security/scripts/
#   - isolate-system.sh
#   - collect-forensics.sh
#   - rotate-credentials.sh
#   - block-ips.sh

# Contact list preparation
# Security team, legal, PR, executive team contacts
# External contacts: CERT, law enforcement, security vendors

# Communication channels
# Secure IRT channel: #security-incidents
# Encrypted communication tools
# Secure file sharing for evidence
```

### Phase 2: Detection & Analysis
```bash
# Detection sources
# 1. Security monitoring alerts
# 2. User reports
# 3. External threat intelligence
# 4. System anomaly detection
# 5. Log analysis

# Initial triage checklist
# [ ] Confirm incident is security-related
# [ ] Determine initial scope and impact
# [ ] Classify severity (SEV-1 to SEV-4)
# [ ] Assign IRT roles
# [ ] Establish secure communication channel
# [ ] Begin evidence preservation
```

### Phase 3: Containment
```bash
# Short-term containment (minutes)
# 1. Isolate affected systems from network
# 2. Change compromised credentials
# 3. Block malicious IP addresses
# 4. Disable compromised accounts
# 5. Implement temporary access controls

# Long-term containment (hours)
# 1. Patch vulnerabilities
# 2. Remove malicious code
# 3. Implement security controls
# 4. Strengthen monitoring
# 5. Update firewall rules
```

### Phase 4: Eradication & Recovery
```bash
# Eradication steps
# 1. Identify and remove all traces of attack
# 2. Verify system integrity
# 3. Update all security configurations
# 4. Rotate all potentially compromised secrets

# Recovery steps
# 1. Restore from clean backups
# 2. Verify backup integrity
# 3. Gradual system reintroduction
# 4. Monitor for recurring issues
# 5. Update all security baselines
```

### Phase 5: Post-Incident Activities
```bash
# Evidence preservation
# 1. Document complete timeline
# 2. Preserve logs and forensic data
# 3. Store evidence securely
# 4. Prepare investigation report

# Lessons learned
# 1. Conduct post-mortem within 48 hours
# 2. Identify root causes
# 3. Develop action items
# 4. Update security policies
# 5. Train staff on findings
```

## Common Security Scenarios

### Scenario 1: Unauthorized Access
**Symptoms**:
- Unusual login patterns
- Access from unexpected locations
- Failed login attempts followed by success
- Account activity outside business hours

**Immediate Actions**:
```bash
# 1. Lock compromised account
curl -X POST https://localhost:3000/api/admin/lock-account \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"userId": "compromised_user"}'

# 2. Check recent logins
grep "login\|authentication" /var/log/myra/server.log | tail -50

# 3. Review access logs
awk '$9 == 200 || $9 == 401' /var/log/nginx/access.log | \
  grep -E "(/api/auth|/api/admin)" | tail -20

# 4. Block suspicious IPs
iptables -A INPUT -s $SUSPICIOUS_IP -j DROP

# 5. Rotate credentials
# API keys, database credentials, service accounts
```

**Investigation Steps**:
```bash
# Collect evidence
mkdir -p /evidence/unauthorized-access-$(date +%Y%m%d)
cp /var/log/myra/server.log /evidence/unauthorized-access-*/server.log
cp /var/log/nginx/access.log /evidence/unauthorized-access-*/access.log
cp /var/log/auth.log /evidence/unauthorized-access-*/auth.log

# Analyze user activity
grep "user:$USER_ID" /var/log/myra/server.log | \
  awk '{print $1, $2, $6, $7, $8}' | tail -100

# Check for persistence mechanisms
find /opt/myra-production -type f -name "*.sh" -o -name "*.js" -o -name "*.json" | \
  xargs grep -l "eval\|exec\|system\|spawn" | \
  grep -v node_modules | grep -v "test\|spec"

# Review cron jobs
crontab -l
ls -la /etc/cron.*/
```

### Scenario 2: Data Exfiltration
**Symptoms**:
- Unusual outbound network traffic
- Large data transfers
- Database query anomalies
- File access outside normal patterns

**Immediate Actions**:
```bash
# 1. Block outbound traffic to suspicious destinations
iptables -A OUTPUT -d $MALICIOUS_IP -j DROP

# 2. Disable data export features
curl -X POST http://localhost:3000/api/admin/disable-feature \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"feature": "data-export"}'

# 3. Enable enhanced logging
curl -X POST http://localhost:3000/api/admin/enable-audit \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"level": "detailed"}'

# 4. Monitor file access
inotifywait -m /var/lib/myra-data -e access,open,modify | \
  grep -v ".swp\|.tmp" >> /var/log/myra/file-access.log
```

**Investigation Steps**:
```bash
# Analyze network traffic
tcpdump -i any -w /evidence/exfiltration-$(date +%Y%m%d).pcap
# Later analysis with Wireshark or tshark

# Check for data manipulation
find /var/lib/myra-data -type f -name "*.json" -exec stat -c "%n %y %s" {} \; | \
  sort -k2 | tail -50

# Review database queries (if applicable)
# For JSON files, check modification patterns
for file in /var/lib/myra-data/**/*.json; do
  if [ $(stat -c %Y "$file") -gt $(date -d "1 hour ago" +%s) ]; then
    echo "Recently modified: $file"
    # Check if modification was legitimate
  fi
done

# Analyze process activity
ps aux | grep -E "(curl|wget|nc|netcat|socat|ssh|scp)"
```

### Scenario 3: Malware Infection
**Symptoms**:
- Unexpected processes
- High CPU/memory usage
- Unusual network connections
- File system changes
- Security tool alerts

**Immediate Actions**:
```bash
# 1. Isolate system
./security/scripts/isolate-system.sh

# 2. Kill suspicious processes
pkill -f "suspicious_process_name"
pkill -f "miner\|cryptominer\|backdoor"

# 3. Check for known malware signatures
clamscan -r /opt/myra-production/

# 4. Review process tree
pstree -p $(pgrep node)

# 5. Check for persistence
systemctl list-unit-files | grep enabled
ls -la /etc/systemd/system/
crontab -l
```

**Investigation Steps**:
```bash
# Collect malware samples
mkdir -p /evidence/malware-$(date +%Y%m%d)
cp /tmp/suspicious_file /evidence/malware-*/sample.bin

# Analyze file system changes
find /opt/myra-production -type f -newer /tmp/marker -exec ls -la {} \;

# Check for file tampering
for file in /opt/myra-production/src/**/*.js; do
  if [ "$(md5sum "$file" | cut -d' ' -f1)" != "$(cat "$file.md5" 2>/dev/null)" ]; then
    echo "File modified: $file"
  fi
done

# Network connection analysis
netstat -tulpn | grep -E "(ESTABLISHED|LISTEN)"
lsof -i -P -n

# Memory analysis
cat /proc/$(pgrep node)/maps
cat /proc/$(pgrep node)/mem
```

### Scenario 4: API Abuse
**Symptoms**:
- Excessive API calls
- Unusual API usage patterns
- Rate limiting triggers
- Resource exhaustion

**Immediate Actions**:
```bash
# 1. Implement aggressive rate limiting
iptables -A INPUT -p tcp --dport 3000 -m limit --limit 10/second -j ACCEPT
iptables -A INPUT -p tcp --dport 3000 -j DROP

# 2. Block abusive IPs
for ip in $(grep "429\|403" /var/log/nginx/access.log | \
  awk '{print $1}' | sort | uniq -c | sort -rn | head -10 | awk '{print $2}'); do
  iptables -A INPUT -s $ip -j DROP
done

# 3. Disable compromised API keys
curl -X POST http://localhost:3000/api/admin/revoke-api-key \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"keyId": "compromised_key"}'

# 4. Enable API request logging
curl -X POST http://localhost:3000/api/admin/enable-api-logging \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"level": "detailed"}'
```

**Investigation Steps**:
```bash
# Analyze API usage patterns
grep "/api/" /var/log/nginx/access.log | \
  awk '{print $1, $7, $9}' | \
  sort | uniq -c | sort -rn | head -20

# Identify abusive patterns
cat /var/log/myra/server.log | \
  grep -E "(rate.limit|throttle|429|abuse)" | \
  awk '{print $1, $2, $6, $7}' | tail -50

# Check for credential stuffing
grep "401\|invalid.*token\|invalid.*credentials" /var/log/myra/server.log | \
  awk '{print $1, $2, $6}' | \
  sort | uniq -c | sort -rn | head -10

# Analyze user agent patterns
awk -F'"' '{print $6}' /var/log/nginx/access.log | \
  sort | uniq -c | sort -rn | head -10
```

### Scenario 5: Insider Threat
**Symptoms**:
- Unusual access to sensitive data
- Attempts to bypass security controls
- Data access outside job role
- Policy violations

**Immediate Actions**:
```bash
# 1. Revoke access immediately
curl -X POST http://localhost:3000/api/admin/revoke-access \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"userId": "suspicious_user", "reason": "security_investigation"}'

# 2. Preserve evidence
# Do not alert suspect
# Collect logs and system state quietly
# Maintain chain of custody

# 3. Enable enhanced monitoring
curl -X POST http://localhost:3000/api/admin/enable-user-monitoring \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"userId": "suspicious_user", "level": "detailed"}'

# 4. Review access history
curl -X GET http://localhost:3000/api/admin/access-logs \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"userId": "suspicious_user", "days": 30}'
```

**Investigation Steps**:
```bash
# Collect user activity logs
grep "user:suspicious_user" /var/log/myra/server.log > /evidence/user-activity.log

# Analyze file access patterns
find /var/lib/myra-data -type f -exec grep -l "suspicious_user" {} \;

# Check for data exfiltration attempts
grep -E "(download|export|copy|move)" /evidence/user-activity.log

# Review privilege escalation attempts
grep -E "(sudo|su|root|admin|privilege)" /var/log/auth.log | \
  grep "suspicious_user"

# Analyze network connections during user activity
# Correlate timestamps with netstat/lsof output
```

## Evidence Collection Procedures

### Digital Evidence Collection
```bash
#!/bin/bash
# collect-forensics.sh
set -e

INCIDENT_ID="$1"
EVIDENCE_DIR="/evidence/$INCIDENT_ID-$(date +%Y%m%d_%H%M%S)"

mkdir -p "$EVIDENCE_DIR"
cd "$EVIDENCE_DIR"

echo "=== Collecting Forensic Evidence ==="
echo "Incident: $INCIDENT_ID"
echo "Timestamp: $(date)"
echo "Evidence Directory: $EVIDENCE_DIR"
echo ""

# System information
uname -a > system-info.txt
hostname >> system-info.txt
cat /etc/os-release >> system-info.txt

# Running processes
ps aux > processes.txt
pstree -p > process-tree.txt

# Network connections
netstat -tulpn > network-connections.txt
lsof -i -P -n > open-connections.txt
ss -tulpn > socket-statistics.txt

# Log files
cp /var/log/myra/server.log myra-server.log
cp /var/log/nginx/access.log nginx-access.log
cp /var/log/nginx/error.log nginx-error.log
cp /var/log/auth.log auth.log
journalctl -u myra-server --since "24 hours ago" > journal-myra.txt

# Configuration files
cp /opt/myra-production/.env.production env-production.txt
cp /etc/nginx/sites-available/myra nginx-config.txt
cp /opt/myra-production/ecosystem.config.js pm2-config.txt

# File system information
find /opt/myra-production -type f -exec stat -c "%n %y %s %u %g" {} \; > file-stats.txt
find /var/lib/myra-data -type f -name "*.json" -exec stat -c "%n %y %s" {} \; > data-files.txt

# User information
who > logged-in-users.txt
last > login-history.txt
cat /etc/passwd > users.txt

# Create evidence manifest
find . -type f | sort > evidence-manifest.txt

# Calculate checksums
md5sum * > checksums.md5
sha256sum * > checksums.sha256

echo "=== Evidence Collection Complete ==="
echo "Total files: $(find . -type f | wc -l)"
echo "Total size: $(du -sh . | cut -f1)"
echo "Checksums verified"
```

### Evidence Preservation Guidelines
1. **Chain of Custody**: Document everyone who handles evidence
2. **Integrity Protection**: Use cryptographic hashes (SHA-256)
3. **Secure Storage**: Encrypt sensitive evidence
4. **Access Control**: Limit access to investigation team
5. **Retention Policy**: Keep evidence for required duration

## Communication Procedures

### Internal Communications
```bash
# Secure IRT channel setup
# Use encrypted messaging (Signal, Keybase, etc.)
# Establish codewords for sensitive information
# Document all communications for investigation

# Status update template
echo "SECURITY INCIDENT UPDATE
Incident ID: $INCIDENT_ID
Severity: $SEVERITY
Status: $STATUS
Summary: $SUMMARY
Impact: $IMPACT
Actions Taken: $ACTIONS
Next Update: $NEXT_UPDATE_TIME
IRT Lead: $IRT_LEAD
"
```

### External Communications
```bash
# Legal/PR coordination required before external communication
# Template for user notifications (if required)
echo "SECURITY NOTIFICATION
Date: $(date)
To: Affected Users
Subject: Security Incident Notification

We are writing to inform you about a security incident that may have affected your data.

What happened:
- $INCIDENT_DESCRIPTION
- Timeframe: $TIMEFRAME
- Systems affected: $SYSTEMS

What information was involved:
- $DATA_TYPES

What we are doing:
- $REMEDIATION_ACTIONS
- $PREVENTIVE_MEASURES

What you can do:
- $USER_ACTIONS

For more information:
- Contact: $CONTACT_INFO
- Resources: $RESOURCES

We sincerely apologize for this incident and are committed to protecting your information."
```

### Regulatory Reporting
```bash
# GDPR (72-hour requirement)
# Report to supervisory authority within 72 hours
# Document all actions taken
# Notify affected individuals without undue delay

# Other regulations:
# - HIPAA: Breach notification rule
# - PCI DSS: Incident response requirements
# - State laws: Varying requirements
```

## Recovery Procedures

### System Recovery
```bash
#!/bin/bash
# system-recovery.sh
set -e

echo "=== System Recovery Procedure ==="

# 1. Verify backup integrity
BACKUP_FILE="/backup/myra/myra_data_clean_$(date -d '7 days ago' +%Y%m%d).tar.gz"
if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Clean backup not found"
  exit 1
fi

sha256sum -c "${BACKUP_FILE}.sha256"
if [ $? -ne 0 ]; then
  echo "ERROR: Backup checksum failed"
  exit 1
fi

# 2. Stop all services
systemctl stop myra-server
systemctl stop nginx

# 3. Isolate system from network
iptables -P INPUT DROP
iptables -P OUTPUT DROP
iptables -P FORWARD DROP

# 4. Clean infected system
rm -rf /opt/myra-production
rm -rf /var/lib/myra-data
rm -rf /tmp/myra-*

# 5. Restore from clean backup
tar -xzf "$BACKUP_FILE" -C /var/lib/myra-data

# 6. Reinstall application from trusted source
git clone https://github.com/your-org/myra-ai-gemini.git /opt/myra-production
cd /opt/myra-production
git checkout $(git describe --tags --abbrev=0)  # Latest stable tag

# 7. Install dependencies in isolated environment
npm ci --only=production --ignore-scripts

# 8. Build application
npm run build

# 9. Rotate all credentials
# Generate new API keys, database passwords, etc.

# 10. Restore network connectivity
iptables -P INPUT ACCEPT
iptables -P OUTPUT ACCEPT
iptables -P FORWARD ACCEPT

# 11. Start services
systemctl start myra-server
systemctl start nginx

# 12. Verify recovery
sleep 10
curl -f http://localhost:3000/api/health || exit 1

echo "=== Recovery Complete ==="
```

### Credential Rotation
```bash
#!/bin/bash
# rotate-credentials.sh
set -e

echo "=== Credential Rotation Procedure ==="

# Generate new Gemini API key
# Visit: https://makersuite.google.com/app/apikey
# Update .env.production
sed -i "s/GEMINI_API_KEY=.*/GEMINI_API_KEY=$NEW_GEMINI_KEY/" /opt/myra-production/.env.production

# Generate new desktop token
NEW_DESKTOP_TOKEN=$(openssl rand -hex 32)
sed -i "s/DESKTOP_TOKEN=.*/DESKTOP_TOKEN=$NEW_DESKTOP_TOKEN/" /opt/myra-production/.env.production

# Generate new session secret
NEW_SESSION_SECRET=$(openssl rand -hex 32)
sed -i "s/SESSION_SECRET=.*/SESSION_SECRET=$NEW_SESSION_SECRET/" /opt/myra-production/.env.production

# Generate new cookie secret
NEW_COOKIE_SECRET=$(openssl rand -hex 32)
sed -i "s/COOKIE_SECRET=.*/COOKIE_SECRET=$NEW_COOKIE_SECRET/" /opt/myra-production/.env.production

# Revoke all existing sessions
curl -X POST http://localhost:3000/api/admin/revoke-all-sessions \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Clear all caches
curl -X POST http://localhost:3000/api/admin/clear-all-caches \
  -H "Authorization: Bearer $ADMIN_TOKEN"

echo "=== Credential Rotation Complete ==="
echo "All credentials have been rotated"
echo "Users will need to re-authenticate"
```

## Prevention & Hardening

### Post-Incident Hardening
```bash
#!/bin/bash
# post-incident-hardening.sh
set -e

echo "=== Post-Incident Hardening ==="

# 1. Update all dependencies
cd /opt/myra-production
npm audit
npm audit fix
npm update

# 2. Review security configurations
# Check .env.production for sensitive data exposure
# Verify file permissions
# Review firewall rules

# 3. Implement additional monitoring
# Install and configure file integrity monitoring
# Set up real-time alerting for security events
# Increase log retention periods

# 4. Conduct security assessment
# Schedule penetration test
# Review access controls
# Test backup and recovery procedures

# 5. Update policies and procedures
# Revise incident response plan
# Update security policies
# Conduct security awareness training

echo "=== Hardening Complete ==="
```

### Continuous Security Monitoring
```bash
#!/bin/bash
# security-monitoring.sh
set -e

# Daily security checks
echo "=== Daily Security Check ==="
echo "Timestamp: $(date)"
echo ""

# Check for unauthorized changes
for file in /opt/myra-production/src/**/*.js; do
  if [ "$(md5sum "$file" | cut -d' ' -f1)" != "$(cat "$file.md5" 2>/dev/null)" ]; then
    echo "ALERT: File modified: $file"
  fi
done

# Check for new listening ports
NEW_PORTS=$(netstat -tulpn | grep LISTEN | awk '{print $4}' | cut -d: -f2 | sort -u)
KNOWN_PORTS="3000 80 443"
for port in $NEW_PORTS; do
  if [[ ! " $KNOWN_PORTS " =~ " $port " ]]; then
    echo "ALERT: Unexpected listening port: $port"
  fi
done

# Check for failed login attempts
FAILED_LOGINS=$(grep "Failed password\|authentication failure" /var/log/auth.log | wc -l)
if [ $FAILED_LOGINS -gt 100 ]; then
  echo "ALERT: High failed login attempts: $FAILED_LOGINS"
fi

# Check for security updates
apt-get update
SECURITY_UPDATES=$(apt-get upgrade --dry-run | grep -i security | wc -l)
if [ $SECURITY_UPDATES -gt 0 ]; then
  echo "INFO: Security updates available: $SECURITY_UPDATES"
fi

echo "=== Security Check Complete ==="
```

## Training & Awareness

### IRT Training Program
1. **Quarterly Tabletop Exercises**: Simulate security incidents
2. **Technical Training**: Forensic tools and techniques
3. **Legal Training**: Regulatory requirements and reporting
4. **Communication Training**: Stakeholder communication
5. **Tool Training**: Security tools and systems

### Security Awareness Program
1. **Monthly Security Newsletters**: Current threats and best practices
2. **Phishing Simulations**: Test employee awareness
3. **Security Workshops**: Hands-on training sessions
4. **Policy Training**: Security policies and procedures
5. **Incident Reporting Training**: How to report security concerns

## Compliance & Reporting

### Regulatory Compliance Checklist
```bash
# GDPR Compliance
# [ ] Data breach notification within 72 hours
# [ ] Data protection impact assessments
# [ ] Records of processing activities
# [ ] Data subject rights procedures

# HIPAA Compliance (if applicable)
# [ ] Breach notification procedures
# [ ] Security risk assessments
# [ ] Business associate agreements
# [ ] Security awareness training

# PCI DSS Compliance (if applicable)
# [ ] Incident response plan
# [ ] Regular security testing
# [ ] Security policies
# [ ] Monitoring and testing
```

### Incident Reporting Templates
```bash
# Internal incident report template
echo "SECURITY INCIDENT REPORT
Report ID: $REPORT_ID
Date: $(date)
Prepared By: $PREPARER

1. Executive Summary
- Incident overview
- Business impact
- Resolution status

2. Incident Details
- Timeline of events
- Systems affected
- Data involved
- Root cause analysis

3. Response Actions
- Immediate actions taken
- Containment measures
- Eradication steps
- Recovery procedures

4. Lessons Learned
- What went well
- What could be improved
- Action items
- Timeline for improvements

5. Evidence
- Evidence collected
- Chain of custody
- Analysis results

6. Recommendations
- Preventive measures
- Detection improvements
- Response enhancements
- Training needs

Attachments:
- Forensic analysis reports
- Log files
- Network captures
- System images
"
```

---

*Security Incident Response Runbook v1.0*
*Last Updated: 2026-11-24*
*Based on Runbooks Prompt Framework*
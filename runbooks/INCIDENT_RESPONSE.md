# Incident Response Runbook

## Purpose
Quick response guide for production incidents affecting Myra AI Gemini.

## Severity Levels

### SEV-1: Critical
- Service completely unavailable
- Data loss or corruption
- Security breach confirmed
- Affects all users

### SEV-2: Major
- Service degraded significantly
- Key features not working
- Affects majority of users
- Performance severely impacted

### SEV-3: Minor
- Service partially degraded
- Non-critical features affected
- Affects subset of users
- Workarounds available

### SEV-4: Low
- Cosmetic issues
- Documentation errors
- Minor performance issues
- No user impact

## Incident Response Process

### Phase 1: Detection & Triage
```
1. Alert received (Slack/PagerDuty/Email)
2. Acknowledge alert within 5 minutes
3. Check incident channel: #incidents
4. Determine severity level
5. Assign incident commander
```

### Phase 2: Investigation
```
1. Gather initial information:
   - Error messages
   - Affected users
   - Time of onset
   - Recent changes
   
2. Check monitoring dashboards:
   - System metrics
   - Error rates
   - User impact
   
3. Review logs:
   - Application logs
   - System logs
   - Access logs
```

### Phase 3: Mitigation
```
1. Implement immediate fix if known
2. Deploy workaround if available
3. Roll back if recent deployment
4. Isolate affected components
5. Update status page
```

### Phase 4: Resolution
```
1. Identify root cause
2. Implement permanent fix
3. Deploy to production
4. Verify resolution
5. Close incident
```

### Phase 5: Post-Mortem
```
1. Schedule within 48 hours
2. Document timeline
3. Identify root cause
4. Action items
5. Share learnings
```

## Common Incidents

### Incident: Service Unavailable
**Symptoms**: HTTP 503 errors, health checks failing

**Immediate Actions**:
1. Check server status: `systemctl status myra-server`
2. Check disk space: `df -h`
3. Check memory: `free -h`
4. Check logs: `journalctl -u myra-server -f`

**Resolution Steps**:
```bash
# Restart service
sudo systemctl restart myra-server

# Check if running
sudo systemctl is-active myra-server

# If still failing, check logs
sudo journalctl -u myra-server --since "10 minutes ago"
```

### Incident: High Error Rate
**Symptoms**: Error rate > 5%, users reporting issues

**Immediate Actions**:
1. Check error dashboard
2. Identify error patterns
3. Check recent deployments
4. Monitor error logs

**Resolution Steps**:
```bash
# Check current error rate
curl http://localhost:3000/metrics | grep http_errors

# Check specific endpoint errors
grep "ERROR" /var/log/myra/server.log | tail -20

# Roll back if recent deployment
cd /opt/myra-production
git checkout HEAD~1
npm ci --only=production
npm run build
pm2 restart myra-production
```

### Incident: Database Corruption
**Symptoms**: Data not loading, file access errors

**Immediate Actions**:
1. Check data directory permissions
2. Verify backup integrity
3. Check disk health

**Resolution Steps**:
```bash
# Stop service
sudo systemctl stop myra-server

# Restore from backup
tar -xzf /backup/myra_data_latest.tar.gz -C /var/lib/myra-data

# Fix permissions
sudo chown -R myra:myra /var/lib/myra-data
sudo chmod -R 750 /var/lib/myra-data

# Start service
sudo systemctl start myra-server
```

### Incident: Security Breach
**Symptoms**: Unusual access patterns, data exfiltration attempts

**Immediate Actions**:
1. Isolate affected systems
2. Preserve logs for investigation
3. Change credentials
4. Notify security team

**Resolution Steps**:
```bash
# Block suspicious IPs
iptables -A INPUT -s <suspicious_ip> -j DROP

# Rotate API keys
# Update .env.production with new Gemini API key

# Review access logs
grep "suspicious" /var/log/nginx/access.log

# Check for compromised files
find /opt/myra-production -type f -mtime -1
```

### Incident: Performance Degradation
**Symptoms**: Slow response times, high latency

**Immediate Actions**:
1. Check CPU/memory usage
2. Monitor request queue
3. Check external service status

**Resolution Steps**:
```bash
# Check system resources
top -b -n 1 | head -20

# Check Node.js memory
pm2 monit

# Check database performance
# Review slow query logs

# Scale horizontally if needed
pm2 scale myra-server +1
```

## Communication Protocol

### Internal Communication
- **Incident Channel**: #incidents
- **Updates**: Every 15 minutes
- **Escalation**: After 30 minutes unresolved

### External Communication
- **Status Page**: Update every 30 minutes
- **Customers**: Transparent but measured
- **Media**: Designated spokesperson only

### Communication Templates
```
INITIAL ALERT:
[SEV-X] Incident: [Brief Description]
Start Time: [Timestamp]
Impact: [What's affected]
Status: Investigating
Next Update: [Time]

UPDATE:
[SEV-X] Incident Update
Current Status: [Updated status]
Progress: [What's been done]
ETA: [If available]
Next Update: [Time]

RESOLUTION:
[SEV-X] Incident Resolved
Resolution Time: [Timestamp]
Root Cause: [Brief description]
Prevention: [Steps taken]
Follow-up: [Post-mortem scheduled]
```

## Escalation Matrix

### Level 1: On-Call Engineer
- Duration: First 30 minutes
- Actions: Initial investigation, basic fixes
- Escalates: If unresolved after 30 minutes

### Level 2: Senior Engineer
- Duration: Next 60 minutes  
- Actions: Deep investigation, complex fixes
- Escalates: If service still impacted

### Level 3: Engineering Manager
- Duration: Beyond 90 minutes
- Actions: Coordinate teams, major decisions
- Escalates: To CTO if strategic impact

### Level 4: CTO/Executive
- Duration: Critical business impact
- Actions: Business decisions, external comms
- Escalates: N/A

## Tools & Resources

### Monitoring Tools
- Prometheus: System metrics
- Grafana: Dashboards
- ELK Stack: Log analysis
- Statuspage: External status

### Communication Tools
- Slack: Internal comms
- PagerDuty: Alerting
- Email: External comms
- Phone: Emergency contacts

### Diagnostic Tools
```bash
# Network
ping google.com
traceroute google.com
netstat -tulpn

# System
htop
iotop
iftop

# Application
curl http://localhost:3000/api/health
curl http://localhost:3000/metrics
pm2 logs myra-server
```

### Recovery Tools
- Backup scripts
- Deployment scripts
- Configuration management
- Database tools

## Checklists

### Pre-Incident Checklist
- [ ] Monitoring configured
- [ ] Alert thresholds set
- [ ] Runbooks updated
- [ ] Contact list current
- [ ] Tools accessible
- [ ] Backup tested

### Incident Start Checklist
- [ ] Acknowledge alert
- [ ] Create incident channel
- [ ] Assign roles
- [ ] Gather initial info
- [ ] Update status page
- [ ] Start timeline

### Incident Resolution Checklist
- [ ] Root cause identified
- [ ] Fix implemented
- [ ] Service restored
- [ ] Users notified
- [ ] Monitoring normal
- [ ] Incident closed

### Post-Incident Checklist
- [ ] Schedule post-mortem
- [ ] Document timeline
- [ ] Identify action items
- [ ] Update runbooks
- [ ] Share learnings
- [ ] Follow up on actions

## Training & Drills

### Monthly Drills
- Simulate SEV-2 incident
- Test communication flow
- Practice tool usage
- Time response

### Quarterly Drills
- Simulate SEV-1 incident
- Test escalation process
- Cross-team coordination
- Full recovery test

### Annual Review
- Update all runbooks
- Review past incidents
- Update contact lists
- Tool refresh

## Metrics & Improvement

### Response Metrics
- Time to acknowledge
- Time to investigate
- Time to mitigate
- Time to resolve
- Total downtime

### Quality Metrics
- Incident recurrence
- Post-mortem completion
- Action item completion
- Customer satisfaction

### Improvement Process
1. Measure current performance
2. Identify bottlenecks
3. Implement improvements
4. Measure again
5. Repeat

---

*Incident Response Runbook v1.0*
*Last Updated: 2026-11-24*
*Based on Runbooks Prompt Framework*
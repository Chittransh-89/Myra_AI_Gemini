# Deployment Rollback Runbook

## Purpose
Safe and rapid rollback of failed deployments with minimal user impact.

## Rollback Triggers

### Automatic Rollback Conditions
- ❌ Health check failures > 30%
- ❌ Error rate increase > 10x baseline  
- ❌ Performance degradation > 50%
- ❌ Critical feature failure
- ❌ Security vulnerability detected

### Manual Rollback Conditions
- 🚨 User reports breaking changes
- 🚨 Data corruption detected
- 🚨 Integration failures
- 🚨 Business impact unacceptable
- 🚨 Team consensus for rollback

## Rollback Decision Matrix

```
Severity Assessment
        ↓
[Minor Issues] → Can Wait → Monitor & Patch
        ↓
[Major Issues] → Affects Some → Partial Rollback
        ↓  
[Critical Issues] → Affects All → Full Rollback
        ↓
[Security Issues] → Immediate → Emergency Rollback
```

## Rollback Procedures

### Procedure 1: Hot Rollback (Zero Downtime)

**When to Use**: Minor issues, canary deployment failures

**Prerequisites**:
- Load balancer with health checks
- Multiple instances running
- Blue-green deployment setup
- Session persistence not required

**Steps**:
```bash
# 1. Identify failing instances
aws elb describe-instance-health --load-balancer-name myra-lb

# 2. Drain connections from new version
aws elb deregister-instances-from-load-balancer \
  --load-balancer-name myra-lb \
  --instances i-new1 i-new2

# 3. Verify old version health
curl http://old-version.myra.ai/api/health

# 4. Route all traffic to old version
aws elb register-instances-with-load-balancer \
  --load-balancer-name myra-lb \
  --instances i-old1 i-old2

# 5. Terminate new version instances
aws ec2 terminate-instances --instance-ids i-new1 i-new2
```

**Verification**:
- Monitor error rates dropping
- Check user reports
- Verify feature functionality
- Confirm performance restored

### Procedure 2: Rolling Rollback (Minimal Downtime)

**When to Use**: Major issues, gradual rollback needed

**Prerequisites**:
- Multiple availability zones
- Auto-scaling groups
- Deployment automation
- Database compatibility

**Steps**:
```bash
# 1. Stop deployment automation
aws deploy stop-deployment --deployment-id d-123456

# 2. Update launch configuration to old AMI
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name myra-asg \
  --launch-configuration-name myra-lc-old

# 3. Begin instance refresh
aws autoscaling start-instance-refresh \
  --auto-scaling-group-name myra-asg \
  --preferences '{"MinHealthyPercentage": 100}'

# 4. Monitor rollback progress
watch -n 5 'aws autoscaling describe-instance-refresh \
  --auto-scaling-group-name myra-asg'

# 5. Verify completion
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names myra-asg
```

**Timeline**:
- T+0: Rollback decision
- T+5: Automation stopped
- T+10: Configuration updated
- T+15: Instance refresh started
- T+30: 50% complete
- T+60: 100% complete

### Procedure 3: Emergency Rollback (Maximum Speed)

**When to Use**: Critical/Security issues, immediate action required

**Prerequisites**:
- Pre-built rollback artifacts
- Database backup ready
- Team on standby
- Communication plan

**Steps**:
```bash
# 1. Emergency stop - all services
systemctl stop myra-server
systemctl stop nginx

# 2. Restore from backup
rm -rf /opt/myra-production
tar -xzf /backup/myra_production_$(date -d '1 day ago' +%Y%m%d).tar.gz -C /opt/

# 3. Restore database state
psql -U myra -d myra_prod -f /backup/db_backup_$(date -d '1 day ago' +%Y%m%d).sql

# 4. Start services
systemctl start myra-server
systemctl start nginx

# 5. Verify basic functionality
curl -f http://localhost:3000/api/health || exit 1
```

**Emergency Checklist**:
- [ ] Notify incident commander
- [ ] Activate emergency channel
- [ ] Disable monitoring alerts
- [ ] Prepare rollback artifacts
- [ ] Backup current state
- [ ] Execute rollback
- [ ] Verify functionality
- [ ] Notify users

### Procedure 4: Database Rollback

**When to Use**: Data corruption, schema changes failed

**Prerequisites**:
- Database backups available
- Migration scripts versioned
- Transaction logs enabled
- Point-in-time recovery configured

**Steps**:
```bash
# For PostgreSQL
# 1. Identify last good state
psql -U myra -d myra_prod -c "SELECT pg_current_wal_lsn()"

# 2. Stop application
systemctl stop myra-server

# 3. Perform point-in-time recovery
pg_ctl stop -m immediate
cp -r /var/lib/postgresql/data /var/lib/postgresql/data_broken
pg_basebackup -D /var/lib/postgresql/data -Ft -z -P

# 4. Recover to specific LSN
echo "restore_command = 'cp /backup/wal/%f %p'" > recovery.conf
echo "recovery_target_lsn = '0/7000000'" >> recovery.conf

# 5. Start database
pg_ctl start
```

**Database Rollback Types**:
1. **Full backup restore**: Complete database replacement
2. **Point-in-time recovery**: Specific transaction recovery
3. **Schema rollback**: Reverse DDL changes only
4. **Data rollback**: Reverse DML changes only

## Version Management

### Version Control Strategy
```bash
# Git tags for releases
git tag -a v1.2.3 -m "Release 1.2.3"
git push origin v1.2.3

# Semantic versioning
# MAJOR.MINOR.PATCH
# 1.2.3 → 1.2.4 (patch fix)
# 1.2.3 → 1.3.0 (minor feature)
# 1.2.3 → 2.0.0 (breaking change)

# Release branches
git checkout -b release/v1.2.3
git push origin release/v1.2.3
```

### Artifact Management
```bash
# Store deployment artifacts
# /artifacts/
#   v1.2.3/
#     myra-server.tar.gz
#     migrations/
#     configs/
#     checksums.txt

# Verify artifact integrity
sha256sum -c checksums.txt

# Rollback artifact retrieval
wget https://artifacts.myra.ai/v1.2.2/myra-server.tar.gz
tar -xzf myra-server.tar.gz -C /opt/myra-production
```

## Communication Plan

### Internal Communication
```
ROLLBACK INITIATED
Severity: [SEV-1/2/3]
Reason: [Brief description]
Impact: [Users affected]
ETA: [Completion time]
Channel: [#incidents]

ROLLBACK PROGRESS
Stage: [Current stage]
Progress: [X% complete]
Issues: [Any encountered]
Next Update: [Time]

ROLLBACK COMPLETE
Time: [Completion timestamp]
Duration: [Total time]
Verification: [Test results]
Follow-up: [Post-mortem scheduled]
```

### External Communication
```
STATUS PAGE UPDATE
Title: Service Degradation
Status: Identified → Investigating → Fixing → Resolved
Message: We're experiencing issues and are rolling back changes

USER NOTIFICATION
Subject: Service Update
Body: We encountered an issue with our latest update and have rolled back to a stable version

SOCIAL MEDIA
Tweet: We've identified an issue with our latest update and are rolling back. Service will be restored shortly
```

## Testing Rollback Scenarios

### Test Scenario 1: Canary Failure
```bash
# Deploy bad version to 10% traffic
# Simulate failure
# Trigger automatic rollback
# Verify traffic routed away
# Measure time to detection
# Measure time to recovery
```

### Test Scenario 2: Database Migration Failure
```bash
# Apply breaking schema change
# Simulate application failure
# Execute database rollback
# Verify data consistency
# Measure data loss (should be zero)
```

### Test Scenario 3: Configuration Error
```bash
# Deploy bad configuration
# Monitor service degradation
# Execute configuration rollback
# Verify service restoration
# Measure configuration propagation time
```

## Rollback Metrics

### Key Performance Indicators
- **MTTD**: Mean Time To Detection < 5 minutes
- **MTTR**: Mean Time To Recovery < 15 minutes
- **Rollback Success Rate**: > 99%
- **Data Loss**: 0% target
- **User Impact**: Minimal to none

### Monitoring During Rollback
```bash
# Real-time monitoring
watch -n 1 '
echo "Error Rate:"
curl -s http://localhost:3000/metrics | grep http_errors
echo ""
echo "Active Instances:"
aws autoscaling describe-auto-scaling-groups --query "AutoScalingGroups[0].Instances"
'

# Alert suppression during rollback
# Temporarily disable non-critical alerts
# Maintain security alerts
```

## Post-Rollback Procedures

### Verification Checklist
- [ ] Health checks passing > 95%
- [ ] Error rate < 1% baseline
- [ ] Performance within SLA
- [ ] All features functional
- [ ] Data integrity verified
- [ ] User sessions preserved

### Cleanup Operations
```bash
# Clean up failed deployment artifacts
rm -rf /opt/myra-failed-deployment

# Remove temporary configurations
rm -f /etc/nginx/sites-enabled/myra-new.conf

# Clean up database temporary tables
psql -U myra -d myra_prod -c "DROP TABLE IF EXISTS temp_*"

# Remove rollback-specific monitoring
rm -f /etc/prometheus/rules/rollback-alerts.yml
```

### Post-Mortem Requirements
1. **Schedule within 24 hours**
2. **Attendees**: All involved teams
3. **Documentation**: Complete timeline
4. **Root Cause**: Technical and process
5. **Action Items**: With owners and dates
6. **Follow-up**: Weekly until resolved

## Prevention Strategies

### Deployment Safety Nets
```yaml
# Deployment pipeline checks
stages:
  - test
  - security_scan
  - performance_test
  - canary_deployment
  - automated_rollback_test
  - production_deployment

# Rollback readiness checks
checks:
  - backup_exists: true
  - rollback_artifacts: true
  - team_available: true
  - communication_plan: ready
  - monitoring_configured: true
```

### Feature Flags
```typescript
// Gradual feature rollout
const featureFlags = {
  newVoiceModel: {
    enabled: false,
    rolloutPercentage: 0, // Start at 0%
    users: ['testers']   // Specific users only
  }
};

// Safe rollback via flags
function rollbackFeature(featureName: string) {
  featureFlags[featureName].enabled = false;
  featureFlags[featureName].rolloutPercentage = 0;
  // No code deployment needed
}
```

### Canary Analysis
```bash
# Automated canary analysis
# Compare metrics between old and new
# - Error rates
# - Performance metrics
# - Business metrics
# - User satisfaction

# Auto-rollback conditions
if (error_rate_new / error_rate_old > 2) {
  trigger_rollback();
}
if (response_time_new > response_time_old * 1.5) {
  trigger_rollback();
}
```

## Training & Documentation

### Team Training Scenarios
1. **Tabletop exercise**: Simulated rollback decision
2. **Technical drill**: Actual rollback execution
3. **Communication drill**: Stakeholder updates
4. **Post-mortem practice**: Learning from simulations

### Documentation Updates
After each rollback:
1. Update this runbook with learnings
2. Add new troubleshooting steps
3. Update communication templates
4. Refresh contact lists
5. Update monitoring configurations

### Knowledge Base
```
/docs/runbooks/
  deployment-rollback.md
  database-rollback.md
  emergency-procedures.md
  communication-templates.md
  
/docs/post-mortems/
  2026-11-24-rollback.md
  2026-10-15-deployment-failure.md
```

## Tools & Automation

### Rollback Automation Scripts
```bash
#!/bin/bash
# /scripts/rollback.sh
set -e

VERSION=$1
ENVIRONMENT=$2

case $ENVIRONMENT in
  staging)
    rollback_staging $VERSION
    ;;
  production)
    rollback_production $VERSION
    ;;
  *)
    echo "Unknown environment"
    exit 1
    ;;
esac

function rollback_production() {
  local version=$1
  
  echo "Starting production rollback to $version"
  
  # 1. Notify
  send_slack_notification "Rollback started to $version"
  
  # 2. Stop deployment
  stop_deployment
  
  # 3. Restore artifacts
  restore_artifacts $version
  
  # 4. Update infrastructure
  update_infrastructure $version
  
  # 5. Verify
  verify_deployment
  
  # 6. Notify completion
  send_slack_notification "Rollback completed to $version"
}
```

### Monitoring Automation
```yaml
# Prometheus alert for auto-rollback
groups:
  - name: auto_rollback
    rules:
      - alert: HighErrorRateAfterDeployment
        expr: |
          increase(http_errors_total[5m]) / increase(http_requests_total[5m]) > 0.05
          and
          time() - deployment_time < 900
        for: 2m
        labels:
          severity: critical
          auto_rollback: "true"
        annotations:
          summary: "Error rate >5% after deployment"
          description: "Triggering automatic rollback"
```

### ChatOps Integration
```
/rollback start version=1.2.2 reason="high error rate"
/rollback status
/rollback cancel
/rollback complete
```

## Special Considerations

### Data-Intensive Applications
```bash
# For applications with large datasets:
# 1. Schema versioning
# 2. Data migration scripts (forward/backward)
# 3. Data validation pre/post
# 4. Staged data migration

# Rollback strategy:
# Keep new schema, revert application
# OR
# Revert both schema and application
# Based on data loss tolerance
```

### Stateful Applications
```bash
# For stateful applications:
# 1. Session draining before rollback
# 2. State migration or reset
# 3. User notification about state loss
# 4. Graceful degradation

# Options:
# - Preserve state in shared storage
# - Reset state to known good
# - Continue with mixed state
```

### Multi-Service Dependencies
```bash
# For microservices:
# 1. Dependency graph analysis
# 2. Order of rollback determination
# 3. API version compatibility
# 4. Contract testing

# Rollback order:
# 1. Leaf services (no dependencies)
# 2. Middle services
# 3. Core services
# 4. Gateway/API services
```

## Continuous Improvement

### Rollback Metrics Review
```bash
# Monthly review
# - Rollback frequency
# - Rollback success rate
# - Time to recovery
# - User impact
# - Process adherence

# Quarterly improvement
# - Update automation
# - Improve tooling
# - Enhance monitoring
# - Streamline communication
```

### Process Optimization
```
Current Process → Identify Bottlenecks → Implement Improvements → Measure Impact

Common optimizations:
1. Faster artifact retrieval
2. Parallel rollback execution
3. Improved health checks
4. Better decision automation
5. Enhanced communication
```

### Tooling Improvements
```bash
# Wishlist for rollback tooling
# 1. One-click rollback dashboard
# 2. Predictive rollback suggestions
# 3. Automated impact analysis
# 4. Integrated communication
# 5. Real-time progress tracking
```

---

*Deployment Rollback Runbook v1.0*
*Last Updated: 2026-11-24*
*Based on Runbooks Prompt Framework*
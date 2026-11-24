# Performance Tuning Runbook

## Purpose
Systematic approach to identifying and resolving performance issues in Myra AI Gemini.

## Performance Baselines

### Current Performance Targets
| Metric | Target | Warning | Critical |
|--------|--------|---------|----------|
| Voice Response Time | < 2s | 2-4s | > 4s |
| Project Analysis | < 30s | 30-60s | > 60s |
| API Response P95 | < 1s | 1-3s | > 3s |
| Memory Usage | < 500MB | 500-800MB | > 800MB |
| CPU Usage | < 50% | 50-80% | > 80% |

### User Experience Indicators
- **Excellent**: Instant response, no lag
- **Good**: Minor delays, acceptable
- **Fair**: Noticeable delays, frustrating
- **Poor**: Long waits, timeouts
- **Unusable**: System hangs, crashes

## Diagnostic Methodology

### Performance Investigation Framework
```
Reported Issue
    ↓
[Quantify Impact] → How many users? What features?
    ↓
[Reproduce Issue] → Consistent? Environment-specific?
    ↓
[Measure Baseline] → Current vs Expected performance
    ↓
[Identify Bottleneck] → CPU? Memory? Network? Disk? Database?
    ↓
[Implement Fix] → Configuration? Code? Infrastructure?
    ↓
[Verify Improvement] → A/B test, monitor metrics
    ↓
[Document Learnings] → Update runbook, share findings
```

### Quick Diagnostics
```bash
# 1-minute system check
#!/bin/bash
echo "=== Myra Performance Quick Check ==="
echo "CPU: $(top -bn1 | grep "Cpu(s)" | awk '{print $2}')%"
echo "Memory: $(free -m | awk 'NR==2{printf "%.1f%%", $3*100/$2}')"
echo "Disk: $(df -h / | awk 'NR==2{print $5}') used"
echo "Network: $(ping -c 1 google.com | grep "time=" | cut -d'=' -f4)"
echo "Myra Status: $(systemctl is-active myra-server)"
echo "API Health: $(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health)"
```

## Common Performance Issues

### Issue 1: Slow Voice Response

**Symptoms**:
- Voice response > 4 seconds
- "Processing" state lingers
- Users report lag

**Diagnostic Steps**:
```bash
# 1. Check Gemini API latency
curl -w "\nTime to Connect: %{time_connect}\nTime to First Byte: %{time_starttransfer}\nTotal Time: %{time_total}\n" \
  -X POST "https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"test"}]}]}'

# 2. Check local processing time
time node -e "
const start = Date.now();
// Simulate voice processing
const crypto = require('crypto');
for(let i = 0; i < 1000000; i++) {
  crypto.createHash('md5').update('test').digest('hex');
}
console.log('Processing time:', Date.now() - start, 'ms');
"

# 3. Check audio pipeline
grep -E "(audio|voice|transcription)" /var/log/myra/server.log | \
  awk '{print $1, $2, $NF}' | tail -10
```

**Resolution Steps**:
```bash
# Optimize Gemini API calls
# 1. Enable response streaming if not already
# 2. Reduce prompt complexity
# 3. Cache common responses

# Optimize local processing
# 1. Increase audio chunk size (100ms → 200ms)
# 2. Pre-warm voice models
# 3. Parallelize audio processing

# Configuration changes
export NODE_OPTIONS="--max-old-space-size=4096"
export UV_THREADPOOL_SIZE=$(nproc)
```

### Issue 2: High Memory Usage

**Symptoms**:
- Memory > 800MB consistently
- Frequent garbage collection
- System swapping

**Diagnostic Steps**:
```bash
# 1. Check Node.js heap usage
node -e "console.log(process.memoryUsage())"

# 2. Identify memory leaks
npm install -g node-memwatch
# Add to application:
const memwatch = require('node-memwatch');
memwatch.on('leak', (info) => {
  console.error('Memory leak detected:', info);
});

# 3. Heap dump analysis
kill -USR2 $(pgrep node)
# Generates heap dump in /tmp

# 4. Check specific components
# Monitor memory during:
# - Project analysis
# - Voice conversations  
# - File imports
```

**Resolution Steps**:
```bash
# Immediate fixes
# 1. Restart service
pm2 restart myra-server --max-memory-restart 500M

# 2. Clear in-memory caches
curl -X POST http://localhost:3000/api/admin/clear-cache

# 3. Reduce cache sizes
export MAX_PENDING_IMPORTS=2  # Was 4
export IMPORT_TTL_MS=900000   # 15 minutes instead of 30

# Code optimizations
# 1. Stream large files instead of loading fully
# 2. Use buffers instead of strings for binary data
# 3. Implement object pooling
# 4. Clear intervals/timeouts properly
```

### Issue 3: CPU Bottleneck

**Symptoms**:
- CPU consistently > 80%
- Slow response during peak usage
- System becomes unresponsive

**Diagnostic Steps**:
```bash
# 1. Identify hot functions
node --prof app.js
node --prof-process isolate-0xnnnnnnn-v8.log > processed.txt

# 2. Real-time CPU profiling
sudo perf record -g -p $(pgrep node)
sudo perf report

# 3. Check specific operations
# Time each major operation:
time curl http://localhost:3000/api/intelligence/projects/proj_123/analyze
time curl http://localhost:3000/api/intelligence/interviews

# 4. Monitor WebSocket operations
# High CPU often correlates with many concurrent WebSocket connections
```

**Resolution Steps**:
```bash
# 1. Optimize expensive operations
# Project analysis:
# - Parallelize file processing
# - Implement incremental analysis
# - Cache intermediate results

# 2. Implement rate limiting
# Add to configuration:
export MAX_CONCURRENT_ANALYSIS=2
export MAX_CONCURRENT_VOICE=5

# 3. Use worker threads for CPU-intensive tasks
# Move to separate workers:
# - File parsing
# - Audio processing  
# - Code analysis

# 4. Database/IO optimizations
# - Add indexes to frequently queried data
# - Implement query caching
# - Use connection pooling
```

### Issue 4: Network Latency

**Symptoms**:
- High response times despite low CPU/memory
- Geographic performance differences
- Inconsistent performance

**Diagnostic Steps**:
```bash
# 1. Comprehensive network test
mtr generativelanguage.googleapis.com
# Check for packet loss, latency spikes

# 2. DNS resolution time
dig generativelanguage.googleapis.com

# 3. Check CDN/edge locations
curl -I https://generativelanguage.googleapis.com
# Look for X-Cache headers

# 4. Monitor WebSocket latency
# Add timing to WebSocket messages:
const start = Date.now();
ws.send(message, () => {
  console.log('WebSocket send time:', Date.now() - start);
});
```

**Resolution Steps**:
```bash
# 1. Optimize API calls
# - Batch requests where possible
# - Implement request deduplication
# - Use HTTP/2 multiplexing

# 2. Geographic optimization
# - Deploy edge locations
# - Use CDN for static assets
# - Regional API endpoints

# 3. Connection optimization
# - Implement connection pooling
# - Use keep-alive connections
# - Optimize TLS settings

# 4. Compression
# - Enable gzip/brotli compression
# - Optimize WebSocket payloads
# - Minify JSON responses
```

## Performance Optimization Techniques

### Database Optimization
```bash
# For JSON file storage:
# 1. Implement indexing
# Create index files for frequent queries
find /var/lib/myra-data -name "*.json" -exec jq '.projectId' {} \; > index.txt

# 2. Implement caching layer
redis-cli SET "project:proj_123" "$(cat project.json)" EX 3600

# 3. Optimize file access
# Use mmap for large files
# Implement read-ahead caching
# Batch file operations

# 4. Data partitioning
# Split large JSON files by:
# - Date ranges
# - Project types
# - User groups
```

### File System Optimization
```bash
# 1. Choose optimal file system
# ext4 for general use
# XFS for large files
# Btrfs for snapshots

# 2. Mount options optimization
# /etc/fstab entry:
/dev/sdb1 /var/lib/myra-data ext4 noatime,nodiratime,data=writeback 0 2

# 3. I/O scheduler tuning
echo deadline > /sys/block/sdb/queue/scheduler

# 4. Read-ahead optimization
blockdev --setra 8192 /dev/sdb1
```

### Node.js Optimization
```javascript
// Application-level optimizations

// 1. Connection pooling
const pool = new GenericPool({
  create: () => createDatabaseConnection(),
  destroy: (client) => client.end(),
  min: 2,
  max: 10,
  idleTimeoutMillis: 30000
});

// 2. Request batching
const batcher = new BatchProcessor({
  maxSize: 100,
  maxTime: 1000,
  process: async (items) => {
    return await processBatch(items);
  }
});

// 3. Memory management
class ObjectPool {
  constructor(createFn) {
    this.pool = [];
    this.createFn = createFn;
  }
  
  acquire() {
    return this.pool.pop() || this.createFn();
  }
  
  release(obj) {
    this.pool.push(obj);
  }
}

// 4. Async optimization
async function optimizedOperation() {
  // Use Promise.all for parallel operations
  const [result1, result2] = await Promise.all([
    operation1(),
    operation2()
  ]);
  
  // Use stream for large data
  const stream = fs.createReadStream('large.json');
  stream.pipe(through2.obj(processChunk));
}
```

### WebSocket Optimization
```javascript
// WebSocket performance optimizations

// 1. Message compression
const ws = new WebSocket('ws://localhost:3000/ws', {
  perMessageDeflate: {
    serverNoContextTakeover: false,
    clientNoContextTakeover: false,
    serverMaxWindowBits: 15,
    clientMaxWindowBits: 15
  }
});

// 2. Connection pooling
class WebSocketPool {
  constructor(maxConnections = 5) {
    this.pool = new Array(maxConnections).fill(null);
    this.index = 0;
  }
  
  getConnection() {
    if (!this.pool[this.index] || !this.pool[this.index].ready) {
      this.pool[this.index] = new WebSocket('ws://localhost:3000/ws');
    }
    
    const conn = this.pool[this.index];
    this.index = (this.index + 1) % this.pool.length;
    return conn;
  }
}

// 3. Message batching
class MessageBatcher {
  constructor(flushInterval = 100) {
    this.batch = [];
    this.flushInterval = flushInterval;
    this.timer = null;
  }
  
  add(message) {
    this.batch.push(message);
    
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushInterval);
    }
    
    if (this.batch.length >= 10) {
      this.flush();
    }
  }
  
  flush() {
    if (this.batch.length > 0) {
      ws.send(JSON.stringify({ batch: this.batch }));
      this.batch = [];
    }
    
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
```

## Monitoring & Alerting

### Performance Dashboards
```yaml
# Grafana dashboard configuration
apiVersion: 1

panels:
  - title: "Voice Response Times"
    type: "graph"
    targets:
      - expr: "histogram_quantile(0.95, rate(voice_response_duration_seconds_bucket[5m]))"
        legendFormat: "P95 Response Time"
    
  - title: "Memory Usage"
    type: "graph"  
    targets:
      - expr: "process_resident_memory_bytes"
        legendFormat: "Memory"
        
  - title: "CPU Usage"
    type: "graph"
    targets:
      - expr: "rate(process_cpu_seconds_total[5m]) * 100"
        legendFormat: "CPU %"
```

### Alert Rules
```yaml
# Prometheus alert rules
groups:
  - name: performance_alerts
    rules:
      - alert: HighVoiceResponseTime
        expr: histogram_quantile(0.95, rate(voice_response_duration_seconds_bucket[5m])) > 4
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Voice response time > 4s"
          
      - alert: HighMemoryUsage
        expr: process_resident_memory_bytes > 800 * 1024 * 1024
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Memory usage > 800MB"
          
      - alert: HighCPUUsage
        expr: rate(process_cpu_seconds_total[5m]) * 100 > 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "CPU usage > 80%"
```

## Capacity Planning

### Scaling Guidelines
```bash
# User-based scaling
# 1-100 users: Single server
# 100-1000 users: Load balanced, 2-3 servers
# 1000-10000 users: Auto-scaling group, 5-10 servers
# 10000+ users: Multi-region, CDN, database clustering

# Resource requirements per 100 concurrent users:
# CPU: 2 cores
# Memory: 1 GB
# Storage: 10 GB
# Network: 10 Mbps
```

### Load Testing
```bash
# Artillery load test configuration
# artillery.yml
config:
  target: "http://localhost:3000"
  phases:
    - duration: 60
      arrivalRate: 10
      name: Warm up
    - duration: 120
      arrivalRate: 50
      name: Load test
    - duration: 60
      arrivalRate: 10
      name: Cool down

scenarios:
  - flow:
    - get:
        url: "/api/health"
    - think: 1
    - post:
        url: "/api/intelligence/import/local"
        json:
          path: "/tmp/test-project"
```

### Performance Testing Scenarios
```bash
# Test 1: Voice conversation load
# Simulate 50 concurrent voice conversations
# Measure: Response time, error rate, resource usage

# Test 2: Project analysis load  
# Simulate 10 concurrent project analyses
# Measure: Analysis time, memory usage, CPU usage

# Test 3: Mixed workload
# Simulate real-world usage patterns
# Measure: Overall system performance
```

## Tuning Parameters

### Configuration Tuning
```bash
# Application configuration
export NODE_OPTIONS="--max-old-space-size=4096"
export UV_THREADPOOL_SIZE=4
export MAX_CONCURRENT_REQUESTS=100
export REQUEST_TIMEOUT=30000

# Database tuning (if using SQLite)
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -2000;  # 2MB cache
PRAGMA busy_timeout = 5000;

# WebSocket tuning
export WS_MAX_PAYLOAD=65536  # 64KB
export WS_HEARTBEAT_INTERVAL=25000  # 25 seconds
export WS_MAX_CONNECTIONS=1000
```

### OS Tuning
```bash
# Linux kernel tuning
# /etc/sysctl.conf
net.core.somaxconn = 1024
net.ipv4.tcp_max_syn_backlog = 1024
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_tw_reuse = 1
vm.swappiness = 10
vm.dirty_ratio = 10
vm.dirty_background_ratio = 5

# File limits
# /etc/security/limits.conf
myra soft nofile 65536
myra hard nofile 65536
myra soft nproc 65536
myra hard nproc 65536
```

## Troubleshooting Workflow

### Step 1: Initial Assessment
```bash
# Quick health check
./scripts/health-check.sh

# Check recent changes
git log --oneline -10

# Review monitoring dashboards
# - Error rates
# - Response times  
# - Resource usage
# - User reports
```

### Step 2: Deep Investigation
```bash
# CPU profiling
node --cpu-prof app.js

# Memory analysis
node --inspect app.js
# Use Chrome DevTools Memory tab

# Network analysis
tcpdump -i any port 3000 -w capture.pcap

# Log analysis
grep -E "(slow|timeout|error)" /var/log/myra/server.log | \
  awk '{print $1, $2, $NF}' | \
  sort | uniq -c | sort -rn
```

### Step 3: Implementation
```bash
# Apply fixes
# 1. Hot fix if possible
curl -X POST http://localhost:3000/api/admin/reload-config

# 2. Configuration update
cp new-config.json /opt/myra-production/config/
pm2 restart myra-server

# 3. Code deployment
git pull origin fix/performance-issue
npm ci --only=production
npm run build
pm2 restart myra-server
```

### Step 4: Verification
```bash
# Monitor after fixes
watch -n 5 '
echo "CPU: $(top -bn1 | grep "Cpu(s)" | awk "{print \$2}")%"
echo "Memory: $(free -m | awk "NR==2{printf \"%.1f%%\", \$3*100/\$2}")"
echo "Response Time: $(curl -w "%{time_total}" -o /dev/null -s http://localhost:3000/api/health)"
'

# A/B testing
# Deploy to canary instances first
# Compare metrics between old and new
# Full rollout if improvements confirmed
```

## Performance Patterns

### Pattern 1: Gradual Degradation
**Cause**: Memory leak, disk fragmentation, cache buildup
**Solution**: Scheduled restarts, cache cleanup, monitoring

### Pattern 2: Sudden Drop
**Cause**: Configuration change, deployment, external dependency
**Solution**: Rollback, investigate changes, check dependencies

### Pattern 3: Periodic Spikes
**Cause**: Scheduled jobs, user patterns, backups
**Solution**: Reschedule jobs, implement rate limiting, optimize

### Pattern 4: Geographic Issues
**Cause**: Network latency, CDN issues, regional outages
**Solution**: Edge deployments, CDN optimization, failover

## Continuous Improvement

### Performance Review Process
```
Weekly:
- Review performance metrics
- Identify top issues
- Plan optimizations

Monthly:
- Load testing
- Capacity planning
- Architecture review

Quarterly:
- Performance audit
- Tooling evaluation
- Training updates
```

### Performance Debt Tracking
```bash
# Track technical debt affecting performance
# /docs/performance-debt.md

1. [HIGH] Voice response optimization
   - Estimated impact: 30% improvement
   - Effort: 2 weeks
   - Status: Planned

2. [MEDIUM] Memory leak in project analysis
   - Estimated impact: 50% memory reduction
   - Effort: 1 week
   - Status: In progress

3. [LOW] Database query optimization
   - Estimated impact: 20% faster queries
   - Effort: 3 days
   - Status: Backlog
```

### Metrics Collection
```bash
# Collect performance metrics
# /scripts/collect-metrics.sh
#!/bin/bash
METRICS_FILE="/var/log/myra/performance-$(date +%Y%m%d).csv"

echo "timestamp,cpu,memory,response_time,error_rate" >> $METRICS_FILE
while true; do
  TIMESTAMP=$(date +%s)
  CPU=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
  MEMORY=$(free -m | awk 'NR==2{printf "%.1f", $3*100/$2}')
  RESPONSE_TIME=$(curl -w "%{time_total}" -o /dev/null -s http://localhost:3000/api/health)
  ERROR_RATE=$(curl -s http://localhost:3000/metrics | grep http_errors | awk '{print $2}')
  
  echo "$TIMESTAMP,$CPU,$MEMORY,$RESPONSE_TIME,$ERROR_RATE" >> $METRICS_FILE
  sleep 60
done
```

## Emergency Procedures

### Critical Performance Issues
```bash
# If system becomes unresponsive:

# 1. Scale horizontally immediately
aws autoscaling set-desired-capacity \
  --auto-scaling-group-name myra-asg \
  --desired-capacity $(($(aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names myra-asg \
    --query "AutoScalingGroups[0].DesiredCapacity" \
    --output text) * 2))

# 2. Disable non-critical features
curl -X POST http://localhost:3000/api/admin/disable-features \
  -H "Content-Type: application/json" \
  -d '{"features": ["project-analysis", "voice-history"]}'

# 3. Implement rate limiting
iptables -A INPUT -p tcp --dport 3000 -m limit --limit 100/second -j ACCEPT
iptables -A INPUT -p tcp --dport 3000 -j DROP

# 4. Notify users
curl -X POST https://api.statuspage.io/v1/pages/PAGE_ID/incidents \
  -H "Authorization: OAuth YOUR_TOKEN" \
  -d '{
    "incident": {
      "name": "Performance Issues",
      "status": "investigating",
      "impact_override": "major",
      "body": "We are experiencing performance issues and are working on a fix."
    }
  }'
```

---

*Performance Tuning Runbook v1.0*
*Last Updated: 2026-11-24*
*Based on Runbooks Prompt Framework*
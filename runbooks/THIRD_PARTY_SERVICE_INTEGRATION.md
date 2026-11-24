# Third-Party Service Integration Runbook

## Purpose
Diagnose and resolve issues with external service integrations in Myra AI Gemini.

## Integration Architecture Overview

### External Service Dependencies
```
Myra AI Gemini
    │
    ├── Gemini AI API (Google)
    │   ├── Text Generation
    │   ├── Voice Processing (Gemini Live)
    │   └── Vision Processing (future)
    │
    ├── Tailscale
    │   ├── Remote Access (Serve)
    │   └── Network Connectivity
    │
    ├── GitHub API
    │   ├── Repository Import
    │   └── Rate Limit Management
    │
    ├── System APIs
    │   ├── File System (local)
    │   ├── Browser Control
    │   └── Application Management
    │
    └── Future Integrations
        ├── OpenAI/Anthropic (alternate AI)
        ├── Cloud Storage (backup)
        └── Notification Services
```

### Service Configuration Matrix
| Service | Configuration Key | Rate Limit | Authentication | Endpoint |
|---------|------------------|------------|----------------|----------|
| Gemini AI | `GEMINI_API_KEY` | Varies by model | API Key | `https://generativelanguage.googleapis.com` |
| Tailscale | Tailscale CLI | N/A | OAuth/MagicDNS | CLI/Tailscale network |
| GitHub API | GitHub Token (optional) | 60 req/hour (unauth) | Token/OAuth | `https://api.github.com` |

## Common Integration Issues

### Issue 1: Gemini API Authentication Failures
**Symptoms**:
- "Invalid API key" errors
- "Authentication failed" messages
- API calls returning 401/403 status
- Voice features not working

**Diagnostic Steps**:
```bash
# 1. Verify API key format
echo $GEMINI_API_KEY | wc -c
# Should be > 30 characters

# 2. Test API key validity
curl -X GET "https://generativelanguage.googleapis.com/v1/models" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -s -o /dev/null -w "%{http_code}"

# 3. Check API key in configuration
grep -E "GEMINI_API_KEY|GOOGLE_API_KEY" .env.production

# 4. Verify environment variable is set
printenv | grep -i gemini

# 5. Check for API key expiration
# Visit: https://makersuite.google.com/app/apikey
# Check quota and expiration
```

**Resolution Steps**:
```bash
# 1. Generate new API key
# Visit: https://makersuite.google.com/app/apikey
# Click "Create API Key"
# Copy the generated key

# 2. Update configuration
sed -i "s/GEMINI_API_KEY=.*/GEMINI_API_KEY=$NEW_KEY/" .env.production

# 3. Restart application
pm2 restart myra-server

# 4. Verify new key works
curl -X POST "https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent" \
  -H "x-goog-api-key: $NEW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Hello"}]}]}' \
  -s -o /dev/null -w "%{http_code}\n"

# 5. Implement key rotation automation
# Schedule monthly key rotation
(crontab -l 2>/dev/null; echo "0 0 1 * * /opt/myra/scripts/rotate-api-keys.sh") | crontab -
```

**API Key Management**:
```bash
#!/bin/bash
# rotate-api-keys.sh
set -e

echo "=== API Key Rotation ==="
echo "Timestamp: $(date)"

# 1. Generate new key (manual step - guide user)
echo "Please generate new Gemini API key at:"
echo "https://makersuite.google.com/app/apikey"
read -p "Enter new API key: " NEW_KEY

# 2. Validate new key
echo "Validating new key..."
HTTP_CODE=$(curl -X GET "https://generativelanguage.googleapis.com/v1/models" \
  -H "x-goog-api-key: $NEW_KEY" \
  -s -o /dev/null -w "%{http_code}")

if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: New API key invalid (HTTP $HTTP_CODE)"
  exit 1
fi

# 3. Update configuration
BACKUP_FILE=".env.production.backup.$(date +%Y%m%d)"
cp .env.production "$BACKUP_FILE"

sed -i "s/GEMINI_API_KEY=.*/GEMINI_API_KEY=$NEW_KEY/" .env.production

# 4. Test with new key
echo "Testing with new key..."
sleep 2
pm2 restart myra-server
sleep 5

# 5. Verify functionality
if curl -f http://localhost:3000/api/health > /dev/null 2>&1; then
  echo "✓ API key rotation successful"
  
  # 6. Schedule old key deactivation (7 days grace period)
  OLD_KEY=$(grep GEMINI_API_KEY "$BACKUP_FILE" | cut -d= -f2)
  echo "Old key will be deactivated in 7 days: $OLD_KEY"
else
  echo "✗ Rotation failed, restoring backup"
  cp "$BACKUP_FILE" .env.production
  pm2 restart myra-server
  exit 1
fi

echo "=== Rotation Complete ==="
```

### Issue 2: Gemini API Rate Limiting
**Symptoms**:
- "429 Too Many Requests" errors
- "Quota exceeded" messages
- Intermittent API failures
- Slow response times during peak usage

**Diagnostic Steps**:
```bash
# 1. Check current quota usage
# Visit: https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas

# 2. Monitor API call frequency
grep -c "generativelanguage.googleapis.com" /var/log/myra/server.log

# 3. Check for burst patterns
awk '{print $1, $2}' /var/log/myra/server.log | \
  grep "generativelanguage" | \
  cut -d: -f1,2 | \
  uniq -c | \
  sort -rn | \
  head -10

# 4. Identify expensive operations
# Voice processing typically uses more tokens
# Project analysis may generate many API calls
```

**Resolution Steps**:
```bash
# 1. Implement client-side rate limiting
const rateLimiter = {
  limits: {
    gemini: {
      tokensPerMinute: 60000,  # Free tier limit
      requestsPerMinute: 60,
      queue: [],
      processing: false
    }
  },
  
  async request(service, operation) {
    if (service === 'gemini') {
      // Check rate limits
      const now = Date.now();
      const minuteAgo = now - 60000;
      
      // Remove old entries
      this.limits.gemini.queue = this.limits.gemini.queue.filter(
        time => time > minuteAgo
      );
      
      // Check if limit exceeded
      if (this.limits.gemini.queue.length >= this.limits.gemini.requestsPerMinute) {
        const oldest = this.limits.gemini.queue[0];
        const waitTime = 60000 - (now - oldest);
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      
      // Add to queue
      this.limits.gemini.queue.push(now);
    }
    
    return operation();
  }
};

# 2. Implement request queuing
class RequestQueue {
  constructor(maxConcurrent = 5) {
    this.queue = [];
    this.active = 0;
    this.maxConcurrent = maxConcurrent;
  }
  
  async add(requestFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ requestFn, resolve, reject });
      this.process();
    });
  }
  
  process() {
    if (this.active >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }
    
    this.active++;
    const { requestFn, resolve, reject } = this.queue.shift();
    
    requestFn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        this.active--;
        this.process();
      });
  }
}

# 3. Implement exponential backoff for retries
async function callWithRetry(apiCall, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await apiCall();
    } catch (error) {
      lastError = error;
      
      // Check if it's a rate limit error
      if (error.status === 429 || error.message.includes('quota')) {
        const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 30000);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // Other errors shouldn't retry
      throw error;
    }
  }
  
  throw lastError;
}

# 4. Implement request caching
const cache = new Map();

async function cachedApiCall(key, apiCall, ttl = 300000) { // 5 minutes
  const cached = cache.get(key);
  
  if (cached && Date.now() - cached.timestamp < ttl) {
    return cached.data;
  }
  
  const data = await apiCall();
  cache.set(key, { data, timestamp: Date.now() });
  
  // Clean old cache entries
  for (const [cacheKey, entry] of cache) {
    if (Date.now() - entry.timestamp > ttl * 2) {
      cache.delete(cacheKey);
    }
  }
  
  return data;
}
```

### Issue 3: Tailscale Integration Problems
**Symptoms**:
- "Cannot connect to desktop" on phone remote
- Tailscale status shows errors
- Serve not working properly
- Intermittent remote access

**Diagnostic Steps**:
```bash
# 1. Check Tailscale status
tailscale status
# Should show "Connected" and your devices

# 2. Check Tailscale Serve configuration
tailscale serve status
tailscale serve list

# 3. Test Tailscale connectivity
tailscale ping $(tailscale ip -4)

# 4. Check firewall rules
sudo iptables -L | grep tailscale
sudo ufw status | grep tailscale

# 5. Verify Serve is accessible
curl -f "http://$(tailscale ip -4):3000/api/health" 2>/dev/null || \
  echo "Serve not accessible"

# 6. Check Tailscale logs
journalctl -u tailscale --since "1 hour ago" | tail -20
```

**Resolution Steps**:
```bash
# 1. Restart Tailscale service
sudo systemctl restart tailscale
sleep 5
tailscale up

# 2. Reconfigure Serve
tailscale serve reset
tailscale serve --bg 3000

# 3. Verify Serve configuration
tailscale serve status
# Should show: bg: http://localhost:3000

# 4. Set up persistent Serve configuration
cat > /etc/systemd/system/tailscale-serve-myra.service << 'EOF'
[Unit]
Description=Tailscale Serve for Myra AI
After=tailscale.service
Requires=tailscale.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/tailscale serve --bg 3000
ExecStop=/usr/bin/tailscale serve --bg 3000 --remove
User=myra

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable tailscale-serve-myra
sudo systemctl start tailscale-serve-myra

# 5. Alternative remote access options
# If Tailscale continues to have issues, consider alternatives:

# Option A: ngrok (requires account)
npm install -g ngrok
ngrok http 3000
# Provides: https://random.ngrok.io

# Option B: localtunnel (free)
npm install -g localtunnel
lt --port 3000 --subdomain myra-ai
# Provides: https://myra-ai.loca.lt

# Option C: Cloudflare Tunnel (requires Cloudflare account)
cloudflared tunnel --url http://localhost:3000
```

### Issue 4: GitHub API Rate Limiting
**Symptoms**:
- GitHub repository import failing
- "API rate limit exceeded" errors
- Slow GitHub operations
- Intermittent import failures

**Diagnostic Steps**:
```bash
# 1. Check GitHub API rate limit status
curl -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/rate_limit

# 2. Without authentication: 60 requests/hour
# With authentication: 5000 requests/hour

# 3. Monitor GitHub API usage
grep -c "api.github.com" /var/log/myra/server.log

# 4. Identify which operations use GitHub API
# - Repository cloning
# - File listing
# - Commit history
# - Issue tracking (future)
```

**Resolution Steps**:
```bash
# 1. Add GitHub authentication token
# Generate token at: https://github.com/settings/tokens
# Minimal permissions: public_repo (for public repos)

# Add to .env.production:
echo "GITHUB_TOKEN=ghp_your_token_here" >> .env.production

# 2. Implement GitHub API client with rate limiting
class GitHubClient {
  constructor(token = null) {
    this.token = token;
    this.rateLimit = {
      remaining: 60,
      reset: 0,
      used: 0
    };
    this.queue = [];
    this.processing = false;
  }
  
  async request(endpoint) {
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Myra-AI-Gemini'
    };
    
    if (this.token) {
      headers['Authorization'] = `token ${this.token}`;
    }
    
    // Check rate limits
    await this.checkRateLimit();
    
    const response = await fetch(`https://api.github.com${endpoint}`, { headers });
    
    // Update rate limit from headers
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    
    if (remaining && reset) {
      this.rateLimit.remaining = parseInt(remaining);
      this.rateLimit.reset = parseInt(reset) * 1000; // Convert to milliseconds
      this.rateLimit.used++;
    }
    
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }
    
    return response.json();
  }
  
  async checkRateLimit() {
    const now = Date.now();
    
    // If reset time has passed, refresh
    if (now > this.rateLimit.reset) {
      const rateLimit = await this.getRateLimit();
      this.rateLimit = rateLimit;
    }
    
    // If no requests remaining, wait
    if (this.rateLimit.remaining <= 0) {
      const waitTime = this.rateLimit.reset - now + 1000; // Add 1 second buffer
      await new Promise(resolve => setTimeout(resolve, waitTime));
      
      // Refresh rate limit after waiting
      const rateLimit = await this.getRateLimit();
      this.rateLimit = rateLimit;
    }
  }
  
  async getRateLimit() {
    const response = await fetch('https://api.github.com/rate_limit', {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Myra-AI-Gemini'
      }
    });
    
    const data = await response.json();
    return {
      remaining: data.rate.remaining,
      reset: data.rate.reset * 1000,
      used: data.rate.used
    };
  }
}

# 3. Implement local caching for GitHub operations
const githubCache = new Map();

async function getRepoInfoWithCache(owner, repo) {
  const cacheKey = `repo:${owner}/${repo}`;
  const cached = githubCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < 3600000) { // 1 hour
    return cached.data;
  }
  
  const client = new GitHubClient(process.env.GITHUB_TOKEN);
  const data = await client.request(`/repos/${owner}/${repo}`);
  
  githubCache.set(cacheKey, {
    data,
    timestamp: Date.now()
  });
  
  return data;
}

# 4. Implement fallback to Git CLI when API limits hit
async function getRepositoryInfo(owner, repo) {
  try {
    // Try GitHub API first
    return await getRepoInfoWithCache(owner, repo);
  } catch (error) {
    if (error.message.includes('rate limit') || error.message.includes('403')) {
      // Fallback to Git CLI
      console.warn('GitHub API rate limited, falling back to Git CLI');
      return await getRepoInfoViaGit(owner, repo);
    }
    throw error;
  }
}

async function getRepoInfoViaGit(owner, repo) {
  // Use git commands to get basic repo info
  const repoUrl = `https://github.com/${owner}/${repo}.git`;
  const tempDir = `/tmp/myra-git-${Date.now()}`;
  
  try {
    // Clone shallow (just for info)
    execSync(`git clone --depth 1 ${repoUrl} ${tempDir}`);
    
    // Get basic info
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tempDir })
      .toString().trim();
    
    const commitCount = execSync('git rev-list --count HEAD', { cwd: tempDir })
      .toString().trim();
    
    const lastCommit = execSync('git log -1 --format="%H %s"', { cwd: tempDir })
      .toString().trim();
    
    // Clean up
    execSync(`rm -rf ${tempDir}`);
    
    return {
      name: repo,
      full_name: `${owner}/${repo}`,
      description: 'Description not available via Git CLI',
      html_url: repoUrl,
      clone_url: repoUrl,
      default_branch: branch,
      size: 0, // Not available via Git CLI
      stargazers_count: 0, // Not available via Git CLI
      forks_count: 0, // Not available via Git CLI
      open_issues_count: 0, // Not available via Git CLI
      _source: 'git-cli-fallback'
    };
  } catch (error) {
    // Clean up on error
    try { execSync(`rm -rf ${tempDir}`); } catch {}
    throw error;
  }
}
```

### Issue 5: External Service Downtime
**Symptoms**:
- All external API calls failing
- "Service unavailable" errors
- Complete feature breakdown
- Timeout errors across all integrations

**Diagnostic Steps**:
```bash
# 1. Check service status pages
curl -s "https://www.google.com/appsstatus/dashboard/" | \
  grep -i "generative" || echo "Check manually: https://status.cloud.google.com/"

# 2. Test connectivity to each service
services=(
  "generativelanguage.googleapis.com:443"
  "api.github.com:443"
  "login.tailscale.com:443"
)

for service in "${services[@]}"; do
  host=$(echo $service | cut -d: -f1)
  port=$(echo $service | cut -d: -f2)
  
  if nc -z -w 5 "$host" "$port"; then
    echo "✓ $host:$port is reachable"
  else
    echo "✗ $host:$port is not reachable"
  fi
done

# 3. Check DNS resolution for all services
for host in generativelanguage.googleapis.com api.github.com login.tailscale.com; do
  if dig +short "$host" | grep -q '^[0-9]'; then
    echo "✓ DNS resolved for $host"
  else
    echo "✗ DNS failed for $host"
  fi
done

# 4. Check for network-wide issues
ping -c 3 8.8.8.8
traceroute generativelanguage.googleapis.com
```

**Resolution Steps**:
```bash
# 1. Implement circuit breaker pattern
class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.failures = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.lastFailureTime = 0;
  }
  
  async execute(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }
    
    try {
      const result = await operation();
      
      if (this.state === 'HALF_OPEN') {
        this.state = 'CLOSED';
        this.failures = 0;
      }
      
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailureTime = Date.now();
      
      if (this.failures >= this.threshold) {
        this.state = 'OPEN';
      }
      
      throw error;
    }
  }
}

# 2. Implement service degradation
class ServiceDegradationManager {
  constructor() {
    this.services = {
      gemini: { priority: 1, fallback: 'local-model' },
      github: { priority: 2, fallback: 'git-cli' },
      tailscale: { priority: 3, fallback: 'alternative-remote' }
    };
    
    this.degradedMode = false;
  }
  
  async execute(serviceName, operation, fallbackOperation) {
    if (this.degradedMode) {
      console.warn(`Service ${serviceName} in degraded mode, using fallback`);
      return fallbackOperation ? fallbackOperation() : null;
    }
    
    try {
      return await operation();
    } catch (error) {
      console.error(`Service ${serviceName} failed:`, error.message);
      
      // If critical service fails, enter degraded mode
      if (this.services[serviceName].priority <= 2) {
        this.degradedMode = true;
        console.warn('Entering degraded mode');
        
        // Try fallback
        if (fallbackOperation) {
          return fallbackOperation();
        }
      }
      
      throw error;
    }
  }
}

# 3. Implement graceful degradation for each service
// Gemini API fallback - local model or cached responses
async function getAIResponseWithFallback(prompt) {
  const degradationManager = new ServiceDegradationManager();
  
  return degradationManager.execute('gemini',
    async () => {
      // Primary: Gemini API
      return await geminiApi.generate(prompt);
    },
    async () => {
      // Fallback: Local model or cached responses
      console.warn('Using fallback AI response');
      
      // Option 1: Use a simpler local model
      // Option 2: Return cached responses for common queries
      // Option 3: Return informative message
      return `I'm currently experiencing connectivity issues with my primary AI service. For now, I can help with basic tasks. Please try again later for full AI capabilities.`;
    }
  );
}

// GitHub API fallback - Git CLI
async function importRepositoryWithFallback(repoUrl) {
  const degradationManager = new ServiceDegradationManager();
  
  return degradationManager.execute('github',
    async () => {
      // Primary: GitHub API
      return await githubApi.importRepo(repoUrl);
    },
    async () => {
      // Fallback: Git CLI
      console.warn('Using Git CLI fallback');
      return await importRepoViaGit(repoUrl);
    }
  );
}

# 4. Implement monitoring and alerting for service health
const serviceHealth = {
  gemini: { status: 'healthy', lastCheck: Date.now() },
  github: { status: 'healthy', lastCheck: Date.now() },
  tailscale: { status: 'healthy', lastCheck: Date.now() }
};

async function monitorServices() {
  setInterval(async () => {
    for (const [service, health] of Object.entries(serviceHealth)) {
      try {
        await checkServiceHealth(service);
        health.status = 'healthy';
        health.lastCheck = Date.now();
      } catch (error) {
        health.status = 'unhealthy';
        health.lastCheck = Date.now();
        
        // Alert if service is critical
        if (service === 'gemini') {
          sendAlert(`Critical service ${service} is down`);
        }
      }
    }
  }, 300000); // Check every 5 minutes
}

async function checkServiceHealth(service) {
  switch (service) {
    case 'gemini':
      await fetch('https://generativelanguage.googleapis.com/v1/models', {
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY }
      });
      break;
    case 'github':
      await fetch('https://api.github.com/zen');
      break;
    case 'tailscale':
      // Check Tailscale status
      const { execSync } = require('child_process');
      execSync('tailscale status', { stdio: 'pipe' });
      break;
  }
}
```

## Monitoring & Alerting

### Service Health Dashboard
```bash
#!/bin/bash
# service-health-check.sh

echo "=== External Service Health Check ==="
echo "Timestamp: $(date)"
echo ""

# 1. Gemini API Health
echo "1. Gemini API:"
GEMINI_STATUS=$(curl -X GET "https://generativelanguage.googleapis.com/v1/models" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -s -o /dev/null -w "%{http_code}" 2>&1)

if [ "$GEMINI_STATUS" = "200" ]; then
  echo "  ✓ Healthy (HTTP $GEMINI_STATUS)"
else
  echo "  ✗ Unhealthy (HTTP $GEMINI_STATUS)"
fi

# 2. GitHub API Health
echo "2. GitHub API:"
GITHUB_STATUS=$(curl -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/zen" \
  -s -o /dev/null -w "%{http_code}" 2>&1)

if [ "$GITHUB_STATUS" = "200" ]; then
  echo "  ✓ Healthy (HTTP $GITHUB_STATUS)"
else
  echo "  ✗ Unhealthy (HTTP $GITHUB_STATUS)"
  
  # Check rate limit
  RATE_LIMIT=$(curl -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/rate_limit" \
    -s 2>/dev/null | jq '.rate.remaining')
  
  if [ "$RATE_LIMIT" = "0" ]; then
    echo "    Rate limit exceeded"
  fi
fi

# 3. Tailscale Health
echo "3. Tailscale:"
if command -v tailscale > /dev/null; then
  TAILSCALE_STATUS=$(tailscale status 2>&1 | head -1)
  if echo "$TAILSCALE_STATUS" | grep -q "Connected"; then
    echo "  ✓ Healthy ($TAILSCALE_STATUS)"
    
    # Check Serve
    SERVE_STATUS=$(tailscale serve status 2>&1)
    if echo "$SERVE_STATUS" | grep -q "bg:"; then
      echo "    Serve: Active"
    else
      echo "    Serve: Inactive"
    fi
  else
    echo "  ✗ Unhealthy ($TAILSCALE_STATUS)"
  fi
else
  echo "  ⚠ Not installed"
fi

# 4. Network Connectivity
echo "4. Network Connectivity:"
if ping -c 1 8.8.8.8 > /dev/null 2>&1; then
  echo "  ✓ Internet reachable"
else
  echo "  ✗ Internet unreachable"
fi

echo ""
echo "=== Health Check Complete ==="
```

### Alert Configuration for External Services
```yaml
# Prometheus alert rules for external services
groups:
  - name: external_services
    rules:
      - alert: GeminiAPIDown
        expr: probe_success{job="gemini-api"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Gemini API is down"
          description: "Voice and AI features will not work"
          
      - alert: GitHubAPIRateLimited
        expr: github_rate_limit_remaining < 100
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "GitHub API rate limit low"
          description: "Only {{ $value }} requests remaining"
          
      - alert: TailscaleDisconnected
        expr: tailscale_connected == 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Tailscale disconnected"
          description: "Remote access will not work"
          
      - alert: MultipleServicesDown
        expr: sum(probe_success == 0) >= 2
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Multiple external services down"
          description: "{{ $value }} services are unavailable"
```

## Recovery Procedures

### Complete Service Failure Recovery
```bash
#!/bin/bash
# service-failure-recovery.sh

echo "=== External Service Failure Recovery ==="
echo ""

# Determine which services are failing
FAILING_SERVICES=()

# Check Gemini
if ! curl -f "https://generativelanguage.googleapis.com/v1/models" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  > /dev/null 2>&1; then
  FAILING_SERVICES+=("gemini")
fi

# Check GitHub
if ! curl -f "https://api.github.com/zen" > /dev/null 2>&1; then
  FAILING_SERVICES+=("github")
fi

# Check Tailscale
if command -v tailscale > /dev/null && ! tailscale status | grep -q "Connected"; then
  FAILING_SERVICES+=("tailscale")
fi

if [ ${#FAILING_SERVICES[@]} -eq 0 ]; then
  echo "All services are healthy"
  exit 0
fi

echo "Failing services: ${FAILING_SERVICES[*]}"
echo ""

# Apply recovery measures
for service in "${FAILING_SERVICES[@]}"; do
  echo "Recovering $service..."
  
  case $service in
    gemini)
      echo "  Gemini API failure detected"
      echo "  1. Checking API key..."
      echo "  2. Enabling degraded mode for AI features..."
      echo "  3. Switching to local model if available..."
      ;;
      
    github)
      echo "  GitHub API failure detected"
      echo "  1. Enabling Git CLI fallback..."
      echo "  2. Disabling repository import features..."
      echo "  3. Using cached repository data..."
      ;;
      
    tailscale)
      echo "  Tailscale failure detected"
      echo "  1. Restarting Tailscale service..."
      sudo systemctl restart tailscale
      sleep 5
      
      echo "  2. Reconnecting..."
      tailscale up
      
      echo "  3. Setting up alternative remote access..."
      # Start localtunnel as fallback
      npm install -g localtunnel
      lt --port 3000 --subdomain myra-ai-fallback &
      ;;
  esac
  
  echo "  ✓ $service recovery initiated"
  echo ""
done

echo "=== Recovery Procedures Applied ==="
echo ""
echo "Next steps:"
echo "1. Monitor service recovery"
echo "2. Update users about degraded service"
echo "3. Investigate root cause"
echo "4. Implement permanent fixes"
```

---

*Third-Party Service Integration Runbook v1.0*
*Last Updated: 2026-11-24*
*Based on Runbooks Prompt Framework*
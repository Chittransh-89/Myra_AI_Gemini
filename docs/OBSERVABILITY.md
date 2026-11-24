# Myra AI Gemini - Observability Framework

## Observability Philosophy
**Comprehensive, actionable, and privacy-preserving** - We monitor everything necessary to understand system behavior while respecting user privacy and data boundaries.

## Three Pillars of Observability

### 1. Metrics
**What**: Quantitative measurements of system behavior  
**Why**: Understand performance, capacity, and trends  
**How**: Time-series data with aggregation

### 2. Logs
**What**: Structured records of discrete events  
**Why**: Debug issues and understand user journeys  
**How**: JSON-structured logs with context

### 3. Traces
**What**: End-to-end request flow tracking  
**Why**: Understand latency and dependency relationships  
**How**: Distributed tracing with context propagation

## Monitoring Architecture

### Data Collection Pipeline
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Instrument    │    │    Collector    │    │     Storage     │
│   Applications  │───▶│    & Buffer     │───▶│   & Analytics   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│      Agents     │    │   Processors    │    │   Dashboards    │
│  (Client-side)  │    │  & Enrichers    │    │   & Alerts      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Privacy Considerations
```typescript
// Never collect PII or sensitive data
const SENSITIVE_FIELDS = [
  'apiKey', 'token', 'password', 'secret',
  'privateKey', 'credential', 'authorization',
  'email', 'phone', 'address', 'creditCard'
]

// Anonymize user identifiers
function anonymizeUserId(userId: string): string {
  return crypto.createHash('sha256').update(userId).digest('hex').substring(0, 16)
}

// Strip sensitive data from logs
function sanitizeLogData(data: any): any {
  const sanitized = { ...data }
  for (const key of Object.keys(sanitized)) {
    const lowerKey = key.toLowerCase()
    if (SENSITIVE_FIELDS.some(sf => lowerKey.includes(sf))) {
      sanitized[key] = '[REDACTED]'
    }
  }
  return sanitized
}
```

## Metrics System

### Core Metrics Categories

#### 1. System Metrics
```typescript
interface SystemMetrics {
  // Resource usage
  cpu: {
    usagePercent: number
    userPercent: number
    systemPercent: number
  }
  memory: {
    usedBytes: number
    totalBytes: number
    heapUsed: number
    heapTotal: number
  }
  disk: {
    usedBytes: number
    totalBytes: number
    iops: number
  }
  network: {
    bytesIn: number
    bytesOut: number
    connections: number
  }
}
```

#### 2. Application Metrics
```typescript
interface ApplicationMetrics {
  // Request metrics
  http: {
    requestsTotal: Counter
    requestsPerSecond: Gauge
    requestDuration: Histogram
    errorsTotal: Counter
    errorRate: Gauge
  }
  
  // WebSocket metrics
  websocket: {
    connectionsActive: Gauge
    connectionsTotal: Counter
    messagesPerSecond: Gauge
    pingLatency: Histogram
  }
  
  // Business metrics
  business: {
    activeUsers: Gauge
    sessionsTotal: Counter
    featuresUsed: Counter
    conversionRate: Gauge
  }
}
```

#### 3. Feature Metrics
```typescript
interface FeatureMetrics {
  // Voice features
  voice: {
    sessionsTotal: Counter
    avgResponseTime: Histogram
    transcriptionAccuracy: Gauge
    interruptionRate: Gauge
  }
  
  // Intelligence features
  intelligence: {
    projectsAnalyzed: Counter
    avgAnalysisTime: Histogram
    interviewSessions: Counter
    avgInterviewDuration: Histogram
  }
  
  // Remote features
  remote: {
    devicesPaired: Counter
    audioStreamsActive: Gauge
    pairingSuccessRate: Gauge
    reconnectRate: Gauge
  }
}
```

### Metric Collection Implementation
```typescript
// Metrics registry
class MetricsRegistry {
  private metrics = new Map<string, Metric>()
  
  // Counter: monotonically increasing value
  createCounter(name: string, help: string, labels: string[] = []): Counter {
    const counter = new Counter(name, help, labels)
    this.metrics.set(name, counter)
    return counter
  }
  
  // Gauge: value that can go up or down
  createGauge(name: string, help: string, labels: string[] = []): Gauge {
    const gauge = new Gauge(name, help, labels)
    this.metrics.set(name, gauge)
    return gauge
  }
  
  // Histogram: samples observations into buckets
  createHistogram(name: string, help: string, buckets: number[]): Histogram {
    const histogram = new Histogram(name, help, buckets)
    this.metrics.set(name, histogram)
    return histogram
  }
  
  // Collect all metrics
  collect(): PrometheusMetric[] {
    return Array.from(this.metrics.values()).flatMap(m => m.collect())
  }
}

// Usage example
const metrics = new MetricsRegistry()

const requestDuration = metrics.createHistogram(
  'http_request_duration_seconds',
  'HTTP request duration in seconds',
  [0.1, 0.5, 1, 2, 5, 10]
)

const activeUsers = metrics.createGauge(
  'active_users_total',
  'Number of currently active users'
)

// Instrument middleware
function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now()
  
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000
    requestDuration.observe(duration, {
      method: req.method,
      path: req.path,
      status: res.statusCode.toString()
    })
  })
  
  next()
}
```

### Prometheus Exposition
```typescript
// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', 'text/plain')
  
  // Collect metrics from all registries
  const metrics = await collectAllMetrics()
  
  // Format in Prometheus text format
  const formatted = formatPrometheusMetrics(metrics)
  
  res.send(formatted)
})

// Example Prometheus output
/*
# HELP http_request_duration_seconds HTTP request duration in seconds
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.1",method="GET",path="/api/health",status="200"} 42
http_request_duration_seconds_bucket{le="0.5",method="GET",path="/api/health",status="200"} 87
http_request_duration_seconds_sum{method="GET",path="/api/health",status="200"} 12.345
http_request_duration_seconds_count{method="GET",path="/api/health",status="200"} 100

# HELP active_users_total Number of currently active users
# TYPE active_users_total gauge
active_users_total 15
*/
```

## Logging System

### Structured Log Format
```typescript
interface StructuredLog {
  // Core fields
  timestamp: string          // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  message: string           // Human-readable message
  
  // Context fields
  service: string           // Service name (e.g., 'myra-server')
  component: string         // Component name (e.g., 'intelligence')
  environment: string       // 'development' | 'staging' | 'production'
  
  // Request context
  requestId?: string        // Correlation ID
  userId?: string           // Anonymized user ID
  sessionId?: string        // Session identifier
  clientIp?: string         // Anonymized IP
  
  // Error context
  error?: {
    name: string
    message: string
    stack?: string
    code?: string
  }
  
  // Custom fields
  [key: string]: any        // Additional structured data
}
```

### Logging Configuration
```typescript
// Configure logging levels by environment
const LOG_LEVELS = {
  development: 'debug',
  staging: 'info',
  production: 'warn'
}

// Create logger instance
class Logger {
  constructor(
    private service: string,
    private environment: string
  ) {}
  
  debug(message: string, context: Record<string, any> = {}) {
    this.log('debug', message, context)
  }
  
  info(message: string, context: Record<string, any> = {}) {
    this.log('info', message, context)
  }
  
  warn(message: string, context: Record<string, any> = {}) {
    this.log('warn', message, context)
  }
  
  error(message: string, error?: Error, context: Record<string, any> = {}) {
    const logContext = { ...context }
    if (error) {
      logContext.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...(error instanceof ApplicationError && { code: error.code })
      }
    }
    this.log('error', message, logContext)
  }
  
  private log(level: LogLevel, message: string, context: Record<string, any>) {
    const log: StructuredLog = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service: this.service,
      component: context.component || 'unknown',
      environment: this.environment,
      ...sanitizeLogData(context)
    }
    
    // Add request context if available
    const requestContext = getRequestContext()
    if (requestContext) {
      log.requestId = requestContext.requestId
      log.userId = requestContext.userId ? anonymizeUserId(requestContext.userId) : undefined
      log.sessionId = requestContext.sessionId
      log.clientIp = requestContext.clientIp ? anonymizeIp(requestContext.clientIp) : undefined
    }
    
    // Output to appropriate destination
    this.output(log)
  }
  
  private output(log: StructuredLog) {
    // Development: human-readable console output
    if (this.environment === 'development') {
      console.log(formatConsoleLog(log))
    }
    // Production: JSON to stdout (for log collection)
    else {
      console.log(JSON.stringify(log))
    }
  }
}
```

### Request Context Propagation
```typescript
// AsyncLocalStorage for request context
const requestContextStorage = new AsyncLocalStorage<RequestContext>()

interface RequestContext {
  requestId: string
  userId?: string
  sessionId?: string
  clientIp?: string
  startTime: number
}

// Middleware to set request context
function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const context: RequestContext = {
    requestId: req.headers['x-request-id']?.toString() || generateRequestId(),
    userId: req.user?.id,
    sessionId: req.session?.id,
    clientIp: req.ip,
    startTime: Date.now()
  }
  
  requestContextStorage.run(context, () => {
    // Add request ID to response headers
    res.setHeader('x-request-id', context.requestId)
    
    // Log request start
    logger.info('Request started', {
      method: req.method,
      path: req.path,
      userAgent: req.get('user-agent')
    })
    
    next()
  })
}

// Helper to get current request context
function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore()
}

// Usage in application code
async function analyzeProject(projectId: string) {
  const context = getRequestContext()
  logger.info('Starting project analysis', {
    projectId,
    requestId: context?.requestId
  })
  
  // ... analysis logic
}
```

## Distributed Tracing

### Trace Context Propagation
```typescript
// W3C Trace Context format
interface TraceContext {
  traceId: string      // 32 hex characters
  parentId?: string    // 16 hex characters
  sampled: boolean     // Whether to sample this trace
  flags: number        // Trace flags
}

// Extract trace context from headers
function extractTraceContext(req: Request): TraceContext {
  const traceparent = req.headers.traceparent as string
  const tracestate = req.headers.tracestate as string
  
  if (traceparent) {
    // Parse W3C traceparent header
    const [, version, traceId, parentId, flags] = traceparent.match(/^(\d{2})-([a-f0-9]{32})-([a-f0-9]{16})-(\d{2})$/) || []
    
    if (version === '00' && traceId && flags) {
      return {
        traceId,
        parentId,
        sampled: (parseInt(flags, 16) & 0x01) === 0x01,
        flags: parseInt(flags, 16)
      }
    }
  }
  
  // Create new trace context
  return {
    traceId: generateTraceId(),
    sampled: shouldSample(),
    flags: 0x01 // sampled flag
  }
}

// Inject trace context into headers
function injectTraceContext(context: TraceContext): Record<string, string> {
  const flags = context.sampled ? '01' : '00'
  const traceparent = `00-${context.traceId}-${context.parentId || '0000000000000000'}-${flags}`
  
  return {
    traceparent,
    tracestate: '' // Optional: vendor-specific data
  }
}
```

### Span Instrumentation
```typescript
// Span represents a unit of work
class Span {
  constructor(
    public traceId: string,
    public spanId: string,
    public parentId?: string,
    public name: string,
    public startTime: number = Date.now()
  ) {}
  
  // End the span
  end(endTime: number = Date.now()) {
    const duration = endTime - this.startTime
    
    // Export span data
    spanExporter.export({
      traceId: this.traceId,
      spanId: this.spanId,
      parentId: this.parentId,
      name: this.name,
      startTime: this.startTime,
      endTime,
      duration,
      attributes: this.attributes,
      events: this.events,
      status: this.status
    })
  }
  
  // Add attributes (key-value pairs)
  setAttribute(key: string, value: any) {
    this.attributes[key] = value
  }
  
  // Add events (timed annotations)
  addEvent(name: string, attributes: Record<string, any> = {}) {
    this.events.push({
      name,
      time: Date.now(),
      attributes
    })
  }
  
  // Set status (OK, ERROR, etc.)
  setStatus(code: SpanStatusCode, message?: string) {
    this.status = { code, message }
  }
}

// Tracer manages spans
class Tracer {
  startSpan(name: string, parentContext?: TraceContext): Span {
    const context = parentContext || {
      traceId: generateTraceId(),
      sampled: shouldSample(),
      flags: 0x01
    }
    
    const spanId = generateSpanId()
    
    return new Span(
      context.traceId,
      spanId,
      context.parentId,
      name
    )
  }
  
  // Create child span
  startChildSpan(parent: Span, name: string): Span {
    return new Span(
      parent.traceId,
      generateSpanId(),
      parent.spanId,
      name
    )
  }
}

// Usage example
async function processInterviewAnswer(answer: string) {
  const tracer = new Tracer()
  const span = tracer.startSpan('processInterviewAnswer')
  
  try {
    span.setAttribute('answer.length', answer.length)
    span.addEvent('start_processing')
    
    // Process the answer
    const result = await analyzeAnswer(answer)
    
    span.addEvent('processing_complete')
    span.setStatus({ code: SpanStatusCode.OK })
    
    return result
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message
    })
    span.setAttribute('error', true)
    throw error
  } finally {
    span.end()
  }
}
```

## Alerting System

### Alert Criteria
```typescript
interface AlertRule {
  id: string
  name: string
  description: string
  severity: 'info' | 'warning' | 'error' | 'critical'
  
  // Condition
  condition: {
    metric: string
    operator: '>' | '<' | '=' | '!=' | '>=' | '<='
    threshold: number
    duration: string  // e.g., '5m', '1h'
    aggregation: 'avg' | 'sum' | 'min' | 'max' | 'count'
  }
  
  // Notification
  notification: {
    channels: Array<'email' | 'slack' | 'pagerduty'>
    message: string
    runbookUrl?: string
  }
  
  // Suppression
  suppression?: {
    repeatInterval?: string  // e.g., '1h'
    maxAlerts?: number
  }
}
```

### Critical Alerts
```typescript
const CRITICAL_ALERTS: AlertRule[] = [
  {
    id: 'high-error-rate',
    name: 'High Error Rate',
    description: 'Error rate exceeds 5% for more than 5 minutes',
    severity: 'critical',
    condition: {
      metric: 'http_errors_total',
      operator: '>',
      threshold: 0.05, // 5%
      duration: '5m',
      aggregation: 'avg'
    },
    notification: {
      channels: ['slack', 'pagerduty'],
      message: 'High error rate detected. Check application logs.',
      runbookUrl: 'https://docs.example.com/runbooks/high-error-rate'
    }
  },
  {
    id: 'service-down',
    name: 'Service Unavailable',
    description: 'Service health check failing for more than 1 minute',
    severity: 'critical',
    condition: {
      metric: 'health_check_failures',
      operator: '>',
      threshold: 0,
      duration: '1m',
      aggregation: 'sum'
    },
    notification: {
      channels: ['pagerduty'],
      message: 'Service is down. Immediate attention required.',
      runbookUrl: 'https://docs.example.com/runbooks/service-down'
    }
  },
  {
    id: 'high-latency',
    name: 'High Response Latency',
    description: '95th percentile response time exceeds 2 seconds',
    severity: 'warning',
    condition: {
      metric: 'http_request_duration_seconds',
      operator: '>',
      threshold: 2,
      duration: '10m',
      aggregation: 'p95'
    },
    notification: {
      channels: ['slack'],
      message: 'High response latency detected.',
      runbookUrl: 'https://docs.example.com/runbooks/high-latency'
    }
  }
]
```

### Alert Manager
```typescript
class AlertManager {
  private rules: AlertRule[] = []
  private activeAlerts = new Map<string, ActiveAlert>()
  
  // Evaluate all rules
  async evaluateRules(metrics: MetricData[]): Promise<Alert[]> {
    const alerts: Alert[] = []
    
    for (const rule of this.rules) {
      const isFiring = await this.evaluateRule(rule, metrics)
      
      if (isFiring) {
        const alert = this.createAlert(rule)
        
        // Check if already active
        const existingAlert = this.activeAlerts.get(rule.id)
        if (!existingAlert || shouldNotifyAgain(existingAlert)) {
          alerts.push(alert)
          this.activeAlerts.set(rule.id, {
            ...alert,
            firedAt: Date.now(),
            notificationCount: (existingAlert?.notificationCount || 0) + 1
          })
        }
      } else {
        // Rule not firing, clear active alert
        this.activeAlerts.delete(rule.id)
      }
    }
    
    return alerts
  }
  
  private async evaluateRule(rule: AlertRule, metrics: MetricData[]): Promise<boolean> {
    // Get relevant metric data
    const metricData = metrics.find(m => m.name === rule.condition.metric)
    if (!metricData) return false
    
    // Apply aggregation
    const aggregated = this.aggregateMetric(metricData, rule.condition)
    
    // Apply operator
    switch (rule.condition.operator) {
      case '>': return aggregated > rule.condition.threshold
      case '<': return aggregated < rule.condition.threshold
      case '=': return aggregated === rule.condition.threshold
      case '!=': return aggregated !== rule.condition.threshold
      case '>=': return aggregated >= rule.condition.threshold
      case '<=': return aggregated <= rule.condition.threshold
      default: return false
    }
  }
  
  private createAlert(rule: AlertRule): Alert {
    return {
      id: `${rule.id}-${Date.now()}`,
      ruleId: rule.id,
      name: rule.name,
      description: rule.description,
      severity: rule.severity,
      firedAt: new Date().toISOString(),
      labels: {
        service: 'myra-server',
        environment: process.env.NODE_ENV || 'development'
      },
      annotations: {
        message: rule.notification.message,
        runbookUrl: rule.notification.runbookUrl
      }
    }
  }
}
```

## Dashboard & Visualization

### Key Dashboards

#### 1. System Health Dashboard
```
┌─────────────────────────────────────────────────────────────┐
│                     SYSTEM HEALTH                           │
├─────────────────────────────────────────────────────────────┤
│ CPU:  ███░░░░░ 32%        Memory: ██████░░░ 65%           │
│ Disk: ████████░░ 80%      Network: ████░░░░░ 45%          │
└─────────────────────────────────────────────────────────────┘
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   REQUEST RATE  │ │   ERROR RATE    │ │   LATENCY P95   │
│   1,234 req/s   │ │     2.3%       │ │     1.2s       │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

#### 2. Business Metrics Dashboard
```
┌─────────────────────────────────────────────────────────────┐
│                     BUSINESS METRICS                        │
├─────────────────────────────────────────────────────────────┤
│ Active Users: 1,234    Sessions: 5,678    Features: 89,012 │
└─────────────────────────────────────────────────────────────┘
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  VOICE USAGE    │ │  INTELLIGENCE   │ │   REMOTE PAIRS  │
│   567 sessions  │ │  89 projects    │ │     123 pairs   │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

#### 3. Error Analysis Dashboard
```
┌─────────────────────────────────────────────────────────────┐
│                     ERROR ANALYSIS                          │
├─────────────────────────────────────────────────────────────┤
│ Total Errors: 1,234   Unique Errors: 45   Affected: 123    │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│                    TOP ERRORS (LAST 24H)                   │
│ 1. NetworkError (234) - 18.9%                              │
│ 2. ValidationError (189) - 15.3%                           │
│ 3. AuthenticationError (156) - 12.6%                       │
│ 4. ExternalServiceError (123) - 9.9%                       │
│ 5. RateLimitError (98) - 7.9%                              │
└─────────────────────────────────────────────────────────────┘
```

### Grafana Configuration
```yaml
# dashboard.yaml
apiVersion: 1

providers:
  - name: 'Myra Dashboards'
    folder: 'Myra AI'
    type: 'file'
    options:
      path: '/etc/grafana/dashboards'
      
# Panel definitions
dashboards:
  - name: 'System Overview'
    panels:
      - title: 'CPU Usage'
        type: 'graph'
        targets:
          - expr: 'rate(process_cpu_seconds_total[5m]) * 100'
            legendFormat: '{{instance}}'
            
      - title: 'Memory Usage'
        type: 'graph'
        targets:
          - expr: 'process_resident_memory_bytes'
            legendFormat: 'Memory'
            
      - title: 'HTTP Requests'
        type: 'stat'
        targets:
          - expr: 'rate(http_requests_total[5m])'
            legendFormat: 'Requests/s'
```

## Performance Monitoring

### Key Performance Indicators (KPIs)

#### 1. Voice System KPIs
```typescript
interface VoiceKPIs {
  // Latency
  transcriptionLatencyP50: number    // 50th percentile
  transcriptionLatencyP95: number    // 95th percentile
  transcriptionLatencyP99: number    // 99th percentile
  
  // Accuracy
  wordErrorRate: number              // WER (0-1, lower is better)
  sentenceAccuracy: number           // % of sentences correctly transcribed
  
  // Reliability
  audioDropRate: number              // % of audio chunks dropped
  connectionStability: number        // % of stable connections
}
```

#### 2. Intelligence System KPIs
```typescript
interface IntelligenceKPIs {
  // Performance
  analysisTimeP95: number            // 95th percentile analysis time
  importTimeP95: number              // 95th percentile import time
  memoryUsagePerProject: number      // Average memory per project
  
  // Quality
  knowledgeAccuracy: number          // % of correct knowledge assertions
  evidenceCompleteness: number       // % of claims with evidence
  reportUsefulness: number           // User rating (1-5)
}
```

#### 3. Remote System KPIs
```typescript
interface RemoteKPIs {
  // Connectivity
  pairingSuccessRate: number         // % of successful pairings
  connectionLatencyP95: number       // 95th percentile latency
  reconnectSuccessRate: number       // % of successful reconnects
  
  // Audio Quality
  audioJitter: number                // Jitter in milliseconds
  packetLossRate: number             // % of packets lost
  audioQualityScore: number          // MOS (1-5)
}
```

### Performance Budgets
```typescript
const PERFORMANCE_BUDGETS = {
  // Voice system
  voice: {
    transcriptionLatencyP95: 2000,   // 2 seconds max
    wordErrorRate: 0.1,              // 10% WER max
    audioDropRate: 0.01              // 1% drop rate max
  },
  
  // Intelligence system
  intelligence: {
    analysisTimeP95: 30000,          // 30 seconds max
    importTimeP95: 60000,            // 1 minute max
    memoryUsagePerProject: 100 * 1024 * 1024  // 100MB max
  },
  
  // Remote system
  remote: {
    pairingSuccessRate: 0.95,        // 95% success min
    connectionLatencyP95: 1000,      // 1 second max
    audioQualityScore: 3.5           // MOS 3.5 min
  },
  
  // General
  general: {
    httpResponseTimeP95: 5000,       // 5 seconds max
    startupTime: 10000,              // 10 seconds max
    memoryUsage: 500 * 1024 * 1024   // 500MB max
  }
}
```

## Security Monitoring

### Security Events
```typescript
interface SecurityEvent {
  timestamp: string
  type: SecurityEventType
  severity: 'info' | 'warning' | 'error' | 'critical'
  source: string
  details: Record<string, any>
  userId?: string  // Anonymized
  sessionId?: string
}

type SecurityEventType =
  | 'authentication.success'
  | 'authentication.failure'
  | 'authentication.brute_force'
  | 'authorization.granted'
  | 'authorization.denied'
  | 'rate_limit.triggered'
  | 'input_validation.failed'
  | 'security_control.bypassed'
  | 'data_exfiltration.attempted'
  | 'system.compromise.indicator'
```

### Security Monitoring Rules
```typescript
const SECURITY_MONITORING_RULES = [
  {
    name: 'Brute Force Detection',
    description: 'Multiple authentication failures from same source',
    condition: (events: SecurityEvent[]) => {
      const failures = events.filter(e => 
        e.type === 'authentication.failure'
      )
      
      // More than 5 failures in 5 minutes
      const recentFailures = failures.filter(f => 
        Date.now() - new Date(f.timestamp).getTime() < 5 * 60 * 1000
      )
      
      return recentFailures.length > 5
    },
    action: 'block_source'
  },
  {
    name: 'Suspicious File Access',
    description: 'Attempt to access sensitive files',
    condition: (events: SecurityEvent[]) => {
      return events.some(e => 
        e.type === 'authorization.denied' &&
        e.details?.reason === 'sensitivePath'
      )
    },
    action: 'alert_security'
  },
  {
    name: 'Rate Limit Evasion',
    description: 'Attempts to bypass rate limiting',
    condition: (events: SecurityEvent[]) => {
      const rateLimitEvents = events.filter(e => 
        e.type === 'rate_limit.triggered'
      )
      
      // Multiple rate limit triggers from same user
      const byUser = groupBy(rateLimitEvents, 'userId')
      return Object.values(byUser).some(events => events.length > 3)
    },
    action: 'increase_rate_limit'
  }
]
```

## Cost Monitoring

### Resource Cost Tracking
```typescript
interface CostMetrics {
  // AI API costs
  aiApi: {
    tokensUsed: number
    requests: number
    estimatedCost: number
    costPerRequest: number
  }
  
  // Infrastructure costs
  infrastructure: {
    computeHours: number
    storageGb: number
    bandwidthGb: number
    estimatedCost: number
  }
  
  // Total
  total: {
    estimatedCost: number
    costPerUser: number
    costPerSession: number
  }
}
```

### Cost Optimization Alerts
```typescript
const COST_ALERTS = [
  {
    name: 'High AI API Usage',
    description: 'AI API usage exceeds budget',
    condition: (costs: CostMetrics) => {
      return costs.aiApi.estimatedCost > COST_BUDGETS.aiApi.monthly
    },
    action: 'review_ai_usage'
  },
  {
    name: 'Inefficient Resource Usage',
    description: 'High cost per user',
    condition: (costs: CostMetrics) => {
      return costs.total.costPerUser > COST_BUDGETS.costPerUser.max
    },
    action: 'optimize_resources'
  },
  {
    name: 'Storage Cost Spike',
    description: 'Storage usage increased significantly',
    condition: (costs: CostMetrics, previous: CostMetrics) => {
      const increase = costs.infrastructure.storageGb / previous.infrastructure.storageGb
      return increase > 1.5  // 50% increase
    },
    action: 'review_storage'
  }
]
```

## Data Retention Policies

### Log Retention
```typescript
const LOG_RETENTION = {
  // Development: keep everything
  development: {
    debug: '30d',
    info: '90d',
    warn: '180d',
    error: '1y',
    fatal: 'forever'
  },
  
  // Production: aggressive retention
  production: {
    debug: '7d',
    info: '30d',
    warn: '90d',
    error: '180d',
    fatal: '1y'
  }
}
```

### Metric Retention
```typescript
const METRIC_RETENTION = {
  // High resolution for recent data
  '5m': '24h',     // 5-minute resolution for 24 hours
  '1h': '7d',      // 1-hour resolution for 7 days
  '1d': '30d',     // 1-day resolution for 30 days
  '1w': '1y'       // 1-week resolution for 1 year
}
```

### Trace Retention
```typescript
const TRACE_RETENTION = {
  // Keep error traces longer
  error: '30d',
  // Sample successful traces
  success: '7d'
}
```

## Implementation Roadmap

### Phase 1: Basic Observability (v1.0)
- ✅ Structured logging
- ✅ Basic metrics (request rate, error rate)
- ✅ Health checks
- ✅ Error tracking

### Phase 2: Advanced Observability (v1.1)
- 🔄 Distributed tracing
- 🔄 Performance monitoring
- 🔄 Business metrics
- 🔄 Alerting system

### Phase 3: Predictive Observability (v1.2)
- 🔄 Anomaly detection
- 🔄 Cost monitoring
- 🔄 Security monitoring
- 🔄 Automated remediation

### Phase 4: Intelligent Observability (v1.3)
- 🔄 AI-powered insights
- 🔄 Predictive scaling
- 🔄 Self-healing systems
- 🔄 Automated optimization

---

*Observability Framework Version: 1.0*  
*Last Updated: 2026-11-24*  
*Based on: THE VIBE CODING BLUEPRINT - Observability & Monitoring Section*
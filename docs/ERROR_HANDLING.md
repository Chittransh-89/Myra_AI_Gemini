# Myra AI Gemini - Error Handling Framework

## Error Handling Philosophy
**Graceful, informative, and recoverable** - Errors are expected and should be handled in a way that maintains user trust and system stability.

## Error Classification

### Severity Levels
```typescript
enum ErrorSeverity {
  INFO = 'info',       // User can continue, no action needed
  WARNING = 'warning', // User should be aware, may affect experience
  ERROR = 'error',     // Feature unavailable, user action may help
  CRITICAL = 'critical' // System unstable, immediate attention needed
}
```

### Error Categories
```typescript
enum ErrorCategory {
  // User errors (4xx)
  VALIDATION = 'validation',      // Invalid input/data
  AUTHENTICATION = 'auth',        // Authentication failures
  AUTHORIZATION = 'authorization', // Permission issues
  NOT_FOUND = 'not_found',       // Resources not found
  CONFLICT = 'conflict',         // State conflicts
  
  // System errors (5xx)
  NETWORK = 'network',           // Network/connection issues
  EXTERNAL_SERVICE = 'external', // Third-party service failures
  DATABASE = 'database',         // Storage/IO errors
  APPLICATION = 'application',   // Application logic errors
  CONFIGURATION = 'config',      // Configuration issues
  
  // Business errors
  BUSINESS_RULE = 'business',    // Business rule violations
  RATE_LIMIT = 'rate_limit',     // Rate limiting
  QUOTA = 'quota',               // Usage quota exceeded
  MAINTENANCE = 'maintenance'    // System maintenance
}
```

## Error Response Structure

### HTTP Error Responses
```typescript
interface ErrorResponse {
  ok: false
  error: string                    // Machine-readable error code
  message?: string                 // Human-readable message (optional)
  details?: Record<string, any>    // Additional error details
  retryAfterMs?: number           // When to retry (for rate limits)
  suggestion?: string             // Suggested action
  traceId?: string               // Correlation ID for debugging
}
```

### WebSocket Error Frames
```typescript
interface WebSocketError {
  type: 'error'
  code: string                    // Error code
  message: string                // Human-readable message
  details?: Record<string, any>  // Additional details
  recoverable?: boolean          // Whether client can recover
}
```

## Common Error Codes

### Authentication & Authorization
| Code | HTTP Status | Description | User Action |
|------|-------------|-------------|-------------|
| `invalidToken` | 401 | Invalid or expired authentication token | Reauthenticate |
| `missingToken` | 401 | No authentication token provided | Provide credentials |
| `insufficientPermissions` | 403 | User lacks required permissions | Contact administrator |
| `sessionExpired` | 401 | User session has expired | Re-login |
| `pairingRequired` | 403 | Device pairing required | Pair device first |

### Validation Errors
| Code | HTTP Status | Description | User Action |
|------|-------------|-------------|-------------|
| `invalidInput` | 400 | General input validation failure | Check input format |
| `missingField` | 400 | Required field missing | Provide all required fields |
| `invalidFormat` | 400 | Data format incorrect | Use correct format |
| `outOfRange` | 400 | Value outside valid range | Use value within range |
| `invalidPath` | 400 | Invalid file path | Check path syntax |

### Resource Errors
| Code | HTTP Status | Description | User Action |
|------|-------------|-------------|-------------|
| `notFound` | 404 | Resource not found | Check resource exists |
| `alreadyExists` | 409 | Resource already exists | Use different identifier |
| `conflict` | 409 | Resource state conflict | Resolve conflict |
| `locked` | 423 | Resource locked | Wait or unlock |

### Rate Limiting
| Code | HTTP Status | Description | User Action |
|------|-------------|-------------|-------------|
| `rateLimited` | 429 | Too many requests | Wait before retrying |
| `quotaExceeded` | 429 | Usage quota exceeded | Upgrade plan or wait |
| `concurrentLimit` | 429 | Too many concurrent operations | Reduce concurrent ops |

### External Service Errors
| Code | HTTP Status | Description | User Action |
|------|-------------|-------------|-------------|
| `serviceUnavailable` | 503 | External service down | Try again later |
| `timeout` | 504 | External service timeout | Retry or check connection |
| `apiLimitExceeded` | 429 | External API limit reached | Wait for reset |
| `invalidApiKey` | 401 | External API key invalid | Update API key |

### Intelligence Module Errors
| Code | HTTP Status | Description | User Action |
|------|-------------|-------------|-------------|
| `projectFilesUnavailable` | 409 | Imported files expired | Re-import project |
| `analysisFailed` | 500 | Project analysis failed | Try different project |
| `rateLimited` | 429 | GitHub API rate limit | Wait or use local import |
| `privateUnsupported` | 400 | Private repo not supported | Use public repo or local |
| `interviewEnded` | 409 | Interview already ended | Start new interview |
| `noOpenQuestion` | 409 | No current question | Wait for next question |

### Remote Control Errors
| Code | HTTP Status | Description | User Action |
|------|-------------|-------------|-------------|
| `invalidCode` | 400 | Invalid pairing code | Get new code |
| `expiredCode` | 400 | Expired pairing code | Get new code |
| `sessionUnavailable` | 503 | No desktop session active | Start Myra on desktop |
| `audioRateLimited` | 429 | Audio too fast | Slow down speaking |
| `badAudio` | 400 | Malformed audio data | Check microphone |
| `audioTooLarge` | 413 | Audio chunk too large | Reduce chunk size |
| `micNotEnabled` | 403 | Microphone not enabled | Enable microphone first |

## Error Handling Implementation

### Server-Side Error Handling
```typescript
// Error handler middleware
function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  // Log the error
  logger.error('Request failed', {
    path: req.path,
    method: req.method,
    error: err.message,
    stack: err.stack,
    userId: req.user?.id,
    traceId: req.traceId
  })

  // Convert to standardized error response
  const errorResponse = toErrorResponse(err)
  
  // Set appropriate HTTP status
  const status = getHttpStatus(err)
  
  // Send response
  res.status(status).json(errorResponse)
}

// Convert error to standardized response
function toErrorResponse(err: Error): ErrorResponse {
  if (err instanceof ApplicationError) {
    return {
      ok: false,
      error: err.code,
      message: err.message,
      details: err.details,
      retryAfterMs: err.retryAfterMs,
      suggestion: err.suggestion,
      traceId: err.traceId
    }
  }
  
  // Default for unexpected errors
  return {
    ok: false,
    error: 'internalError',
    message: 'An unexpected error occurred',
    traceId: generateTraceId()
  }
}
```

### Custom Error Classes
```typescript
// Base application error
class ApplicationError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number = 500,
    public details?: Record<string, any>,
    public retryAfterMs?: number,
    public suggestion?: string
  ) {
    super(message)
    this.name = 'ApplicationError'
  }
}

// Validation error
class ValidationError extends ApplicationError {
  constructor(
    message: string,
    details?: Record<string, any>,
    suggestion?: string
  ) {
    super(message, 'validation', 400, details, undefined, suggestion)
    this.name = 'ValidationError'
  }
}

// Authentication error
class AuthenticationError extends ApplicationError {
  constructor(
    message: string,
    details?: Record<string, any>,
    suggestion?: string
  ) {
    super(message, 'authentication', 401, details, undefined, suggestion)
    this.name = 'AuthenticationError'
  }
}

// Rate limit error
class RateLimitError extends ApplicationError {
  constructor(
    message: string,
    retryAfterMs: number,
    details?: Record<string, any>
  ) {
    super(
      message,
      'rateLimited',
      429,
      details,
      retryAfterMs,
      'Please wait before trying again'
    )
    this.name = 'RateLimitError'
  }
}

// External service error
class ExternalServiceError extends ApplicationError {
  constructor(
    service: string,
    message: string,
    details?: Record<string, any>,
    retryAfterMs?: number
  ) {
    super(
      `Service ${service}: ${message}`,
      'externalService',
      503,
      { service, ...details },
      retryAfterMs,
      'Try again in a few minutes'
    )
    this.name = 'ExternalServiceError'
  }
}
```

### Client-Side Error Handling
```typescript
// React error boundary
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log to error reporting service
    logError(error, errorInfo)
    
    // Show user-friendly error
    this.setState({ 
      hasError: true, 
      error: new UserFriendlyError(
        'Something went wrong',
        'Please try refreshing the page'
      )
    })
  }

  render() {
    if (this.state.hasError) {
      return <ErrorDisplay error={this.state.error} />
    }
    return this.props.children
  }
}

// Custom hook for API error handling
function useApiErrorHandler() {
  const [error, setError] = useState<ErrorResponse | null>(null)
  
  const handleError = useCallback((err: unknown) => {
    if (isErrorResponse(err)) {
      setError(err)
      
      // Show appropriate user message
      switch (err.error) {
        case 'rateLimited':
          showToast(`Too many requests. Try again in ${err.retryAfterMs}ms`)
          break
        case 'invalidToken':
          showToast('Session expired. Please login again.')
          clearAuth()
          break
        default:
          showToast(err.message || 'An error occurred')
      }
    } else {
      // Unexpected error
      setError({
        ok: false,
        error: 'unexpected',
        message: 'An unexpected error occurred'
      })
      showToast('An unexpected error occurred')
    }
  }, [])
  
  const clearError = useCallback(() => {
    setError(null)
  }, [])
  
  return { error, handleError, clearError }
}
```

## Error Recovery Strategies

### Automatic Retry
```typescript
// Retry with exponential backoff
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      // Don't retry certain errors
      if (isNonRetryableError(error)) {
        throw error
      }
      
      // Last attempt, throw error
      if (attempt === maxRetries) {
        throw error
      }
      
      // Calculate delay with jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000
      
      // Wait before retry
      await wait(delay)
    }
  }
  
  throw new Error('Max retries exceeded')
}

// Determine if error is retryable
function isRetryableError(error: Error): boolean {
  // Network errors are usually retryable
  if (error.name === 'NetworkError') return true
  
  // Rate limits with retry-after
  if (error instanceof RateLimitError && error.retryAfterMs) return true
  
  // External service errors
  if (error instanceof ExternalServiceError) return true
  
  // 5xx server errors
  if (isServerError(error)) return true
  
  return false
}
```

### Fallback Strategies
```typescript
// Fallback to local mode when cloud AI unavailable
async function getAiResponseWithFallback(
  prompt: string,
  options: { useLocalFallback: boolean } = { useLocalFallback: true }
): Promise<string> {
  try {
    return await geminiApi.generate(prompt)
  } catch (error) {
    if (options.useLocalFallback && isNetworkError(error)) {
      logger.warn('Falling back to local AI model', { error })
      return await localAiModel.generate(prompt)
    }
    throw error
  }
}

// Cache fallback for intelligence data
async function getProjectWithCacheFallback(
  projectId: string
): Promise<ProjectKnowledge> {
  try {
    return await intelligenceService.getProject(projectId)
  } catch (error) {
    if (error.code === 'projectFilesUnavailable') {
      // Try to restore from local cache
      const cached = await cache.getProject(projectId)
      if (cached) {
        logger.info('Restored project from cache', { projectId })
        return cached
      }
    }
    throw error
  }
}
```

## Error Logging & Monitoring

### Structured Logging
```typescript
interface ErrorLog {
  timestamp: string
  level: 'error' | 'warn' | 'info'
  message: string
  error: {
    name: string
    message: string
    stack?: string
    code?: string
  }
  context: {
    userId?: string
    sessionId?: string
    requestId?: string
    path?: string
    method?: string
    userAgent?: string
  }
  tags: string[]
  metadata: Record<string, any>
}

// Log error with context
function logError(error: Error, context: Partial<ErrorLog['context']> = {}) {
  const log: ErrorLog = {
    timestamp: new Date().toISOString(),
    level: 'error',
    message: error.message,
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack
    },
    context: {
      requestId: generateRequestId(),
      ...context
    },
    tags: ['error', error.name.toLowerCase()],
    metadata: {}
  }
  
  // Add additional properties for known error types
  if (error instanceof ApplicationError) {
    log.error.code = error.code
    log.tags.push(error.code)
    log.metadata = {
      status: error.status,
      details: error.details,
      retryAfterMs: error.retryAfterMs,
      suggestion: error.suggestion
    }
  }
  
  // Send to logging service
  loggingService.send(log)
}
```

### Error Aggregation
```typescript
// Track error rates and patterns
class ErrorTracker {
  private errors: Map<string, ErrorStats> = new Map()
  private windowSize = 60 * 60 * 1000 // 1 hour
  
  recordError(error: Error) {
    const key = this.getErrorKey(error)
    const stats = this.errors.get(key) || {
      count: 0,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      users: new Set(),
      examples: []
    }
    
    stats.count++
    stats.lastSeen = Date.now()
    
    // Track affected users (anonymized)
    if (error instanceof UserError) {
      stats.users.add(error.userId)
    }
    
    // Keep sample of error instances
    if (stats.examples.length < 10) {
      stats.examples.push({
        message: error.message,
        timestamp: Date.now(),
        stack: error.stack?.split('\n').slice(0, 5).join('\n')
      })
    }
    
    this.errors.set(key, stats)
    
    // Clean up old errors
    this.cleanup()
  }
  
  private getErrorKey(error: Error): string {
    if (error instanceof ApplicationError) {
      return `${error.name}:${error.code}`
    }
    return `${error.name}:${error.message.substring(0, 50)}`
  }
  
  private cleanup() {
    const cutoff = Date.now() - this.windowSize
    for (const [key, stats] of this.errors) {
      if (stats.lastSeen < cutoff) {
        this.errors.delete(key)
      }
    }
  }
  
  getErrorStats(): ErrorReport {
    return {
      totalErrors: Array.from(this.errors.values()).reduce((sum, s) => sum + s.count, 0),
      uniqueErrors: this.errors.size,
      frequentErrors: Array.from(this.errors.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)
        .map(([key, stats]) => ({ key, ...stats }))
    }
  }
}
```

## User-Facing Error Messages

### Error Message Guidelines
1. **Be helpful**: Suggest concrete next steps
2. **Be specific**: Explain what went wrong
3. **Be polite**: Don't blame the user
4. **Be technical when appropriate**: Developers appreciate details
5. **Provide recovery options**: Offer ways to fix the issue

### Message Templates
```typescript
const ERROR_MESSAGES = {
  // Network errors
  NETWORK_ERROR: {
    title: 'Connection Issue',
    message: 'Unable to connect to the server. Please check your internet connection.',
    actions: ['Retry', 'Check Network']
  },
  
  // Authentication errors
  AUTH_EXPIRED: {
    title: 'Session Expired',
    message: 'Your session has expired. Please login again to continue.',
    actions: ['Login']
  },
  
  // File errors
  FILE_NOT_FOUND: {
    title: 'File Not Found',
    message: 'The file "{path}" could not be found. Please check the path and try again.',
    actions: ['Choose Different File', 'Check Path']
  },
  
  // Rate limits
  RATE_LIMITED: {
    title: 'Too Many Requests',
    message: 'You\'ve made too many requests. Please wait {time} before trying again.',
    actions: ['Wait', 'Learn More']
  },
  
  // External service
  GEMINI_UNAVAILABLE: {
    title: 'AI Service Unavailable',
    message: 'The AI service is currently unavailable. You can try again in a few minutes.',
    actions: ['Retry', 'Use Local Mode']
  }
}

// Generate user-friendly error message
function getUserErrorMessage(error: Error): UserMessage {
  if (error instanceof ApplicationError) {
    const template = ERROR_MESSAGES[error.code as keyof typeof ERROR_MESSAGES]
    if (template) {
      return {
        title: template.title,
        message: interpolate(template.message, error.details),
        actions: template.actions,
        severity: getSeverity(error)
      }
    }
  }
  
  // Default fallback
  return {
    title: 'Something Went Wrong',
    message: 'An unexpected error occurred. Please try again.',
    actions: ['Retry', 'Report Issue'],
    severity: 'error'
  }
}
```

## Testing Error Handling

### Error Test Cases
```typescript
describe('Error Handling', () => {
  test('should handle network errors gracefully', async () => {
    // Mock network failure
    mockNetworkError()
    
    const result = await apiClient.fetchData()
    
    expect(result).toEqual({
      ok: false,
      error: 'networkError',
      message: expect.stringContaining('network')
    })
  })
  
  test('should retry on transient errors', async () => {
    let attempts = 0
    const mockService = jest.fn()
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce({ data: 'success' })
    
    const result = await retryWithBackoff(mockService)
    
    expect(result).toEqual({ data: 'success' })
    expect(mockService).toHaveBeenCalledTimes(2)
  })
  
  test('should show user-friendly error messages', () => {
    const error = new ValidationError('Invalid input', { field: 'email' })
    const message = getUserErrorMessage(error)
    
    expect(message.title).toBe('Invalid Input')
    expect(message.actions).toContain('Fix Input')
  })
  
  test('should log errors with context', () => {
    const logSpy = jest.spyOn(logger, 'error')
    const error = new Error('Test error')
    
    errorHandler(error, mockRequest, mockResponse, mockNext)
    
    expect(logSpy).toHaveBeenCalledWith(
      'Request failed',
      expect.objectContaining({
        error: 'Test error',
        path: '/test'
      })
    )
  })
})
```

### Error Scenario Testing
```typescript
// Test specific error scenarios
const ERROR_SCENARIOS = [
  {
    name: 'Slow network connection',
    setup: () => mockSlowNetwork(5000),
    expected: 'timeout error with retry option'
  },
  {
    name: 'Invalid API key',
    setup: () => mockInvalidApiKey(),
    expected: 'authentication error with key update suggestion'
  },
  {
    name: 'Disk full',
    setup: () => mockDiskFull(),
    expected: 'storage error with cleanup suggestion'
  },
  {
    name: 'Corrupted project file',
    setup: () => mockCorruptedFile(),
    expected: 'validation error with re-import option'
  }
]

// Run error scenario tests
ERROR_SCENARIOS.forEach(scenario => {
  test(`should handle ${scenario.name}`, async () => {
    scenario.setup()
    
    // Execute operation that should trigger error
    const result = await performOperation()
    
    // Verify error handling
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.message).toBeTruthy()
    
    // Verify recovery options are provided
    if (result.suggestion) {
      expect(result.suggestion).toBeTruthy()
    }
  })
})
```

## Error Analytics & Improvement

### Error Metrics Dashboard
```typescript
interface ErrorMetrics {
  // Volume metrics
  totalErrors: number
  errorRate: number  // errors per 1000 requests
  uniqueErrors: number
  
  // Impact metrics
  affectedUsers: number
  recoveryRate: number  // % of errors with successful recovery
  meanTimeToRecovery: number  // average recovery time in ms
  
  // Category breakdown
  bySeverity: Record<ErrorSeverity, number>
  byCategory: Record<ErrorCategory, number>
  byFeature: Record<string, number>
  
  // Trend analysis
  trend: {
    daily: Array<{ date: string; count: number }>
    weekly: Array<{ week: string; count: number }>
    monthly: Array<{ month: string; count: number }>
  }
  
  // Top errors
  topErrors: Array<{
    code: string
    count: number
    affectedUsers: number
    lastOccurred: string
    suggestedFix?: string
  }>
}

// Generate error metrics report
async function generateErrorReport(
  period: 'day' | 'week' | 'month' = 'week'
): Promise<ErrorMetrics> {
  const logs = await errorLogs.query({ period })
  
  return {
    totalErrors: logs.length,
    errorRate: (logs.length / (await requestCount(period))) * 1000,
    uniqueErrors: new Set(logs.map(l => l.error.code)).size,
    affectedUsers: new Set(logs.filter(l => l.context.userId).map(l => l.context.userId)).size,
    recoveryRate: calculateRecoveryRate(logs),
    meanTimeToRecovery: calculateMeanRecoveryTime(logs),
    bySeverity: groupBy(logs, 'severity'),
    byCategory: groupBy(logs, 'category'),
    byFeature: groupBy(logs, 'feature'),
    trend: calculateTrends(logs, period),
    topErrors: getTopErrors(logs, 10)
  }
}
```

### Continuous Improvement Process
1. **Monitor**: Track error metrics daily
2. **Analyze**: Identify patterns and root causes weekly
3. **Prioritize**: Fix highest-impact errors first
4. **Implement**: Deploy fixes in next release
5. **Verify**: Confirm error reduction in metrics
6. **Document**: Update error handling guidelines

---

*Error Handling Framework Version: 1.0*  
*Last Updated: 2026-11-24*  
*Based on: THE VIBE CODING BLUEPRINT - Resilience Engineering Section*
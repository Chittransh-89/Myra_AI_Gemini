# Myra AI Gemini - Security Architecture

## Security Philosophy
**Defense in depth, zero trust, local-first** - Myra assumes no network, no user, and no component can be fully trusted. Every layer enforces its own security boundaries.

## Threat Model

### Adversarial Capabilities
1. **Network attacker** - Can intercept loopback traffic
2. **Malicious phone** - Attempts to pair without consent  
3. **Compromised renderer** - XSS or code injection in UI
4. **Malicious tools** - Attempts to execute unauthorized operations
5. **Data exfiltration** - Attempts to steal credentials or files

### Protected Assets
1. **Gemini API key** - Never leaves desktop process
2. **User files** - Read-only access with explicit consent
3. **Credentials** - Redacted from analysis and logs
4. **System access** - Limited to allowlisted operations
5. **User privacy** - No audio storage, local data only

## Security Layers

### Layer 1: Network Security
```typescript
// Default: loopback-only binding
app.listen(PORT, '127.0.0.1')

// Remote exposure: Tailscale Serve only
// - HTTPS termination at Tailscale
// - Tailnet-only access (no public internet)
// - No port forwarding required

// WebSocket security
const wss = new WebSocket.Server({
  noServer: true,
  maxPayload: 64 * 1024,  // 64KB max frame size
  verifyClient: (info, callback) => {
    // Origin validation
    const origin = info.origin
    if (origin && !isAllowedOrigin(origin)) {
      return callback(false, 403, 'Origin rejected')
    }
    callback(true)
  }
})
```

### Layer 2: Authentication

#### Desktop Authentication
```typescript
// Per-run desktop token (32 bytes hex)
const MYRA_WS_TOKEN = crypto.randomBytes(32).toString('hex')

// WebSocket authentication
function authenticateDesktopToken(token: string): boolean {
  // Constant-time comparison
  return crypto.timingSafeEqual(
    Buffer.from(token, 'hex'),
    Buffer.from(MYRA_WS_TOKEN, 'hex')
  )
}

// HTTP header authentication (intelligence API)
function verifyDesktopHeader(req: Request): boolean {
  const token = req.headers['x-myra-desktop-token']
  return token === MYRA_WS_TOKEN
}
```

#### Phone Pairing Authentication
```typescript
// One-time pairing code (6 digits, 5-minute expiry)
function generatePairingCode(): string {
  return crypto.randomInt(100000, 999999).toString()
}

// Phone session token (256 bits, HttpOnly cookie)
async function createPhoneSession(): Promise<{
  token: Buffer  // 32 random bytes
  tokenHash: string  // SHA-256 for storage
}> {
  const token = crypto.randomBytes(32)
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  return { token, tokenHash }
}

// Cookie settings for phone token
const PHONE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  path: '/remote',
  maxAge: 12 * 60 * 60,  // 12 hours
  secure: isHttpsRequest(req)  // Set only for HTTPS
}
```

### Layer 3: Authorization

#### File Access Authorization
```typescript
// Electron file access control
interface FileAuthorization {
  path: string      // Exact real path
  grantedAt: number // Timestamp
  expiresAt?: number // Optional expiry
}

// Main process maintains authorization list
const fileAuthorizations = new Map<string, FileAuthorization>()

function authorizeFile(path: string): string {
  const authId = crypto.randomBytes(16).toString('hex')
  const authorization: FileAuthorization = {
    path: fs.realpathSync(path),
    grantedAt: Date.now()
  }
  fileAuthorizations.set(authId, authorization)
  return authId
}

function checkFileAuthorization(authId: string, requestedPath: string): boolean {
  const auth = fileAuthorizations.get(authId)
  if (!auth) return false
  
  // Path must match exactly (realpath comparison)
  return fs.realpathSync(requestedPath) === auth.path
}
```

#### Tool Execution Authorization (Handoff Authority)
```typescript
// Handoff ticket structure
interface HandoffTicket {
  v: 1
  kind: 'ticket'
  callId: string      // Registry ID
  toolName: string    // e.g., 'fileControl'
  argsDigest: string  // SHA-256 of args
  sessionId: string   // WebSocket connection ID
  expNs: string       // Monotonic nanosecond deadline
  sig: string         // HMAC-SHA256 signature
}

// Ticket validation
function validateHandoffTicket(ticket: string): ValidationResult {
  // 1. Base64URL decode
  const decoded = base64UrlDecode(ticket)
  const payload: HandoffTicket = JSON.parse(decoded)
  
  // 2. Version check
  if (payload.v !== 1) return { valid: false, reason: 'invalidVersion' }
  
  // 3. Expiry check (monotonic time)
  const nowNs = getMonotonicTimeNs()
  if (BigInt(payload.expNs) <= nowNs) {
    return { valid: false, reason: 'expired' }
  }
  
  // 4. HMAC verification
  const expectedSig = computeHmac(payload)
  if (!crypto.timingSafeEqual(
    Buffer.from(payload.sig, 'hex'),
    Buffer.from(expectedSig, 'hex')
  )) {
    return { valid: false, reason: 'invalidSignature' }
  }
  
  // 5. Registry lookup
  const registry = getRegistryEntry(payload.callId)
  if (!registry) return { valid: false, reason: 'unknownCall' }
  
  // 6. Tool binding check
  if (registry.toolName !== payload.toolName) {
    return { valid: false, reason: 'toolMismatch' }
  }
  
  // 7. Args binding check
  const expectedDigest = computeArgsDigest(registry.args)
  if (payload.argsDigest !== expectedDigest) {
    return { valid: false, reason: 'argsMismatch' }
  }
  
  // 8. Session routing check
  if (!isSessionActive(payload.sessionId)) {
    return { valid: false, reason: 'sessionInactive' }
  }
  
  return { valid: true, payload }
}
```

### Layer 4: Input Validation

#### Audio Input Validation
```typescript
function validateAudioFrame(frame: AudioFrame): ValidationResult {
  // 1. JSON structure
  if (frame.type !== 'audio') return { valid: false, reason: 'invalidType' }
  if (typeof frame.data !== 'string') return { valid: false, reason: 'invalidData' }
  if (typeof frame.seq !== 'number') return { valid: false, reason: 'invalidSeq' }
  
  // 2. Base64 validation
  if (!isValidBase64(frame.data)) return { valid: false, reason: 'invalidBase64' }
  
  // 3. Size limits
  const decoded = Buffer.from(frame.data, 'base64')
  if (decoded.length === 0) return { valid: false, reason: 'emptyData' }
  if (decoded.length > 8 * 1024) return { valid: false, reason: 'tooLarge' } // 8KB
  if (decoded.length % 2 !== 0) return { valid: false, reason: 'oddLength' } // PCM16 LE
  
  // 4. Token bucket rate limiting
  const bridge = getAudioBridge(frame.sessionId)
  if (!bridge) return { valid: false, reason: 'noBridge' }
  
  const result = bridge.push(decoded)
  if (!result.ok) return { valid: false, reason: result.reason }
  
  return { valid: true }
}
```

#### File Path Validation
```typescript
function validateFilePath(root: string, path: string): ValidationResult {
  // 1. Absolute path resolution
  const absolute = path.resolve(root, path)
  
  // 2. Directory traversal prevention
  if (!absolute.startsWith(path.resolve(root))) {
    return { valid: false, reason: 'pathTraversal' }
  }
  
  // 3. Symlink safety
  try {
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) {
      return { valid: false, reason: 'symlink' }
    }
  } catch {
    return { valid: false, reason: 'notFound' }
  }
  
  // 4. Sensitive path blocking
  const sensitivePatterns = [
    /\.env$/i,
    /\.aws[\\/]credentials$/i,
    /\.ssh[\\/]id_/i,
    /\.kube[\\/]config$/i,
    /(?:private|secret)\.key$/i,
    /\.pem$/i,
    /\.pfx$/i,
    /\.p12$/i
  ]
  
  for (const pattern of sensitivePatterns) {
    if (pattern.test(absolute)) {
      return { valid: false, reason: 'sensitivePath' }
    }
  }
  
  // 5. Size limits (for analysis)
  const stats = fs.statSync(absolute)
  if (stats.size > 200 * 1024) { // 200KB
    return { valid: false, reason: 'tooLarge' }
  }
  
  return { valid: true, absolutePath: absolute }
}
```

### Layer 5: Data Protection

#### Secrets Redaction
```typescript
const SECRET_REDACTION_PATTERNS = [
  // API keys, tokens
  /(["'`]?)(?:api[_-]?key|secret|token|password|credential|private[_-]?key)\1\s*[:=]\s*(["'`])([^"'`\n]{8,})\2/gi,
  
  // Private keys
  /-----BEGIN (?:RSA|DSA|EC|OPENSSH) PRIVATE KEY-----[^]+?-----END (?:RSA|DSA|EC|OPENSSH) PRIVATE KEY-----/g,
  
  // Basic auth URLs
  /(?:https?:\/\/)[^\/]+@[^\s"']+/g,
  
  // Database connection strings
  /(["'`])(?:mongodb|postgres|mysql|redis):\/\/[^:]+:[^@]+@[^"'`\n]+\1/g,
  
  // JWT tokens (approx pattern)
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
]

function redactSecrets(text: string): { text: string; redactions: number } {
  let redacted = text
  let redactionCount = 0
  
  for (const pattern of SECRET_REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      redactionCount++
      return '[REDACTED]'
    })
  }
  
  return { text: redacted, redactions: redactionCount }
}
```

#### Memory Safety
```typescript
// Bounded buffers and caches
const MEMORY_LIMITS = {
  maxPendingImports: 4,           // Max concurrent imports
  importTtlMs: 30 * 60 * 1000,    // 30 minutes TTL
  maxImportChars: 700_000,        // 700K characters total
  maxAudioQueue: 10,              // Max audio chunks in queue
  maxWebSocketBuffer: 256 * 1024, // 256KB WebSocket buffer
}

// Automatic cleanup
function cleanupMemory() {
  const now = Date.now()
  
  // Clean expired imports
  for (const [id, import_] of pendingImports) {
    if (now - import_.importedAt > MEMORY_LIMITS.importTtlMs) {
      pendingImports.delete(id)
    }
  }
  
  // Enforce size limits
  if (pendingImports.size > MEMORY_LIMITS.maxPendingImports) {
    // Remove oldest
    const entries = Array.from(pendingImports.entries())
    entries.sort((a, b) => a[1].importedAt - b[1].importedAt)
    for (let i = 0; i < entries.length - MEMORY_LIMITS.maxPendingImports; i++) {
      pendingImports.delete(entries[i][0])
    }
  }
}
```

## Security Controls

### Rate Limiting

#### Pairing Rate Limits
```typescript
const PAIRING_RATE_LIMIT = {
  attempts: 5,           // Max attempts
  windowMs: 60 * 1000,   // 1 minute window
  blockDurationMs: 60 * 1000  // 1 minute block
}

class PairingRateLimiter {
  private attempts = new Map<string, number[]>()
  
  check(clientKey: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now()
    const clientAttempts = this.attempts.get(clientKey) || []
    
    // Clean old attempts
    const recentAttempts = clientAttempts.filter(t => now - t < PAIRING_RATE_LIMIT.windowMs)
    
    if (recentAttempts.length >= PAIRING_RATE_LIMIT.attempts) {
      const oldest = Math.min(...recentAttempts)
      const retryAfter = oldest + PAIRING_RATE_LIMIT.windowMs - now
      return { allowed: false, retryAfterMs: Math.max(0, retryAfter) }
    }
    
    recentAttempts.push(now)
    this.attempts.set(clientKey, recentAttempts)
    return { allowed: true }
  }
  
  reset(clientKey: string) {
    this.attempts.delete(clientKey)
  }
}
```

#### Audio Rate Limiting (Token Bucket)
```typescript
class TokenBucket {
  private tokens: number
  private lastRefill: number
  
  constructor(
    private maxTokens: number,
    private refillRate: number  // tokens per millisecond
  ) {
    this.tokens = maxTokens
    this.lastRefill = Date.now()
  }
  
  tryConsume(tokens: number): boolean {
    this.refill()
    
    if (this.tokens >= tokens) {
      this.tokens -= tokens
      return true
    }
    
    return false
  }
  
  private refill() {
    const now = Date.now()
    const elapsed = now - this.lastRefill
    const newTokens = elapsed * this.refillRate
    
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens)
    this.lastRefill = now
  }
}

// Audio bridge token bucket
const audioBucket = new TokenBucket(
  48 * 1024,     // 48KB burst
  64 * 1024 / 1000  // 64KB per second = ~65 bytes/ms
)
```

### Logging Security

#### Security-Sensitive Logging
```typescript
// Never log secrets
const SENSITIVE_KEYS = [
  'apiKey', 'token', 'password', 'secret',
  'privateKey', 'credential', 'authorization'
]

function sanitizeLogData(data: any): any {
  if (typeof data !== 'object' || data === null) return data
  
  const sanitized = { ...data }
  for (const key of Object.keys(sanitized)) {
    const lowerKey = key.toLowerCase()
    
    // Check if key indicates sensitive data
    if (SENSITIVE_KEYS.some(sk => lowerKey.includes(sk))) {
      sanitized[key] = '[REDACTED]'
    }
    
    // Recursively sanitize nested objects
    else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
      sanitized[key] = sanitizeLogData(sanitized[key])
    }
  }
  
  return sanitized
}

// Secure logging function
function logSecurityEvent(event: string, data?: any) {
  console.log(`[SECURITY] ${event}`, data ? sanitizeLogData(data) : '')
}
```

## Security Auditing

### Security Events
```typescript
interface SecurityEvent {
  timestamp: string
  type: SecurityEventType
  severity: 'info' | 'warning' | 'error' | 'critical'
  source: string
  details: Record<string, any>
  userId?: string
  sessionId?: string
}

type SecurityEventType =
  | 'authentication.success'
  | 'authentication.failure'
  | 'authorization.granted'
  | 'authorization.denied'
  | 'rate_limit.triggered'
  | 'input_validation.failed'
  | 'security_control.bypassed'
  | 'data_exfiltration.attempted'
  | 'system.compromise.indicator'
```

### Audit Trail
```typescript
class SecurityAuditor {
  private events: SecurityEvent[] = []
  private maxEvents = 10000
  
  record(event: Omit<SecurityEvent, 'timestamp'>) {
    const fullEvent: SecurityEvent = {
      timestamp: new Date().toISOString(),
      ...event
    }
    
    this.events.push(fullEvent)
    
    // Maintain size limit
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents)
    }
    
    // Immediate alert for critical events
    if (event.severity === 'critical') {
      this.alertCritical(event)
    }
  }
  
  getRecentEvents(limit: number = 100): SecurityEvent[] {
    return this.events.slice(-limit)
  }
  
  private alertCritical(event: SecurityEvent) {
    // Could send to monitoring system, but for local app:
    console.error(`[CRITICAL SECURITY] ${event.type}`, event.details)
  }
}
```

## Incident Response

### Security Incident Types
1. **Credential leak** - API key exposed
2. **Unauthorized access** - Phone pairing bypass
3. **Data exfiltration** - File access outside bounds
4. **Denial of service** - Rate limit exhaustion
5. **Privilege escalation** - Tool execution bypass

### Response Procedures
```typescript
async function handleSecurityIncident(
  type: SecurityIncidentType,
  details: IncidentDetails
): Promise<void> {
  // 1. Immediate containment
  switch (type) {
    case 'credential_leak':
      await rotateApiKey()
      break
    case 'unauthorized_access':
      await revokeAllSessions()
      break
    case 'data_exfiltration':
      await disableRemoteAccess()
      break
  }
  
  // 2. Investigation
  const auditTrail = auditor.getRecentEvents(1000)
  const relevantEvents = auditTrail.filter(e => 
    e.timestamp >= details.startTime
  )
  
  // 3. Remediation
  await applySecurityPatch(type)
  
  // 4. Recovery
  await restoreNormalOperations(type)
  
  // 5. Post-mortem
  await documentIncident(type, details, relevantEvents)
}
```

## Compliance & Best Practices

### OWASP Top 10 Mitigations
1. **Injection** - Input validation, parameterized operations
2. **Broken Authentication** - Multi-factor, rate limiting
3. **Sensitive Data Exposure** - Encryption, redaction
4. **XML External Entities** - Disabled XML parsing
5. **Broken Access Control** - Principle of least privilege
6. **Security Misconfiguration** - Secure defaults
7. **Cross-Site Scripting** - Content Security Policy
8. **Insecure Deserialization** - JSON only, schema validation
9. **Using Components with Known Vulnerabilities** - Regular updates
10. **Insufficient Logging & Monitoring** - Comprehensive auditing

### Privacy by Design
1. **Data minimization** - Collect only what's needed
2. **Purpose limitation** - Use data only for intended purpose
3. **Storage limitation** - Temporary storage with TTLs
4. **Accuracy** - Regular data validation
5. **Integrity & confidentiality** - Encryption, access controls
6. **Accountability** - Audit trails, incident response

## Security Testing

### Automated Security Tests
```typescript
// Security test suite
describe('Security Controls', () => {
  test('should reject invalid handoff tickets', async () => {
    const invalidTicket = 'invalid.base64.url'
    const result = validateHandoffTicket(invalidTicket)
    expect(result.valid).toBe(false)
  })
  
  test('should enforce file path boundaries', async () => {
    const result = validateFilePath('/allowed', '../etc/passwd')
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('pathTraversal')
  })
  
  test('should rate limit pairing attempts', async () => {
    const limiter = new PairingRateLimiter()
    const clientKey = 'test-client'
    
    // First 5 attempts should succeed
    for (let i = 0; i < 5; i++) {
      expect(limiter.check(clientKey).allowed).toBe(true)
    }
    
    // 6th attempt should be blocked
    expect(limiter.check(clientKey).allowed).toBe(false)
  })
  
  test('should redact secrets from logs', () => {
    const data = {
      apiKey: 'sk-test-123456',
      normalData: 'safe'
    }
    
    const sanitized = sanitizeLogData(data)
    expect(sanitized.apiKey).toBe('[REDACTED]')
    expect(sanitized.normalData).toBe('safe')
  })
})
```

### Penetration Testing Checklist
- [ ] Authentication bypass attempts
- [ ] Authorization escalation attempts
- [ ] Input validation bypass
- [ ] Rate limit evasion
- [ ] Memory exhaustion attacks
- [ ] File path traversal
- [ ] XSS in rendered content
- [ ] WebSocket protocol attacks
- [ ] Audio streaming attacks
- [ ] Tool execution bypass

---

*Security Architecture Version: 1.0*  
*Last Updated: 2026-11-23*  
*Based on: THE VIBE CODING BLUEPRINT - Security Framework Section*
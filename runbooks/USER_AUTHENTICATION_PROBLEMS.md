# User Authentication Problems Runbook

## Purpose
Diagnose and resolve authentication and authorization issues in Myra AI Gemini.

## Authentication Architecture Overview

### Myra AI Authentication Model
```
Desktop Application (Primary Auth)
    │
    ├── Desktop Token (32-byte hex, per-run)
    │   ├── Generated on startup
    │   ├── Stored in memory
    │   └── Used for local API calls
    │
    ├── Phone Remote Auth
    │   ├── One-time pairing codes (6-digit, 5-min expiry)
    │   ├── HttpOnly cookies for session
    │   └── Tailscale-based remote access
    │
    └── Future Authentication Methods
        ├── User accounts (future)
        ├── OAuth integrations
        └── Multi-factor authentication
```

### Authentication Flow
1. **Desktop Startup**: Generate random desktop token
2. **Phone Pairing**: Display 6-digit code, user enters on phone
3. **Session Establishment**: Phone receives HttpOnly session cookie
4. **API Authorization**: All requests require valid token/cookie
5. **Session Management**: Automatic cleanup of expired sessions

## Common Authentication Issues

### Issue 1: Desktop Token Authentication Failures
**Symptoms**:
- "Invalid desktop token" errors
- Local API calls returning 401
- Desktop features not working
- Token mismatch between components

**Diagnostic Steps**:
```bash
# 1. Check desktop token generation
grep -i "desktop.*token\|DESKTOP_TOKEN" /opt/myra-production/src/**/*.ts

# 2. Verify token is being sent in requests
# Check Electron main process logs
# Check browser developer tools Network tab

# 3. Check token validation logic
grep -i "verify\|validate\|authenticate" /opt/myra-production/src/server/**/*.ts

# 4. Monitor authentication logs
grep -E "(token|auth|401|403)" /var/log/myra/server.log | tail -20

# 5. Check environment variable
echo $DESKTOP_TOKEN
# Should be 64-character hex string

# 6. Verify token format
if [[ ! "$DESKTOP_TOKEN" =~ ^[a-f0-9]{64}$ ]]; then
  echo "ERROR: Invalid desktop token format"
fi
```

**Resolution Steps**:
```bash
# 1. Regenerate desktop token
# Stop the application first
pm2 stop myra-server

# Generate new token
NEW_TOKEN=$(openssl rand -hex 32)
echo "New desktop token: $NEW_TOKEN"

# Update configuration
sed -i "s/DESKTOP_TOKEN=.*/DESKTOP_TOKEN=$NEW_TOKEN/" .env.production

# 2. Update Electron configuration
# In Electron main process:
const newToken = process.env.DESKTOP_TOKEN;
// Update all API calls to use new token

# 3. Clear any cached tokens
# In Electron:
localStorage.removeItem('desktop_token');
sessionStorage.removeItem('desktop_token');

# 4. Restart application
pm2 start myra-server

# 5. Verify new token works
curl -H "Authorization: Bearer $NEW_TOKEN" \
  http://localhost:3000/api/health
```

**Token Management Best Practices**:
```typescript
// Secure token generation and management
import crypto from 'crypto';

class DesktopTokenManager {
  private token: string;
  private generatedAt: number;
  
  constructor() {
    this.generateToken();
  }
  
  private generateToken(): void {
    this.token = crypto.randomBytes(32).toString('hex');
    this.generatedAt = Date.now();
    
    // Log token generation (without revealing full token)
    console.log(`Desktop token generated: ${this.token.substring(0, 8)}...`);
  }
  
  getToken(): string {
    return this.token;
  }
  
  validateToken(token: string): boolean {
    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(this.token)
    );
  }
  
  // Optional: Rotate token periodically
  rotateToken(): void {
    const oldToken = this.token;
    this.generateToken();
    
    // Notify components about token rotation
    this.notifyTokenRotation(oldToken, this.token);
  }
  
  private notifyTokenRotation(oldToken: string, newToken: string): void {
    // Update Electron windows
    // Update any background processes
    // Log the rotation
    console.log(`Desktop token rotated`);
  }
}

// Token validation middleware
function validateDesktopToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }
  
  const [scheme, token] = authHeader.split(' ');
  
  if (scheme !== 'Bearer') {
    return res.status(401).json({ error: 'Invalid authorization scheme' });
  }
  
  if (!token || token.length !== 64) {
    return res.status(401).json({ error: 'Invalid token format' });
  }
  
  // Validate against current desktop token
  if (!desktopTokenManager.validateToken(token)) {
    return res.status(401).json({ error: 'Invalid desktop token' });
  }
  
  // Token is valid, proceed
  next();
}
```

### Issue 2: Phone Pairing Code Problems
**Symptoms**:
- "Invalid pairing code" errors
- Codes not appearing or expiring too quickly
- Multiple failed pairing attempts
- Codes not working after generation

**Diagnostic Steps**:
```bash
# 1. Check pairing code generation logic
grep -r "pairing.*code\|generateCode" /opt/myra-production/src/

# 2. Monitor pairing attempts
grep -E "(pairing|code|pair)" /var/log/myra/server.log | tail -20

# 3. Check code expiration logic
grep -r "expire\|expiry\|timeout" /opt/myra-production/src/server/auth/

# 4. Verify code storage
# Check Redis/memory store for active codes
redis-cli keys "pairing:*"

# 5. Test code generation manually
curl -X POST http://localhost:3000/api/auth/pairing/code \
  -H "Authorization: Bearer $DESKTOP_TOKEN"
```

**Resolution Steps**:
```bash
# 1. Reset all pairing codes
curl -X DELETE http://localhost:3000/api/auth/pairing/codes \
  -H "Authorization: Bearer $DESKTOP_TOKEN"

# 2. Generate new code with extended expiry
curl -X POST http://localhost:3000/api/auth/pairing/code \
  -H "Authorization: Bearer $DESKTOP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expiryMinutes": 10}'  # Extend to 10 minutes

# 3. Verify code appears in dashboard
# Check /remote dashboard for displayed code

# 4. Clear browser cookies on phone
# Instructions for user:
# - Open browser settings
# - Clear cookies for Myra domain
# - Refresh /remote page

# 5. Implement code validation improvements
```

**Enhanced Pairing Code System**:
```typescript
class PairingCodeManager {
  private codes: Map<string, PairingCode>;
  private codeExpiry: number = 5 * 60 * 1000; // 5 minutes
  
  constructor() {
    this.codes = new Map();
    // Clean up expired codes every minute
    setInterval(() => this.cleanupExpiredCodes(), 60000);
  }
  
  generateCode(): PairingCode {
    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    const pairingCode: PairingCode = {
      code,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.codeExpiry,
      used: false,
      attempts: 0
    };
    
    this.codes.set(code, pairingCode);
    
    // Log generation (without revealing full code in logs)
    console.log(`Pairing code generated: ${code.substring(0, 3)}...`);
    
    return pairingCode;
  }
  
  validateCode(code: string): ValidationResult {
    const pairingCode = this.codes.get(code);
    
    if (!pairingCode) {
      return { valid: false, reason: 'Code not found' };
    }
    
    // Check if expired
    if (Date.now() > pairingCode.expiresAt) {
      this.codes.delete(code);
      return { valid: false, reason: 'Code expired' };
    }
    
    // Check if already used
    if (pairingCode.used) {
      return { valid: false, reason: 'Code already used' };
    }
    
    // Increment attempts
    pairingCode.attempts++;
    
    // Check for brute force attempts
    if (pairingCode.attempts > 5) {
      this.codes.delete(code);
      return { valid: false, reason: 'Too many attempts' };
    }
    
    return { valid: true, pairingCode };
  }
  
  markCodeUsed(code: string): void {
    const pairingCode = this.codes.get(code);
    if (pairingCode) {
      pairingCode.used = true;
      pairingCode.usedAt = Date.now();
    }
  }
  
  getActiveCode(): PairingCode | null {
    // Find first unused, unexpired code
    for (const [code, pairingCode] of this.codes) {
      if (!pairingCode.used && Date.now() <= pairingCode.expiresAt) {
        return pairingCode;
      }
    }
    return null;
  }
  
  private cleanupExpiredCodes(): void {
    const now = Date.now();
    for (const [code, pairingCode] of this.codes) {
      if (now > pairingCode.expiresAt) {
        this.codes.delete(code);
      }
    }
  }
}

// Pairing endpoint
app.post('/api/auth/pair/validate', async (req, res) => {
  const { code } = req.body;
  
  if (!code || code.length !== 6) {
    return res.status(400).json({ error: 'Invalid code format' });
  }
  
  const validation = pairingCodeManager.validateCode(code);
  
  if (!validation.valid) {
    return res.status(401).json({ 
      error: 'Invalid pairing code',
      reason: validation.reason
    });
  }
  
  // Mark code as used
  pairingCodeManager.markCodeUsed(code);
  
  // Generate session
  const sessionId = crypto.randomBytes(16).toString('hex');
  const sessionToken = crypto.randomBytes(32).toString('hex');
  
  // Store session
  await sessionStore.createSession(sessionId, {
    token: sessionToken,
    createdAt: Date.now(),
    expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
  });
  
  // Set HttpOnly cookie
  res.cookie('myra_session', sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  });
  
  res.json({ 
    success: true,
    sessionId,
    message: 'Pairing successful'
  });
});
```

### Issue 3: Session Cookie Problems
**Symptoms**:
- "Session expired" errors
- Users getting logged out unexpectedly
- Cookies not being set or persisted
- Cross-domain cookie issues

**Diagnostic Steps**:
```bash
# 1. Check cookie configuration
grep -r "cookie\|session" /opt/myra-production/src/server/

# 2. Monitor session creation/deletion
grep -E "(session|cookie)" /var/log/myra/server.log | tail -20

# 3. Test cookie setting
curl -i -X POST http://localhost:3000/api/auth/pair/validate \
  -H "Content-Type: application/json" \
  -d '{"code": "123456"}' | grep -i "set-cookie"

# 4. Check cookie attributes in browser
# Developer Tools → Application → Cookies

# 5. Verify session store
# Check Redis or in-memory store for sessions
```

**Resolution Steps**:
```bash
# 1. Clear all sessions
curl -X DELETE http://localhost:3000/api/auth/sessions \
  -H "Authorization: Bearer $DESKTOP_TOKEN"

# 2. Update cookie configuration
# In Express configuration:
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',  # Changed from 'strict' for cross-origin
    maxAge: 24 * 60 * 60 * 1000  # 24 hours
  }
}));

# 3. Implement session refresh
app.post('/api/auth/session/refresh', (req, res) => {
  if (req.session) {
    // Reset maxAge
    req.session.cookie.maxAge = 24 * 60 * 60 * 1000;
    req.session.touch();
    
    res.json({ success: true, expiresAt: req.session.cookie.expires });
  } else {
    res.status(401).json({ error: 'No active session' });
  }
});

# 4. Add session validation middleware
function validateSession(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Session expired' });
  }
  
  // Check session expiration
  if (req.session.cookie.expires < Date.now()) {
    return res.status(401).json({ error: 'Session expired' });
  }
  
  next();
}

# 5. Configure CORS for cookie handling
app.use(cors({
  origin: ['http://localhost:3000', 'https://your-domain.com'],
  credentials: true  // Important for cookies
}));
```

### Issue 4: Cross-Origin Authentication Issues
**Symptoms**:
- CORS errors in browser console
- Authentication requests failing
- Cookies not being sent with requests
- Preflight request failures

**Diagnostic Steps**:
```bash
# 1. Check CORS configuration
grep -r "cors\|CORS" /opt/myra-production/src/server/

# 2. Test preflight requests
curl -X OPTIONS http://localhost:3000/api/auth/pair/validate \
  -H "Origin: http://localhost:3000" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type, authorization"

# 3. Check browser console for CORS errors
# Open Developer Tools → Console

# 4. Verify allowed origins
# Check configuration for allowed domains
```

**Resolution Steps**:
```typescript
// Comprehensive CORS configuration
import cors from 'cors';

const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://myra.yourdomain.com',
  // Add phone remote URLs
];

const corsOptions = {
  origin: (origin: string | undefined, callback: Function) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin'
  ],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400  // 24 hours
};

app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Authentication-specific CORS headers
app.use('/api/auth/*', (req, res, next) => {
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  next();
});

// Session cookie configuration for cross-origin
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000,
    domain: process.env.NODE_ENV === 'production' ? '.yourdomain.com' : undefined
  }
}));
```

### Issue 5: Rate Limiting on Authentication Endpoints
**Symptoms**:
- "Too many requests" errors
- Users locked out after failed attempts
- Slow response times on auth endpoints
- Brute force protection triggering

**Diagnostic Steps**:
```bash
# 1. Check rate limiting configuration
grep -r "rate.*limit\|throttle" /opt/myra-production/src/server/

# 2. Monitor authentication attempts
grep -E "(401|403|429)" /var/log/myra/server.log | \
  grep -E "(auth|pair|login)" | \
  tail -20

# 3. Check Redis/memory store for rate limits
redis-cli keys "ratelimit:*"

# 4. Test rate limiting
for i in {1..10}; do
  curl -X POST http://localhost:3000/api/auth/pair/validate \
    -H "Content-Type: application/json" \
    -d '{"code": "wrongcode"}' -s -o /dev/null -w "%{http_code}\n"
done
```

**Resolution Steps**:
```typescript
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';

// Store configuration
const store = process.env.REDIS_URL
  ? new RedisStore({
      redisURL: process.env.REDIS_URL,
      prefix: 'ratelimit:'
    })
  : new MemoryStore();  // In-memory for development

// Pairing code validation rate limiter
const pairingCodeLimiter = rateLimit({
  store,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  message: 'Too many pairing attempts. Please wait 15 minutes.',
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    // Rate limit by IP for pairing
    return req.ip;
  },
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many pairing attempts',
      retryAfter: Math.ceil(req.rateLimit.resetTime / 1000),
      message: 'Please wait before trying again'
    });
  }
});

// Apply to pairing endpoints
app.post('/api/auth/pair/validate', pairingCodeLimiter, validatePairingCode);

// General authentication rate limiter
const authLimiter = rateLimit({
  store,
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100, // 100 requests per hour per IP
  message: 'Too many authentication requests from this IP.',
  skipFailedRequests: false,
  keyGenerator: (req) => req.ip
});

// Apply to all auth endpoints
app.use('/api/auth/*', authLimiter);

// IP-based blocking for brute force
const failedAttempts = new Map();

function checkBruteForce(ip: string): boolean {
  const attempts = failedAttempts.get(ip) || [];
  const now = Date.now();
  
  // Keep only attempts from last 15 minutes
  const recentAttempts = attempts.filter(time => now - time < 15 * 60 * 1000);
  
  if (recentAttempts.length >= 10) {
    // Block this IP for 1 hour
    return true;
  }
  
  failedAttempts.set(ip, recentAttempts);
  return false;
}

app.post('/api/auth/*', (req, res, next) => {
  const ip = req.ip;
  
  if (checkBruteForce(ip)) {
    return res.status(429).json({
      error: 'IP temporarily blocked',
      message: 'Too many failed attempts. Please try again later.'
    });
  }
  
  next();
});

// Track failed attempts
app.use((req, res, next) => {
  const originalSend = res.send;
  
  res.send = function(body) {
    if (res.statusCode === 401 || res.statusCode === 403) {
      const ip = req.ip;
      const attempts = failedAttempts.get(ip) || [];
      attempts.push(Date.now());
      failedAttempts.set(ip, attempts);
    }
    
    originalSend.call(this, body);
  };
  
  next();
});
```

## Security Best Practices

### Authentication Security Checklist
```bash
#!/bin/bash
# auth-security-audit.sh

echo "=== Authentication Security Audit ==="
echo "Timestamp: $(date)"
echo ""

# 1. Check token entropy
echo "1. Token Entropy:"
if [ $(echo $DESKTOP_TOKEN | wc -c) -eq 65 ]; then
  echo "  ✓ Desktop token is 64 characters (256 bits)"
else
  echo "  ✗ Desktop token length insufficient"
fi

# 2. Check for hardcoded secrets
echo "2. Hardcoded Secrets:"
if grep -r "password\|secret\|token" /opt/myra-production/src/ | \
  grep -v "process.env\|env\." | \
  grep -v "test\|spec\|example"; then
  echo "  ✗ Potential hardcoded secrets found"
else
  echo "  ✓ No hardcoded secrets found"
fi

# 3. Check session configuration
echo "3. Session Security:"
if grep -q "httpOnly: true" /opt/myra-production/src/server/config/session.ts; then
  echo "  ✓ HttpOnly cookies enabled"
else
  echo "  ✗ HttpOnly cookies not enabled"
fi

if grep -q "secure: true" /opt/myra-production/src/server/config/session.ts; then
  echo "  ✓ Secure cookies enabled (HTTPS only)"
else
  echo "  ✗ Secure cookies not enabled"
fi

# 4. Check rate limiting
echo "4. Rate Limiting:"
if curl -X POST http://localhost:3000/api/auth/pair/validate \
  -d '{"code":"111111"}' \
  -H "Content-Type: application/json" \
  -s -o /dev/null -w "%{http_code}" | grep -q "429"; then
  echo "  ✓ Rate limiting active"
else
  echo "  ✗ Rate limiting may not be active"
fi

# 5. Check CORS configuration
echo "5. CORS Configuration:"
ORIGIN_CHECK=$(curl -X OPTIONS http://localhost:3000/api/auth/pair/validate \
  -H "Origin: http://evil.com" \
  -s -o /dev/null -w "%{http_code}")

if [ "$ORIGIN_CHECK" = "200" ]; then
  echo "  ✗ CORS may be too permissive"
else
  echo "  ✓ CORS properly restricted"
fi

echo ""
echo "=== Audit Complete ==="
```

### Secure Authentication Implementation
```typescript
// Comprehensive authentication security
import crypto from 'crypto';
import bcrypt from 'bcrypt';

class SecureAuthManager {
  // Password hashing (for future user accounts)
  async hashPassword(password: string): Promise<string> {
    const saltRounds = 12;
    return bcrypt.hash(password, saltRounds);
  }
  
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }
  
  // Secure token generation
  generateSecureToken(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }
  
  // HMAC-based token signing
  signToken(payload: any, secret: string): string {
    const payloadStr = JSON.stringify(payload);
    const signature = crypto
      .createHmac('sha256', secret)
      .update(payloadStr)
      .digest('hex');
    
    return `${payloadStr}.${signature}`;
  }
  
  verifySignedToken(token: string, secret: string): any | null {
    const [payloadStr, signature] = token.split('.');
    
    if (!payloadStr || !signature) {
      return null;
    }
    
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payloadStr)
      .digest('hex');
    
    if (!crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    )) {
      return null;
    }
    
    return JSON.parse(payloadStr);
  }
  
  // Prevent timing attacks
  constantTimeCompare(a: string, b: string): boolean {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
  
  // Secure session management
  async createSecureSession(userId: string): Promise<Session> {
    const sessionId = this.generateSecureToken(32);
    const sessionToken = this.generateSecureToken(64);
    
    // Hash session token before storage
    const hashedToken = await this.hashPassword(sessionToken);
    
    const session: DBSession = {
      id: sessionId,
      userId,
      hashedToken,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      lastActivity: new Date(),
      userAgent: '', // Will be set by middleware
      ipAddress: ''  // Will be set by middleware
    };
    
    await sessionStore.save(session);
    
    return {
      sessionId,
      sessionToken,  // Return plain token to client
      expiresAt: session.expiresAt
    };
  }
  
  async validateSession(sessionId: string, sessionToken: string): Promise<boolean> {
    const session = await sessionStore.findById(sessionId);
    
    if (!session) {
      return false;
    }
    
    // Check expiration
    if (new Date() > session.expiresAt) {
      await sessionStore.delete(sessionId);
      return false;
    }
    
    // Verify token
    const isValid = await bcrypt.compare(sessionToken, session.hashedToken);
    
    if (isValid) {
      // Update last activity
      session.lastActivity = new Date();
      await sessionStore.save(session);
    }
    
    return isValid;
  }
}
```

## Recovery Procedures

### Authentication System Reset
```bash
#!/bin/bash
# auth-system-reset.sh

echo "=== Authentication System Reset ==="
echo "WARNING: This will invalidate all active sessions and tokens"
echo ""

read -p "Are you sure? This will disconnect all users. (y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Reset aborted."
  exit 1
fi

# 1. Stop the application
echo "Stopping application..."
pm2 stop myra-server

# 2. Generate new desktop token
echo "Generating new desktop token..."
NEW_DESKTOP_TOKEN=$(openssl rand -hex 32)
sed -i "s/DESKTOP_TOKEN=.*/DESKTOP_TOKEN=$NEW_DESKTOP_TOKEN/" .env.production

# 3. Generate new session secret
echo "Generating new session secret..."
NEW_SESSION_SECRET=$(openssl rand -hex 32)
sed -i "s/SESSION_SECRET=.*/SESSION_SECRET=$NEW_SESSION_SECRET/" .env.production

# 4. Clear all active sessions
echo "Clearing active sessions..."
if command -v redis-cli > /dev/null; then
  redis-cli flushdb
else
  # For in-memory store, restart will clear
  echo "Using in-memory store - sessions will clear on restart"
fi

# 5. Clear all pairing codes
echo "Clearing pairing codes..."
# This happens automatically on restart

# 6. Reset rate limiting counters
echo "Resetting rate limiting..."
# Rate limits will reset on restart

# 7. Start application
echo "Starting application..."
pm2 start myra-server

# 8. Verify
echo "Verifying authentication system..."
sleep 5

# Test desktop token
DESKTOP_RESPONSE=$(curl -H "Authorization: Bearer $NEW_DESKTOP_TOKEN" \
  http://localhost:3000/api/health \
  -s -o /dev/null -w "%{http_code}")

if [ "$DESKTOP_RESPONSE" = "200" ]; then
  echo "✓ Desktop authentication working"
else
  echo "✗ Desktop authentication failed"
fi

# Generate pairing code
PAIRING_RESPONSE=$(curl -X POST http://localhost:3000/api/auth/pairing/code \
  -H "Authorization: Bearer $NEW_DESKTOP_TOKEN" \
  -H "Content-Type: application/json" \
  -s)

if echo "$PAIRING_RESPONSE" | grep -q "code"; then
  echo "✓ Pairing system working"
else
  echo "✗ Pairing system failed"
fi

echo ""
echo "=== Authentication System Reset Complete ==="
echo "New desktop token: ${NEW_DESKTOP_TOKEN:0:8}..."
echo "All users will need to re-pair their devices"
```

### User Lockout Recovery
```bash
#!/bin/bash
# user-lockout-recovery.sh

echo "=== User Lockout Recovery ==="
echo "This will unlock users who are locked out due to failed attempts"
echo ""

read -p "Enter IP address or 'all' to unlock all: " TARGET

if [ "$TARGET" = "all" ]; then
  echo "Unlocking all IPs..."
  
  if command -v redis-cli > /dev/null; then
    # Redis store
    redis-cli --scan --pattern "ratelimit:*" | xargs redis-cli del
    redis-cli --scan --pattern "failed:*" | xargs redis-cli del
  else
    # In-memory store - restart required
    echo "In-memory store detected. Restarting application..."
    pm2 restart myra-server
  fi
  
  echo "All IPs unlocked"
else
  echo "Unlocking IP: $TARGET"
  
  if command -v redis-cli > /dev/null; then
    # Redis store
    redis-cli del "ratelimit:$TARGET"
    redis-cli del "failed:$TARGET"
    echo "IP $TARGET unlocked"
  else
    echo "In-memory store detected. Manual intervention required."
    echo "Please restart the application to clear all locks."
  fi
fi

echo ""
echo "=== Recovery Complete ==="
```

## Monitoring & Alerting

### Authentication Monitoring
```bash
#!/bin/bash
# auth-monitoring.sh

LOG_FILE="/var/log/myra/auth-monitor.log"

echo "=== Authentication Monitoring $(date) ===" >> $LOG_FILE

# 1. Check active sessions
ACTIVE_SESSIONS=$(redis-cli keys "session:*" 2>/dev/null | wc -l || echo "0")
echo "Active sessions: $ACTIVE_SESSIONS" >> $LOG_FILE

# 2. Check failed authentication attempts
FAILED_ATTEMPTS=$(grep -c "401\|403" /var/log/myra/server.log 2>/dev/null || echo "0")
echo "Failed attempts (last hour): $FAILED_ATTEMPTS" >> $LOG_FILE

# 3. Check pairing code usage
PAIRING_CODES=$(redis-cli keys "pairing:*" 2>/dev/null | wc -l || echo "0")
echo "Active pairing codes: $PAIRING_CODES" >> $LOG_FILE

# 4. Check rate limiting
RATE_LIMITED=$(grep -c "429" /var/log/myra/server.log 2>/dev/null || echo "0")
echo "Rate limited requests: $RATE_LIMITED" >> $LOG_FILE

# 5. Alert thresholds
if [ "$FAILED_ATTEMPTS" -gt 100 ]; then
  echo "ALERT: High failed authentication attempts" >> $LOG_FILE
fi

if [ "$RATE_LIMITED" -gt 50 ]; then
  echo "ALERT: High rate limiting activity" >> $LOG_FILE
fi

echo "=== Monitoring Complete ===" >> $LOG_FILE
```

### Alert Configuration
```yaml
# Prometheus alert rules for authentication
groups:
  - name: authentication_alerts
    rules:
      - alert: HighFailedAuthenticationAttempts
        expr: increase(auth_failed_attempts_total[1h]) > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High failed authentication attempts"
          description: "{{ $value }} failed attempts in the last hour"
          
      - alert: BruteForceAttackDetected
        expr: increase(auth_failed_attempts_total[5m]) > 50
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Possible brute force attack"
          description: "{{ $value }} failed attempts in 5 minutes"
          
      - alert: RateLimitingActive
        expr: increase(auth_rate_limited_total[1h]) > 100
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High rate limiting activity"
          description: "{{ $value }} requests rate limited in the last hour"
          
      - alert: SessionLeak
        expr: increase(auth_sessions_created_total[1h]) / increase(auth_sessions_ended_total[1h]) > 10
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Possible session leak"
          description: "High session creation without corresponding endings"
```

---

*User Authentication Problems Runbook v1.0*
*Last Updated: 2026-11-24*
*Based on Runbooks Prompt Framework*
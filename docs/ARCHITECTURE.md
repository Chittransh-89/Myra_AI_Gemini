# Myra AI Gemini - Architecture Document

## System Overview
Myra is a **local-first, modular desktop AI assistant** built with Electron, React, and Express.js. The architecture follows a clear separation of concerns with security as a first-class principle.

## Architecture Diagram
```
┌─────────────────────────────────────────────────────────────┐
│                    User Interface Layer                      │
├─────────────────────────────────────────────────────────────┤
│  React Frontend (Vite + TypeScript + Tailwind CSS)          │
│  • App Shell & Routing                                      │
│  • Voice Interface Components                                │
│  • Remote Control Dashboard                                  │
│  • Project Intelligence Panel                                │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP/WebSocket
┌──────────────────────────────▼──────────────────────────────┐
│                    API Gateway Layer                         │
├─────────────────────────────────────────────────────────────┤
│  Express.js Server (TypeScript)                             │
│  • /api/health - Health checks                              │
│  • /api/intelligence/* - Project analysis                   │
│  • /remote/* - Phone remote endpoints                       │
│  • /ws - Desktop WebSocket (voice & tools)                  │
│  • /remote/ws - Phone WebSocket (audio streaming)           │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                  Service Layer                               │
├──────────────┬──────────────┬──────────────┬───────────────┤
│ Voice Service│Remote Service│ Intel Service│  Tool Service │
├──────────────┼──────────────┼──────────────┼───────────────┤
│• Gemini API  │• Pairing     │• File        │• Handoff      │
│• Audio       │• Audio       │  analysis    │  Authority    │
│• Transcription│ streaming   │• GitHub      │• Tool         │
│              │• State       │  integration │  execution    │
│              │  management  │• Interview   │• Security     │
│              │              │  engine      │  validation   │
└──────────────┴──────────────┴──────────────┴───────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                  Data Layer                                  │
├─────────────────────────────────────────────────────────────┤
│  Local JSON Storage (.myra-data/)                           │
│  • Project knowledge profiles                               │
│  • Interview sessions                                       │
│  • Assessment reports                                       │
│  • Approved folder roots (Electron only)                    │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                  Native Integration Layer                    │
├─────────────────────────────────────────────────────────────┤
│  Electron Main Process (Node.js)                            │
│  • Native file picker                                       │
│  • Handoff Authority (tool security)                        │
│  • Windows app control                                      │
│  • System integration                                       │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Frontend Architecture (React)
```typescript
src/
├── components/          # Reusable UI components
│   ├── voice/          # Voice interface components
│   ├── remote/         # Remote control components
│   ├── intelligence/   # Project analysis components
│   └── common/         # Shared components
├── hooks/              # Custom React hooks
├── utils/              # Utility functions
└── App.tsx             # Root component
```

**Key Patterns:**
- Component composition over inheritance
- Custom hooks for business logic
- Context API for global state
- Error boundaries for graceful failure

### 2. Backend Architecture (Express.js)
```typescript
src/server/
├── index.ts            # Server entry point
├── config.ts           # Configuration management
├── gemini.ts           # Gemini AI provider
├── local.ts            # Local AI provider (future)
├── intelligence/       # Project intelligence module
│   ├── routes.ts       # API routes
│   ├── service.ts      # Business logic
│   ├── knowledge.ts    # Knowledge extraction
│   └── interview.ts    # Interview engine
├── remote/             # Remote control module
│   ├── routes.ts       # Remote API routes
│   ├── pairing.ts      # Pairing logic
│   ├── audioBridge.ts  # Audio streaming bridge
│   └── runtime.ts      # Runtime state management
└── tools/              # Tool execution (future)
```

**Key Patterns:**
- Modular route handlers
- Service layer for business logic
- Middleware for cross-cutting concerns
- Error handling middleware

### 3. Electron Architecture
```typescript
electron/
├── main.cjs            # Main process entry
├── preload.cjs         # Preload script (context bridge)
├── lib/
│   ├── handoffAuthority.cjs  # Tool security
│   ├── fileControl.cjs       # File system tools
│   ├── browserControl.cjs    # Browser automation
│   ├── appControl.cjs        # App management
│   ├── projectControl.cjs    # VS Code integration
│   └── taskControl.cjs       # Multi-step tasks
└── assets/             # App icons and resources
```

**Key Patterns:**
- Context isolation for security
- IPC for process communication
- Native API integration
- Handoff Authority for tool security

## Communication Patterns

### 1. HTTP API Communication
```typescript
// Client → Server
fetch('/api/intelligence/projects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: projectPath })
})

// Server → Client
res.json({ ok: true, project: projectData })
```

### 2. WebSocket Communication
```typescript
// Desktop WebSocket (/ws)
const ws = new WebSocket(`ws://localhost:3000/ws?auth=${token}`)

// Frame types
type WebSocketFrame = 
  | { type: 'audio', data: string }
  | { type: 'toolCall', functionCalls: ToolCall[] }
  | { type: 'status', state: ConnectionState }
  | { type: 'error', message: string }
```

### 3. Electron IPC Communication
```typescript
// Renderer → Main
window.myraDesktop.executeTool({
  ticket: handoffTicket,
  name: 'fileControl',
  args: { action: 'read', path: filePath }
})

// Main → Renderer
ipcMain.handle('execute-tool', async (event, payload) => {
  // Validate and execute tool
})
```

## Data Flow

### 1. Voice Conversation Flow
```
User Speech → Browser Audio API → WebSocket Audio Frame → 
Gemini Live API → Text Response → TTS Audio → 
WebSocket Audio Frame → Browser Audio API → Speaker Output
```

### 2. Phone Remote Audio Flow
```
Phone Microphone → Web Audio API → PCM16 Encoding → 
WebSocket Audio Frame → Server Validation → 
Desktop Session Attachment → Gemini Live API
```

### 3. Project Intelligence Flow
```
Project Import → File Scanning → Chunking → 
Gemini Analysis → Knowledge Extraction → 
JSON Storage → Interview Session → Assessment Report
```

## State Management

### 1. Server-Side State
```typescript
interface ServerState {
  // Remote control
  pairing: Map<string, PhoneSession>
  audioBridges: Map<string, RemoteAudioBridge>
  
  // Intelligence
  pendingImports: Map<string, ImportCache>  // 30-minute TTL
  activeInterviews: Map<string, InterviewSession>
  
  // Desktop sessions
  desktopSessions: Map<string, DesktopSession>
}
```

### 2. Client-Side State
```typescript
// React Context for global state
interface AppState {
  voice: {
    state: VoiceState
    transcript: string
    isConnected: boolean
  }
  remote: {
    isPaired: boolean
    deviceName: string | null
    code: string | null
  }
  intelligence: {
    currentProject: ProjectKnowledge | null
    activeInterview: InterviewSession | null
  }
}
```

### 3. Persistent State
```typescript
// JSON files in MYRA_DATA_DIR
{
  "projects": {
    "proj_abc123": ProjectKnowledge
  },
  "interviews": {
    "itv_def456": InterviewSession
  },
  "reports": {
    "rep_ghi789": InterviewReport
  }
}
```

## Security Architecture

### 1. Authentication Layers
```typescript
// Layer 1: Desktop token (per-run)
const MYRA_WS_TOKEN = crypto.randomBytes(32).toString('hex')

// Layer 2: Phone pairing (one-time code)
const pairingCode = generate6DigitCode()  // 5-minute expiry

// Layer 3: Phone session token
const phoneToken = crypto.randomBytes(32)  // HttpOnly cookie
```

### 2. Handoff Authority
```typescript
// Tool execution security
interface HandoffTicket {
  v: 1
  kind: 'ticket'
  callId: string
  toolName: string
  argsDigest: string  // SHA-256 of args
  sessionId: string
  expNs: string       // Monotonic deadline
  sig: string         // HMAC-SHA256
}
```

### 3. Network Security
```typescript
// Default: loopback-only
app.listen(3000, '127.0.0.1')

// Remote: Tailscale Serve only
// No public internet exposure
// HTTPS termination at Tailscale
```

## Performance Considerations

### 1. Memory Management
```typescript
// Bounded in-memory caches
const MAX_PENDING_IMPORTS = 4
const IMPORT_TTL_MS = 30 * 60 * 1000  // 30 minutes

// File size limits
const MAX_FILE_SIZE = 200 * 1024      // 200KB
const MAX_TOTAL_CHARS = 700_000       // 700K characters
```

### 2. Audio Processing
```typescript
// Real-time audio constraints
const AUDIO_CHUNK_MS = 100            // 100ms chunks
const SAMPLE_RATE = 16000             // 16kHz
const CHANNELS = 1                    // Mono

// Rate limiting
const MAX_BYTES_PER_SECOND = 64 * 1024  // 64KB/s
const BURST_BYTES = 48 * 1024           // 48KB burst
```

### 3. API Rate Limiting
```typescript
// GitHub API limits
const MAX_GITHUB_REQUESTS = 220
const GITHUB_TIMEOUT_MS = 15_000

// Pairing rate limits
const MAX_PAIRING_ATTEMPTS = 5
const PAIRING_WINDOW_MS = 60_000      // 1 minute
```

## Scalability Considerations

### 1. Horizontal Scaling (Future)
```typescript
// Stateless server design
// All state in external stores
// WebSocket connection pooling
```

### 2. Vertical Scaling
```typescript
// Worker threads for:
// - File processing
// - AI model inference (future)
// - Audio transcoding
```

### 3. Database Migration (Future)
```typescript
// JSON → SQLite migration path
// Schema versioning
// Data migration scripts
```

## Monitoring & Observability

### 1. Logging
```typescript
// Structured logging
interface AppLog {
  timestamp: string
  level: 'info' | 'warn' | 'error'
  component: string
  message: string
  data?: Record<string, unknown>
}

// Security-sensitive data never logged
```

### 2. Metrics
```typescript
// Key metrics
interface SystemMetrics {
  uptime: number
  activeSessions: number
  memoryUsage: number
  requestCount: number
  errorRate: number
}
```

### 3. Health Checks
```typescript
// Health endpoint
GET /api/health → {
  status: 'ok',
  mode: 'development',
  provider: 'gemini',
  wsAuth: 'token'
}
```

## Deployment Architecture

### 1. Development
```bash
npm run dev           # Vite dev server + Express
npm run electron:dev  # Electron with hot reload
```

### 2. Production Build
```bash
npm run build         # Build frontend + backend
npm run electron:build:win  # Windows installer
```

### 3. Distribution
```typescript
// NSIS installer for Windows
// Code signing (future)
// Auto-updates (future)
```

---

*Architecture Version: 1.0*  
*Last Updated: 2026-11-23*  
*Based on: THE VIBE CODING BLUEPRINT - System Architecture Section*
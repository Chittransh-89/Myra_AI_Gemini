# Myra AI Gemini - API Documentation

## API Philosophy
**RESTful, type-safe, and well-documented** - Myra's APIs follow consistent patterns with clear error handling and comprehensive documentation.

## API Overview

### Base URLs
```
Development: http://localhost:3000
Production: http://127.0.0.1:3000 (loopback only)
```

### Authentication Methods

#### 1. Desktop Token (Electron & Token Mode)
```http
x-myra-desktop-token: <32-byte-hex-token>
```
Required for `/api/intelligence/*` and `/api/remote/pairing*` in Electron mode.

#### 2. WebSocket Token
```
ws://127.0.0.1:3000/ws?auth=<32-byte-hex-token>
```
Required for `/ws` in Electron/token mode.

#### 3. Phone Pairing Cookie
```http
Cookie: myra_remote=<256-bit-token>; HttpOnly; SameSite=Strict; Path=/remote
```
Set by `POST /remote/pair`, required for `/remote/*` endpoints.

## Health & Status APIs

### GET /api/health
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "mode": "development",
  "provider": "gemini",
  "wsAuth": "token"
}
```

**Fields:**
- `mode`: `"development" | "production"`
- `provider`: `"gemini" | "local"`
- `wsAuth`: `"token" | "open"`

## Project Intelligence APIs

### POST /api/intelligence/import/local
Import a local folder for analysis.

**Request:**
```json
{
  "path": "C:\\Projects\\my-project"
}
```

**Response:**
```json
{
  "ok": true,
  "project": {
    "projectId": "proj_abc123def456",
    "name": "my-project",
    "source": {
      "kind": "local",
      "root": "C:\\Projects\\my-project",
      "name": "my-project"
    },
    "stats": {
      "files": 42,
      "bytes": 182000,
      "chars": 160000,
      "redactions": 3,
      "skipped": 17
    },
    "warnings": [],
    "tree": [
      { "path": "src/", "type": "dir" },
      { "path": "src/index.ts", "type": "file" }
    ],
    "skipped": [
      { "path": "node_modules/", "reason": "excludedDirectory" }
    ],
    "importedAt": "2026-11-23T10:00:00.000Z"
  },
  "aiAvailable": true
}
```

**Limits:**
- 200KB per file
- 160 files maximum
- 700,000 characters total
- 30-minute in-memory TTL

### POST /api/intelligence/import/github
Import a public GitHub repository.

**Request:**
```json
{
  "url": "https://github.com/owner/repository"
}
```

**Response:** Same as local import with different source:
```json
"source": {
  "kind": "github",
  "repoUrl": "https://github.com/owner/repository",
  "owner": "owner",
  "repo": "repository",
  "branch": "main",
  "treeSha": "abc123..."
}
```

**Limits:**
- Public repositories only
- 220 GitHub API requests max
- 15-second timeout

### POST /api/intelligence/projects/{projectId}/analyze
Analyze imported project and extract knowledge.

**Response:**
```json
{
  "ok": true,
  "project": {
    "version": 1,
    "projectId": "proj_abc123def456",
    "name": "my-project",
    "purpose": "A web application for...",
    "stack": ["React", "TypeScript", "Express"],
    "frontend": ["React components", "Tailwind CSS"],
    "backend": ["Express server", "REST API"],
    "entryPoints": [
      { "file": "src/index.ts", "symbol": "main", "note": "Application entry" }
    ],
    "keyFunctions": [
      { "file": "src/api/user.ts", "symbol": "createUser", "lines": "45-60" }
    ],
    "modules": [
      { "name": "auth", "path": "src/auth/", "role": "Authentication logic" }
    ],
    "apiEndpoints": [
      { "method": "GET", "path": "/api/users", "file": "src/routes/users.ts" }
    ],
    "dataModels": [
      { "name": "User", "file": "src/models/user.ts", "note": "User entity" }
    ],
    "auth": ["JWT tokens", "Bearer authentication"],
    "dataFlow": ["API → Service → Database"],
    "aiIntegration": ["Gemini API for chat"],
    "externalServices": ["PostgreSQL", "Redis"],
    "dependencies": [
      { "name": "express", "role": "HTTP server" },
      { "name": "react", "role": "UI framework" }
    ],
    "designDecisions": [
      {
        "decision": "Use SQLite for development",
        "rationale": "Simpler setup",
        "evidence": [{ "file": "src/config/database.ts" }],
        "confidence": "confirmed"
      }
    ],
    "limitations": ["No email service integration"],
    "unknowns": ["Deployment strategy"],
    "codeSamples": [
      {
        "file": "src/index.ts",
        "lines": "1-20",
        "content": "import express from 'express'...",
        "note": "Server setup"
      }
    ],
    "stats": { "files": 42, "bytes": 182000, "chars": 160000, "redactions": 3, "skipped": 17 },
    "warnings": [],
    "model": "gemini-3.8-flash",
    "createdAt": "2026-11-23T10:05:00.000Z"
  }
}
```

### GET /api/intelligence/projects
List all analyzed projects.

**Response:**
```json
{
  "ok": true,
  "projects": [
    {
      "projectId": "proj_abc123def456",
      "name": "my-project",
      "sourceKind": "local",
      "sourceLabel": "C:\\Projects\\my-project",
      "analyzedAt": "2026-11-23T10:05:00.000Z",
      "stack": ["React", "Express"],
      "files": 42
    }
  ]
}
```

### GET /api/intelligence/projects/{projectId}
Get full project knowledge with interviews.

**Response:** Full project knowledge plus:
```json
{
  "ok": true,
  "project": { /* ProjectKnowledge */ },
  "interviews": [
    {
      "id": "itv_def456ghi789",
      "projectName": "my-project",
      "type": "full",
      "difficulty": "medium",
      "status": "ended",
      "createdAt": "2026-11-23T10:10:00.000Z",
      "updatedAt": "2026-11-23T10:25:00.000Z",
      "questionCount": 8,
      "reportId": "rep_ghi789jkl012"
    }
  ]
}
```

## Interview APIs

### POST /api/intelligence/interviews
Create a new interview session.

**Request:**
```json
{
  "projectId": "proj_abc123def456",
  "type": "full",
  "difficulty": "medium"
}
```

**Types:** `"full" | "architecture" | "codeReview"`
**Difficulties:** `"beginner" | "medium" | "advanced"`

**Response:**
```json
{
  "ok": true,
  "session": {
    "version": 1,
    "id": "itv_def456ghi789",
    "projectId": "proj_abc123def456",
    "projectName": "my-project",
    "type": "full",
    "difficulty": "medium",
    "status": "active",
    "stage": "architecture",
    "stagePlan": ["purpose", "architecture", "implementation", "advanced"],
    "stageIndex": 0,
    "currentQuestion": {
      "id": "q_123",
      "text": "What is the overall purpose of this project?",
      "stage": "purpose",
      "evidence": [
        { "file": "README.md", "note": "Project description" }
      ],
      "expectedTopics": ["purpose", "problem solved", "target users"],
      "hints": ["Check the README file", "Look at package.json"]
    },
    "questions": [],
    "turns": [],
    "assessments": [],
    "hintsUsed": 0,
    "skips": 0,
    "reportId": null,
    "createdAt": "2026-11-23T10:10:00.000Z",
    "updatedAt": "2026-11-23T10:10:00.000Z"
  },
  "question": { /* InterviewQuestion */ }
}
```

### POST /api/intelligence/interviews/{interviewId}/answer
Submit answer to current question.

**Request:**
```json
{
  "answer": "The project is a web application that..."
}
```

**Response:**
```json
{
  "ok": true,
  "session": { /* Updated InterviewSession */ },
  "assessment": {
    "correctness": "solid",
    "score": 8.5,
    "missing": ["target users"],
    "misconceptions": [],
    "needsFollowUp": false,
    "note": "Good understanding of purpose"
  },
  "nextQuestion": { /* Next InterviewQuestion or null */ },
  "finished": false
}
```

### GET /api/intelligence/interviews
List interviews (optional project filter).

**Query Parameters:**
- `projectId` (optional): Filter by project

**Response:**
```json
{
  "ok": true,
  "interviews": [
    {
      "id": "itv_def456ghi789",
      "projectId": "proj_abc123def456",
      "projectName": "my-project",
      "type": "full",
      "difficulty": "medium",
      "status": "ended",
      "createdAt": "2026-11-23T10:10:00.000Z",
      "updatedAt": "2026-11-23T10:25:00.000Z",
      "questionCount": 8,
      "reportId": "rep_ghi789jkl012"
    }
  ]
}
```

### GET /api/intelligence/interviews/{interviewId}
Get interview session with report.

**Response:**
```json
{
  "ok": true,
  "session": { /* InterviewSession */ },
  "report": { /* InterviewReport or null */ }
}
```

### POST /api/intelligence/interviews/{interviewId}/hint
Get hints for current question.

**Response:**
```json
{
  "ok": true,
  "hints": ["Check the README file", "Look at the main entry point"]
}
```

### POST /api/intelligence/interviews/{interviewId}/explain
Get explanation of current concept.

**Response:**
```json
{
  "ok": true,
  "concept": "MVC Architecture",
  "explanation": "MVC stands for Model-View-Controller..."
}
```

### POST /api/intelligence/interviews/{interviewId}/skip
Skip current question.

**Response:**
```json
{
  "ok": true,
  "session": { /* Updated InterviewSession */ },
  "question": { /* Next InterviewQuestion or null */ }
}
```

### GET /api/intelligence/interviews/{interviewId}/code
Get code samples for current question.

**Response:**
```json
{
  "ok": true,
  "samples": [
    {
      "file": "src/index.ts",
      "lines": "1-20",
      "content": "import express from 'express'...",
      "note": "Server entry point"
    }
  ]
}
```

### POST /api/intelligence/interviews/{interviewId}/pause
Pause interview.

**Response:**
```json
{
  "ok": true,
  "session": { /* InterviewSession with status: "paused" */ }
}
```

### POST /api/intelligence/interviews/{interviewId}/resume
Resume paused interview.

**Response:**
```json
{
  "ok": true,
  "session": { /* InterviewSession with status: "active" */ }
}
```

### POST /api/intelligence/interviews/{interviewId}/end
End interview and generate report.

**Response:**
```json
{
  "ok": true,
  "session": { /* InterviewSession with status: "ended" */ },
  "report": { /* InterviewReport */ }
}
```

### POST /api/intelligence/interviews/{interviewId}/transcript
Submit voice transcription (for voice interviews).

**Request:**
```json
{
  "role": "candidate",
  "text": "The project uses React for the frontend..."
}
```

**Response:**
```json
{
  "ok": true
}
```

### GET /api/intelligence/reports/{reportId}
Get assessment report.

**Response:**
```json
{
  "ok": true,
  "report": {
    "version": 1,
    "id": "rep_ghi789jkl012",
    "interviewId": "itv_def456ghi789",
    "projectId": "proj_abc123def456",
    "projectName": "my-project",
    "type": "full",
    "difficulty": "medium",
    "createdAt": "2026-11-23T10:25:00.000Z",
    "questions": [ /* InterviewQuestions */ ],
    "overallScore": 78,
    "scores": {
      "technicalKnowledge": 16,
      "codeUnderstanding": 18,
      "architectureUnderstanding": 15,
      "reasoning": 14,
      "communicationClarity": 15
    },
    "verdict": "strong_understanding",
    "summary": "Candidate demonstrates solid understanding...",
    "weakAreas": ["Database design", "Error handling"],
    "incorrectAssumptions": ["Assumed MongoDB was used"],
    "topicsToRevise": ["SQL optimization", "API versioning"],
    "followUpTopics": ["Scalability strategies"],
    "revisionPlan": ["Review database indexing..."]
  }
}
```

## Remote Control APIs

### GET /remote
Phone dashboard HTML (serves React app).

**Headers:** None required (public endpoint when remote enabled)

### POST /remote/pair
Pair phone with desktop.

**Request:**
```json
{
  "code": "123456",
  "deviceName": "Pixel 8"
}
```

**Success Response:**
```json
{
  "ok": true,
  "deviceName": "Pixel 8",
  "expiresAt": 1763943200000,
  "snapshot": {
    "serverTime": 1763900000000,
    "uptimeMs": 123456,
    "remote": {
      "enabled": true,
      "publicUrl": "https://myra-pc.example.ts.net/remote",
      "phoneConnected": true,
      "deviceName": "Pixel 8",
      "connectedAt": 1763899900000
    },
    "pc": {
      "connected": true,
      "lastSeenAt": 1763899990000,
      "clients": 1
    },
    "myra": {
      "state": "ACTIVE",
      "mode": "legacy",
      "speaking": false
    },
    "mic": {
      "source": "desktop",
      "defaultSource": "desktop",
      "streaming": false
    },
    "error": null
  }
}
```

**Error Responses:**
```json
{
  "ok": false,
  "error": "invalidCode"
}
```
```json
{
  "ok": false,
  "error": "rateLimited",
  "retryAfterMs": 45000
}
```

### POST /remote/unpair
Unpair current phone.

**Headers:** Phone cookie required

**Response:**
```json
{
  "ok": true,
  "snapshot": { /* Updated snapshot */ }
}
```

### GET /remote/api/state
Get current remote state.

**Headers:** Phone cookie required

**Response:**
```json
{
  "serverTime": 1763900000000,
  "uptimeMs": 123456,
  "remote": {
    "enabled": true,
    "publicUrl": "https://myra-pc.example.ts.net/remote",
    "phoneConnected": true,
    "deviceName": "Pixel 8",
    "connectedAt": 1763899900000
  },
  "pc": {
    "connected": true,
    "lastSeenAt": 1763899990000,
    "clients": 1
  },
  "myra": {
    "state": "ACTIVE",
    "mode": "legacy",
    "speaking": false
  },
  "mic": {
    "source": "phone",
    "defaultSource": "phone",
    "streaming": true
  },
  "error": null
}
```

### GET /api/remote/pairing
Get desktop pairing information.

**Headers:** `x-myra-desktop-token` required

**Response:**
```json
{
  "ok": true,
  "enabled": true,
  "code": "123456",
  "expiresAt": 1763943200000,
  "pairedDevice": "Pixel 8",
  "pairedAt": 1763899900000,
  "remoteUrl": "https://myra-pc.example.ts.net/remote",
  "serverTime": 1763900000000
}
```

### POST /api/remote/pairing/rotate
Generate new pairing code.

**Headers:** `x-myra-desktop-token` required

**Response:** Same as GET /api/remote/pairing with new code

## WebSocket APIs

### /ws - Desktop Voice & Tools
**URL:** `ws://127.0.0.1:3000/ws?auth=<token>&interview=<optional>`

**Client → Server Frames:**

1. **Audio**
```json
{
  "type": "audio",
  "data": "<base64 PCM16 16kHz>"
}
```

2. **Tool Response** (Electron mode only)
```json
{
  "type": "toolResponse",
  "functionResponses": [
    {
      "id": "call_123",
      "name": "fileControl",
      "response": {
        "output": {
          "ok": true,
          "content": "File content...",
          "bytes": 1024
        }
      }
    }
  ]
}
```

**Server → Client Frames:**

1. **Status**
```json
{
  "type": "status",
  "state": "connecting" | "connected" | "disconnected" | "error"
}
```

2. **Audio** (Model speech)
```json
{
  "type": "audio",
  "data": "<base64 PCM>"
}
```

3. **Tool Call**
```json
{
  "type": "toolCall",
  "functionCalls": [
    {
      "id": "call_123",
      "name": "fileControl",
      "args": {
        "action": "read",
        "path": "C:\\notes.txt"
      },
      "handoff": {
        "ticket": "<base64url>"
      }
    }
  ]
}
```

4. **Transcript** (Interview mode)
```json
{
  "type": "transcript",
  "role": "interviewer" | "candidate",
  "text": "What is the purpose of this project?"
}
```

5. **Tool Completion** (Main-executed tools)
```json
{
  "type": "toolCompletion",
  "callId": "call_123",
  "name": "fileControl",
  "status": "success" | "execution_error" | "denied" | "cancelled",
  "output": {
    "ok": true,
    "content": "File content..."
  }
}
```

### /remote/ws - Phone Audio
**URL:** `ws://127.0.0.1:3000/remote/ws` (cookie authentication)

**Client → Server Frames:**

1. **Request State**
```json
{
  "type": "requestState"
}
```

2. **Ping**
```json
{
  "type": "ping",
  "ts": 1234567890
}
```

3. **Audio Start**
```json
{
  "type": "audioStart"
}
```

4. **Audio Chunk**
```json
{
  "type": "audio",
  "data": "<base64 PCM16 16kHz mono>",
  "seq": 42
}
```

5. **Audio Stop**
```json
{
  "type": "audioStop"
}
```

**Server → Client Frames:**

1. **Remote State**
```json
{
  "type": "remoteState",
  "snapshot": { /* RemoteSnapshot */ }
}
```

2. **Pong**
```json
{
  "type": "pong",
  "ts": 1234567890,
  "serverTime": 1763900000000
}
```

3. **Audio Ack**
```json
{
  "type": "audioAck",
  "seq": 42,
  "bytes": 3200
}
```

4. **Error**
```json
{
  "type": "error",
  "code": "sessionUnavailable",
  "message": "No desktop session is active"
}
```

## Tool APIs

### Tool Execution Flow

#### 1. Tool Call Generation
Gemini generates tool call, server adds handoff ticket:
```json
{
  "type": "toolCall",
  "functionCalls": [
    {
      "id": "call_123",
      "name": "fileControl",
      "args": { "action": "read", "path": "C:\\notes.txt" },
      "handoff": {
        "ticket": "eyJ2IjoxLCJraW5kIj...<base64url>"
      }
    }
  ]
}
```

#### 2. Renderer Execution (Electron)
```javascript
const result = await window.myraDesktop.executeTool({
  ticket: "eyJ2IjoxLCJraW5kIj...",
  name: "fileControl",
  args: { action: "read", path: "C:\\notes.txt" }
})
```

#### 3. Tool Completion Delivery
```json
{
  "type": "toolCompletion",
  "callId": "call_123",
  "name": "fileControl",
  "status": "success",
  "output": {
    "ok": true,
    "content": "# My Notes\n\nThis is my note file...",
    "bytes": 1024
  }
}
```

## Error Handling

### Error Response Format
```json
{
  "ok": false,
  "error": "errorCode",
  "message": "Human-readable message (intelligence routes only)"
}
```

### Common Error Codes

#### Intelligence Errors
- `projectFilesUnavailable`: In-memory import expired
- `rateLimited`: GitHub API rate limit reached
- `privateUnsupported`: Private repository not supported
- `analysisFailed`: AI analysis failed
- `interviewEnded`: Interview already ended
- `noOpenQuestion`: No current question to answer

#### Remote Errors
- `invalidCode`: Wrong or expired pairing code
- `rateLimited`: Too many pairing attempts
- `sessionUnavailable`: No desktop session active
- `audioRateLimited`: Audio too fast (token bucket)
- `badAudio`: Malformed audio frame
- `audioTooLarge`: Audio chunk > 8KB

#### General Errors
- `badRequest`: Invalid JSON or missing fields
- `unauthorized`: Missing or invalid authentication
- `notFound`: Resource not found
- `internalError`: Server error

## Rate Limiting

### Intelligence Routes
- GitHub imports: 220 requests per import
- File analysis: 200KB/file, 160 files max
- Interview answers: 8000 characters max

### Remote Routes
- Pairing: 5 attempts per minute per client
- Audio: 64KB/s sustained, 48KB burst
- WebSocket frames: 64KB max payload

## Caching Headers

### Intelligence Responses
```
Cache-Control: no-store
```

### Remote Pairing Responses
```
Cache-Control: no-store
Pragma: no-cache
```

## CORS Policy
- **Intelligence routes**: Reject foreign `Origin` headers
- **Remote routes**: Accept same-origin only
- **WebSocket**: Origin validation on upgrade

## Content Types
- **JSON**: `application/json`
- **HTML**: `text/html` (dashboard only)
- **Plain text**: `text/plain` (errors)

## Versioning
- No API version headers
- WebSocket tickets: `v: 1`
- Intelligence documents: `version: 1`
- Backward compatible changes only

## Testing

### Example API Calls

```bash
# Health check
curl http://localhost:3000/api/health

# List projects (desktop token required)
curl -H "x-myra-desktop-token: $TOKEN" \
  http://localhost:3000/api/intelligence/projects

# Create interview
curl -H "x-myra-desktop-token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"proj_abc123","type":"full","difficulty":"medium"}' \
  http://localhost:3000/api/intelligence/interviews

# Phone pairing
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"code":"123456","deviceName":"Pixel 8"}' \
  https://myra-pc.example.ts.net/remote/pair
```

---

*API Documentation Version: 1.0*  
*Last Updated: 2026-11-23*  
*Based on: THE VIBE CODING BLUEPRINT - API Design Section*
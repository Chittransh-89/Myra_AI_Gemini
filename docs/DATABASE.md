# Myra AI Gemini - Data Storage Design

## Storage Philosophy
**Local-first, JSON-based, file-per-entity** - Myra uses a simple file-based storage system that prioritizes privacy, portability, and simplicity over complex database management.

## Storage Architecture

### Directory Structure
```
.myra-data/                     # MYRA_DATA_DIR
├── projects/                   # Analyzed project knowledge
│   ├── proj_abc123def456.json
│   └── proj_789ghi012jkl.json
├── interviews/                 # Interview sessions
│   ├── itv_mno345pqr678.json
│   └── itv_stu901vwx234.json
├── reports/                    # Assessment reports
│   ├── rep_yza567bcd890.json
│   └── rep_efg123hij456.json
└── metadata/                   # System metadata (future)
    └── stats.json
```

### Electron-Specific Storage
```
%APPDATA%/myra/                # Windows: C:\Users\<user>\AppData\Roaming\myra\
├── approved-project-roots.json  # Approved folder paths
├── config.json                  # User preferences (future)
└── logs/                        # Application logs (future)
```

## Data Models

### 1. Project Knowledge (`ProjectKnowledge`)
```typescript
interface ProjectKnowledge {
  version: 1
  projectId: string  // Format: proj_[a-f0-9]{8,32}
  name: string      // Project name (folder/repo name)
  
  source: {
    kind: 'local' | 'github'
    // Local source
    root?: string
    // GitHub source  
    repoUrl?: string
    owner?: string
    repo?: string
    branch?: string
    treeSha?: string
  }
  
  // Technical analysis
  purpose: string
  problem: string
  stack: string[]
  frontend: string[]
  backend: string[]
  
  // Evidence-based claims
  entryPoints: EvidenceRef[]
  keyFunctions: EvidenceRef[]
  modules: { name: string; path: string; role: string }[]
  apiEndpoints: { method?: string; path: string; file: string }[]
  dataModels: { name: string; file: string; note: string }[]
  
  // Behavior analysis
  auth: string[]
  dataFlow: string[]
  aiIntegration: string[]
  externalServices: string[]
  dependencies: { name: string; role: string }[]
  
  // Design decisions
  designDecisions: DesignDecision[]
  
  // Honest gaps
  limitations: string[]
  unknowns: string[]
  
  // Code samples (redacted)
  codeSamples: CodeSnippet[]
  
  // Metadata
  stats: {
    files: number
    bytes: number
    chars: number
    redactions: number
    skipped: number
  }
  
  warnings: string[]
  model: string  // e.g., "gemini-3.8-flash"
  createdAt: string  // ISO timestamp
}
```

### 2. Interview Session (`InterviewSession`)
```typescript
interface InterviewSession {
  version: 1
  id: string  // Format: itv_[a-f0-9]{8,32}
  projectId: string
  projectName: string
  type: 'full' | 'architecture' | 'codeReview'
  difficulty: 'beginner' | 'medium' | 'advanced'
  
  // Session state
  status: 'active' | 'paused' | 'ended'
  stage: string
  stagePlan: string[]
  stageIndex: number
  
  // Current question
  currentQuestion: InterviewQuestion | null
  
  // History
  questions: InterviewQuestion[]
  turns: InterviewTurn[]
  assessments: AnswerAssessment[]
  
  // Usage metrics
  hintsUsed: number
  skips: number
  
  // Linked report
  reportId: string | null  // Format: rep_[a-f0-9]{8,32}
  
  // Timestamps
  createdAt: string  // ISO timestamp
  updatedAt: string  // ISO timestamp
  endedAt?: string   // Optional end timestamp
}
```

### 3. Assessment Report (`InterviewReport`)
```typescript
interface InterviewReport {
  version: 1
  id: string  // Format: rep_[a-f0-9]{8,32}
  interviewId: string
  projectId: string
  projectName: string
  type: string
  difficulty: string
  
  // Questions and answers
  questions: InterviewQuestion[]
  
  // Scoring
  overallScore: number  // 0-100
  scores: {
    technicalKnowledge: number      // 0-20
    codeUnderstanding: number       // 0-20
    architectureUnderstanding: number  // 0-20
    reasoning: number               // 0-20
    communicationClarity: number    // 0-20
  }
  
  // Verdict
  verdict: 'strong_understanding' | 'architecture_only' | 
           'memorized' | 'serious_gaps'
  
  // Detailed feedback
  summary: string
  weakAreas: string[]
  incorrectAssumptions: string[]
  topicsToRevise: string[]
  followUpTopics: string[]
  revisionPlan: string[]
  
  // Metadata
  createdAt: string  // ISO timestamp
}
```

## Supporting Types

### Evidence References
```typescript
interface EvidenceRef {
  file: string      // Relative path
  symbol?: string   // Function/class name
  lines?: string    // "10-25" or "45"
  note?: string     // Human-readable note
}
```

### Design Decisions
```typescript
interface DesignDecision {
  decision: string
  rationale: string
  evidence: EvidenceRef[]
  confidence: 'confirmed' | 'inferred' | 'unknown'
}
```

### Code Samples
```typescript
interface CodeSnippet {
  file: string
  lines: string     // "50-75"
  content: string   // Redacted code
  note?: string
}
```

### Interview Questions
```typescript
interface InterviewQuestion {
  id: string
  text: string
  stage: string
  evidence: EvidenceRef[]
  expectedTopics: string[]
  hints: string[]    // Up to 3 hints
  explanation?: { concept: string; text: string }
}
```

### Interview Turns
```typescript
interface InterviewTurn {
  role: 'interviewer' | 'candidate'
  text: string
  at: string  // ISO timestamp
  questionId?: string
  source: 'text' | 'voice'
}
```

### Answer Assessments
```typescript
interface AnswerAssessment {
  correctness: 'solid' | 'partial' | 'vague' | 'incorrect'
  score: number  // 0-10
  missing: string[]
  misconceptions: string[]
  needsFollowUp: boolean
  note: string
}
```

## Storage Operations

### 1. File Operations
```typescript
// Read project knowledge
async function readProject(projectId: string): Promise<ProjectKnowledge> {
  const path = join(MYRA_DATA_DIR, 'projects', `${projectId}.json`)
  const content = await fs.readFile(path, 'utf-8')
  return JSON.parse(content)
}

// Write project knowledge
async function writeProject(project: ProjectKnowledge): Promise<void> {
  const path = join(MYRA_DATA_DIR, 'projects', `${project.projectId}.json`)
  await fs.writeFile(path, JSON.stringify(project, null, 2))
}

// List all projects
async function listProjects(): Promise<ProjectSummary[]> {
  const dir = join(MYRA_DATA_DIR, 'projects')
  const files = await fs.readdir(dir)
  return Promise.all(
    files.filter(f => f.endsWith('.json')).map(async file => {
      const content = await fs.readFile(join(dir, file), 'utf-8')
      const project = JSON.parse(content) as ProjectKnowledge
      return {
        projectId: project.projectId,
        name: project.name,
        sourceKind: project.source.kind,
        sourceLabel: project.source.kind === 'local' 
          ? project.source.root 
          : project.source.repoUrl,
        analyzedAt: project.createdAt,
        stack: project.stack,
        files: project.stats.files
      }
    })
  )
}
```

### 2. Memory Cache (Temporary Storage)
```typescript
// In-memory import cache (30-minute TTL)
const pendingImports = new Map<string, {
  files: Map<string, string>  // path → content
  stats: ImportStats
  importedAt: number
}>()

// Cache management
function getImport(projectId: string): ImportCache | null {
  const cache = pendingImports.get(projectId)
  if (!cache) return null
  
  // Check TTL (30 minutes)
  if (Date.now() - cache.importedAt > 30 * 60 * 1000) {
    pendingImports.delete(projectId)
    return null
  }
  
  return cache
}

// Cache limits
const MAX_PENDING_IMPORTS = 4
const MAX_TOTAL_CHARS = 700_000
```

### 3. Session Storage (Runtime)
```typescript
// Active interviews (in-memory only)
const activeInterviews = new Map<string, InterviewSession>()

// Phone pairing sessions
const pairingSessions = new Map<string, {
  tokenHash: string      // SHA-256 of phone token
  deviceName: string
  connectedAt: number
  socket?: WebSocket
}>()

// Audio bridges
const audioBridges = new Map<string, RemoteAudioBridge>()
```

## Data Security

### 1. Secrets Redaction
```typescript
// Patterns to redact from stored data
const SECRET_PATTERNS = [
  /(["'`]?)(?:api[_-]?key|secret|token|password|credential|private[_-]?key)\1\s*[:=]\s*(["'`])([^"'`\n]{8,})\2/gi,
  /-----BEGIN (?:RSA|DSA|EC|OPENSSH) PRIVATE KEY-----[^]+?-----END (?:RSA|DSA|EC|OPENSSH) PRIVATE KEY-----/g,
  /(?:https?:\/\/)[^\/]+@[^\s"']+/g,  // Basic auth URLs
  /(["'`])(?:mongodb|postgres|mysql|redis):\/\/[^:]+:[^@]+@[^"'`\n]+\1/g
]

function redactSecrets(text: string): string {
  let redacted = text
  let redactionCount = 0
  
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      redactionCount++
      return '[REDACTED]'
    })
  }
  
  return redacted
}
```

### 2. File Path Sanitization
```typescript
// Ensure paths stay within allowed boundaries
function sanitizePath(root: string, path: string): string {
  const absolute = resolve(root, path)
  
  // Check it's within the root
  if (!absolute.startsWith(resolve(root))) {
    throw new Error('Path traversal attempt')
  }
  
  // Check for sensitive paths
  const sensitive = [
    /\.env$/i,
    /\.aws\/credentials$/i,
    /\.ssh\/id_/i,
    /\.kube\/config$/i,
    /keys?\.(pem|key|pfx|p12)$/i
  ]
  
  for (const pattern of sensitive) {
    if (pattern.test(absolute)) {
      throw new Error('Sensitive path blocked')
    }
  }
  
  return absolute
}
```

### 3. Data Validation
```typescript
// Schema validation for stored data
import { z } from 'zod'

const ProjectKnowledgeSchema = z.object({
  version: z.literal(1),
  projectId: z.string().regex(/^proj_[a-f0-9]{8,32}$/),
  name: z.string().min(1).max(200),
  // ... more validation
})

function validateProject(data: unknown): ProjectKnowledge {
  return ProjectKnowledgeSchema.parse(data)
}
```

## Performance Considerations

### 1. File Size Limits
```typescript
const STORAGE_LIMITS = {
  maxFileSize: 200 * 1024,        // 200KB per file (import)
  maxTotalChars: 700_000,         // 700K characters per import
  maxProjectFiles: 160,           // Max files per project
  maxJsonSize: 10 * 1024 * 1024,  // 10MB max JSON file
}
```

### 2. Indexing Strategy (Future)
```typescript
// Simple file-based indexing
interface StorageIndex {
  projects: Record<string, {
    name: string
    sourceKind: 'local' | 'github'
    analyzedAt: string
    size: number
  }>
  interviews: Record<string, {
    projectId: string
    status: string
    createdAt: string
  }>
  lastUpdated: string
}

// Auto-rebuild index on startup
async function rebuildIndex(): Promise<StorageIndex> {
  // Scan directories and build index
}
```

### 3. Backup Strategy
```typescript
// Simple backup on write
async function writeWithBackup(
  path: string, 
  data: string
): Promise<void> {
  // Check if file exists
  if (await fs.exists(path)) {
    const backupPath = `${path}.backup-${Date.now()}`
    await fs.copyFile(path, backupPath)
  }
  
  // Write new file
  await fs.writeFile(path, data)
  
  // Clean up old backups (keep last 5)
  await cleanupOldBackups(path)
}
```

## Migration Strategy

### 1. Schema Versioning
```typescript
// Each JSON file includes version
interface VersionedData {
  version: number
  // ... data
}

// Migration functions
const MIGRATIONS = {
  1: (data: any) => data,  // v1 → v1 (identity)
  2: (data: any) => ({     // v1 → v2
    ...data,
    version: 2,
    newField: 'default'
  })
}

async function migrateData(path: string): Promise<void> {
  const content = await fs.readFile(path, 'utf-8')
  const parsed = JSON.parse(content)
  
  let current = parsed
  while (current.version < LATEST_VERSION) {
    const migrator = MIGRATIONS[current.version + 1]
    if (!migrator) break
    
    current = migrator(current)
  }
  
  await fs.writeFile(path, JSON.stringify(current, null, 2))
}
```

### 2. Data Cleanup
```typescript
// Automatic cleanup of stale data
async function cleanupStaleData(): Promise<void> {
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000) // 30 days
  
  // Clean up old projects
  const projects = await listProjects()
  for (const project of projects) {
    const analyzed = new Date(project.analyzedAt).getTime()
    if (analyzed < cutoff) {
      await deleteProject(project.projectId)
    }
  }
  
  // Clean up old backups
  await cleanupOldBackups()
}
```

## Monitoring & Metrics

### 1. Storage Metrics
```typescript
interface StorageMetrics {
  totalProjects: number
  totalInterviews: number
  totalReports: number
  totalSize: number  // bytes
  averageProjectSize: number
  oldestProject: string | null  // timestamp
  newestProject: string | null  // timestamp
}

async function getStorageMetrics(): Promise<StorageMetrics> {
  // Calculate metrics from storage
}
```

### 2. Health Checks
```typescript
async function checkStorageHealth(): Promise<{
  healthy: boolean
  issues: string[]
}> {
  const issues: string[] = []
  
  // Check directory exists
  if (!await fs.exists(MYRA_DATA_DIR)) {
    issues.push('Storage directory missing')
  }
  
  // Check write permissions
  try {
    const testFile = join(MYRA_DATA_DIR, '.healthcheck')
    await fs.writeFile(testFile, 'test')
    await fs.unlink(testFile)
  } catch {
    issues.push('No write permission')
  }
  
  // Check disk space (future)
  
  return {
    healthy: issues.length === 0,
    issues
  }
}
```

---

*Database Design Version: 1.0*  
*Last Updated: 2026-11-23*  
*Based on: THE VIBE CODING BLUEPRINT - Data Storage Section*
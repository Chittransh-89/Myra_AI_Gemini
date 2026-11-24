# Myra AI Gemini - Code Style Guide

## Philosophy
**Consistent, readable, and maintainable** - Code should be written for humans first, computers second. Consistency across the codebase is more important than personal preference.

## TypeScript Configuration

### tsconfig.json Rules
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "types": ["node"],
    "jsx": "react-jsx"
  }
}
```

## Naming Conventions

### Files and Directories
```typescript
// kebab-case for files and directories
src/
├── components/
│   ├── voice-interface/
│   │   ├── voice-indicator.tsx
│   │   └── transcript-display.tsx
│   └── common/
│       ├── button.tsx
│       └── card.tsx
├── hooks/
│   ├── use-voice-state.ts
│   └── use-remote-control.ts
└── utils/
    ├── audio-processing.ts
    └── validation-helpers.ts
```

### Variables and Functions
```typescript
// camelCase for variables and functions
const userName = 'John'
const projectCount = 42

function calculateScore(answer: string): number {
  // ...
}

async function fetchProjectData(id: string): Promise<Project> {
  // ...
}

// Boolean variables start with is/has/should
const isConnected = true
const hasPermission = false
const shouldRetry = true
```

### Classes and Types
```typescript
// PascalCase for classes, interfaces, types, enums
class InterviewEngine {
  // ...
}

interface ProjectKnowledge {
  // ...
}

type WebSocketFrame = AudioFrame | ToolCallFrame

enum VoiceState {
  IDLE = 'idle',
  LISTENING = 'listening',
  PROCESSING = 'processing',
  SPEAKING = 'speaking'
}

// Constants in UPPER_SNAKE_CASE
const MAX_FILE_SIZE = 200 * 1024
const DEFAULT_PORT = 3000
const API_VERSION = '1.0'
```

### React Components
```typescript
// PascalCase for components
function VoiceIndicator({ state, size }: VoiceIndicatorProps) {
  return (
    <div className={`voice-indicator ${state}`}>
      {/* ... */}
    </div>
  )
}

// Use named exports for components
export { VoiceIndicator }
export type { VoiceIndicatorProps }

// Props interface naming: ComponentNameProps
interface VoiceIndicatorProps {
  state: VoiceState
  size?: 'small' | 'medium' | 'large'
  className?: string
}
```

## Code Organization

### File Structure
```typescript
// 1. Imports (grouped and sorted)
import React from 'react'
import { useCallback, useState } from 'react'

import { Button } from '@/components/common/button'
import { Card } from '@/components/common/card'

import { useVoiceState } from '@/hooks/use-voice-state'
import { formatTimestamp } from '@/utils/date-helpers'

// 2. Types and Interfaces
interface ComponentProps {
  // ...
}

type ComponentState = 'idle' | 'loading' | 'error'

// 3. Constants
const MAX_RETRIES = 3
const RETRY_DELAY = 1000

// 4. Component/Function
export function MyComponent({ prop1, prop2 }: ComponentProps) {
  // 5. State hooks
  const [state, setState] = useState<ComponentState>('idle')
  const [count, setCount] = useState(0)
  
  // 6. Effect hooks
  useEffect(() => {
    // ...
  }, [dependencies])
  
  // 7. Event handlers
  const handleClick = useCallback(() => {
    // ...
  }, [dependencies])
  
  // 8. Derived values
  const isDisabled = state === 'loading' || count >= MAX_RETRIES
  
  // 9. Render
  return (
    <div>
      {/* ... */}
    </div>
  )
}

// 10. Helper functions (if small, otherwise extract)
function calculateSomething(value: number): number {
  return value * 2
}
```

### Function Length and Complexity
```typescript
// GOOD: Small, focused functions
function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString()
}

// BAD: Too long, doing too much
function processUserDataAndSendEmailAndUpdateDatabase(user: User) {
  // 50 lines of mixed concerns
}
```

### Component Organization
```typescript
// Keep components small and focused
// Extract logic to custom hooks

// Component file
function UserProfile({ userId }: UserProfileProps) {
  const { user, isLoading, error } = useUser(userId)
  const { updateProfile } = useProfileActions()
  
  if (isLoading) return <LoadingSpinner />
  if (error) return <ErrorMessage error={error} />
  
  return (
    <ProfileCard user={user} onUpdate={updateProfile} />
  )
}

// Custom hook file
function useUser(userId: string) {
  const [state, setState] = useState<UserState>({ 
    user: null, 
    isLoading: true, 
    error: null 
  })
  
  useEffect(() => {
    fetchUser(userId).then(
      user => setState({ user, isLoading: false, error: null }),
      error => setState({ user: null, isLoading: false, error })
    )
  }, [userId])
  
  return state
}
```

## TypeScript Best Practices

### Use Explicit Types
```typescript
// GOOD: Explicit return types
function calculateTotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price, 0)
}

async function fetchData(url: string): Promise<Data> {
  const response = await fetch(url)
  return response.json()
}

// BAD: Implicit any
function process(data) {  // data: any
  return data.value * 2  // return type: any
}
```

### Avoid Any Type
```typescript
// GOOD: Use unknown or specific types
function parseJson(json: string): unknown {
  return JSON.parse(json)
}

function processData(data: unknown): ProcessedData {
  if (isValidData(data)) {
    return transformData(data)
  }
  throw new Error('Invalid data')
}

// BAD: Using any
function dangerousFunction(data: any): any {
  // No type safety
  return data.undefinedProperty.someMethod()
}
```

### Use Type Guards
```typescript
// Type guard functions
function isError(value: unknown): value is Error {
  return value instanceof Error
}

function isValidUser(user: unknown): user is User {
  return (
    typeof user === 'object' &&
    user !== null &&
    'id' in user &&
    'name' in user &&
    typeof (user as any).id === 'string' &&
    typeof (user as any).name === 'string'
  )
}

// Usage
function handleResult(result: unknown) {
  if (isError(result)) {
    console.error('Error:', result.message)
  } else if (isValidUser(result)) {
    console.log('User:', result.name)
  }
}
```

### Use Utility Types
```typescript
// Partial for optional updates
interface User {
  id: string
  name: string
  email: string
}

function updateUser(id: string, updates: Partial<User>) {
  // Only some fields may be provided
}

// Pick for specific fields
type UserPreview = Pick<User, 'id' | 'name'>

// Omit for excluding fields
type UserWithoutId = Omit<User, 'id'>

// Record for mapped types
type UserMap = Record<string, User>

// ReturnType for function returns
type FetchResult = ReturnType<typeof fetchData>
```

## React Best Practices

### Hooks Rules
```typescript
// 1. Only call hooks at the top level
function MyComponent() {
  // GOOD
  const [state, setState] = useState('')
  const value = useContext(MyContext)
  
  // BAD - Inside conditions, loops, or nested functions
  if (condition) {
    const [state, setState] = useState('')  // ❌
  }
  
  useEffect(() => {
    const [state, setState] = useState('')  // ❌
  }, [])
}

// 2. Only call hooks from React functions
function useCustomHook() {
  // GOOD - Custom hook
  const [state, setState] = useState('')
  return state
}

function regularFunction() {
  const [state, setState] = useState('')  // ❌
}
```

### Props Design
```typescript
// Use descriptive prop names
// GOOD
interface ButtonProps {
  variant: 'primary' | 'secondary' | 'danger'
  size: 'small' | 'medium' | 'large'
  isLoading?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}

// BAD - Vague or boolean props
interface BadButtonProps {
  type: string      // ❌ Too vague
  big?: boolean     // ❌ Use size instead
  click: () => void // ❌ Should be onClick
}

// Use default props or default values
function Button({
  variant = 'primary',
  size = 'medium',
  isLoading = false,
  disabled = false,
  onClick,
  children
}: ButtonProps) {
  // ...
}
```

### State Management
```typescript
// Group related state
// GOOD
function UserForm() {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: ''
  })
  
  const updateField = useCallback((field: keyof typeof formData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }, [])
}

// BAD - Too many separate states
function BadUserForm() {
  const [name, setName] = useState('')      // ❌
  const [email, setEmail] = useState('')    // ❌
  const [password, setPassword] = useState('') // ❌
}

// Use useReducer for complex state
function complexReducer(state: State, action: Action): State {
  switch (action.type) {
    case 'ADD_ITEM':
      return { ...state, items: [...state.items, action.payload] }
    case 'REMOVE_ITEM':
      return { ...state, items: state.items.filter(i => i.id !== action.payload) }
    default:
      return state
  }
}
```

## Error Handling

### Try-Catch Patterns
```typescript
// Async/await with try-catch
async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response
    } catch (error) {
      if (i === retries - 1) throw error
      await wait(1000 * Math.pow(2, i)) // Exponential backoff
    }
  }
  throw new Error('Max retries exceeded')
}

// Result type for better error handling
type Result<T, E = Error> = 
  | { success: true; data: T }
  | { success: false; error: E }

async function safeFetch(url: string): Promise<Result<Response>> {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      return { success: false, error: new Error(`HTTP ${response.status}`) }
    }
    return { success: true, data: response }
  } catch (error) {
    return { success: false, error: error as Error }
  }
}
```

### Custom Error Classes
```typescript
// Domain-specific errors
class IntelligenceError extends Error {
  constructor(
    message: string,
    public code: IntelligenceErrorCode,
    public details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'IntelligenceError'
  }
}

type IntelligenceErrorCode = 
  | 'projectFilesUnavailable'
  | 'rateLimited'
  | 'analysisFailed'
  | 'invalidProject'

// Usage
function analyzeProject(projectId: string): Promise<ProjectKnowledge> {
  if (!isValidProjectId(projectId)) {
    throw new IntelligenceError(
      'Invalid project ID',
      'invalidProject',
      { projectId }
    )
  }
  // ...
}
```

## Testing Patterns

### Test File Organization
```typescript
// Test files alongside source files
src/
├── components/
│   ├── button.tsx
│   └── button.test.tsx
├── hooks/
│   ├── use-voice-state.ts
│   └── use-voice-state.test.ts
└── utils/
    ├── validation.ts
    └── validation.test.ts

// Or in a separate __tests__ directory
src/
├── components/
│   ├── button.tsx
│   └── __tests__/
│       └── button.test.tsx
```

### Test Structure
```typescript
// Arrange-Act-Assert pattern
describe('Button component', () => {
  it('renders with primary variant', () => {
    // Arrange
    const label = 'Click me'
    
    // Act
    render(<Button variant="primary">{label}</Button>)
    
    // Assert
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByRole('button')).toHaveClass('button-primary')
  })
  
  it('calls onClick when clicked', () => {
    // Arrange
    const handleClick = jest.fn()
    
    // Act
    render(<Button onClick={handleClick}>Click</Button>)
    fireEvent.click(screen.getByRole('button'))
    
    // Assert
    expect(handleClick).toHaveBeenCalledTimes(1)
  })
})
```

### Mocking Guidelines
```typescript
// Mock external dependencies
jest.mock('@/api/client', () => ({
  fetchUser: jest.fn()
}))

describe('UserProfile', () => {
  it('loads user data', async () => {
    // Arrange
    const mockUser = { id: '1', name: 'John' }
    ;(fetchUser as jest.Mock).mockResolvedValue(mockUser)
    
    // Act
    render(<UserProfile userId="1" />)
    
    // Assert
    await waitFor(() => {
      expect(screen.getByText('John')).toBeInTheDocument()
    })
    expect(fetchUser).toHaveBeenCalledWith('1')
  })
})

// Clean up mocks
afterEach(() => {
  jest.clearAllMocks()
})
```

## Performance Considerations

### React Optimization
```typescript
// Memoize expensive computations
function ExpensiveComponent({ items }: { items: Item[] }) {
  const total = useMemo(() => {
    return items.reduce((sum, item) => sum + calculateExpensiveValue(item), 0)
  }, [items])  // Only recalculate when items change
  
  return <div>Total: {total}</div>
}

// Memoize callbacks
function InteractiveComponent({ onSubmit }: { onSubmit: (data: Data) => void }) {
  const handleSubmit = useCallback((data: Data) => {
    // Expensive validation or processing
    const processed = processData(data)
    onSubmit(processed)
  }, [onSubmit])  // Stable reference
  
  return <Form onSubmit={handleSubmit} />
}

// Use React.memo for expensive renders
const ExpensiveDisplay = React.memo(function ExpensiveDisplay({ data }: DisplayProps) {
  return (
    <div>
      {/* Complex rendering */}
    </div>
  )
})
```

### Bundle Size Optimization
```typescript
// Code splitting with React.lazy
const VoiceInterface = React.lazy(() => import('./VoiceInterface'))

function App() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <VoiceInterface />
    </Suspense>
  )
}

// Dynamic imports for large dependencies
async function processLargeFile(file: File) {
  const { heavyProcessor } = await import('./heavy-processor')
  return heavyProcessor(file)
}
```

## Documentation

### JSDoc Comments
```typescript
/**
 * Calculates the score for an interview answer.
 * 
 * @param answer - The candidate's answer text
 * @param expectedTopics - Array of topics expected in the answer
 * @returns A score between 0 and 10
 * 
 * @example
 * ```typescript
 * const score = calculateAnswerScore(
 *   "React uses virtual DOM for performance",
 *   ["virtual DOM", "performance"]
 * )
 * // Returns 8.5
 * ```
 */
function calculateAnswerScore(answer: string, expectedTopics: string[]): number {
  // Implementation
}

/**
 * Represents a project knowledge profile.
 * 
 * @property version - Schema version (currently 1)
 * @property projectId - Unique identifier (proj_...)
 * @property name - Project name
 * @property source - Source information (local or GitHub)
 */
interface ProjectKnowledge {
  version: 1
  projectId: string
  name: string
  source: ProjectSource
}
```

### Inline Comments
```typescript
// Use comments for "why", not "what"
// GOOD - Explains reasoning
// Using Map instead of object for O(1) lookups
const cache = new Map<string, Data>()

// BAD - Redundant
// Increment counter by 1
counter++

// Complex logic should have comments
function calculateTokenBucketRefill(tokens: number, elapsedMs: number): number {
  // Formula: newTokens = elapsedMs * (maxTokensPerSecond / 1000)
  // This ensures smooth rate limiting regardless of chunk timing
  const tokensPerMs = MAX_TOKENS_PER_SECOND / 1000
  return Math.min(MAX_BURST_TOKENS, tokens + elapsedMs * tokensPerMs)
}
```

## Git and Version Control

### Commit Messages
```
type(scope): description

[optional body]

[optional footer]

Types:
feat:     New feature
fix:      Bug fix
docs:     Documentation changes
style:    Code style changes (formatting, etc.)
refactor: Code refactoring
test:     Test changes
chore:    Maintenance tasks
perf:     Performance improvements
```

### Examples
```
feat(voice): add real-time transcription display

fix(security): prevent path traversal in file validation

docs(api): update endpoint documentation

refactor(intelligence): extract knowledge extraction to separate service

test(remote): add pairing rate limit tests
```

### Branch Naming
```
feature/voice-transcription
fix/security-file-validation
hotfix/critical-auth-bug
release/v1.2.0
docs/api-contracts
```

## Linting and Formatting

### ESLint Configuration
```json
{
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react/recommended",
    "plugin:react-hooks/recommended"
  ],
  "rules": {
    "@typescript-eslint/explicit-function-return-type": "error",
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
    "react/prop-types": "off",
    "react/react-in-jsx-scope": "off",
    "no-console": ["warn", { "allow": ["warn", "error"] }]
  }
}
```

### Prettier Configuration
```json
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": true,
  "printWidth": 80,
  "tabWidth": 2,
  "useTabs": false,
  "bracketSpacing": true,
  "arrowParens": "avoid"
}
```

## Review Checklist

### Code Review Guidelines
- [ ] Does the code follow the style guide?
- [ ] Are there any TypeScript errors or warnings?
- [ ] Are functions small and focused?
- [ ] Is error handling appropriate?
- [ ] Are there sufficient tests?
- [ ] Is the code documented?
- [ ] Are performance considerations addressed?
- [ ] Are security considerations addressed?

### Self-Review Before PR
- [ ] Run linter: `npm run lint`
- [ ] Run tests: `npm test`
- [ ] Check TypeScript: `npm run type-check`
- [ ] Test functionality manually
- [ ] Update documentation if needed

---

*Code Style Guide Version: 1.0*  
*Last Updated: 2026-11-23*  
*Based on: THE VIBE CODING BLUEPRINT - Code Quality Section*
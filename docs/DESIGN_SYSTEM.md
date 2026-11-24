# Myra AI Gemini - Design System

## Design Philosophy
**Minimal, functional, and responsive** - Myra's design prioritizes clarity over decoration, function over form, and accessibility over aesthetics.

## Visual Design

### Color Palette
```css
/* Primary Colors */
--primary-blue: #2563eb;    /* Actions, active states */
--primary-dark: #1e40af;    /* Hover states */
--primary-light: #60a5fa;   /* Focus states */

/* Neutral Colors */
--neutral-900: #111827;     /* Text, headers */
--neutral-700: #374151;     /* Body text */
--neutral-500: #6b7280;     /* Secondary text */
--neutral-300: #d1d5db;     /* Borders, dividers */
--neutral-100: #f3f4f6;     /* Backgrounds */
--neutral-50: #f9fafb;      /* Card backgrounds */

/* Semantic Colors */
--success: #10b981;         /* Success states */
--warning: #f59e0b;         /* Warnings */
--error: #ef4444;           /* Errors, destructive */
--info: #3b82f6;            /* Information */
```

### Typography
- **Primary Font**: System UI stack (SF Pro, Segoe UI, Roboto)
- **Monospace Font**: JetBrains Mono, Consolas, Monaco
- **Base Size**: 16px (1rem)
- **Scale**: 1.125 major second (1.125x)

### Spacing System
```css
/* 4px base unit */
--space-1: 0.25rem;   /* 4px */
--space-2: 0.5rem;    /* 8px */
--space-3: 0.75rem;   /* 12px */
--space-4: 1rem;      /* 16px */
--space-6: 1.5rem;    /* 24px */
--space-8: 2rem;      /* 32px */
--space-12: 3rem;     /* 48px */
--space-16: 4rem;     /* 64px */
```

## Components

### Buttons
```typescript
// Primary Button
<Button variant="primary" onClick={handleClick}>
  Start Voice
</Button>

// Secondary Button  
<Button variant="secondary" onClick={handleClick}>
  Settings
</Button>

// Ghost Button
<Button variant="ghost" onClick={handleClick}>
  Cancel
</Button>

// Danger Button
<Button variant="danger" onClick={handleDelete}>
  Delete
</Button>
```

### Cards
```typescript
// Default Card
<Card>
  <CardHeader>
    <CardTitle>Project Analysis</CardTitle>
    <CardDescription>Analyze local or GitHub projects</CardDescription>
  </CardHeader>
  <CardContent>
    {/* Content */}
  </CardContent>
  <CardFooter>
    <Button>Analyze</Button>
  </CardFooter>
</Card>
```

### Form Elements
```typescript
// Input
<Input 
  placeholder="Enter repository URL"
  value={url}
  onChange={(e) => setUrl(e.target.value)}
/>

// Select
<Select value={model} onValueChange={setModel}>
  <SelectTrigger>
    <SelectValue placeholder="Select model" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="gemini-2.5-flash">Gemini 2.5 Flash</SelectItem>
    <SelectItem value="gemini-2.0-flash">Gemini 2.0 Flash</SelectItem>
  </SelectContent>
</Select>

// Textarea
<Textarea 
  placeholder="Enter your answer..."
  value={answer}
  onChange={(e) => setAnswer(e.target.value)}
/>
```

## Layout System

### Grid Layout
```typescript
// Main layout grid
<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
  <div className="lg:col-span-2">
    {/* Main content */}
  </div>
  <div className="lg:col-span-1">
    {/* Sidebar */}
  </div>
</div>
```

### Flex Utilities
```typescript
// Horizontal alignment
<div className="flex items-center justify-between">
  {/* Content */}
</div>

// Vertical alignment  
<div className="flex flex-col gap-4">
  {/* Content */}
</div>
```

## Interactive States

### Hover States
```css
.button-primary:hover {
  background-color: var(--primary-dark);
  transform: translateY(-1px);
}

.card:hover {
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1);
}
```

### Focus States
```css
.input:focus {
  border-color: var(--primary-blue);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.button:focus {
  outline: 2px solid var(--primary-blue);
  outline-offset: 2px;
}
```

### Active States
```css
.button:active {
  transform: translateY(0);
}
```

## Animation System

### Transitions
```css
/* Fast transitions for interactions */
.transition-fast {
  transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
}

/* Standard transitions */
.transition-standard {
  transition: all 250ms cubic-bezier(0.4, 0, 0.2, 1);
}

/* Slow transitions for page loads */
.transition-slow {
  transition: all 400ms cubic-bezier(0.4, 0, 0.2, 1);
}
```

### Micro-interactions
```typescript
// Loading states
<Button disabled={isLoading}>
  {isLoading ? (
    <Loader className="animate-spin" />
  ) : (
    "Submit"
  )}
</Button>

// Success feedback
<Toast variant="success" open={showSuccess}>
  Operation completed successfully
</Toast>
```

## Accessibility

### ARIA Labels
```typescript
// All interactive elements must have proper labels
<Button aria-label="Start voice conversation">
  <MicIcon />
</Button>

<Input 
  aria-label="GitHub repository URL"
  placeholder="https://github.com/owner/repo"
/>
```

### Keyboard Navigation
- **Tab navigation**: Logical focus order
- **Enter/Space**: Activate buttons
- **Escape**: Close modals, cancel actions
- **Arrow keys**: Navigate lists, select options

### Screen Reader Support
- Semantic HTML structure
- Proper heading hierarchy (h1 → h6)
- Descriptive alt text for images
- Live regions for dynamic content

## Responsive Design

### Breakpoints
```css
/* Mobile (default) */
@media (min-width: 640px) { /* sm */ }
@media (min-width: 768px) { /* md */ }
@media (min-width: 1024px) { /* lg */ }
@media (min-width: 1280px) { /* xl */ }
@media (min-width: 1536px) { /* 2xl */ }
```

### Mobile-First Approach
```typescript
// Default to mobile, enhance for larger screens
<div className="p-4 md:p-6 lg:p-8">
  {/* Content scales with screen size */}
</div>
```

## Dark Mode
```typescript
// Automatic dark mode based on system preference
// Manual toggle available in settings

.dark {
  --neutral-900: #f9fafb;
  --neutral-100: #111827;
  /* Inverted color scheme */
}
```

## Voice Interface Design

### Voice States
```typescript
// Visual feedback for voice states
enum VoiceState {
  IDLE = 'idle',
  LISTENING = 'listening',
  PROCESSING = 'processing',
  SPEAKING = 'speaking',
  ERROR = 'error'
}
```

### Voice UI Components
```typescript
// Voice indicator
<VoiceIndicator state={voiceState} />

// Transcript display
<Transcript 
  text={transcript}
  isFinal={isFinal}
  speaker="user"
/>
```

---

*Design System Version: 1.0*  
*Last Updated: 2026-11-23*  
*Based on: THE VIBE CODING BLUEPRINT - Design Principles Section*
# Myra AI Gemini - Architecture Decision Records (ADRs)

## Decision Record Philosophy
**Transparent, documented, and reversible** - Every significant architectural decision is recorded with context, alternatives considered, and consequences.

## ADR Template
Each decision follows this format:
```
## [ADR-001] Decision Title
**Status**: Accepted | Proposed | Superseded | Deprecated  
**Date**: YYYY-MM-DD  
**Context**: What prompted this decision?  
**Decision**: What we decided to do.  
**Consequences**: What becomes easier/harder.  
**Alternatives**: What other options were considered.  
```

## Core Architecture Decisions

### [ADR-001] Local-First Architecture
**Status**: Accepted  
**Date**: 2026-10-15  
**Context**: Need for privacy-focused AI assistant that works without internet.  
**Decision**: Implement local-first architecture with optional cloud AI integration.  
**Consequences**:
- ✅ No mandatory internet connection
- ✅ User data stays on device
- ✅ Lower latency for local operations
- ❌ More complex offline support
- ❌ Limited to device storage/processing
**Alternatives**:
1. Cloud-only: Simpler but less private
2. Hybrid default: Better features but privacy concerns

### [ADR-002] Electron for Desktop Integration
**Status**: Accepted  
**Date**: 2026-10-16  
**Context**: Need deep system integration (file access, app control, native APIs).  
**Decision**: Use Electron as desktop runtime with React frontend.  
**Consequences**:
- ✅ Full native system access
- ✅ Single codebase for desktop/web
- ✅ Established ecosystem
- ❌ Larger bundle size (~100MB)
- ❌ Security complexity (context isolation)
**Alternatives**:
1. Native apps (C++/Swift): Better performance but 3 codebases
2. Tauri: Smaller but less mature ecosystem
3. Pure web: Simpler but limited system access

### [ADR-003] JSON File Storage
**Status**: Accepted  
**Date**: 2026-10-17  
**Context**: Need simple, portable data storage without database setup.  
**Decision**: Use JSON files (file-per-entity) in `.myra-data` directory.  
**Consequences**:
- ✅ No database installation/configuration
- ✅ Easy backup/restore (copy files)
- ✅ Human-readable/debuggable
- ❌ No transactions or complex queries
- ❌ Manual migration needed
**Alternatives**:
1. SQLite: ACID compliance but setup complexity
2. IndexedDB: Browser-native but Electron complexity
3. Cloud sync: Multi-device but privacy concerns

### [ADR-004] Handoff Authority Security Model
**Status**: Accepted  
**Date**: 2026-10-18  
**Context**: Need secure tool execution in Electron (renderer ↔ main).  
**Decision**: Implement Handoff Authority with signed tickets for tool execution.  
**Consequences**:
- ✅ Secure tool execution boundary
- ✅ Audit trail for all tool calls
- ✅ Prevention of unauthorized operations
- ❌ Complexity in ticket management
- ❌ Performance overhead for validation
**Alternatives**:
1. IPC with allowlists: Simpler but less secure
2. Capability-based: More flexible but complex
3. No security: Fast but dangerous

### [ADR-005] Token Bucket Rate Limiting
**Status**: Accepted  
**Date**: 2026-10-19  
**Context**: Need to prevent abuse of audio streaming and API endpoints.  
**Decision**: Implement token bucket algorithm for all rate-limited resources.  
**Consequences**:
- ✅ Smooth rate limiting (not hard cutoffs)
- ✅ Configurable burst allowances
- ✅ Fair resource allocation
- ❌ Implementation complexity
- ❌ Memory overhead for bucket tracking
**Alternatives**:
1. Fixed window: Simpler but allows bursts
2. Sliding window: Fair but more complex
3. Leaky bucket: Similar but different semantics

## Technology Stack Decisions

### [ADR-006] TypeScript for Type Safety
**Status**: Accepted  
**Date**: 2026-10-20  
**Context**: Need robust type checking for complex AI/voice application.  
**Decision**: Use TypeScript throughout (frontend, backend, Electron).  
**Consequences**:
- ✅ Catch errors at compile time
- ✅ Better IDE support
- ✅ Self-documenting code
- ❌ Build configuration complexity
- ❌ Type definition maintenance
**Alternatives**:
1. JavaScript: Faster iteration but more runtime errors
2. Flow: Similar benefits but less ecosystem
3. JSDoc: Incremental adoption but limited

### [ADR-007] React with Functional Components
**Status**: Accepted  
**Date**: 2026-10-21  
**Context**: Need modern, maintainable UI framework for complex interactions.  
**Decision**: Use React 19+ with functional components and hooks.  
**Consequences**:
- ✅ Declarative UI patterns
- ✅ Rich ecosystem (libraries, tools)
- ✅ Good performance with virtual DOM
- ❌ Bundle size overhead
- ❌ Learning curve for new developers
**Alternatives**:
1. Vue: Simpler but less enterprise adoption
2. Svelte: Faster but younger ecosystem
3. SolidJS: Performant but niche

### [ADR-008] Tailwind CSS for Styling
**Status**: Accepted  
**Date**: 2026-10-22  
**Context**: Need consistent, maintainable styling system.  
**Decision**: Use Tailwind CSS with component-based design system.  
**Consequences**:
- ✅ Utility-first rapid development
- ✅ Consistent design tokens
- ✅ Small bundle with PurgeCSS
- ❌ HTML class bloat
- ❌ Learning curve for CSS-in-JS developers
**Alternatives**:
1. CSS Modules: Scoped but verbose
2. Styled Components: Dynamic but runtime cost
3. CSS-in-JS: Flexible but bundle size

### [ADR-009] Express.js for Backend
**Status**: Accepted  
**Date**: 2026-10-23  
**Context**: Need lightweight, flexible HTTP server for local API.  
**Decision**: Use Express.js with TypeScript for backend API.  
**Consequences**:
- ✅ Minimal overhead
- ✅ Middleware ecosystem
- ✅ Easy WebSocket integration
- ❌ Less structure than frameworks
- ❌ Manual error handling
**Alternatives**:
1. Fastify: Faster but less middleware
2. NestJS: Structured but heavier
3. Hono: Edge-focused but less mature

## Security Decisions

### [ADR-010] Loopback-Only Binding
**Status**: Accepted  
**Date**: 2026-10-24  
**Context**: Default security for local AI assistant.  
**Decision**: Bind server to 127.0.0.1 only, require Tailscale for remote.  
**Consequences**:
- ✅ No accidental internet exposure
- ✅ Simple security model
- ✅ No firewall configuration needed
- ❌ Manual setup for remote access
- ❌ No local network access
**Alternatives**:
1. 0.0.0.0: Flexible but dangerous default
2. Local network: Convenient but less secure
3. Unix sockets: Secure but Windows complexity

### [ADR-011] Secrets Redaction System
**Status**: Accepted  
**Date**: 2026-10-25  
**Context**: Prevent accidental credential exposure in project analysis.  
**Decision**: Implement regex-based secrets redaction before AI processing.  
**Consequences**:
- ✅ Prevent credential leaks to AI
- ✅ Transparent to user (redaction count)
- ✅ Extensible pattern matching
- ❌ False positives possible
- ❌ Performance overhead for large files
**Alternatives**:
1. File exclusion: Simpler but less useful
2. Manual review: Secure but not scalable
3. No protection: Fast but dangerous

### [ADR-012] One-Time Pairing Codes
**Status**: Accepted  
**Date**: 2026-10-26  
**Context**: Secure phone pairing without account system.  
**Decision**: 6-digit codes with 5-minute expiry and single use.  
**Consequences**:
- ✅ No persistent credentials
- ✅ Easy for users (no passwords)
- ✅ Revocation on use
- ❌ Manual code entry
- ❌ Limited to one paired device
**Alternatives**:
1. QR codes: Easier but camera requirement
2. Account system: Multi-device but complexity
3. Bluetooth pairing: Automatic but inconsistent

## Data & Storage Decisions

### [ADR-013] In-Memory Import Cache
**Status**: Accepted  
**Date**: 2026-10-27  
**Context**: Balance between performance and memory usage for project analysis.  
**Decision**: 30-minute TTL cache for imported files, max 4 projects.  
**Consequences**:
- ✅ Fast re-analysis within window
- ✅ Automatic memory cleanup
- ✅ Configurable limits
- ❌ Data loss on restart/crash
- ❌ Memory pressure with large projects
**Alternatives**:
1. Persistent cache: Reliable but disk usage
2. No cache: Simple but slow re-analysis
3. LRU cache: Adaptive but complex

### [ADR-014] File Size Limits
**Status**: Accepted  
**Date**: 2026-10-28  
**Context**: Prevent performance issues with very large files.  
**Decision**: 200KB per file, 160 files max, 700K characters total.  
**Consequences**:
- ✅ Predictable performance
- ✅ Prevent memory exhaustion
- ✅ Focus on source code (not binaries)
- ❌ Large projects may be incomplete
- ❌ Manual file selection needed
**Alternatives**:
1. No limits: Flexible but risky
2. Dynamic limits: Adaptive but complex
3. User-configurable: Flexible but confusing defaults

### [ADR-015] GitHub API Rate Limit Handling
**Status**: Accepted  
**Date**: 2026-10-29  
**Context**: Respect GitHub API limits for public repository analysis.  
**Decision**: 220 request limit with clear error messages and fallbacks.  
**Consequences**:
- ✅ Prevent API bans
- ✅ Transparent to users
- ✅ Suggest alternatives (local import)
- ❌ Large repos may be incomplete
- ❌ No automatic retry (user must wait)
**Alternatives**:
1. No limits: Simple but risk of bans
2. Caching: Efficient but storage complexity
3. Paid API: Higher limits but cost

## Audio & Voice Decisions

### [ADR-016] PCM16 Audio Format
**Status**: Accepted  
**Date**: 2026-10-30  
**Context**: Need consistent audio format across platforms.  
**Decision**: Use PCM16 little-endian, mono, 16kHz for all audio processing.  
**Consequences**:
- ✅ Cross-platform compatibility
- ✅ Gemini API compatibility
- ✅ Simple processing
- ❌ Browser resampling needed
- ❌ Larger than compressed formats
**Alternatives**:
1. Opus: Efficient but transcoding complexity
2. WebM: Browser-native but server complexity
3. MP3: Universal but licensing

### [ADR-017] 100ms Audio Chunks
**Status**: Accepted  
**Date**: 2026-10-31  
**Context**: Balance between latency and processing efficiency.  
**Decision**: Send audio in 100ms chunks (1600 samples at 16kHz).  
**Consequences**:
- ✅ Low latency (real-time feel)
- ✅ Efficient network usage
- ✅ Predictable processing
- ❌ More frequent network calls
- ❌ Chunk alignment complexity
**Alternatives**:
1. 50ms: Lower latency but more overhead
2. 200ms: Less overhead but noticeable latency
3. Variable: Adaptive but complex

### [ADR-018] Voice Activity Detection (VAD)
**Status**: Accepted  
**Date**: 2026-11-01  
**Context**: Need to detect when user stops speaking.  
**Decision**: Implement server-side VAD with 1.4s silence timeout.  
**Consequences**:
- ✅ Natural conversation flow
- ✅ Reduced false transmissions
- ✅ Configurable sensitivity
- ❌ Additional processing
- ❌ May cut off slow speakers
**Alternatives**:
1. Client-side VAD: Faster but inconsistent
2. Manual stop: Simple but unnatural
3. Fixed intervals: Predictable but inefficient

## UI/UX Decisions

### [ADR-019] Progressive Disclosure
**Status**: Accepted  
**Date**: 2026-11-02  
**Context**: Balance simplicity for beginners with power for experts.  
**Decision**: Implement progressive disclosure with basic/advanced modes.  
**Consequences**:
- ✅ Low barrier to entry
- ✅ Power features accessible
- ✅ Clean default interface
- ❌ Feature discovery challenge
- ❌ Two interface modes to maintain
**Alternatives**:
1. Simple only: Easy but limited
2. Complex only: Powerful but intimidating
3. Customizable: Flexible but overwhelming

### [ADR-020] Real-time Transcription
**Status**: Accepted  
**Date**: 2026-11-03  
**Context**: User feedback during voice processing.  
**Decision**: Show real-time transcription as user speaks.  
**Consequences**:
- ✅ Immediate feedback
- ✅ Error correction (see what was heard)
- ✅ Engagement during processing
- ❌ Visual distraction
- ❌ Implementation complexity
**Alternatives**:
1. No transcription: Simple but no feedback
2. Post-process only: Clean but delayed
3. Optional: Flexible but configuration burden

### [ADR-021] Dark/Light Mode
**Status**: Accepted  
**Date**: 2026-11-04  
**Context**: User preference and accessibility.  
**Decision**: Support both modes with system preference detection.  
**Consequences**:
- ✅ User preference support
- ✅ Accessibility improvement
- ✅ Modern app feel
- ❌ Double design work
- ❌ Testing complexity
**Alternatives**:
1. Light only: Simple but not modern
2. Dark only: Trendy but not for everyone
3. User setting: Flexible but storage needed

## Testing Decisions

### [ADR-022] Test Pyramid Structure
**Status**: Accepted  
**Date**: 2026-11-05  
**Context**: Need balanced test coverage across layers.  
**Decision**: 70% unit tests, 20% integration tests, 10% E2E tests.  
**Consequences**:
- ✅ Fast feedback from unit tests
- ✅ Confidence from integration tests
- ✅ Real-world validation from E2E
- ❌ Maintenance overhead
- ❌ Test environment complexity
**Alternatives**:
1. All E2E: Realistic but slow
2. All unit: Fast but gaps in integration
3. TDD: Quality but slower development

### [ADR-023] Jest for Testing
**Status**: Accepted  
**Date**: 2026-11-06  
**Context**: Need consistent testing framework across TypeScript.  
**Decision**: Use Jest with TypeScript support for all testing.  
**Consequences**:
- ✅ Single test runner
- ✅ Rich assertion library
- ✅ Snapshot testing
- ❌ Configuration complexity
- ❌ Performance with large suites
**Alternatives**:
1. Vitest: Faster but less mature
2. Mocha/Chai: Flexible but more setup
3. Node test runner: Native but basic

## Deployment Decisions

### [ADR-024] NSIS Windows Installer
**Status**: Accepted  
**Date**: 2026-11-07  
**Context**: Need professional Windows installation experience.  
**Decision**: Use electron-builder with NSIS installer.  
**Consequences**:
- ✅ Professional installation flow
- ✅ Automatic updates (future)
- ✅ Code signing support
- ❌ Large installer size
- ❌ Windows-only initially
**Alternatives**:
1. Portable zip: Simple but no installation
2. MSIX: Modern but Windows 10+ only
3. Custom installer: Flexible but complex

### [ADR-025] Auto-update Mechanism
**Status**: Proposed  
**Date**: 2026-11-08  
**Context**: Need to deliver updates to users.  
**Decision**: Implement electron-updater with GitHub releases.  
**Consequences**:
- ✅ Users always have latest
- ✅ Security patch delivery
- ✅ Better user experience
- ❌ Update server maintenance
- ❌ Testing complexity
**Alternatives**:
1. Manual updates: Simple but users lag behind
2. App stores: Distribution but restrictions
3. Web version: Always current but limited features

## Superseded Decisions

### [ADR-026] WebSocket Heartbeat (Superseded)
**Status**: Superseded by ADR-027  
**Date**: 2026-11-09  
**Context**: Originally implemented 60s heartbeat for connection health.  
**Decision**: Change to 25s heartbeat with exponential backoff.  
**Reason**: Better mobile network handling and faster failure detection.

### [ADR-027] Audio Buffer Size (Superseded)
**Status**: Superseded by ADR-017  
**Date**: 2026-11-10  
**Context**: Originally used 50ms audio chunks.  
**Decision**: Change to 100ms chunks for better network efficiency.  
**Reason**: Reduced WebSocket overhead without noticeable latency impact.

## Pending Decisions

### [ADR-028] Multi-language Support
**Status**: Proposed  
**Date**: 2026-11-11  
**Context**: International user base expansion.  
**Decision**: Implement i18n with React Intl, starting with English.  
**Consequences**:
- ✅ Global accessibility
- ✅ Localized user experience
- ✅ Contribution opportunity
- ❌ Translation maintenance
- ❌ UI layout challenges
**Alternatives**:
1. English only: Simple but limited reach
2. Community translations: Scalable but quality varies
3. Auto-translation: Fast but inaccurate

### [ADR-029] Plugin System
**Status**: Proposed  
**Date**: 2026-11-12  
**Context**: Extend functionality without core changes.  
**Decision**: Design plugin API for custom tools and integrations.  
**Consequences**:
- ✅ Community extensions
- ✅ Modular architecture
- ✅ Faster feature development
- ❌ Security review needed
- ❌ API stability commitment
**Alternatives**:
1. Monolithic: Controlled but slow evolution
2. Fork-based: Flexible but fragmented
3. Config-only: Simple but limited

## Decision Review Process

### Quarterly Review
All ADRs reviewed every quarter for:
1. **Relevance**: Still applicable to current context
2. **Effectiveness**: Working as intended
3. **Alternatives**: New options emerged
4. **Supersession**: Should be updated/replaced

### Change Procedure
1. Document proposed change as new ADR
2. Discuss with team for 1 week
3. Update implementation if accepted
4. Mark old ADR as superseded
5. Update documentation

### Exception Process
Emergency changes can bypass review but must:
1. Be documented within 24 hours
2. Have security review before production
3. Undergo retrospective analysis

---

*Decision Records Version: 1.0*  
*Last Updated: 2026-11-23*  
*Based on: THE VIBE CODING BLUEPRINT - Architecture Decision Framework*
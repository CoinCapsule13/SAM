# Pure Functional Event Sourcing Messaging System

**All state is derived from canonical events through pure functions. Every time. Everywhere.**

This is a complete, production-ready messaging system built on event sourcing principles where:
- Every state change is recorded as an immutable event
- State is never mutated; it's always computed from events using pure functions
- The same event log always produces the same state (determinism)
- Complete audit trail and time-travel capability

---

## Quick Start

### 1. Create a messaging system
```typescript
import { PureFunctionalMessagingSystem } from './event_sourcing_system';

const system = new PureFunctionalMessagingSystem();

// Create a conversation
system.createConversation('conv-1', ['alice', 'bob']);
```

### 2. Send a message
```typescript
system.executeCommand('CreateMessage', 'conv-1', 'alice', {
  content: 'Hello, Bob!',
});

// State is immediately derived from events
const conversation = system.getConversation('conv-1');
console.log(conversation.messages[0].content); // "Hello, Bob!"
```

### 3. Edit and react
```typescript
const msg = conversation.messages[0];

// Edit
system.executeCommand('EditMessage', 'conv-1', 'alice', {
  messageId: msg.id,
  newContent: 'Hello, Bob! 👋',
});

// React
system.executeCommand('AddReaction', 'conv-1', 'bob', {
  messageId: msg.id,
  emoji: '❤️',
});

// State automatically reflects all changes
const updated = system.getMessage(msg.id);
console.log(updated.content); // "Hello, Bob! 👋"
console.log(updated.reactions.get('❤️')); // Set(['bob'])
```

### 4. Rebuild state (proves determinism)
```typescript
// Get all events
const events = system.getAllEvents();

// Rebuild from scratch—produces identical state
const rebuiltModel = buildReadModel(events);
const rebuiltConv = rebuiltModel.conversations.get('conv-1');

// Same as current state
console.log(rebuiltConv.messages.length === conversation.messages.length); // true
```

---

## Files Overview

### `event_sourcing_system.ts` (Main Library)
- **Event types** - Canonical event definitions
- **Pure reduction functions** - `deriveMessage()`, `deriveConversation()`, `buildReadModel()`
- **Command handlers** - `handleCreateMessage()`, `handleEditMessage()`, etc.
- **EventStore** - Append-only log
- **PureFunctionalMessagingSystem** - Main orchestrator

**Lines of code**: ~650  
**Dependencies**: None (vanilla TypeScript)

### `tests_and_examples.ts` (Comprehensive Tests)
9 major test suites demonstrating:
1. Pure function determinism
2. Complete state reconstruction
3. Immutability guarantees
4. Edit history & auditability
5. Reaction accumulation (fold pattern)
6. Validation & error handling
7. Querying & projections
8. Time-travel reconstruction
9. Concurrent command ordering

Run with: `ts-node tests_and_examples.ts`

### `integration_patterns.ts` (Real-world Patterns)
8 production patterns:
1. **WebSocket Syncing** - Distribute events to all clients
2. **Optimistic UI** - Show changes instantly, confirm server-side
3. **Event Snapshots** - Reduce replay time for large event logs
4. **Event Versioning** - Handle schema migrations
5. **Specialized Read Models** - Build custom indexes and projections
6. **Debugging & Replaying** - Print timelines, verify consistency
7. **Authorization Model** - Check permissions using event state
8. **Testing Patterns** - Pure functions = trivial tests

### `DESIGN.md` (Architecture Document)
Detailed explanation of:
- Core principles (why events?)
- Data flow (commands → events → state)
- Reduction functions (pure derivation)
- Key properties (determinism, immutability, auditability)
- Comparison to traditional approaches
- When to use this pattern

---

## Core Concepts

### Event (Immutable)
```typescript
{
  id: 'evt-1',
  type: 'message:created',
  timestamp: 1000,
  aggregateId: 'conv-1',
  version: 1,
  data: {
    type: 'MessageCreated',
    messageId: 'msg-1',
    content: 'Hello!',
    authorId: 'alice',
  },
}
```

### Message (Derived)
```typescript
{
  id: 'msg-1',
  conversationId: 'conv-1',
  authorId: 'alice',
  content: 'Hello!',        // From latest edit
  createdAt: 1000,
  editedAt: undefined,
  reactions: Map {          // Folded from all reaction events
    '❤️' → Set(['bob', 'charlie'])
  },
}
```

### Conversation (Derived)
```typescript
{
  id: 'conv-1',
  participantIds: ['alice', 'bob'],
  createdAt: 1000,
  messages: [msg1, msg2, ...],  // Sorted by timestamp
  isActive: true,
}
```

---

## Data Flow

```
User Action
    ↓
Command (e.g., CreateMessage)
    ↓
Command Handler (pure function)
  └→ Validate
  └→ Check current state (read-only)
  └→ Return events (if valid) or errors
    ↓
Event Store (append-only)
    ↓
Build Read Model (pure reduction)
  └→ deriveConversation()
  └→ deriveMessage()
  └→ Fold reactions, edits, deletions
    ↓
Conversations & Messages (immutable)
    ↓
Queries (pure projections)
    ↓
UI / Response
```

---

## Key Guarantees

### ✓ **Determinism**
Same events → Same state. Always.
```typescript
const state1 = buildReadModel(events);
const state2 = buildReadModel(events);
// Logically identical
```

### ✓ **Immutability**
State is read-only. Changes only via events.
```typescript
const msg = getMessage(id);
// msg is readonly
// Can query but never mutate
```

### ✓ **Auditability**
Every change is recorded.
```typescript
getMessageEditHistory(allEvents, messageId)
// Returns timeline: [v1, v2, v3, ...]
```

### ✓ **Time-Travel**
Reconstruct state at any point.
```typescript
const eventsAt5Min = allEvents.slice(0, 42);
const stateThen = buildReadModel(eventsAt5Min);
```

### ✓ **Replicability**
Distribute events; all systems derive identical state.
```typescript
systemA.append(events);
systemB.append(events);
// Both have identical conversation state
```

---

## Testing

Pure functions are trivial to test—no mocks, no state setup:

```typescript
test('message edit', () => {
  const events = [creationEvent, editEvent];
  const msg = deriveMessage(events);
  
  expect(msg.content).toBe('edited');
  expect(msg.editedAt).toBe(2000);
});

test('reactions accumulate', () => {
  const events = [creation, reaction1, reaction2];
  const msg = deriveMessage(events);
  
  expect(msg.reactions.get('👍').size).toBe(2);
});

test('deleted messages return null', () => {
  const events = [creation, deletion];
  const msg = deriveMessage(events);
  
  expect(msg).toBe(null);
});
```

---

## Performance Notes

### Time Complexity
- **Append event**: O(1)
- **Build read model**: O(n) where n = number of events
- **Query conversation**: O(1) (lookup in map)
- **Query message**: O(1) (lookup in map)

### Space Complexity
- **Event store**: O(n) where n = number of events
- **Read model**: O(n) (derived state)
- **Snapshots**: O(1) reference + O(n) at snapshot point

### Optimization
For large event logs:
1. Take periodic snapshots (every 10k events)
2. Only replay events since last snapshot
3. Use specialized read models (indexes) for queries

Example:
```typescript
// Instead of: buildReadModel(1M events)
// Do:         restoreFromSnapshot + buildReadModel(newEvents)
```

---

## Real-World Integration

### WebSocket Sync
```typescript
client.onMessage(event => {
  system.append([event]);  // Add to log
  ui.render(system.getConversation(event.aggregateId));
});
```

### Optimistic UI
```typescript
// Show immediately
ui.render(tempMessage);

// Send to server
server.send(command).then(confirmedEvent => {
  system.append([confirmedEvent]);
  ui.render(system.getMessage(confirmedEvent.data.messageId));
});
```

### REST API
```typescript
POST /messages
  → handleCreateMessage()
  → append event
  → return Message

GET /conversations/conv-1
  → getConversation()
  → return Conversation
```

### Database Persistence
```typescript
// Store events in DB
events.forEach(e => db.insert('events', e));

// On startup, replay from DB
const stored = db.query('SELECT * FROM events ORDER BY version');
system.eventStore = new EventStore(stored);
system.readModel = buildReadModel(stored);
```

---

## Comparison to Alternatives

| Approach | Audit Trail | Time-Travel | Replication | Testing | Scaling |
|----------|-------------|-------------|-------------|---------|---------|
| **Mutable State** | ❌ Lost | ❌ Impossible | ❌ Hard | ⚠️ Complex | ⚠️ Conflicts |
| **Event Sourcing** | ✅ Complete | ✅ Trivial | ✅ Events | ✅ Easy | ✅ Simple |
| **CQRS** | ✅ Complete | ✅ Trivial | ✅ Events | ✅ Easy | ✅ Simple |
| **Snapshot Pattern** | ✅ Complete | ✅ Trivial | ✅ Events | ✅ Easy | ✅ Fast |

---

## When to Use

✅ **Ideal for:**
- Messaging systems (Slack, Discord, etc.)
- Financial transactions (audit required)
- Collaborative tools (Google Docs-style)
- Event-driven architectures
- Systems needing complete history
- Distributed systems (event sync)

⚠️ **Less ideal for:**
- Bulk data processing (MapReduce)
- Real-time analytics at extreme scale
- When events aren't meaningful

---

## Architecture Benefits

1. **Debugging** - Exact replay of what happened
2. **Testing** - Pure functions, no mocks
3. **Scalability** - CQRS pattern separates reads from writes
4. **Consistency** - Deterministic derivation guarantees correctness
5. **Flexibility** - Add new projections without changing code
6. **Resilience** - Replay recovers from any state corruption
7. **Analytics** - Event log is ready-made analytics source
8. **Compliance** - Complete audit trail for regulations

---

## Example: Message Timeline

```
1000ms: MessageCreated
        └─ content: "Hello"
        └─ author: alice

2000ms: MessageEdited
        └─ content: "Hello! 👋"

3000ms: ReactionAdded
        └─ emoji: "❤️"
        └─ user: bob

4000ms: ReactionAdded
        └─ emoji: "❤️"
        └─ user: charlie

5000ms: ReactionAdded
        └─ emoji: "👍"
        └─ user: alice
```

Derive at 5000ms:
```typescript
{
  content: "Hello! 👋",      // Latest from edit
  editedAt: 2000,
  reactions: {
    "❤️": Set(['bob', 'charlie']),
    "👍": Set(['alice']),
  },
}
```

---

## Getting Started

1. **Read** `DESIGN.md` for architecture overview
2. **Study** `event_sourcing_system.ts` - the core library
3. **Run** `tests_and_examples.ts` - see it in action
4. **Review** `integration_patterns.ts` - real-world patterns
5. **Build** your messaging system using the patterns

---

## TypeScript Support

Full TypeScript with strict mode:
- Event types are discriminated unions
- State is immutable (readonly properties)
- Pure functions have proper signatures
- Zero-cost abstractions (compiles to clean JS)

---

## License

MIT - Use freely in commercial and open-source projects.

---

## Questions?

See the code - it's heavily commented and self-documenting through types and pure functions.

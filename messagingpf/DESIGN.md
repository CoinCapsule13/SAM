# Pure Functional Event Sourcing Messaging System

## Core Principle

**All state is derived from canonical events through pure functions. Every time. Everywhere.**

This system treats events as the single source of truth. State (conversations, messages, reactions) is never mutated directly—it's always computed from the immutable event log using deterministic pure functions.

---

## Architecture

### 1. Canonical Events (Single Source of Truth)

Events are immutable records of what happened:

```typescript
interface Event<T> {
  id: string;                    // Unique event ID
  type: string;                  // Event type (message:created, etc)
  timestamp: number;             // When it happened
  aggregateId: string;           // Which conversation/entity
  version: number;               // Order within aggregate
  data: T;                        // Event payload (immutable)
  metadata?: {
    userId?: string;
    source?: string;
    causationId?: string;
  };
}
```

**Why events?**
- Complete audit trail: every state change is recorded
- Time-travel: reconstruct state at any moment in history
- Debugging: see exactly what led to current state
- Replication: send events to other services/instances
- Idempotency: replay events always produces same state

---

### 2. Commands → Events (Validation Layer)

Commands are *requests* to change state. They're validated and converted to events:

```typescript
handleCreateMessage(convId, authorId, content) → CommandResult {
  // Pure function: no side effects
  // 1. Validate input
  // 2. If valid: return { events: [...], errors: [] }
  // 3. If invalid: return { events: [], errors: [...] }
}
```

**Key principle:** Commands are the *only* place that validates. Events are trusted to be valid.

---

### 3. Event Store (Append-Only Log)

```typescript
class EventStore {
  private events: Event[] = [];
  
  append(newEvents: Event[]): EventStore {
    // Pure: returns NEW instance with appended events
    return new EventStore([...this.events, ...newEvents]);
  }
  
  getEvents(): Event[] {
    // Returns immutable copy
  }
}
```

**Properties:**
- Append-only: events never change or delete (or use soft-deletes as events)
- Immutable: every read returns a frozen copy
- Ordered: version numbers ensure global ordering
- Replayable: entire state reconstructible from start

---

### 4. Pure Reduction Functions (State Derivation)

State is computed, never stored as mutable objects:

#### Derive a single message:
```typescript
deriveMessage(messageEvents: Event[]): Message | null {
  // 1. Find creation event
  // 2. Apply edits (find latest)
  // 3. Accumulate reactions (fold over all reaction events)
  // 4. Check deletion
  
  return {
    id,
    content,        // Latest from edits
    reactions,      // Map<emoji, Set<userId>>
    ...
  };
}
```

This is a **fold/reduce**: iterate events, accumulating state step by step. Same input always produces same output.

#### Derive a conversation:
```typescript
deriveConversation(convId: string, allEvents: Event[]): Conversation {
  // 1. Filter events for this conversation
  // 2. Find creation event (participants)
  // 3. Accumulate participant adds/removes
  // 4. Derive all messages within conversation
  // 5. Sort messages by timestamp
  
  return {
    id,
    participants,
    messages,       // Derived from deriveMessage() calls
    isActive,       // Check for closing event
  };
}
```

---

### 5. Read Model (Materialized View)

Built once from entire event log:

```typescript
buildReadModel(events: Event[]): ReadModel {
  const conversations = new Map();
  const messages = new Map();
  
  // Derive every conversation and message
  for each unique aggregateId {
    conversations.set(id, deriveConversation(id, events));
  }
  
  return { conversations, messages };
}
```

**This is rebuilding from scratch, proving determinism.** Can call anytime:
- After startup
- When subscribing to events
- For debugging
- As a consistency check

---

## Key Properties

### 1. **Determinism**
Same input → same output, always.

```typescript
const state1 = buildReadModel(events);
const state2 = buildReadModel(events);
// state1 === state2 ✓ (logically)
```

Multiple systems receiving the same event log derive identical state.

### 2. **Immutability**
State is read-only. Changes only via new events.

```typescript
const msg = getMessage(id);
// msg.content is readonly
// msg.reactions is ReadonlyMap<...>
// Cannot mutate; can only query
```

### 3. **Auditability**
Every state change is recorded as an event.

```typescript
getMessageEditHistory(allEvents, messageId)
// Returns timeline of all versions:
// [{ content: "v1", editedAt: t1 },
//  { content: "v2", editedAt: t2 }, ...]
```

### 4. **Time-Travel**
Reconstruct state at any point in history.

```typescript
const eventsUpToMinute5 = allEvents.slice(0, 42);
const stateAt5Min = buildReadModel(eventsUpToMinute5);
// What did it look like 5 minutes ago?
```

### 5. **Replicability**
Distribute events to other systems; they derive identical state.

```typescript
systemA.append(events) → derives state
systemB.append(events) → derives identical state
// No version conflicts, no merge logic needed
```

---

## Data Flow

```
Command
  ↓
Command Handler (pure function)
  ├→ Validate
  ├→ Check current state (read-only query)
  └→ Return: { events: [...], errors: [...] }
      ↓
  [if valid]
      ↓
  Event Store (append)
      ↓
  Build Read Model (pure reduction)
      ↓
  Conversations & Messages (immutable)
      ↓
  Queries (pure projections)
```

---

## Example: Create, Edit, React

### Step 1: User creates message

```typescript
command: CreateMessage {
  conversationId: 'conv-1'
  authorId: 'alice'
  content: 'Hello!'
}
```

**Handler produces event:**
```typescript
Event {
  type: 'message:created'
  data: {
    type: 'MessageCreated'
    messageId: 'msg-1'
    content: 'Hello!'
    authorId: 'alice'
  }
  timestamp: 1000
  aggregateId: 'conv-1'
}
```

**Event store appends.** Read model is rebuilt. Query returns:
```typescript
Message {
  id: 'msg-1'
  content: 'Hello!'
  authorId: 'alice'
  createdAt: 1000
  reactions: Map {}
}
```

### Step 2: User edits message

```typescript
command: EditMessage {
  conversationId: 'conv-1'
  messageId: 'msg-1'
  authorId: 'alice'
  newContent: 'Hello! 👋'
}
```

**Handler checks:**
- Message exists? ✓
- Author matches? ✓
- Not deleted? ✓
- Content changed? ✓

**Produces event:**
```typescript
Event {
  type: 'message:edited'
  data: {
    type: 'MessageEdited'
    messageId: 'msg-1'
    newContent: 'Hello! 👋'
    editedAt: 1100
  }
}
```

**Event store appends.** Derivation now:

```typescript
deriveMessage([creationEvent, editEvent]) → {
  // Find creation: content = 'Hello!'
  // Find latest edit: content = 'Hello! 👋'
  // Return with updated content
  
  content: 'Hello! 👋'
  editedAt: 1100
}
```

### Step 3: Bob reacts

```typescript
command: AddReaction {
  conversationId: 'conv-1'
  messageId: 'msg-1'
  userId: 'bob'
  emoji: '👍'
}
```

**Produces event:**
```typescript
Event {
  type: 'reaction:added'
  data: {
    type: 'ReactionAdded'
    messageId: 'msg-1'
    emoji: '👍'
    userId: 'bob'
  }
}
```

**Derivation now folds over ALL reaction events:**

```typescript
deriveMessage([creation, edit, reaction]) → {
  // Previous state: { content, editedAt }
  // Plus: fold reactions
  // reactions: Map { '👍' → Set(['bob']) }
}
```

### Step 4: Alice also reacts

Same process. Event added. Reaction folding accumulates:

```typescript
reactions: Map { '👍' → Set(['bob', 'alice']) }
```

---

## Why This Design?

### Traditional Mutable State
```typescript
class Message {
  content: string;
  reactions: Map<string, Set<string>>;
  
  edit(newContent) {
    this.content = newContent;  // ⚠️ Mutates!
  }
}
```

**Problems:**
- ❌ Hard to track what changed
- ❌ Concurrent edits collide
- ❌ Can't replay history
- ❌ Difficult to debug
- ❌ Can't replicate to other services deterministically

### Event Sourcing + Pure Functions
```typescript
deriveMessage(events: Event[]): Message {
  // Compute from scratch each time
  // Same events → same message
  // No mutation, no side effects
}
```

**Benefits:**
- ✓ Complete audit trail
- ✓ Time-travel capability
- ✓ Deterministic replication
- ✓ Easy to test
- ✓ Easy to debug
- ✓ Scales to distributed systems

---

## Testing

### Pure functions are trivial to test:

```typescript
test('deriveMessage with edit and reaction', () => {
  const events = [
    creationEvent,
    editEvent,
    reactionEvent,
  ];
  
  const message = deriveMessage(events);
  
  expect(message.content).toBe('edited content');
  expect(message.reactions.get('👍')).toContain('bob');
});
```

No mocks, no state setup, no side effects. Just input → output.

---

## Scaling

### Snapshot Pattern
For large event logs, take periodic snapshots:

```typescript
// Every 10,000 events:
snapshot = buildReadModel(events.slice(0, 10000));

// New events only applied to snapshot:
finalState = deriveFromSnapshot(snapshot, newEvents);
```

### Event Versioning
If message format changes:

```typescript
deriveMessage(events) {
  const processed = events.map(e => {
    if (e.version === 1) {
      return migrateV1ToV2(e);
    }
    return e;
  });
  // Derive from migrated events
}
```

### Distributed Replication
```typescript
// System A appends events
eventStore.append(events);

// Send to System B
replicationQueue.push(...events);

// System B receives and appends
eventStore.append(events);

// Both systems derive identical state
```

---

## Consistency Guarantees

### Strong Consistency Within Single Stream
Events in a conversation are totally ordered (version number). Same sequence of events always produces same state.

### Causal Consistency Across Streams
Use `causationId` to track cause-effect relationships between aggregates.

### Idempotency
```typescript
system.append([event1, event2, event3]);
system.append([event1, event2, event3]);
// Result identical both times ✓
```

---

## Operations

### Add Message
```
Command → Validate → Event:MessageCreated → Store → Rebuild → Query
```

### Edit Message
```
Command → Validate (check author, not deleted) → Event:MessageEdited → Store → Rebuild → Query
```

### Delete Message
```
Command → Validate → Event:MessageDeleted → Store (soft-delete) → Query (filtered out)
```

### React
```
Command → Validate (not deleted, not duplicate) → Event:ReactionAdded → Store → Rebuild → Query
```

---

## Comparison to Traditional Approaches

| Aspect | Traditional | Event Sourcing |
|--------|-----------|-----------------|
| State Storage | Direct mutable updates | Events only |
| History | Lost (only current state) | Complete (all events) |
| Debugging | "What is the state now?" | "What led to this state?" |
| Replication | Complex sync logic | Simple event distribution |
| Time-travel | Impossible | Trivial |
| Consistency | Hard to reason about | Strong + auditable |
| Testing | Mocks, state setup | Pure functions |
| Scaling | Conflicts at write time | Conflicts resolved at read time |

---

## When to Use This Pattern

✓ **Good for:**
- Messaging systems
- Financial transactions
- Audit-critical applications
- Collaborative tools
- Distributed systems
- When you need complete history

❌ **Less ideal for:**
- Bulk data processing
- Real-time analytics at extreme scale
- When events aren't meaningful (raw logs)

---

## References

- **Event Sourcing**: Martin Fowler, Greg Young
- **CQRS**: Command Query Responsibility Segregation
- **Functional Programming**: Pure functions, immutability, determinism
- **Distributed Systems**: Causal consistency, replication

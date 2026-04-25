/**
 * INTEGRATION GUIDE: Pure Functional Event Sourcing Messaging System
 * 
 * Real-world patterns and examples
 */

import {
  PureFunctionalMessagingSystem,
  EventStore,
  Event,
  MessageEvent,
  Message,
  Conversation,
  deriveMessage,
  buildReadModel,
} from './event_sourcing_system';

// ============================================================================
// PATTERN 1: WebSocket Syncing (Distributed State)
// ============================================================================

/**
 * Multi-user messaging with WebSocket sync
 * 
 * Key insight: Clients send events to server, server distributes to all.
 * All clients derive identical state.
 */

class DistributedMessagingServer {
  private eventStore: EventStore = new EventStore();
  private subscribers = new Map<string, (events: Event<MessageEvent>[]) => void>();

  /**
   * Client sends command → server produces events → server distributes
   */
  async handleClientCommand(
    userId: string,
    conversationId: string,
    command: any,
  ) {
    // 1. Validate command (server-side)
    const currentConversation = this.getConversation(conversationId);
    
    // 2. Produce events from command
    let resultingEvents: Event<MessageEvent>[] = [];
    
    if (command.type === 'CreateMessage') {
      resultingEvents = [
        {
          id: `evt-${Date.now()}`,
          type: 'message:created',
          timestamp: Date.now(),
          aggregateId: conversationId,
          version: 1, // Server will set real version
          data: {
            type: 'MessageCreated',
            messageId: `msg-${Date.now()}`,
            content: command.content,
            authorId: userId,
          },
          metadata: { userId, source: 'client' },
        } as Event<MessageEvent>,
      ];
    }

    // 3. Append to server's event log
    if (resultingEvents.length > 0) {
      this.eventStore = this.eventStore.append(resultingEvents);

      // 4. Broadcast to all subscribers (WebSocket, etc)
      this.broadcastToSubscribers(conversationId, resultingEvents);
    }

    return { events: resultingEvents };
  }

  /**
   * Each client has identical event log and derives identical state
   */
  private broadcastToSubscribers(conversationId: string, events: Event<MessageEvent>[]) {
    // In real app: send via WebSocket
    // client1.send(events);
    // client2.send(events);
    // client3.send(events);
    
    // All clients:
    // eventStore.append(events);
    // readModel = buildReadModel(eventStore.getEvents());
    // ui.render(readModel.conversations.get(conversationId));
  }

  getConversation(id: string): Conversation | null {
    const events = this.eventStore.getEvents();
    const model = buildReadModel(events);
    return model.conversations.get(id) || null;
  }
}

// ============================================================================
// PATTERN 2: Optimistic UI Updates
// ============================================================================

/**
 * User sees changes instantly, server confirms later
 * 
 * 1. Client produces event optimistically
 * 2. Shows in UI immediately
 * 3. Sends to server
 * 4. Server confirms or rejects (with new version)
 */

class OptimisticMessagingClient {
  private localEventStore: EventStore = new EventStore();
  private optimisticEvents = new Map<string, Event<MessageEvent>>();

  /**
   * User clicks "send" → immediate UI update
   */
  async sendMessage(conversationId: string, userId: string, content: string) {
    // 1. Optimistically create event
    const optimisticEvent: Event<MessageEvent> = {
      id: `optimistic-${Date.now()}`,
      type: 'message:created',
      timestamp: Date.now(),
      aggregateId: conversationId,
      version: 999, // Temporary
      data: {
        type: 'MessageCreated',
        messageId: `tmp-${Date.now()}`,
        content,
        authorId: userId,
      },
      metadata: { userId, source: 'optimistic' },
    };

    // 2. Add to local store and update UI
    const tempId = optimisticEvent.id;
    this.optimisticEvents.set(tempId, optimisticEvent);
    this.updateUIImmediately(conversationId, optimisticEvent);

    // 3. Send to server asynchronously
    try {
      const serverResponse = await fetch('/api/message', {
        method: 'POST',
        body: JSON.stringify({ conversationId, userId, content }),
      });

      const confirmedEvent = await serverResponse.json();

      // 4. Server sent back the real event with real IDs and version
      if (serverResponse.ok) {
        // Remove optimistic, add confirmed
        this.optimisticEvents.delete(tempId);
        this.localEventStore = this.localEventStore.append([confirmedEvent]);
        this.updateUIWithConfirmed(conversationId, confirmedEvent);
      } else {
        // Reject: remove optimistic, show error
        this.optimisticEvents.delete(tempId);
        this.showError('Message failed to send');
      }
    } catch (error) {
      this.optimisticEvents.delete(tempId);
      this.showError(`Network error: ${error}`);
    }
  }

  private updateUIImmediately(conversationId: string, event: Event<MessageEvent>) {
    // Render optimistically (might be loading state)
    const events = [
      ...this.localEventStore.getEvents(),
      ...Array.from(this.optimisticEvents.values()),
    ];
    const readModel = buildReadModel(events);
    const conversation = readModel.conversations.get(conversationId);
    // ui.render(conversation);
  }

  private updateUIWithConfirmed(conversationId: string, event: Event<MessageEvent>) {
    // Remove loading state, show confirmed
    const events = this.localEventStore.getEvents();
    const readModel = buildReadModel(events);
    const conversation = readModel.conversations.get(conversationId);
    // ui.render(conversation);
  }

  private showError(msg: string) {
    console.error(msg);
  }
}

// ============================================================================
// PATTERN 3: Event Snapshots
// ============================================================================

/**
 * For large event logs, periodically save snapshots
 * 
 * Instead of replaying 1M events, replay last 100K from snapshot
 */

class SnapshotManager {
  /**
   * After N events, create a snapshot
   */
  createSnapshot(events: Event<MessageEvent>[], maxEventsBeforeSnapshot = 10000) {
    if (events.length < maxEventsBeforeSnapshot) {
      return null;
    }

    // Take first N events, build read model
    const snapshotEvents = events.slice(0, maxEventsBeforeSnapshot);
    const readModel = buildReadModel(snapshotEvents);

    return {
      snapshotId: `snapshot-${Date.now()}`,
      version: maxEventsBeforeSnapshot,
      readModel,
      timestamp: Date.now(),
    };
  }

  /**
   * Restore from snapshot + new events
   */
  restoreFromSnapshot(
    snapshot: any,
    additionalEvents: Event<MessageEvent>[],
  ) {
    // Instead of replaying all events from start:
    // 1. Load snapshot (O(1) deserialization)
    // 2. Apply only new events since snapshot

    const allEvents = [
      // ... events from snapshot ...
      ...additionalEvents,
    ];

    return buildReadModel(allEvents);
  }
}

// ============================================================================
// PATTERN 4: Event Versioning & Migration
// ============================================================================

/**
 * Events format might change over time
 * 
 * V1: { type: 'MessageCreated', messageId, content, authorId }
 * V2: { type: 'MessageCreated', messageId, content, authorId, language }
 */

class EventMigration {
  /**
   * Deserialize events, applying migrations
   */
  static deserializeWithMigration(
    storedEvent: any,
  ): Event<MessageEvent> {
    const { version = 1, ...event } = storedEvent;

    if (version === 1) {
      // Upgrade V1 → V2
      return {
        ...event,
        data: {
          ...event.data,
          language: 'en', // Default
        },
      };
    }

    return event;
  }

  /**
   * When deriving state, handle schema changes
   */
  static deriveMessageWithVersionHandling(
    events: Event<MessageEvent>[],
  ): Message | null {
    const normalizedEvents = events.map(e => EventMigration.deserializeWithMigration(e));
    // Now derive with normalized events
    return deriveMessage(normalizedEvents);
  }
}

// ============================================================================
// PATTERN 5: Complex Queries (Read Model)
// ============================================================================

/**
 * Build specialized read models for different queries
 * 
 * The base read model is derived from events.
 * Specialized projections use the base read model.
 */

class SpecializedReadModels {
  /**
   * Messages by user index
   */
  static buildMessagesByUserIndex(
    conversations: Map<string, Conversation>,
  ) {
    const index = new Map<string, Message[]>();

    conversations.forEach(conv => {
      conv.messages.forEach(msg => {
        const existing = index.get(msg.authorId) ?? [];
        index.set(msg.authorId, [...existing, msg]);
      });
    });

    return index;
  }

  /**
   * Time-based index: messages by hour
   */
  static buildTimeIndex(
    conversations: Map<string, Conversation>,
  ) {
    const index = new Map<number, Message[]>(); // hour -> messages

    conversations.forEach(conv => {
      conv.messages.forEach(msg => {
        const hourKey = Math.floor(msg.createdAt / 3600000);
        const existing = index.get(hourKey) ?? [];
        index.set(hourKey, [...existing, msg]);
      });
    });

    return index;
  }

  /**
   * Full-text search index
   */
  static buildSearchIndex(conversations: Map<string, Conversation>) {
    const index = new Map<string, Message[]>(); // word -> messages

    conversations.forEach(conv => {
      conv.messages.forEach(msg => {
        const words = msg.content.toLowerCase().split(/\s+/);
        words.forEach(word => {
          const existing = index.get(word) ?? [];
          index.set(word, [...existing, msg]);
        });
      });
    });

    return index;
  }
}

// ============================================================================
// PATTERN 6: Debugging & Replaying
// ============================================================================

/**
 * Replay events to debug issues or understand how state changed
 */

class DebugTools {
  /**
   * Print timeline of conversation
   */
  static printTimeline(
    events: Event<MessageEvent>[],
    conversationId: string,
  ) {
    const convEvents = events.filter(e => e.aggregateId === conversationId);

    console.log(`\n=== Timeline for conversation ${conversationId} ===\n`);

    convEvents.forEach((event, idx) => {
      const date = new Date(event.timestamp);
      const dataStr = JSON.stringify(event.data);
      console.log(`${idx}: [${date.toISOString()}] ${event.type}`);
      console.log(`   ${dataStr}`);
    });
  }

  /**
   * Replay to specific point in time
   */
  static replayUntil(
    events: Event<MessageEvent>[],
    untilTimestamp: number,
  ) {
    const relevantEvents = events.filter(e => e.timestamp <= untilTimestamp);
    return buildReadModel(relevantEvents);
  }

  /**
   * Check consistency: rebuild from scratch should match current state
   */
  static verifyConsistency(eventStore: EventStore, currentState: any) {
    const rebuiltState = buildReadModel(eventStore.getEvents());

    // Deep comparison
    const rebuilt = JSON.stringify(rebuiltState);
    const current = JSON.stringify(currentState);

    if (rebuilt === current) {
      console.log('✓ State is consistent');
      return true;
    } else {
      console.log('✗ State is inconsistent!');
      console.log('Rebuilt:', rebuilt);
      console.log('Current:', current);
      return false;
    }
  }
}

// ============================================================================
// PATTERN 7: Authorization & Permissions
// ============================================================================

/**
 * Use events to track permissions
 * 
 * E.g., "Message can only be edited by author" is checked in command handler
 */

class AuthorizationModel {
  /**
   * Can user edit this message?
   */
  static canEditMessage(message: Message, userId: string): boolean {
    // Only author can edit
    return message.authorId === userId && !message.deletedAt;
  }

  /**
   * Can user delete this message?
   */
  static canDeleteMessage(message: Message, userId: string): boolean {
    // Only author can delete
    return message.authorId === userId && !message.deletedAt;
  }

  /**
   * Can user react to this message?
   */
  static canReactToMessage(message: Message, userId: string): boolean {
    // Anyone can react unless message is deleted
    return !message.deletedAt;
  }

  /**
   * Can user see this conversation?
   */
  static canSeeConversation(conversation: Conversation, userId: string): boolean {
    return conversation.participantIds.includes(userId);
  }
}

// ============================================================================
// PATTERN 8: Testing Patterns
// ============================================================================

/**
 * Pure functions make testing trivial
 */

class TestExamples {
  /**
   * Test: Message creation and editing
   */
  static testMessageLifecycle() {
    const events: Event<MessageEvent>[] = [
      {
        id: '1',
        type: 'message:created',
        timestamp: 1000,
        aggregateId: 'conv-1',
        version: 1,
        data: {
          type: 'MessageCreated',
          messageId: 'msg-1',
          content: 'Original',
          authorId: 'alice',
        },
      },
      {
        id: '2',
        type: 'message:edited',
        timestamp: 2000,
        aggregateId: 'conv-1',
        version: 2,
        data: {
          type: 'MessageEdited',
          messageId: 'msg-1',
          newContent: 'Edited',
          editedAt: 2000,
        },
      },
    ];

    const message = deriveMessage(events);

    console.assert(message?.content === 'Edited', 'Content should be updated');
    console.assert(message?.editedAt === 2000, 'Edit time should be recorded');
    console.log('✓ testMessageLifecycle passed');
  }

  /**
   * Test: Reactions accumulate
   */
  static testReactionAccumulation() {
    const events: Event<MessageEvent>[] = [
      {
        id: '1',
        type: 'message:created',
        timestamp: 1000,
        aggregateId: 'conv-1',
        version: 1,
        data: {
          type: 'MessageCreated',
          messageId: 'msg-1',
          content: 'Great!',
          authorId: 'alice',
        },
      },
      {
        id: '2',
        type: 'reaction:added',
        timestamp: 1100,
        aggregateId: 'conv-1',
        version: 2,
        data: {
          type: 'ReactionAdded',
          messageId: 'msg-1',
          emoji: '👍',
          userId: 'bob',
        },
      },
      {
        id: '3',
        type: 'reaction:added',
        timestamp: 1200,
        aggregateId: 'conv-1',
        version: 3,
        data: {
          type: 'ReactionAdded',
          messageId: 'msg-1',
          emoji: '👍',
          userId: 'charlie',
        },
      },
    ];

    const message = deriveMessage(events);
    const thumbsUpUsers = message?.reactions.get('👍');

    console.assert(thumbsUpUsers?.size === 2, 'Should have 2 thumbs up');
    console.assert(thumbsUpUsers?.has('bob'), 'Bob should have reacted');
    console.assert(thumbsUpUsers?.has('charlie'), 'Charlie should have reacted');
    console.log('✓ testReactionAccumulation passed');
  }

  /**
   * Test: Deleted messages are filtered out
   */
  static testMessageDeletion() {
    const events: Event<MessageEvent>[] = [
      {
        id: '1',
        type: 'message:created',
        timestamp: 1000,
        aggregateId: 'conv-1',
        version: 1,
        data: {
          type: 'MessageCreated',
          messageId: 'msg-1',
          content: 'Will be deleted',
          authorId: 'alice',
        },
      },
      {
        id: '2',
        type: 'message:deleted',
        timestamp: 2000,
        aggregateId: 'conv-1',
        version: 2,
        data: {
          type: 'MessageDeleted',
          messageId: 'msg-1',
          deletedAt: 2000,
        },
      },
    ];

    const message = deriveMessage(events);

    console.assert(message === null, 'Deleted message should return null');
    console.log('✓ testMessageDeletion passed');
  }
}

// ============================================================================
// EXPORT USAGE EXAMPLES
// ============================================================================

export {
  DistributedMessagingServer,
  OptimisticMessagingClient,
  SnapshotManager,
  EventMigration,
  SpecializedReadModels,
  DebugTools,
  AuthorizationModel,
  TestExamples,
};

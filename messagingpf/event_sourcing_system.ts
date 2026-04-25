/**
 * Pure Functional Event Sourcing Messaging System
 * 
 * Core principle: All state is derived from canonical events through pure functions.
 * No mutable state, no side effects in reduction logic.
 */

// ============================================================================
// TYPES & DEFINITIONS
// ============================================================================

/**
 * Canonical event - the single source of truth
 * Every event is immutable and contains all data needed to derive new state
 */
export interface Event<T = any> {
  readonly id: string;           // Unique event ID (UUID)
  readonly type: string;         // Event type discriminator
  readonly timestamp: number;    // Unix timestamp (ms)
  readonly aggregateId: string;  // Which entity/conversation this belongs to
  readonly version: number;      // Event ordering within aggregate
  readonly data: T;              // Event payload (immutable)
  readonly metadata?: {
    readonly userId?: string;
    readonly source?: string;
    readonly causationId?: string;
  };
}

/**
 * Message - the state derived from events
 * Recalculated deterministically from events by pure functions
 */
export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly authorId: string;
  readonly content: string;
  readonly createdAt: number;
  readonly editedAt?: number;
  readonly deletedAt?: number;
  readonly reactions: ReadonlyMap<string, ReadonlySet<string>>; // emoji -> Set<userId>
}

/**
 * Conversation - container of messages, also derived from events
 */
export interface Conversation {
  readonly id: string;
  readonly participantIds: ReadonlyArray<string>;
  readonly createdAt: number;
  readonly messages: ReadonlyArray<Message>; // Always sorted by createdAt
  readonly isActive: boolean;
}

// Event type discriminators
export type MessageEvent = 
  | { readonly type: 'MessageCreated'; readonly messageId: string; readonly content: string; readonly authorId: string }
  | { type: 'MessageEdited'; readonly messageId: string; readonly newContent: string; readonly editedAt: number }
  | { type: 'MessageDeleted'; readonly messageId: string; readonly deletedAt: number }
  | { type: 'ReactionAdded'; readonly messageId: string; readonly emoji: string; readonly userId: string }
  | { type: 'ReactionRemoved'; readonly messageId: string; readonly emoji: string; readonly userId: string }
  | { type: 'ConversationCreated'; readonly participantIds: ReadonlyArray<string> }
  | { type: 'ParticipantAdded'; readonly userId: string }
  | { type: 'ParticipantRemoved'; readonly userId: string }
  | { type: 'ConversationClosed' };

// ============================================================================
// PURE REDUCTION FUNCTIONS
// ============================================================================

/**
 * Pure function: Derive a message from its events
 * Given all events for a message ID, compute the current message state
 */
export const deriveMessage = (messageEvents: ReadonlyArray<Event<MessageEvent>>): Message | null => {
  if (messageEvents.length === 0) return null;

  // Find the creation event (must exist first)
  const creationEvent = messageEvents.find(e => e.data.type === 'MessageCreated');
  if (!creationEvent || creationEvent.data.type !== 'MessageCreated') return null;

  // If deleted, return null (message doesn't exist in projection)
  const deletionEvent = messageEvents.find(e => e.data.type === 'MessageDeleted');
  if (deletionEvent && deletionEvent.data.type === 'MessageDeleted') {
    return null;
  }

  // Find latest edit
  const editEvents = messageEvents.filter(e => e.data.type === 'MessageEdited');
  const latestEdit = editEvents.length > 0 ? editEvents[editEvents.length - 1] : null;

  // Accumulate reactions: fold over all reaction events
  const reactions = messageEvents
    .filter(e => e.data.type === 'ReactionAdded' || e.data.type === 'ReactionRemoved')
    .reduce((acc, event) => {
      const evt = event.data;
      if (evt.type === 'ReactionAdded') {
        const set = acc.get(evt.emoji) ?? new Set<string>();
        return new Map(acc).set(evt.emoji, new Set([...set, evt.userId]));
      } else if (evt.type === 'ReactionRemoved') {
        const set = acc.get(evt.emoji) ?? new Set<string>();
        const updated = new Set(set);
        updated.delete(evt.userId);
        const newMap = new Map(acc);
        if (updated.size === 0) {
          newMap.delete(evt.emoji);
        } else {
          newMap.set(evt.emoji, updated);
        }
        return newMap;
      }
      return acc;
    }, new Map<string, Set<string>>());

  return {
    id: creationEvent.data.messageId,
    conversationId: creationEvent.aggregateId,
    authorId: creationEvent.data.authorId,
    content: latestEdit ? 
      (latestEdit.data.type === 'MessageEdited' ? latestEdit.data.newContent : creationEvent.data.content) :
      creationEvent.data.content,
    createdAt: creationEvent.timestamp,
    editedAt: latestEdit?.timestamp,
    deletedAt: undefined,
    reactions: reactions as ReadonlyMap<string, ReadonlySet<string>>,
  };
};

/**
 * Pure function: Derive a conversation from its events
 * Given all events for a conversation ID, compute the current conversation state
 */
export const deriveConversation = (
  conversationId: string,
  allEvents: ReadonlyArray<Event<MessageEvent>>,
): Conversation | null => {
  // Filter events for this conversation
  const convEvents = allEvents.filter(e => e.aggregateId === conversationId);
  if (convEvents.length === 0) return null;

  // Find conversation creation event
  const creationEvent = convEvents.find(e => e.data.type === 'ConversationCreated');
  if (!creationEvent || creationEvent.data.type !== 'ConversationCreated') return null;

  // Check if conversation is closed
  const closedEvent = convEvents.find(e => e.data.type === 'ConversationClosed');

  // Accumulate participant changes
  const participants = creationEvent.data.participantIds.reduce((acc, id) => {
    const set = new Set(acc);
    set.add(id);
    return set;
  }, new Set<string>());

  convEvents.forEach(event => {
    if (event.data.type === 'ParticipantAdded') {
      participants.add(event.data.userId);
    } else if (event.data.type === 'ParticipantRemoved') {
      participants.delete(event.data.userId);
    }
  });

  // Derive all messages within this conversation
  const messageIds = new Set<string>();
  convEvents.forEach(event => {
    if (event.data.type === 'MessageCreated') {
      messageIds.add(event.data.messageId);
    }
  });

  const messages = Array.from(messageIds)
    .map(messageId => {
      const messageEvents = convEvents.filter(e => {
        const evt = e.data;
        return evt.type === 'MessageCreated' && evt.messageId === messageId ||
               evt.type === 'MessageEdited' && evt.messageId === messageId ||
               evt.type === 'MessageDeleted' && evt.messageId === messageId ||
               evt.type === 'ReactionAdded' && evt.messageId === messageId ||
               evt.type === 'ReactionRemoved' && evt.messageId === messageId;
      });
      return deriveMessage(messageEvents);
    })
    .filter((m): m is Message => m !== null)
    .sort((a, b) => a.createdAt - b.createdAt);

  return {
    id: conversationId,
    participantIds: Array.from(participants).sort(),
    createdAt: creationEvent.timestamp,
    messages,
    isActive: !closedEvent,
  };
};

// ============================================================================
// COMMAND HANDLERS - Produce Events from Commands
// ============================================================================

/**
 * A command is a request to change state
 * Commands are validated and converted to events
 */
export interface Command<T = any> {
  readonly type: string;
  readonly payload: T;
}

/**
 * Commands produce events; never modify state directly
 */
export interface CommandResult {
  readonly events: ReadonlyArray<Event<MessageEvent>>;
  readonly errors: ReadonlyArray<string>;
}

/**
 * Pure function: Create a message event
 */
export const handleCreateMessage = (
  conversationId: string,
  authorId: string,
  content: string,
): CommandResult => {
  const errors: string[] = [];

  if (!content || content.trim().length === 0) {
    errors.push('Message content cannot be empty');
  }
  if (content.length > 10000) {
    errors.push('Message too long (max 10000 chars)');
  }

  if (errors.length > 0) {
    return { events: [], errors };
  }

  const event: Event<MessageEvent> = {
    id: generateId(),
    type: 'message:created',
    timestamp: Date.now(),
    aggregateId: conversationId,
    version: 1, // Will be set by event store
    data: {
      type: 'MessageCreated',
      messageId: generateId(),
      content: content.trim(),
      authorId,
    },
    metadata: { userId: authorId },
  };

  return { events: [event], errors: [] };
};

/**
 * Pure function: Edit a message event
 */
export const handleEditMessage = (
  conversationId: string,
  messageId: string,
  userId: string,
  newContent: string,
  currentMessage: Message | null,
): CommandResult => {
  const errors: string[] = [];

  if (!currentMessage) {
    errors.push('Message not found');
    return { events: [], errors };
  }

  if (currentMessage.authorId !== userId) {
    errors.push('Cannot edit message authored by another user');
  }

  if (currentMessage.deletedAt) {
    errors.push('Cannot edit deleted message');
  }

  if (!newContent || newContent.trim().length === 0) {
    errors.push('New content cannot be empty');
  }

  if (newContent === currentMessage.content) {
    errors.push('Content unchanged');
  }

  if (errors.length > 0) {
    return { events: [], errors };
  }

  const event: Event<MessageEvent> = {
    id: generateId(),
    type: 'message:edited',
    timestamp: Date.now(),
    aggregateId: conversationId,
    version: 1,
    data: {
      type: 'MessageEdited',
      messageId,
      newContent: newContent.trim(),
      editedAt: Date.now(),
    },
    metadata: { userId },
  };

  return { events: [event], errors: [] };
};

/**
 * Pure function: Delete a message event
 */
export const handleDeleteMessage = (
  conversationId: string,
  messageId: string,
  userId: string,
  currentMessage: Message | null,
): CommandResult => {
  const errors: string[] = [];

  if (!currentMessage) {
    errors.push('Message not found');
    return { events: [], errors };
  }

  if (currentMessage.authorId !== userId) {
    errors.push('Cannot delete message authored by another user');
  }

  if (currentMessage.deletedAt) {
    errors.push('Message already deleted');
  }

  if (errors.length > 0) {
    return { events: [], errors };
  }

  const event: Event<MessageEvent> = {
    id: generateId(),
    type: 'message:deleted',
    timestamp: Date.now(),
    aggregateId: conversationId,
    version: 1,
    data: {
      type: 'MessageDeleted',
      messageId,
      deletedAt: Date.now(),
    },
    metadata: { userId },
  };

  return { events: [event], errors: [] };
};

/**
 * Pure function: Add reaction event
 */
export const handleAddReaction = (
  conversationId: string,
  messageId: string,
  userId: string,
  emoji: string,
  currentMessage: Message | null,
): CommandResult => {
  const errors: string[] = [];

  if (!currentMessage) {
    errors.push('Message not found');
    return { events: [], errors };
  }

  if (currentMessage.deletedAt) {
    errors.push('Cannot react to deleted message');
  }

  if (!emoji || emoji.length === 0) {
    errors.push('Emoji cannot be empty');
  }

  const alreadyReacted = currentMessage.reactions.get(emoji)?.has(userId);
  if (alreadyReacted) {
    errors.push('Already reacted with this emoji');
  }

  if (errors.length > 0) {
    return { events: [], errors };
  }

  const event: Event<MessageEvent> = {
    id: generateId(),
    type: 'reaction:added',
    timestamp: Date.now(),
    aggregateId: conversationId,
    version: 1,
    data: {
      type: 'ReactionAdded',
      messageId,
      emoji,
      userId,
    },
    metadata: { userId },
  };

  return { events: [event], errors: [] };
};

/**
 * Pure function: Remove reaction event
 */
export const handleRemoveReaction = (
  conversationId: string,
  messageId: string,
  userId: string,
  emoji: string,
  currentMessage: Message | null,
): CommandResult => {
  const errors: string[] = [];

  if (!currentMessage) {
    errors.push('Message not found');
    return { events: [], errors };
  }

  const hasReacted = currentMessage.reactions.get(emoji)?.has(userId);
  if (!hasReacted) {
    errors.push('No reaction to remove');
  }

  if (errors.length > 0) {
    return { events: [], errors };
  }

  const event: Event<MessageEvent> = {
    id: generateId(),
    type: 'reaction:removed',
    timestamp: Date.now(),
    aggregateId: conversationId,
    version: 1,
    data: {
      type: 'ReactionRemoved',
      messageId,
      emoji,
      userId,
    },
    metadata: { userId },
  };

  return { events: [event], errors: [] };
};

// ============================================================================
// EVENT STORE - Append-only log of canonical events
// ============================================================================

/**
 * In-memory event store (production would use database)
 * Stores events in append-only sequence
 */
export class EventStore {
  private events: Event<MessageEvent>[] = [];
  private version = 0;

  /**
   * Append events to the log (pure: returns new EventStore with appended events)
   */
  append(newEvents: ReadonlyArray<Event<MessageEvent>>): EventStore {
    const updated = new EventStore();
    updated.events = [
      ...this.events,
      ...newEvents.map((e, i) => ({
        ...e,
        version: this.version + i + 1,
      })),
    ];
    updated.version = updated.events.length;
    return updated;
  }

  /**
   * Get all events (immutable)
   */
  getEvents(): ReadonlyArray<Event<MessageEvent>> {
    return Object.freeze([...this.events]);
  }

  /**
   * Get events for a specific aggregate
   */
  getAggregateEvents(aggregateId: string): ReadonlyArray<Event<MessageEvent>> {
    return this.events.filter(e => e.aggregateId === aggregateId);
  }

  /**
   * Get events of a specific type
   */
  getEventsByType(type: string): ReadonlyArray<Event<MessageEvent>> {
    return this.events.filter(e => e.data.type === type);
  }
}

// ============================================================================
// PROJECTION - Materialized view of state derived from events
// ============================================================================

/**
 * Read model: Derived from event log, used for queries
 * Completely reconstructible from events
 */
export interface ReadModel {
  readonly conversations: ReadonlyMap<string, Conversation>;
  readonly messages: ReadonlyMap<string, Message>;
}

/**
 * Pure function: Build read model from event stream
 * Can be called anytime to reconstruct complete state
 */
export const buildReadModel = (events: ReadonlyArray<Event<MessageEvent>>): ReadModel => {
  // Get all unique conversation IDs
  const conversationIds = new Set<string>();
  const messageIds = new Set<string>();

  events.forEach(e => {
    conversationIds.add(e.aggregateId);
    if (e.data.type === 'MessageCreated') {
      messageIds.add(e.data.messageId);
    }
  });

  // Build each conversation
  const conversations = new Map<string, Conversation>();
  conversationIds.forEach(convId => {
    const conv = deriveConversation(convId, events);
    if (conv) {
      conversations.set(convId, conv);
    }
  });

  // Build each message
  const messages = new Map<string, Message>();
  messageIds.forEach(msgId => {
    const msgEvents = events.filter(e => {
      const evt = e.data;
      return (evt.type === 'MessageCreated' && evt.messageId === msgId) ||
             (evt.type === 'MessageEdited' && evt.messageId === msgId) ||
             (evt.type === 'MessageDeleted' && evt.messageId === msgId) ||
             (evt.type === 'ReactionAdded' && evt.messageId === msgId) ||
             (evt.type === 'ReactionRemoved' && evt.messageId === msgId);
    });
    const msg = deriveMessage(msgEvents);
    if (msg) {
      messages.set(msgId, msg);
    }
  });

  return {
    conversations: new Map(conversations),
    messages: new Map(messages),
  };
};

// ============================================================================
// MESSAGING SYSTEM - Orchestrates commands, events, and queries
// ============================================================================

export class PureFunctionalMessagingSystem {
  private eventStore: EventStore;
  private readModel: ReadModel;

  constructor() {
    this.eventStore = new EventStore();
    this.readModel = buildReadModel([]);
  }

  /**
   * Get a conversation with all its messages
   */
  getConversation(conversationId: string): Conversation | null {
    return this.readModel.conversations.get(conversationId) ?? null;
  }

  /**
   * Get a specific message
   */
  getMessage(messageId: string): Message | null {
    return this.readModel.messages.get(messageId) ?? null;
  }

  /**
   * Execute a command and persist resulting events
   * Returns the new state after applying the command
   */
  executeCommand(
    commandType: string,
    conversationId: string,
    userId: string,
    payload: any,
  ): CommandResult & { newState?: Conversation } {
    let result: CommandResult = { events: [], errors: [] };

    // Route command to handler
    switch (commandType) {
      case 'CreateMessage': {
        result = handleCreateMessage(conversationId, userId, payload.content);
        break;
      }
      case 'EditMessage': {
        const currentMessage = this.getMessage(payload.messageId);
        result = handleEditMessage(conversationId, payload.messageId, userId, payload.newContent, currentMessage);
        break;
      }
      case 'DeleteMessage': {
        const currentMessage = this.getMessage(payload.messageId);
        result = handleDeleteMessage(conversationId, payload.messageId, userId, currentMessage);
        break;
      }
      case 'AddReaction': {
        const currentMessage = this.getMessage(payload.messageId);
        result = handleAddReaction(conversationId, payload.messageId, userId, payload.emoji, currentMessage);
        break;
      }
      case 'RemoveReaction': {
        const currentMessage = this.getMessage(payload.messageId);
        result = handleRemoveReaction(conversationId, payload.messageId, userId, payload.emoji, currentMessage);
        break;
      }
      default:
        result = { events: [], errors: [`Unknown command: ${commandType}`] };
    }

    // If command succeeded, persist events and rebuild read model
    if (result.events.length > 0) {
      this.eventStore = this.eventStore.append(result.events);
      this.readModel = buildReadModel(this.eventStore.getEvents());
    }

    return {
      ...result,
      newState: this.getConversation(conversationId) ?? undefined,
    };
  }

  /**
   * Create a new conversation
   */
  createConversation(conversationId: string, participantIds: string[]): CommandResult {
    const event: Event<MessageEvent> = {
      id: generateId(),
      type: 'conversation:created',
      timestamp: Date.now(),
      aggregateId: conversationId,
      version: 1,
      data: {
        type: 'ConversationCreated',
        participantIds,
      },
    };

    this.eventStore = this.eventStore.append([event]);
    this.readModel = buildReadModel(this.eventStore.getEvents());

    return { events: [event], errors: [] };
  }

  /**
   * Get all events (for debugging, snapshots, replication)
   */
  getAllEvents(): ReadonlyArray<Event<MessageEvent>> {
    return this.eventStore.getEvents();
  }

  /**
   * Snapshot: rebuild state from scratch (proves it's all deterministic)
   */
  rebuildFromScratch(): ReadModel {
    return buildReadModel(this.eventStore.getEvents());
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Generate a simple ID (production would use UUID library)
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Pure function: Filter messages by author
 */
export const filterMessagesByAuthor = (
  messages: ReadonlyArray<Message>,
  authorId: string,
): ReadonlyArray<Message> => {
  return messages.filter(m => m.authorId === authorId);
};

/**
 * Pure function: Get message with most reactions
 */
export const getMostReactedMessage = (
  messages: ReadonlyArray<Message>,
): Message | null => {
  if (messages.length === 0) return null;
  
  return messages.reduce((max, msg) => {
    const msgReactionCount = Array.from(msg.reactions.values())
      .reduce((sum, set) => sum + set.size, 0);
    const maxReactionCount = Array.from((max.reactions || new Map()).values())
      .reduce((sum, set) => sum + set.size, 0);
    return msgReactionCount > maxReactionCount ? msg : max;
  });
};

/**
 * Pure function: Timeline of edits for a message
 */
export const getMessageEditHistory = (
  allEvents: ReadonlyArray<Event<MessageEvent>>,
  messageId: string,
): Array<{ content: string; editedAt: number }> => {
  const events = allEvents.filter(e => {
    const evt = e.data;
    return (evt.type === 'MessageCreated' && evt.messageId === messageId) ||
           (evt.type === 'MessageEdited' && evt.messageId === messageId);
  });

  return events
    .map(e => {
      const evt = e.data;
      if (evt.type === 'MessageCreated') {
        return { content: evt.content, editedAt: e.timestamp };
      } else if (evt.type === 'MessageEdited') {
        return { content: evt.newContent, editedAt: e.timestamp };
      }
      return null;
    })
    .filter((x): x is { content: string; editedAt: number } => x !== null);
};

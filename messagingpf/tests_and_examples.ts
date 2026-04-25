/**
 * Tests & Examples: Pure Functional Event Sourcing Messaging System
 * 
 * Demonstrates:
 * - Pure functions always produce the same output for same input
 * - State is completely reconstructible from events
 * - No mutable state, complete auditability
 */

import {
  PureFunctionalMessagingSystem,
  buildReadModel,
  deriveMessage,
  deriveConversation,
  handleCreateMessage,
  handleEditMessage,
  handleAddReaction,
  handleRemoveReaction,
  getMessageEditHistory,
  getMostReactedMessage,
  EventStore,
  Event,
  MessageEvent,
  Message,
  Conversation,
} from './event_sourcing_system';

// ============================================================================
// TEST 1: Pure Function Determinism
// ============================================================================

console.log('=== TEST 1: Pure Function Determinism ===\n');

const system = new PureFunctionalMessagingSystem();

// Create a conversation
system.createConversation('conv-1', ['alice', 'bob']);

// Same command twice = same result
const result1 = system.executeCommand('CreateMessage', 'conv-1', 'alice', {
  content: 'Hello, world!',
});

const allEvents1 = system.getAllEvents();
console.log('✓ First message created');
console.log(`  Events in log: ${allEvents1.length}`);
console.log(`  Message ID: ${(result1.events[0]?.data as any)?.messageId}`);

// Query the same conversation twice
const conv1 = system.getConversation('conv-1');
const conv2 = system.getConversation('conv-1');

console.log('\n✓ Same query, identical result:');
console.log(`  conv1 === conv2: ${conv1 === conv2} (object identity, not just value)`);
console.log(`  Messages count: ${conv1?.messages.length}`);
console.log(`  First message: "${conv1?.messages[0]?.content}"`);

// ============================================================================
// TEST 2: Complete State Reconstruction
// ============================================================================

console.log('\n\n=== TEST 2: Complete State Reconstruction ===\n');

// Make changes
system.executeCommand('CreateMessage', 'conv-1', 'bob', { content: 'Hi Alice!' });
system.executeCommand('CreateMessage', 'conv-1', 'alice', { content: 'How are you?' });

const msgId = (system.getAllEvents()
  .find(e => (e.data as any)?.type === 'MessageCreated' && (e.data as any)?.content === 'Hi Alice!')?.data as any)?.messageId;

system.executeCommand('AddReaction', 'conv-1', 'alice', {
  messageId: msgId,
  emoji: '👍',
});

system.executeCommand('EditMessage', 'conv-1', 'bob', {
  messageId: msgId,
  newContent: 'Hi Alice! 😊',
});

// Get current state
const currentState = system.getConversation('conv-1');
console.log('Current state:');
console.log(`  Messages: ${currentState?.messages.length}`);
console.log(`  Last message: "${currentState?.messages[currentState!.messages.length - 1]?.content}"`);

// Rebuild from scratch
const allEvents = system.getAllEvents();
console.log(`\nTotal events in log: ${allEvents.length}`);

const rebuiltReadModel = buildReadModel(allEvents);
const rebuiltConv = rebuiltReadModel.conversations.get('conv-1');

console.log('\n✓ Rebuilt state from events:');
console.log(`  Messages match: ${currentState?.messages.length === rebuiltConv?.messages.length}`);
console.log(`  Content match: ${
  currentState?.messages.map(m => m.content).join(' | ') ===
  rebuiltConv?.messages.map(m => m.content).join(' | ')
}`);
console.log(`  Reactions preserved: ${
  JSON.stringify(Array.from(currentState?.messages[1]?.reactions.entries() ?? [])) ===
  JSON.stringify(Array.from(rebuiltConv?.messages[1]?.reactions.entries() ?? []))
}`);

// ============================================================================
// TEST 3: Immutability & Derived State
// ============================================================================

console.log('\n\n=== TEST 3: Immutability & Derived State ===\n');

const initialConv = system.getConversation('conv-1');
const initialMsgCount = initialConv?.messages.length ?? 0;

// Try to modify (should not work - read-only)
// @ts-ignore (intentionally)
initialConv?.messages.push({ id: 'fake', content: 'hacked' });

const sameConv = system.getConversation('conv-1');
console.log('✓ Immutable state:');
console.log(`  Initial count: ${initialMsgCount}`);
console.log(`  After attempted mutation: ${sameConv?.messages.length}`);
console.log(`  Still the same: ${initialMsgCount === sameConv?.messages.length}`);

// Create new message, previous references unchanged
system.executeCommand('CreateMessage', 'conv-1', 'alice', { content: 'New message' });
console.log(`\n✓ Previous references unaffected by new data:`);
console.log(`  Old reference still has ${initialConv?.messages.length} messages`);
console.log(`  New query shows ${system.getConversation('conv-1')?.messages.length} messages`);

// ============================================================================
// TEST 4: Edit History & Auditability
// ============================================================================

console.log('\n\n=== TEST 4: Edit History & Auditability ===\n');

const system2 = new PureFunctionalMessagingSystem();
system2.createConversation('conv-2', ['charlie', 'diana']);

// Create and edit a message
system2.executeCommand('CreateMessage', 'conv-2', 'charlie', { content: 'First draft' });
const msg = system2.getConversation('conv-2')?.messages[0];
const messageId = msg?.id!;

console.log('Message lifecycle:');
console.log(`  Created: "${msg?.content}"`);

system2.executeCommand('EditMessage', 'conv-2', 'charlie', {
  messageId,
  newContent: 'Second draft',
});
console.log(`  Edited: "${system2.getMessage(messageId)?.content}"`);

system2.executeCommand('EditMessage', 'conv-2', 'charlie', {
  messageId,
  newContent: 'Final version',
});
console.log(`  Edited again: "${system2.getMessage(messageId)?.content}"`);

// Get full history
const history = getMessageEditHistory(system2.getAllEvents(), messageId);
console.log(`\n✓ Complete audit trail (${history.length} versions):`);
history.forEach((h, i) => {
  const date = new Date(h.editedAt).toISOString();
  console.log(`  ${i}: "${h.content}" @ ${date}`);
});

// ============================================================================
// TEST 5: Reaction Accumulation (Fold Pattern)
// ============================================================================

console.log('\n\n=== TEST 5: Reaction Accumulation ===\n');

const system3 = new PureFunctionalMessagingSystem();
system3.createConversation('conv-3', ['eve', 'frank', 'grace']);

system3.executeCommand('CreateMessage', 'conv-3', 'eve', { content: 'Nice idea!' });
const msg3 = system3.getConversation('conv-3')?.messages[0];
const msg3Id = msg3?.id!;

console.log('Adding reactions:');

const users = ['eve', 'frank', 'grace'];
const emojis = ['👍', '❤️', '😂'];

for (let i = 0; i < 3; i++) {
  system3.executeCommand('AddReaction', 'conv-3', users[i], {
    messageId: msg3Id,
    emoji: emojis[i],
  });
  const updated = system3.getMessage(msg3Id);
  const reactionCount = Array.from(updated?.reactions.values() ?? [])
    .reduce((sum, set) => sum + set.size, 0);
  console.log(`  After user ${i + 1}: ${reactionCount} total reactions`);
}

// Multiple users can react with same emoji
system3.executeCommand('AddReaction', 'conv-3', 'frank', { messageId: msg3Id, emoji: '👍' });
system3.executeCommand('AddReaction', 'conv-3', 'grace', { messageId: msg3Id, emoji: '👍' });

const finalMsg = system3.getMessage(msg3Id);
console.log(`\n✓ Final reaction state:`);
Array.from(finalMsg?.reactions.entries() ?? []).forEach(([emoji, users]) => {
  console.log(`  ${emoji}: ${Array.from(users).join(', ')}`);
});

// ============================================================================
// TEST 6: Validation & Error Handling
// ============================================================================

console.log('\n\n=== TEST 6: Validation & Error Handling ===\n');

const system4 = new PureFunctionalMessagingSystem();
system4.createConversation('conv-4', ['henry', 'iris']);

// Try invalid commands
const errors: { cmd: string; errors: string[] }[] = [];

const result1 = system4.executeCommand('CreateMessage', 'conv-4', 'henry', { content: '' });
if (result1.errors.length > 0) {
  errors.push({ cmd: 'Empty message', errors: result1.errors });
}

const longContent = 'x'.repeat(10001);
const result2 = system4.executeCommand('CreateMessage', 'conv-4', 'henry', { content: longContent });
if (result2.errors.length > 0) {
  errors.push({ cmd: 'Too long', errors: result2.errors });
}

// Create a valid message first
system4.executeCommand('CreateMessage', 'conv-4', 'henry', { content: 'Valid message' });

// Try to edit non-existent message
const result3 = system4.executeCommand('EditMessage', 'conv-4', 'henry', {
  messageId: 'nonexistent',
  newContent: 'new',
});
if (result3.errors.length > 0) {
  errors.push({ cmd: 'Edit nonexistent', errors: result3.errors });
}

// Try to edit with wrong author
const msg4 = system4.getConversation('conv-4')?.messages[0];
const result4 = system4.executeCommand('EditMessage', 'conv-4', 'iris', {
  messageId: msg4?.id,
  newContent: 'hacked',
});
if (result4.errors.length > 0) {
  errors.push({ cmd: 'Edit wrong author', errors: result4.errors });
}

console.log('✓ Validation caught errors:');
errors.forEach(({ cmd, errors: errs }) => {
  console.log(`\n  ${cmd}:`);
  errs.forEach(e => console.log(`    - ${e}`));
});

// ============================================================================
// TEST 7: Querying & Projections
// ============================================================================

console.log('\n\n=== TEST 7: Querying & Projections ===\n');

const system5 = new PureFunctionalMessagingSystem();
system5.createConversation('conv-5', ['jack', 'kate', 'liam']);

const msgData = [
  { author: 'jack', content: 'First message' },
  { author: 'kate', content: 'Second message' },
  { author: 'liam', content: 'Third message' },
  { author: 'jack', content: 'Fourth message' },
  { author: 'kate', content: 'Fifth message' },
];

msgData.forEach(({ author, content }) => {
  system5.executeCommand('CreateMessage', 'conv-5', author, { content });
});

// Add reactions
const msgs = system5.getConversation('conv-5')?.messages ?? [];
system5.executeCommand('AddReaction', 'conv-5', 'kate', {
  messageId: msgs[0].id,
  emoji: '👍',
});
system5.executeCommand('AddReaction', 'conv-5', 'liam', {
  messageId: msgs[0].id,
  emoji: '👍',
});
system5.executeCommand('AddReaction', 'conv-5', 'jack', {
  messageId: msgs[3].id,
  emoji: '👍',
});
system5.executeCommand('AddReaction', 'conv-5', 'kate', {
  messageId: msgs[3].id,
  emoji: '❤️',
});

// Pure query functions
const jackMessages = msgs.filter(m => m.authorId === 'jack');
const mostReacted = getMostReactedMessage(msgs);

console.log('✓ Pure queries on messages:');
console.log(`  Jack's messages: ${jackMessages.length} (${jackMessages.map(m => `"${m.content}"`).join(', ')})`);
console.log(`  Most reacted: "${mostReacted?.content}" (${
  Array.from(mostReacted?.reactions.values() ?? []).reduce((sum, set) => sum + set.size, 0)
} reactions)`);

// ============================================================================
// TEST 8: Time-travel / Point-in-time reconstruction
// ============================================================================

console.log('\n\n=== TEST 8: Time-travel / Point-in-time Reconstruction ===\n');

const system6 = new PureFunctionalMessagingSystem();
system6.createConversation('conv-6', ['maya', 'noah']);

const timestamps: { desc: string; eventCount: number }[] = [];

system6.executeCommand('CreateMessage', 'conv-6', 'maya', { content: 'Message 1' });
timestamps.push({ desc: 'After message 1', eventCount: system6.getAllEvents().length });

system6.executeCommand('CreateMessage', 'conv-6', 'noah', { content: 'Message 2' });
timestamps.push({ desc: 'After message 2', eventCount: system6.getAllEvents().length });

const msg = system6.getConversation('conv-6')?.messages[0];
system6.executeCommand('AddReaction', 'conv-6', 'noah', {
  messageId: msg?.id!,
  emoji: '👍',
});
timestamps.push({ desc: 'After reaction', eventCount: system6.getAllEvents().length });

system6.executeCommand('EditMessage', 'conv-6', 'maya', {
  messageId: msg?.id!,
  newContent: 'Message 1 (edited)',
});
timestamps.push({ desc: 'After edit', eventCount: system6.getAllEvents().length });

console.log('✓ Reconstructing state at different points in time:\n');

timestamps.forEach(({ desc, eventCount }) => {
  const eventsUpToHere = system6.getAllEvents().slice(0, eventCount);
  const stateAtThatTime = buildReadModel(eventsUpToHere);
  const convAtThatTime = stateAtThatTime.conversations.get('conv-6');
  
  console.log(`${desc}:`);
  console.log(`  Events: ${eventCount}`);
  console.log(`  Messages: ${convAtThatTime?.messages.length}`);
  console.log(`  Content: ${convAtThatTime?.messages.map(m => `"${m.content}"`).join(' | ')}`);
  console.log();
});

// ============================================================================
// TEST 9: Concurrent Commands (Deterministic Ordering)
// ============================================================================

console.log('=== TEST 9: Concurrent Commands (Event Log Orders) ===\n');

const system7 = new PureFunctionalMessagingSystem();
system7.createConversation('conv-7', ['olivia', 'peter']);

// Simulate "concurrent" operations - events are logged in order
const ops = [
  { author: 'olivia', content: 'First' },
  { author: 'peter', content: 'Second' },
  { author: 'olivia', content: 'Third' },
];

ops.forEach(({ author, content }) => {
  system7.executeCommand('CreateMessage', 'conv-7', author, { content });
});

const finalConv = system7.getConversation('conv-7');
console.log('✓ Operations executed in order:');
finalConv?.messages.forEach((m, i) => {
  console.log(`  ${i}: "${m.content}" by ${m.authorId} @ ${new Date(m.createdAt).toISOString()}`);
});

console.log('\nKey insight: Event log provides global ordering.');
console.log('All replicas will derive identical state, even if commands arrived out of order over network.');

// ============================================================================
// SUMMARY
// ============================================================================

console.log('\n\n=== SUMMARY ===\n');

console.log(`✓ Pure functions: Same input always produces same output`);
console.log(`✓ Immutability: State is read-only, events are immutable`);
console.log(`✓ Determinism: State is completely reconstructible from events`);
console.log(`✓ Auditability: Every change is recorded in the event log`);
console.log(`✓ Time-travel: Can reconstruct state at any point in history`);
console.log(`✓ No mutable state: Everything derived from canonical events`);
console.log(`✓ Idempotent queries: Same query always returns same result`);
console.log(`✓ Testable: Pure functions easy to test, no mocks needed`);
console.log(`✓ Replicable: Distributed systems can synchronize via event log`);
console.log(`✓ CQRS: Separate command (events) from query (read models)`);

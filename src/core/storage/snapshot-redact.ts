// Save-time redactor for ephemeral biometric capture messages. Replaces the
// fenced-block content of any message tagged cause.kind === 'biometric'
// with a placeholder so on-disk snapshots never contain landmark JSON, head
// pose, or expression scores. Live in-room rendering is unaffected — the
// in-memory message keeps its original content until next save.
//
// Why redact instead of dropping the message?
// Dropping would break message-id continuity for downstream consumers (e.g.
// a follow-up message that inReplyTo's the original). The placeholder
// keeps the chain intact while making it obvious in any audit that a
// capture happened and what is missing.
//
// SNAPSHOT_VERSION is NOT bumped: this is purely additive on an optional
// field (cause), and load remains compatible. See feedback_no_snapshot_backcompat.md.

import type { Message } from '../types/messaging.ts'

const PLACEHOLDER = '[biometric capture — not persisted]'

export const redactBiometricMessages = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> =>
  messages.map(m => m.cause?.kind === 'biometric' ? { ...m, content: PLACEHOLDER } : m)

// Generated explicit Calendar conversation intent; selection is not authority.
export type CalendarConversationWindow = { "kind": "date"; "startDate": string; "endDateExclusive": string };
export type CalendarConversationIntent = { "schemaVersion": "1.0.0"; "assistantId": string; "conversationId": string; "enrollmentId": string; "sourceNamespace": string; "expectedPolicyRevision": number; "policyBindingDigest": string; "window": CalendarConversationWindow; "expiresAt": string };
export type CalendarConversationPin = { "schemaId": "https://lifestream.dev/contracts/mobile-context-calendar-conversation/1.0.0"; "schemaVersion": "1.0.0"; "digest": string };
export type CalendarConversationAttachment = { "producerPin": CalendarConversationPin; "intent": CalendarConversationIntent };

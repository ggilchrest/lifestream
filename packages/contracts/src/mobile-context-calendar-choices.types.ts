// Generated Calendar source choices; metadata is not authority.
export type CalendarChoicesQuery = { "schemaVersion": "1.0.0"; "assistantId": string };
export type CalendarChoice = { "enrollmentId": string; "sourceNamespace": string; "collector": "eventKit" | "androidCalendar" | "googleTasks"; "policyRevision": number; "policyBindingDigest": string };
export type CalendarChoices = { "principalId": string; "assistantId": string; "choices": (CalendarChoice)[] };
export type CalendarChoicesPin = { "schemaId": "https://lifestream.dev/contracts/mobile-context-calendar-choices/1.0.0"; "schemaVersion": "1.0.0"; "digest": string };
export type CalendarChoicesResponse = { "schemaVersion": "1.0.0"; "producerPin": CalendarChoicesPin; "result": CalendarChoices };

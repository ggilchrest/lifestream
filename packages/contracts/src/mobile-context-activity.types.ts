// Generated from raw activity schema. Not presence or authority.
export type ActivityInstant = string;
export type ActivityUnknownReason = "notProvided" | "notObservable" | "unsupported";
export type ActivitySourceIdentity = { "collector": "coreMotion" | "androidActivityRecognition"; "namespace": string; "upstreamId": (string) | (null); "originalApp": (string) | (null); "originalDevice": (string) | (null) };
export type ActivityMethod = ({ "kind": "reported"; "value": string }) | ({ "kind": "unknown" });
export type ActivityConfidence = ({ "kind": "categorical"; "value": "low" | "medium" | "high" }) | ({ "kind": "unrecognized"; "nativeValue": number }) | ({ "kind": "unknown"; "reason": ActivityUnknownReason });
export type ActivityMotionFlags = { "stationary": boolean; "walking": boolean; "running": boolean; "cycling": boolean; "automotive": boolean; "unknown": boolean };
export type ActivityCoreMotion = { "kind": "coreMotion"; "flags": ActivityMotionFlags; "confidence": ActivityConfidence };
export type ActivityAndroidCandidate = { "nativeType": number; "confidencePercent": number };
export type ActivityAndroidRecognition = { "kind": "androidActivityRecognition"; "activities": (ActivityAndroidCandidate)[] };
export type ActivityUnavailable = { "kind": "unavailable"; "reason": "notObservable" | "unsupported" | "temporarilyUnavailable" | "invalidMeasurement" | "unknown" };
export type ActivityObservation = ({ "schemaVersion": "1.0.0"; "source": ActivitySourceIdentity; "observedAt": ActivityInstant; "collectedAt": ActivityInstant; "method": ActivityMethod; "observation": ActivityCoreMotion }) | ({ "schemaVersion": "1.0.0"; "source": ActivitySourceIdentity; "observedAt": ActivityInstant; "collectedAt": ActivityInstant; "method": ActivityMethod; "observation": ActivityAndroidRecognition }) | ({ "schemaVersion": "1.0.0"; "source": ActivitySourceIdentity; "observedAt": (ActivityInstant) | (null); "collectedAt": ActivityInstant; "method": ActivityMethod; "observation": ActivityUnavailable });
export type ActivityAgeContext = { "referenceAt": ActivityInstant; "maximumAgeMs": number };
export type ActivityAgeAssessment = ({ "state": "fresh" | "stale"; "ageNanoseconds": string; "maximumAgeMs": number; "qualification": "observationAgeOnly" }) | ({ "state": "unknown"; "reason": "unavailable" | "futureObservation" | "futureCollection" | "observationAfterCollection"; "ageNanoseconds": null; "maximumAgeMs": number; "qualification": "observationAgeOnly" });

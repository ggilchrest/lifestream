// Generated from raw location producer schema. Observation data is not authority.
export type LocationInstant = string;
export type LocationUnknownReason = "notProvided" | "notObservable" | "unsupported";
export type LocationProvenanceFlag = ({ "kind": "reported"; "value": boolean }) | ({ "kind": "unknown"; "reason": LocationUnknownReason });
export type LocationCollectionMethod = ({ "kind": "reported"; "value": string }) | ({ "kind": "unknown" });
export type LocationProvenance = { "method": LocationCollectionMethod; "simulatedBySoftware": LocationProvenanceFlag; "accessoryProduced": LocationProvenanceFlag; "mockProvider": LocationProvenanceFlag; "monotonicClock"?: LocationMonotonicClock };
export type LocationSourceIdentity = { "collector": "coreLocation" | "androidLocation"; "namespace": string; "upstreamId": (string) | (null); "originalApp": (string) | (null); "originalDevice": (string) | (null) };
export type LocationAccuracyConfidence = ({ "kind": "reported"; "probability": number }) | ({ "kind": "unspecified" });
export type LocationHorizontalAccuracy = ({ "kind": "reported"; "meters": number; "confidence": LocationAccuracyConfidence }) | ({ "kind": "unknown"; "reason": LocationUnknownReason });
export type LocationCoordinates = { "system": "WGS84"; "latitude": number; "longitude": number };
export type LocationPosition = { "kind": "position"; "coordinates": LocationCoordinates; "horizontalAccuracy": LocationHorizontalAccuracy };
export type LocationRegionTransition = { "kind": "regionTransition"; "sourceRegionId": string; "transition": "entered" | "exited" | "unknown" };
export type LocationUnavailable = { "kind": "unavailable"; "reason": "notObservable" | "unsupported" | "temporarilyUnavailable" | "invalidMeasurement" | "unknown" };
export type LocationObservation = ({ "schemaVersion": "1.0.0"; "source": LocationSourceIdentity; "observedAt": LocationInstant; "collectedAt": LocationInstant; "provenance": LocationProvenance; "observation": LocationPosition }) | ({ "schemaVersion": "1.0.0"; "source": LocationSourceIdentity; "observedAt": LocationInstant; "collectedAt": LocationInstant; "provenance": LocationProvenance; "observation": LocationRegionTransition }) | ({ "schemaVersion": "1.0.0"; "source": LocationSourceIdentity; "observedAt": (LocationInstant) | (null); "collectedAt": LocationInstant; "provenance": LocationProvenance; "observation": LocationUnavailable });
export type LocationAgeContext = { "referenceAt": LocationInstant; "maximumAgeMs": number };
export type LocationAgeAssessment = ({ "state": "fresh" | "stale"; "ageNanoseconds": string; "maximumAgeMs": number; "qualification": "observationAgeOnly" }) | ({ "state": "unknown"; "reason": "unavailable" | "futureObservation" | "futureCollection" | "observationAfterCollection"; "ageNanoseconds": null; "maximumAgeMs": number; "qualification": "observationAgeOnly" });
export type LocationElapsedUncertainty = ({ "kind": "reported"; "nanoseconds": number; "confidence": LocationAccuracyConfidence }) | ({ "kind": "unknown"; "reason": LocationUnknownReason });
export type LocationMonotonicClock = ({ "kind": "reported"; "elapsedRealtimeNanoseconds": string; "uncertainty": LocationElapsedUncertainty; "clockScope": (string) | (null) }) | ({ "kind": "unknown"; "reason": LocationUnknownReason });

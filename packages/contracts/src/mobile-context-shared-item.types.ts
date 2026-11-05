// Generated from declared SharedItem schema; reference metadata is not protected custody.
import type {ArtifactRef} from './provider-messages.ts';
export type SharedItemInstant = string;
export type SharedItemSource = { "collector": "iosShareDeclaration" | "androidShareDeclaration"; "namespace": string; "upstreamId": (string) | (null); "originalApp": (string) | (null); "originalDevice": (string) | (null) };
export type SharedItemUrl = string;
export type SharedTextSelection = { "kind": "text"; "mediaType": "text/plain"; "text": string };
export type SharedUrlSelection = { "kind": "url"; "mediaType": "text/uri-list"; "url": SharedItemUrl; "title": (string) | (null) };
export type SharedAttachmentReference = { "kind": "attachmentReference"; "contentKind": "image" | "file"; "artifact": ArtifactRef; "displayName": (string) | (null) };
export type SharedUnavailableSelection = { "kind": "unavailable"; "reason": "unsupportedType" | "temporarilyUnavailable" | "notObservable" | "unknown"; "declaredMediaType": (string) | (null); "displayName": (string) | (null) };
export type SharedItemContent = (SharedTextSelection) | (SharedUrlSelection) | (SharedAttachmentReference) | (SharedUnavailableSelection);
export type SharedItem = { "schemaVersion": "1.0.0"; "source": SharedItemSource; "sharedAt": SharedItemInstant; "collectedAt": SharedItemInstant; "originUrl": (SharedItemUrl) | (null); "note": (string) | (null); "content": SharedItemContent };
export type SharedItemIntegrity = { "qualification": "integrityOnly"; "sha256": string; "byteLength": number };

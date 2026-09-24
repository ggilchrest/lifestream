// Generated exclusively from digest-verified PWCE public condition contracts.
const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;};
export const EXPECTED_PWCE_CONDITION_BUNDLE=freeze({
  "profileId": "pwce-urgent-conditions.v1",
  "profileVersion": "1.0.0",
  "bundleId": "pwce-urgent-conditions.bundle.v1",
  "bundleVersion": "1.0.0",
  "routes": {
    "bundle": "/gateway/v1/conditions/bundle",
    "request": "/gateway/v1/conditions"
  },
  "authentication": {
    "agentBearerRequired": true,
    "authorityContextRequired": true,
    "contractHeader": "X-PWCE-Condition-Contract",
    "scopedSiteRequired": true
  },
  "maximumRequestBytes": 8192,
  "maximumResponseBytes": 524288,
  "maximumConditionsPerResponse": 100,
  "semantics": {
    "source": "Only a host-configured enabled source/World/site/zone/event-class binding may admit input; no gateway ingress or source enrollment operation exists. The binding fixes evidence basis and maximum severity.",
    "lifecycle": "PWCE assigns opaque condition identity, monotonically increasing revisions and ordered durable cursors. Source revisions are monotonic per condition. Exact event retransmission is idempotent; changed duplicates or terminal reopening fail closed.",
    "freshness": "Freshness is evaluated at response time; stale input cannot refresh a condition. Expiry creates a terminal revision before any later read. Freshness, qualification, uncertainty and evidence remain explicit.",
    "delivery": "Snapshot/changes are bounded polling operations, separate from the ordinary invalidation SSE stream. Cursor gaps or future cursors require a full scoped snapshot. A snapshot exceeding100 records fails explicitly; narrow source/zone selectors rather than treating a partial snapshot as complete. Changes retain ordered historical revisions and may repeat a condition identity. Superseded revisions are always stale or expired. Snapshots contain one latest revision per identity. A fresh resolved record remains terminal and never qualifies as an open condition.",
    "acknowledgment": "Acknowledgment records this authenticated consumer scope receiving the exact current revision. It never resolves a condition or proves Human acknowledgment, notification, speech, capture or action authority. Updates require a new acknowledgment.",
    "scope": "World, site, Assistant, endpoint, participants, audience and deadline are checked against current authority before state access and again before response. Source and zone selectors only narrow site authority.",
    "limits": "No live source is enabled by default. No provider calls, notifications, camera activation, interruption policy, emotion, voice controls or raw sensor/media transport are part of this extension."
  },
  "digestAlgorithm": "sha256-ordered-path-bytes-v1",
  "bundleDigest": "f472b81627d2b1dd5e56e50ce8a59ffdb68a04bb46a3a6e361378a88e91c00d5",
  "artifacts": [
    {
      "path": "contracts/urgent-conditions/profile.json",
      "sha256": "238b4f7918717a337d7a9549cdf31fdfca53ea2a77cec790ea9d5e2b5334d4c4"
    },
    {
      "path": "contracts/urgent-conditions/schema.json",
      "sha256": "256bad0cf46ff75ace754900b7610a6e71b1dbe93024941737fb9eb606b43b9d"
    }
  ]
});
export const PWCE_CONDITION_SCHEMA=freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://pwce.local/contracts/urgent-conditions-1.0.0.schema.json",
  "$defs": {
    "qualification": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "state",
        "confidence",
        "limitations",
        "evidenceRefs"
      ],
      "properties": {
        "state": {
          "enum": [
            "qualified",
            "uncertain",
            "unavailable"
          ]
        },
        "confidence": {
          "anyOf": [
            {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "limitations": {
          "type": "array",
          "maxItems": 8,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "maxLength": 256
          }
        },
        "evidenceRefs": {
          "type": "array",
          "maxItems": 16,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          }
        }
      }
    },
    "condition": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "conditionRef",
        "revision",
        "sourceRef",
        "worldRef",
        "siteRef",
        "zoneRef",
        "eventClass",
        "sourceRevision",
        "status",
        "transition",
        "severity",
        "summary",
        "occurredAt",
        "receivedAt",
        "updatedAt",
        "freshUntil",
        "expiresAt",
        "freshness",
        "basis",
        "qualification"
      ],
      "properties": {
        "conditionRef": {
          "type": "string",
          "pattern": "^pwce:condition:[a-f0-9]{64}$"
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "sourceRef": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        },
        "worldRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "siteRef": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        },
        "zoneRef": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        },
        "eventClass": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        },
        "sourceRevision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "status": {
          "enum": [
            "open",
            "resolved",
            "expired"
          ]
        },
        "transition": {
          "enum": [
            "open",
            "update",
            "resolve",
            "expire"
          ]
        },
        "severity": {
          "enum": [
            "info",
            "warning",
            "critical"
          ]
        },
        "summary": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1024
        },
        "occurredAt": {
          "type": "string",
          "format": "date-time"
        },
        "receivedAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "type": "string",
          "format": "date-time"
        },
        "freshUntil": {
          "type": "string",
          "format": "date-time"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time"
        },
        "freshness": {
          "enum": [
            "fresh",
            "stale",
            "expired"
          ]
        },
        "basis": {
          "enum": [
            "observed",
            "derived",
            "synthetic"
          ]
        },
        "qualification": {
          "$ref": "#/$defs/qualification"
        }
      }
    },
    "ingress": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "conditionKey",
        "eventRef",
        "sourceRevision",
        "transition",
        "eventClass",
        "severity",
        "summary",
        "occurredAt",
        "freshUntil",
        "expiresAt",
        "qualification"
      ],
      "properties": {
        "conditionKey": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        },
        "eventRef": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        },
        "sourceRevision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "transition": {
          "enum": [
            "open",
            "update",
            "resolve"
          ]
        },
        "eventClass": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        },
        "severity": {
          "enum": [
            "info",
            "warning",
            "critical"
          ]
        },
        "summary": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1024
        },
        "occurredAt": {
          "type": "string",
          "format": "date-time"
        },
        "freshUntil": {
          "type": "string",
          "format": "date-time"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time"
        },
        "qualification": {
          "$ref": "#/$defs/qualification"
        }
      }
    },
    "request": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "operation",
        "authorityContextRef",
        "worldRef",
        "executionEnvironmentRef",
        "siteRef",
        "assistantRef",
        "endpointRef",
        "participantRefs",
        "audienceRef",
        "deadline"
      ],
      "properties": {
        "operation": {
          "enum": [
            "snapshot",
            "changes",
            "acknowledge"
          ]
        },
        "authorityContextRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "worldRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "executionEnvironmentRef": {
          "const": "normal"
        },
        "siteRef": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        },
        "assistantRef": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            {
              "type": "null"
            }
          ]
        },
        "endpointRef": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            {
              "type": "null"
            }
          ]
        },
        "participantRefs": {
          "type": "array",
          "maxItems": 32,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          }
        },
        "audienceRef": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            {
              "type": "null"
            }
          ]
        },
        "deadline": {
          "type": "string",
          "format": "date-time"
        },
        "sourceRef": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        },
        "zoneRef": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
        },
        "afterCursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        "conditionRef": {
          "type": "string",
          "pattern": "^pwce:condition:[a-f0-9]{64}$"
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "operation": {
                "const": "changes"
              }
            },
            "required": [
              "operation"
            ]
          },
          "then": {
            "required": [
              "afterCursor"
            ],
            "properties": {
              "afterCursor": {}
            }
          },
          "else": {
            "not": {
              "anyOf": [
                {
                  "required": [
                    "afterCursor"
                  ],
                  "properties": {
                    "afterCursor": {}
                  }
                },
                {
                  "required": [
                    "limit"
                  ],
                  "properties": {
                    "limit": {}
                  }
                }
              ]
            }
          }
        },
        {
          "if": {
            "properties": {
              "operation": {
                "const": "acknowledge"
              }
            },
            "required": [
              "operation"
            ]
          },
          "then": {
            "required": [
              "conditionRef",
              "revision"
            ],
            "properties": {
              "conditionRef": {},
              "revision": {}
            }
          },
          "else": {
            "not": {
              "anyOf": [
                {
                  "required": [
                    "conditionRef"
                  ],
                  "properties": {
                    "conditionRef": {}
                  }
                },
                {
                  "required": [
                    "revision"
                  ],
                  "properties": {
                    "revision": {}
                  }
                }
              ]
            }
          }
        }
      ]
    },
    "acknowledgment": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "conditionRef",
        "revision",
        "acknowledgedAt"
      ],
      "properties": {
        "conditionRef": {
          "type": "string",
          "pattern": "^pwce:condition:[a-f0-9]{64}$"
        },
        "revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "acknowledgedAt": {
          "type": "string",
          "format": "date-time"
        }
      }
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "profileId",
        "profileVersion",
        "operation",
        "status",
        "evaluatedAt",
        "conditions",
        "nextCursor",
        "hasMore",
        "resyncReason",
        "acknowledgment"
      ],
      "properties": {
        "profileId": {
          "const": "pwce-urgent-conditions.v1"
        },
        "profileVersion": {
          "const": "1.0.0"
        },
        "operation": {
          "enum": [
            "snapshot",
            "changes",
            "acknowledge"
          ]
        },
        "status": {
          "enum": [
            "ok",
            "resyncRequired"
          ]
        },
        "evaluatedAt": {
          "type": "string",
          "format": "date-time"
        },
        "conditions": {
          "type": "array",
          "maxItems": 100,
          "items": {
            "$ref": "#/$defs/condition"
          }
        },
        "nextCursor": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "hasMore": {
          "type": "boolean"
        },
        "resyncReason": {
          "enum": [
            null,
            "cursorExpired",
            "cursorAhead"
          ]
        },
        "acknowledgment": {
          "anyOf": [
            {
              "$ref": "#/$defs/acknowledgment"
            },
            {
              "type": "null"
            }
          ]
        }
      }
    }
  }
});
export const PWCE_CONDITION_REQUEST_SCHEMA=freeze({...PWCE_CONDITION_SCHEMA,$ref:"#/$defs/request"});
export const PWCE_CONDITION_RESPONSE_SCHEMA=freeze({...PWCE_CONDITION_SCHEMA,$ref:"#/$defs/response"});
export const PWCE_CONDITION_RECORD_SCHEMA=freeze({...PWCE_CONDITION_SCHEMA,$ref:"#/$defs/condition"});

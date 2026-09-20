// Generated exclusively from digest-verified PWCE public incident contracts.
const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;};
export const EXPECTED_PWCE_INCIDENT_BUNDLE=freeze({
  "profileId": "pwce-incident-evidence.v1",
  "profileVersion": "1.0.0",
  "bundleId": "pwce-incident-evidence.bundle.v1",
  "bundleVersion": "1.0.0",
  "routes": {
    "bundle": "/gateway/v1/incidents/bundle",
    "query": "/gateway/v1/incidents",
    "media": "/gateway/v1/incidents/media"
  },
  "authentication": {
    "agentBearerRequired": true,
    "authorityContextRequired": true,
    "contractHeader": "X-PWCE-Incident-Contract",
    "scopedSiteRequired": true,
    "mediaRequiresConfiguredPrincipalPermission": true
  },
  "maximumRequestBytes": 8192,
  "maximumResponseBytes": 131072,
  "maximumMediaBytes": 67108864,
  "semantics": {
    "capture": "Read-only extension. It cannot activate a camera, enroll a zone, request arbitrary capture, select a recorder or change retention.",
    "custody": "PWCE retains bounded event evidence through an independently configured recorder. Summaries contain opaque evidence references, never raw media or provider file paths.",
    "review": "Media access is separately authorized on every read; pending, failed and expired evidence are explicit.",
    "defaults": "An explicitly enabled zone without an earlier approved policy uses 30 seconds pre-roll, 60 seconds after last trigger, at most 300 seconds per segment, 30 days retention and an explicit byte quota. Recorder coverage limitations remain visible.",
    "independence": "Recording and expiry have no dependency on LLM, avatar, endpoint or notification availability.",
    "scope": "Each request matches the current authority context Assistant, endpoint, participants, audience and site; World identity and a bounded deadline are rechecked. Normal-mode evidence review grants no replay or recording authority."
  },
  "digestAlgorithm": "sha256-ordered-path-bytes-v1",
  "bundleDigest": "04a53ca17bcfa9b37d6863c0612675cb590ea48e1c5b2228b498a716cb54cfc4",
  "artifacts": [
    {
      "path": "contracts/incident-evidence/profile.json",
      "sha256": "ef7650ce7756d020528367b713ad83e49a99052a958cf0509a8dc98b99058987"
    },
    {
      "path": "contracts/incident-evidence/request.schema.json",
      "sha256": "c5e94dd380b11c8f4ad9b18e4c47dc385732bbc7a2134ce691e59b62417aff81"
    },
    {
      "path": "contracts/incident-evidence/response.schema.json",
      "sha256": "8d438136f170c86e07099eecf4bc1bc1c366c4252e6259de1822155a6ff70aa6"
    }
  ]
});
export const PWCE_INCIDENT_REQUEST_SCHEMA=freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://pwce.local/contracts/incident-evidence-request-1.0.0.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "operation",
    "authorityContextRef",
    "siteRef",
    "worldRef",
    "executionEnvironmentRef",
    "deadline",
    "assistantRef",
    "endpointRef",
    "participantRefs",
    "audienceRef"
  ],
  "properties": {
    "operation": {
      "enum": [
        "list",
        "get",
        "media"
      ]
    },
    "authorityContextRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "siteRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "evidenceRef": {
      "type": "string",
      "pattern": "^pwce:incident:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50
    },
    "worldRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "executionEnvironmentRef": {
      "const": "normal"
    },
    "deadline": {
      "type": "string",
      "format": "date-time"
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
    }
  }
});
export const PWCE_INCIDENT_RESPONSE_SCHEMA=freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://pwce.local/contracts/incident-evidence-response-1.0.0.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "profileId",
    "profileVersion",
    "incidents"
  ],
  "properties": {
    "profileId": {
      "const": "pwce-incident-evidence.v1"
    },
    "profileVersion": {
      "const": "1.0.0"
    },
    "incidents": {
      "type": "array",
      "maxItems": 50,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "evidenceRef",
          "siteRef",
          "zoneRef",
          "eventClass",
          "state",
          "occurredAt",
          "lastTriggerAt",
          "windowStart",
          "windowEnd",
          "expiresAt",
          "summary",
          "media",
          "limitations"
        ],
        "properties": {
          "evidenceRef": {
            "type": "string",
            "pattern": "^pwce:incident:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"
          },
          "siteRef": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "zoneRef": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "eventClass": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "state": {
            "enum": [
              "pending",
              "ready",
              "failed",
              "expired"
            ]
          },
          "occurredAt": {
            "type": "string",
            "format": "date-time"
          },
          "lastTriggerAt": {
            "type": "string",
            "format": "date-time"
          },
          "windowStart": {
            "type": "string",
            "format": "date-time"
          },
          "windowEnd": {
            "type": "string",
            "format": "date-time"
          },
          "expiresAt": {
            "type": "string",
            "format": "date-time"
          },
          "summary": {
            "type": "string",
            "maxLength": 1024
          },
          "media": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "sha256",
                  "bytes",
                  "mime",
                  "actualStart",
                  "actualEnd"
                ],
                "properties": {
                  "sha256": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "bytes": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 67108864
                  },
                  "mime": {
                    "enum": [
                      "image/png",
                      "image/jpeg",
                      "video/mp4",
                      "video/webm"
                    ]
                  },
                  "actualStart": {
                    "type": "string",
                    "format": "date-time"
                  },
                  "actualEnd": {
                    "type": "string",
                    "format": "date-time"
                  }
                }
              }
            ]
          },
          "limitations": {
            "type": "array",
            "maxItems": 8,
            "items": {
              "type": "string",
              "maxLength": 256
            }
          }
        }
      }
    }
  }
});

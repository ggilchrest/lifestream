// Generated only from PWCE public admission-recovery contracts.
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const EXPECTED_PWCE_ADMISSION_RECOVERY_BUNDLE=freeze({
  "profileId": "pwce-admission-recovery.v1",
  "profileVersion": "1.0.0",
  "bundleId": "pwce-admission-recovery.bundle.v1",
  "bundleVersion": "1.0.0",
  "requiredGatewayBundle": {
    "bundleId": "pwce-agent-gateway.bundle.v1",
    "bundleVersion": "1.0.0",
    "bundleDigest": "32c555ba675b61b4c1ec82245e314a8f6ca537484defbeb48b9fe1b6bdf4e2e2"
  },
  "requiredAdmissionBundle": {
    "bundleId": "pwce-action-admission.bundle.v1",
    "bundleVersion": "1.0.0",
    "bundleDigest": "0379a7615ee3df928024d8f0290bbcf62b5ccb67e016ef3c3373d37a87294f8f"
  },
  "requestSchemaRef": "https://pwce.local/contracts/pwce-admission-recovery-request-1.0.0.schema.json",
  "responseSchemaRef": "https://pwce.local/contracts/pwce-admission-recovery-response-1.0.0.schema.json",
  "routes": {
    "bundle": {
      "method": "GET",
      "path": "/gateway/v1/admission-recovery/bundle"
    },
    "query": {
      "method": "POST",
      "path": "/gateway/v1/admission-recovery"
    }
  },
  "authentication": {
    "agentBearerRequired": true,
    "dispatcherSecretRequired": false,
    "contractHeader": "X-PWCE-Admission-Recovery-Contract"
  },
  "maximumRequestBytes": 65536,
  "maximumResponseBytes": 131072,
  "semantics": {
    "lookup": "Read the original globally unique producer idempotency key. The caller supplies its exact original canonical requestFingerprint text, snapshot and approval terms. A changed or absent tuple returns unknown without an action identifier. The original producer deadline comes only from retained admission evidence; it is not replaced by the query deadline.",
    "scope": "Current Agent authentication and the original authority context must match principal, sites, World, environment, Assistant, endpoint, ordered participants and audience. Expired or revoked current authority withholds evidence. Context rotation and restoration are not supplied by this profile.",
    "immutability": "The returned admissionEvidence is the existing public admission proof projected from original durable custody. Its original action ID, admittedAt, deadlineAt, snapshot, precondition and approval terms are not renewed. Current invocation status and effect confirmation require a separate status read.",
    "readOnly": "Never call authorization, dispatch, target preconditions, target invocation or target reconciliation. Gateway request audit may be appended; no action, approval or snapshot is created or changed.",
    "uncertainty": "Unknown never proves that no admission occurred and never authorizes resubmission. Legacy records lacking qualified original evidence remain unavailable. Corrupt qualified evidence fails closed.",
    "deadline": "The query has a new current deadline at most 30000 ms away, independent of the original admission deadline. Original expiry does not hide historical evidence or create fresh dispatch authority."
  },
  "digestAlgorithm": "sha256-ordered-path-bytes-v1",
  "bundleDigest": "43d1d8e574bf09a92bf1cd24ac69ffbb6a2e6a56c7628ae8dfe35d18854a5ab3",
  "artifacts": [
    {
      "path": "contracts/admission-recovery/profile.json",
      "sha256": "d0efa349ec7cc2c876cdee67fcad837811a2d3e95132676a3724290ad663f9c6"
    },
    {
      "path": "contracts/admission-recovery/request.schema.json",
      "sha256": "9cd50d512bb461f6238d5790c716c2ed5c10aeb3e6ca40798bf4d26b659678b2"
    },
    {
      "path": "contracts/admission-recovery/response.schema.json",
      "sha256": "fb513d5fc385652427f8477cb312c0cb354ddb240b05fafd0d5efdc69f8e0c26"
    }
  ],
  "schemaArtifacts": [
    {
      "reference": "https://pwce.local/contracts/pwce-admission-recovery-request-1.0.0.schema.json",
      "sha256": "9cd50d512bb461f6238d5790c716c2ed5c10aeb3e6ca40798bf4d26b659678b2",
      "byteLength": 3035,
      "mediaType": "application/schema+json",
      "schemaRef": "https://json-schema.org/draft/2020-12/schema"
    },
    {
      "reference": "https://pwce.local/contracts/pwce-admission-recovery-response-1.0.0.schema.json",
      "sha256": "fb513d5fc385652427f8477cb312c0cb354ddb240b05fafd0d5efdc69f8e0c26",
      "byteLength": 19307,
      "mediaType": "application/schema+json",
      "schemaRef": "https://json-schema.org/draft/2020-12/schema"
    }
  ]
} as const);
export const PWCE_ADMISSION_RECOVERY_REQUEST_SCHEMA=freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://pwce.local/contracts/pwce-admission-recovery-request-1.0.0.schema.json",
  "title": "Read original admission under current original scope; never dispatch",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "profileId",
    "profileVersion",
    "requestId",
    "correlationId",
    "worldRef",
    "executionEnvironmentRef",
    "authorityContextRef",
    "assistantRef",
    "endpointRef",
    "participantRefs",
    "audienceRef",
    "deadline",
    "idempotencyKey",
    "approvalRequired",
    "approvalRef",
    "recoveryProfileId",
    "recoveryProfileVersion",
    "operation",
    "requestFingerprint",
    "originalSnapshotRef"
  ],
  "properties": {
    "profileId": {
      "const": "pwce-agent-gateway.v1"
    },
    "profileVersion": {
      "const": "1.0.0"
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "correlationId": {
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
      "enum": [
        "normal",
        "live",
        "test",
        "replay",
        "simulation",
        "dry-run"
      ]
    },
    "authorityContextRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "assistantRef": {
      "type": [
        "string",
        "null"
      ],
      "minLength": 1,
      "maxLength": 128
    },
    "endpointRef": {
      "type": [
        "string",
        "null"
      ],
      "minLength": 1,
      "maxLength": 128
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
      "type": [
        "string",
        "null"
      ],
      "minLength": 1,
      "maxLength": 128
    },
    "deadline": {
      "type": "string",
      "format": "date-time",
      "maxLength": 40,
      "pattern": "^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$"
    },
    "idempotencyKey": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "approvalRequired": {
      "type": "boolean"
    },
    "approvalRef": {
      "type": [
        "string",
        "null"
      ],
      "minLength": 1,
      "maxLength": 128
    },
    "recoveryProfileId": {
      "const": "pwce-admission-recovery.v1"
    },
    "recoveryProfileVersion": {
      "const": "1.0.0"
    },
    "operation": {
      "const": "authority.recoverAdmission"
    },
    "requestFingerprint": {
      "type": "string",
      "minLength": 1,
      "maxLength": 32768
    },
    "originalSnapshotRef": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  }
} as const);
export const PWCE_ADMISSION_RECOVERY_RESPONSE_SCHEMA=freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://pwce.local/contracts/pwce-admission-recovery-response-1.0.0.schema.json",
  "title": "Original producer admission proof or explicit unknown; no new permission",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "recoveryProfileId",
    "recoveryProfileVersion",
    "profileId",
    "profileVersion",
    "requestId",
    "correlationId",
    "worldRef",
    "executionEnvironmentRef",
    "status",
    "actionRef",
    "admissionEvidence",
    "reason"
  ],
  "properties": {
    "recoveryProfileId": {
      "const": "pwce-admission-recovery.v1"
    },
    "recoveryProfileVersion": {
      "const": "1.0.0"
    },
    "profileId": {
      "const": "pwce-agent-gateway.v1"
    },
    "profileVersion": {
      "const": "1.0.0"
    },
    "requestId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "correlationId": {
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
      "enum": [
        "normal",
        "live",
        "test",
        "replay",
        "simulation",
        "dry-run"
      ]
    },
    "status": {
      "enum": [
        "known",
        "unknown"
      ]
    },
    "actionRef": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "admissionEvidence": {
      "anyOf": [
        {
          "$ref": "#/$defs/OriginalAdmission"
        },
        {
          "type": "null"
        }
      ]
    },
    "reason": {
      "enum": [
        null,
        "admission_not_found",
        "original_evidence_unavailable"
      ]
    }
  },
  "$defs": {
    "OriginalAdmission": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "https://pwce.local/contracts/action-admission-evidence-1.0.0.schema.json",
      "title": "Immutable producer action admission evidence; not dispatch or effect confirmation",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "schemaVersion",
        "kind",
        "actionRef",
        "idempotencyKey",
        "requestFingerprint",
        "principalRef",
        "capabilityRef",
        "capabilityVersion",
        "operation",
        "siteRef",
        "targetEntityId",
        "parameters",
        "executionEnvironmentRef",
        "gatewayScope",
        "grantRevision",
        "targetIdentity",
        "deadlineAt",
        "approvalRequired",
        "approvalRef",
        "capabilitySnapshot",
        "precondition",
        "admittedAt",
        "decision"
      ],
      "properties": {
        "schemaVersion": {
          "const": "1.0.0"
        },
        "kind": {
          "const": "pwce.action.admission"
        },
        "actionRef": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "idempotencyKey": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "requestFingerprint": {
          "type": "string",
          "minLength": 1,
          "maxLength": 8192
        },
        "principalRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "capabilityRef": {
          "const": "home.light.set_level"
        },
        "capabilityVersion": {
          "const": "1.0.0"
        },
        "operation": {
          "const": "light.set_level"
        },
        "siteRef": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9._-]{0,63}$"
        },
        "targetEntityId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "parameters": {
          "$ref": "#/$defs/Parameters"
        },
        "executionEnvironmentRef": {
          "enum": [
            "normal",
            "live",
            "test",
            "replay",
            "simulation",
            "dry-run"
          ]
        },
        "gatewayScope": {
          "$ref": "#/$defs/GatewayScope"
        },
        "grantRevision": {
          "type": "integer",
          "minimum": 1
        },
        "targetIdentity": {
          "type": "string",
          "minLength": 1,
          "maxLength": 500
        },
        "deadlineAt": {
          "type": "string",
          "format": "date-time"
        },
        "approvalRequired": {
          "type": "boolean"
        },
        "approvalRef": {
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
        "capabilitySnapshot": {
          "$ref": "#/$defs/SnapshotCustody"
        },
        "precondition": {
          "anyOf": [
            {
              "$ref": "#/$defs/PreconditionCustody"
            },
            {
              "type": "null"
            }
          ]
        },
        "admittedAt": {
          "type": "string",
          "format": "date-time"
        },
        "decision": {
          "$ref": "#/$defs/Decision"
        }
      },
      "$defs": {
        "Parameters": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "level"
          ],
          "properties": {
            "level": {
              "type": "number",
              "minimum": 0,
              "maximum": 1
            }
          }
        },
        "GatewayScope": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "worldRef",
            "assistantRef",
            "endpointRef",
            "participantRefs",
            "audienceRef"
          ],
          "properties": {
            "worldRef": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
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
        },
        "FingerprintInput": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "principalRef",
            "capabilityRef",
            "capabilityVersion",
            "operation",
            "siteRef",
            "targetEntityId",
            "parameters",
            "executionEnvironmentRef",
            "gatewayScope"
          ],
          "properties": {
            "principalRef": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "capabilityRef": {
              "const": "home.light.set_level"
            },
            "capabilityVersion": {
              "const": "1.0.0"
            },
            "operation": {
              "const": "light.set_level"
            },
            "siteRef": {
              "type": "string",
              "pattern": "^[a-z0-9][a-z0-9._-]{0,63}$"
            },
            "targetEntityId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "parameters": {
              "$ref": "#/$defs/Parameters"
            },
            "executionEnvironmentRef": {
              "enum": [
                "normal",
                "live",
                "test",
                "replay",
                "simulation",
                "dry-run"
              ]
            },
            "gatewayScope": {
              "$ref": "#/$defs/GatewayScope"
            }
          }
        },
        "AdmissionPrecondition": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "schemaVersion",
            "phase",
            "targetIdentity",
            "requestFingerprint",
            "checkedAt",
            "result"
          ],
          "properties": {
            "schemaVersion": {
              "const": "1.0.0"
            },
            "phase": {
              "const": "admission"
            },
            "targetIdentity": {
              "type": "string",
              "minLength": 1,
              "maxLength": 500
            },
            "requestFingerprint": {
              "type": "string",
              "minLength": 1,
              "maxLength": 8192
            },
            "checkedAt": {
              "type": "string",
              "format": "date-time"
            },
            "result": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "allowed",
                "reasonCode",
                "observed"
              ],
              "properties": {
                "allowed": {
                  "const": true
                },
                "reasonCode": {
                  "type": "string",
                  "pattern": "^[a-zA-Z0-9_.-]{1,128}$"
                },
                "observed": {}
              }
            }
          }
        },
        "SnapshotCustody": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "snapshotRef",
            "sha256",
            "expiresAt",
            "snapshotJson"
          ],
          "properties": {
            "snapshotRef": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "sha256": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "expiresAt": {
              "type": "string",
              "format": "date-time"
            },
            "snapshotJson": {
              "type": "string",
              "minLength": 1,
              "maxLength": 32768
            }
          }
        },
        "RetainedSnapshotDocument": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "scope",
            "sourceDigest",
            "snapshot"
          ],
          "properties": {
            "scope": {
              "$ref": "#/$defs/SnapshotScope"
            },
            "sourceDigest": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "snapshot": {
              "$ref": "#/$defs/SnapshotValue"
            }
          }
        },
        "SnapshotScope": {
          "type": "array",
          "minItems": 11,
          "maxItems": 11,
          "prefixItems": [
            {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
              "title": "Authority context reference"
            },
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 128,
              "title": "Principal reference"
            },
            {
              "type": "integer",
              "minimum": 1,
              "title": "Principal revision"
            },
            {
              "type": "integer",
              "minimum": 0,
              "title": "Grant revision"
            },
            {
              "type": "array",
              "minItems": 1,
              "maxItems": 128,
              "uniqueItems": true,
              "items": {
                "type": "string",
                "pattern": "^[a-z0-9][a-z0-9._-]{0,63}$"
              },
              "title": "Authorized sites"
            },
            {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                {
                  "type": "null"
                }
              ],
              "title": "Assistant reference"
            },
            {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                {
                  "type": "null"
                }
              ],
              "title": "Endpoint reference"
            },
            {
              "type": "array",
              "maxItems": 32,
              "uniqueItems": true,
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "title": "Participants"
            },
            {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                {
                  "type": "null"
                }
              ],
              "title": "Audience reference"
            },
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 128,
              "title": "World reference"
            },
            {
              "enum": [
                "normal",
                "live",
                "test",
                "replay",
                "simulation",
                "dry-run"
              ],
              "title": "Execution environment"
            }
          ],
          "items": false
        },
        "SnapshotValue": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "snapshotRef",
            "profileId",
            "profileVersion",
            "principalRef",
            "siteRefs",
            "sourceRevision",
            "issuedAt",
            "expiresAt",
            "invalidationSequence",
            "capabilities",
            "availability",
            "limitations"
          ],
          "properties": {
            "snapshotRef": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "profileId": {
              "const": "pwce-agent-gateway.v1"
            },
            "profileVersion": {
              "const": "1.0.0"
            },
            "principalRef": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "siteRefs": {
              "type": "array",
              "minItems": 1,
              "maxItems": 128,
              "uniqueItems": true,
              "items": {
                "type": "string",
                "pattern": "^[a-z0-9][a-z0-9._-]{0,63}$"
              }
            },
            "sourceRevision": {
              "type": "integer",
              "minimum": 0
            },
            "issuedAt": {
              "type": "string",
              "format": "date-time"
            },
            "expiresAt": {
              "type": "string",
              "format": "date-time"
            },
            "invalidationSequence": {
              "type": "integer",
              "minimum": 0
            },
            "capabilities": {
              "type": "array",
              "minItems": 1,
              "maxItems": 1,
              "items": {
                "type": "object"
              }
            },
            "availability": {
              "const": "configured"
            },
            "limitations": {
              "type": "array",
              "maxItems": 8,
              "items": {
                "type": "string",
                "maxLength": 500
              }
            }
          }
        },
        "Decision": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "outcome",
            "rationaleCodes"
          ],
          "properties": {
            "outcome": {
              "const": "allowed"
            },
            "rationaleCodes": {
              "type": "array",
              "minItems": 1,
              "maxItems": 16,
              "items": {
                "type": "string",
                "pattern": "^[a-zA-Z0-9_.-]{1,128}$"
              }
            }
          }
        },
        "PreconditionCustody": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "sha256",
            "checkJson"
          ],
          "properties": {
            "sha256": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "checkJson": {
              "type": "string",
              "minLength": 1,
              "maxLength": 16384
            }
          }
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "approvalRequired": {
                "const": true
              }
            },
            "required": [
              "approvalRequired"
            ]
          },
          "then": {
            "properties": {
              "approvalRef": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            }
          }
        }
      ]
    }
  },
  "allOf": [
    {
      "if": {
        "properties": {
          "status": {
            "const": "known"
          }
        }
      },
      "then": {
        "properties": {
          "actionRef": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "admissionEvidence": {
            "$ref": "#/$defs/OriginalAdmission"
          },
          "reason": {
            "type": "null"
          }
        }
      },
      "else": {
        "properties": {
          "actionRef": {
            "type": "null"
          },
          "admissionEvidence": {
            "type": "null"
          },
          "reason": {
            "enum": [
              "admission_not_found",
              "original_evidence_unavailable"
            ]
          }
        }
      }
    }
  ]
} as const);

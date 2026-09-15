// Generated only from PWCE public admission contracts.
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const EXPECTED_PWCE_ADMISSION_BUNDLE=freeze({
  "profileId": "pwce-action-admission.v1",
  "profileVersion": "1.0.0",
  "bundleId": "pwce-action-admission.bundle.v1",
  "bundleVersion": "1.0.0",
  "requiredDispatchBundle": {
    "bundleId": "pwce-trusted-dispatch.bundle.v1",
    "bundleVersion": "1.0.0",
    "bundleDigest": "c61b022af86244d9da5f6b1e2222b44df22487289c0a963816f5242e0958e7be"
  },
  "responseField": "admissionEvidence",
  "schemaRef": "https://pwce.local/contracts/action-admission-evidence-1.0.0.schema.json",
  "semantics": {
    "identity": "Derived only from the existing durable action record. All fields are original admission fields and remain byte-identical as action status and results change.",
    "requestFingerprint": "Canonical JSON string of FingerprintInput, not a digest. Recursively sort object keys by JavaScript UTF-16 lexical order; preserve array order; serialize primitives with JSON.stringify; no whitespace.",
    "snapshotJson": "Original UTF-8 JSON string matching RetainedSnapshotDocument. Verify byte length <=32768 and SHA-256 before parsing; preserve its original byte representation.",
    "snapshotBinding": "Snapshot scope and value must match principal, grant revision, World, execution environment, Assistant, endpoint, participant order, audience, site and original snapshot reference/expiry. Capability definitions match the separately published exact capability bundle.",
    "precondition": "Only the original admission-phase precondition. checkJson is its exact JSON.stringify entry string in field order schemaVersion, phase, targetIdentity, requestFingerprint, checkedAt, result. sha256 hashes its UTF-8 bytes. Verify byte length <=16384 and hash before parsing against AdmissionPrecondition. Preserve checkJson byte representation, including the original result object key order. The result must permit admission. A dispatch-phase check cannot replace it.",
    "timestamps": "admittedAt is the original action createdAt. deadlineAt is later than admittedAt and at most 30000 ms later; it is not later than snapshot expiry. Snapshot issuedAt and the admission precondition checkedAt are no later than admittedAt. These are original producer times and are never refreshed on duplicate. An expired proof cannot restore dispatch authority.",
    "approval": "approvalRequired and approvalRef preserve original terms; a reference alone is not approval. The producer rechecks approval at final dispatch.",
    "custody": "This proof is a projection of producer custody, not a signature, a bearer credential, a target-call claim or permission to replay an effect. Current authority and original snapshot custody remain required for invocation.",
    "currentState": "Current action status/result remain separate response fields; they do not alter original admission evidence. Transport or proof success does not establish effect success."
  },
  "requiredCapabilityBundle": {
    "bundleId": "pwce-capability-contracts.bundle.v1",
    "bundleVersion": "1.0.0",
    "bundleDigest": "6df58c602d8a43fdababd388c588aef631662e5904139837baa36db9c6730a0c"
  },
  "maximumEvidenceBytes": 65536,
  "digestAlgorithm": "sha256-ordered-path-bytes-v1",
  "bundleDigest": "0379a7615ee3df928024d8f0290bbcf62b5ccb67e016ef3c3373d37a87294f8f",
  "artifacts": [
    {
      "path": "contracts/action-admission/profile.json",
      "sha256": "74723fa2cd5bce332f513c22c9770b3f678ecfea7f7bea54f0663fac6dc2f7ad"
    },
    {
      "path": "contracts/action-admission/evidence.schema.json",
      "sha256": "a5b944ec79f545c0a6182087b64b33247cd6f3df7abab247a62e345b48116d69"
    }
  ],
  "schemaArtifact": {
    "reference": "https://pwce.local/contracts/action-admission-evidence-1.0.0.schema.json",
    "sha256": "a5b944ec79f545c0a6182087b64b33247cd6f3df7abab247a62e345b48116d69",
    "byteLength": 13939,
    "mediaType": "application/schema+json",
    "schemaRef": "https://json-schema.org/draft/2020-12/schema"
  }
} as const);
export const PWCE_ADMISSION_SCHEMA=freeze({
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
} as const);

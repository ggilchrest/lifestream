// Generated only from PWCE public invocation contracts.
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const EXPECTED_PWCE_INVOCATION_BUNDLE=freeze({
  "profileId": "pwce-action-invocation.v1",
  "profileVersion": "1.0.1",
  "bundleId": "pwce-action-invocation.bundle.v1",
  "bundleVersion": "1.0.1",
  "requiredAdmissionBundle": {
    "bundleId": "pwce-action-admission.bundle.v1",
    "bundleVersion": "1.0.0",
    "bundleDigest": "0379a7615ee3df928024d8f0290bbcf62b5ccb67e016ef3c3373d37a87294f8f"
  },
  "requiredCapabilityBundle": {
    "bundleId": "pwce-capability-contracts.bundle.v1",
    "bundleVersion": "1.0.0",
    "bundleDigest": "6df58c602d8a43fdababd388c588aef631662e5904139837baa36db9c6730a0c"
  },
  "requiredDispatchBundle": {
    "bundleId": "pwce-trusted-dispatch.bundle.v1",
    "bundleVersion": "1.0.0",
    "bundleDigest": "c61b022af86244d9da5f6b1e2222b44df22487289c0a963816f5242e0958e7be"
  },
  "responseField": "invocationEvidence",
  "schemaRef": "https://pwce.local/contracts/action-invocation-evidence-1.0.1.schema.json",
  "maximumEvidenceBytes": 131072,
  "semantics": {
    "source": "A bounded projection of the current durable producer action after dispatch or read-only status reconciliation. It is not a signature or permission to send an action.",
    "identity": "actionRef and admissionEvidence.actionRef agree. Original admission evidence is unchanged across all observations. attemptRef and startedAt identify the sole durable dispatch claim; both are null before a claim. A claim can precede a target call that is subsequently refused.",
    "status": "Preserve admitted, started and all published producer result statuses distinctly. Only succeeded with externalEffectOccurred=true confirms full requested success. Partially succeeded is not full success. Transport completion is never effect confirmation.",
    "results": "result is the current producer result and has the same status as the action, with original producer completedAt. dispatchResult preserves the first stored dispatch reply when available. Values validate against the separately published result schema. Neither target-supplied completion times nor refreshed observation times are introduced.",
    "reconciliation": "reconciliationRef is the last durable reconciliation entry reference or null. A reconciled current result retains the producer reconciledAt/completedAt; original dispatchResult remains unchanged. Prior observation artifacts must remain history, not be overwritten with later success. A failed reply with externalEffectOccurred=unknown is still uncertain and remains eligible for a read-only target status check.",
    "readOnly": "capabilities.getInvocation preserves current identity and site access. It may query target status but never admits, invokes, renews the original action deadline or reconstructs an attempt. Missing and foreign actions return no proof.",
    "bounds": "The complete JSON evidence is at most 131072 UTF-8 bytes; each producer result including host timestamps is at most 17000 bytes. Malformed custody cannot become a valid observation.",
    "legacy": "Status reads for original targets without a declared stable targetIdentity retain their existing action view, omit invocationEvidence and return invocationEvidenceUnavailable=original_target_identity_missing. This is not qualified proof. Other malformed custody fails explicitly; the producer never fills in historical target identity."
  },
  "unavailableField": "invocationEvidenceUnavailable",
  "unavailableReasons": [
    "original_target_identity_missing"
  ],
  "digestAlgorithm": "sha256-ordered-path-bytes-v1",
  "bundleDigest": "dafcdadf33216ae5c27429a7687f46b4bad442eac0baf2eded683cc2e122ecc6",
  "artifacts": [
    {
      "path": "contracts/action-invocation/profile.json",
      "sha256": "c295a7e503237ec9da89e0da8265658e4b11c4621c7440b00f7d5976ac2e6856"
    },
    {
      "path": "contracts/action-invocation/evidence.schema.json",
      "sha256": "5f1b0e0a05a197f6216483a9192044e096d29ce811bb541ccfa6ddfd1d75be4c"
    }
  ],
  "schemaArtifact": {
    "reference": "https://pwce.local/contracts/action-invocation-evidence-1.0.1.schema.json",
    "sha256": "5f1b0e0a05a197f6216483a9192044e096d29ce811bb541ccfa6ddfd1d75be4c",
    "byteLength": 28280,
    "mediaType": "application/schema+json",
    "schemaRef": "https://json-schema.org/draft/2020-12/schema"
  }
} as const);
export const PWCE_INVOCATION_SCHEMA=freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://pwce.local/contracts/action-invocation-evidence-1.0.1.schema.json",
  "title": "Producer invocation state bound to original admission and attempt",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "kind",
    "actionRef",
    "admissionEvidence",
    "status",
    "attemptRef",
    "startedAt",
    "dispatchResult",
    "result",
    "reconciliationRef"
  ],
  "properties": {
    "schemaVersion": {
      "const": "1.0.0"
    },
    "kind": {
      "const": "pwce.action.invocation"
    },
    "actionRef": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "admissionEvidence": {
      "$ref": "https://pwce.local/contracts/action-admission-evidence-1.0.0.schema.json"
    },
    "status": {
      "enum": [
        "admitted",
        "started",
        "succeeded",
        "partially_succeeded",
        "failed",
        "rejected",
        "denied",
        "timed_out",
        "cancelled",
        "outcome_unknown"
      ]
    },
    "attemptRef": {
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
    "startedAt": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time"
        },
        {
          "type": "null"
        }
      ]
    },
    "dispatchResult": {
      "anyOf": [
        {
          "allOf": [
            {
              "$ref": "https://pwce.local/contracts/home-light-set-level-result-1.0.0.schema.json"
            },
            {
              "required": [
                "completedAt"
              ],
              "not": {
                "required": [
                  "reconciledAt"
                ],
                "type": "object"
              },
              "type": "object"
            }
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "result": {
      "anyOf": [
        {
          "$ref": "https://pwce.local/contracts/home-light-set-level-result-1.0.0.schema.json"
        },
        {
          "type": "null"
        }
      ]
    },
    "reconciliationRef": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        {
          "type": "null"
        }
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
    },
    "ProducerResult": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "https://pwce.local/contracts/home-light-set-level-result-1.0.0.schema.json",
      "title": "Original producer light-action result; only succeeded confirms an effect",
      "type": "object",
      "required": [
        "status",
        "externalEffectOccurred"
      ],
      "additionalProperties": false,
      "properties": {
        "status": {
          "enum": [
            "succeeded",
            "partially_succeeded",
            "failed",
            "rejected",
            "denied",
            "timed_out",
            "cancelled",
            "outcome_unknown"
          ]
        },
        "externalEffectOccurred": {
          "enum": [
            true,
            false,
            "unknown"
          ]
        },
        "reasonCode": {
          "type": "string",
          "pattern": "^[a-zA-Z0-9_.-]{1,128}$"
        },
        "observed": {},
        "dispatchAcknowledged": {
          "type": "boolean"
        },
        "completedAt": {
          "type": "string",
          "format": "date-time"
        },
        "reconciledAt": {
          "type": "string",
          "format": "date-time"
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "status": {
                "enum": [
                  "succeeded",
                  "partially_succeeded"
                ]
              }
            }
          },
          "then": {
            "properties": {
              "externalEffectOccurred": {
                "const": true
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "status": {
                "const": "outcome_unknown"
              }
            }
          },
          "then": {
            "properties": {
              "externalEffectOccurred": {
                "const": "unknown"
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "status": {
                "enum": [
                  "denied",
                  "rejected"
                ]
              }
            }
          },
          "then": {
            "properties": {
              "externalEffectOccurred": {
                "const": false
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
            "const": "admitted"
          }
        },
        "required": [
          "status"
        ]
      },
      "then": {
        "properties": {
          "result": {
            "const": null
          },
          "dispatchResult": {
            "const": null
          },
          "reconciliationRef": {
            "const": null
          },
          "attemptRef": {
            "const": null
          },
          "startedAt": {
            "const": null
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "status": {
            "const": "started"
          }
        },
        "required": [
          "status"
        ]
      },
      "then": {
        "properties": {
          "result": {
            "const": null
          },
          "dispatchResult": {
            "const": null
          },
          "reconciliationRef": {
            "const": null
          },
          "attemptRef": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          },
          "startedAt": {
            "type": "string",
            "format": "date-time"
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "status": {
            "const": "succeeded"
          }
        },
        "required": [
          "status"
        ]
      },
      "then": {
        "properties": {
          "result": {
            "type": "object",
            "required": [
              "completedAt"
            ],
            "properties": {
              "status": {
                "const": "succeeded"
              }
            }
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "status": {
            "const": "partially_succeeded"
          }
        },
        "required": [
          "status"
        ]
      },
      "then": {
        "properties": {
          "result": {
            "type": "object",
            "required": [
              "completedAt"
            ],
            "properties": {
              "status": {
                "const": "partially_succeeded"
              }
            }
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "status": {
            "const": "failed"
          }
        },
        "required": [
          "status"
        ]
      },
      "then": {
        "properties": {
          "result": {
            "type": "object",
            "required": [
              "completedAt"
            ],
            "properties": {
              "status": {
                "const": "failed"
              }
            }
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "status": {
            "const": "rejected"
          }
        },
        "required": [
          "status"
        ]
      },
      "then": {
        "properties": {
          "result": {
            "type": "object",
            "required": [
              "completedAt"
            ],
            "properties": {
              "status": {
                "const": "rejected"
              }
            }
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "status": {
            "const": "denied"
          }
        },
        "required": [
          "status"
        ]
      },
      "then": {
        "properties": {
          "result": {
            "type": "object",
            "required": [
              "completedAt"
            ],
            "properties": {
              "status": {
                "const": "denied"
              }
            }
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "status": {
            "const": "timed_out"
          }
        },
        "required": [
          "status"
        ]
      },
      "then": {
        "properties": {
          "result": {
            "type": "object",
            "required": [
              "completedAt"
            ],
            "properties": {
              "status": {
                "const": "timed_out"
              }
            }
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "status": {
            "const": "cancelled"
          }
        },
        "required": [
          "status"
        ]
      },
      "then": {
        "properties": {
          "result": {
            "type": "object",
            "required": [
              "completedAt"
            ],
            "properties": {
              "status": {
                "const": "cancelled"
              }
            }
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "status": {
            "const": "outcome_unknown"
          }
        },
        "required": [
          "status"
        ]
      },
      "then": {
        "properties": {
          "result": {
            "type": "object",
            "required": [
              "completedAt"
            ],
            "properties": {
              "status": {
                "const": "outcome_unknown"
              }
            }
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "attemptRef": {
            "type": "null"
          }
        },
        "required": [
          "attemptRef"
        ]
      },
      "then": {
        "properties": {
          "startedAt": {
            "const": null
          },
          "status": {
            "enum": [
              "admitted",
              "denied",
              "rejected"
            ]
          }
        }
      },
      "else": {
        "properties": {
          "startedAt": {
            "type": "string",
            "format": "date-time"
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "reconciliationRef": {
            "type": "string"
          }
        },
        "required": [
          "reconciliationRef"
        ]
      },
      "then": {
        "properties": {
          "result": {
            "type": "object",
            "required": [
              "reconciledAt"
            ]
          },
          "attemptRef": {
            "type": "string",
            "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
          }
        }
      },
      "else": {
        "properties": {
          "result": {
            "not": {
              "type": "object",
              "required": [
                "reconciledAt"
              ]
            }
          }
        }
      }
    }
  ]
} as const);

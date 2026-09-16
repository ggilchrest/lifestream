// Generated only from PWCE public approval-recovery contracts.
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const EXPECTED_PWCE_APPROVAL_RECOVERY_BUNDLE=freeze({
  "profileId": "pwce-approval-recovery.v1",
  "profileVersion": "1.0.0",
  "bundleId": "pwce-approval-recovery.bundle.v1",
  "bundleVersion": "1.0.0",
  "requiredGatewayBundle": {
    "bundleId": "pwce-agent-gateway.bundle.v1",
    "bundleVersion": "1.0.0",
    "bundleDigest": "32c555ba675b61b4c1ec82245e314a8f6ca537484defbeb48b9fe1b6bdf4e2e2"
  },
  "requiredDispatchBundle": {
    "bundleId": "pwce-trusted-dispatch.bundle.v1",
    "bundleVersion": "1.0.0",
    "bundleDigest": "c61b022af86244d9da5f6b1e2222b44df22487289c0a963816f5242e0958e7be"
  },
  "requestSchemaRef": "https://pwce.local/contracts/pwce-approval-recovery-request-1.0.0.schema.json",
  "responseSchemaRef": "https://pwce.local/contracts/pwce-approval-recovery-response-1.0.0.schema.json",
  "evidenceSchemaRef": "https://pwce.local/contracts/pwce-approval-evidence-1.0.0.schema.json",
  "routes": {
    "bundle": {
      "method": "GET",
      "path": "/gateway/v1/approval-recovery/bundle"
    },
    "query": {
      "method": "POST",
      "path": "/gateway/v1/approval-recovery"
    }
  },
  "authentication": {
    "agentBearerRequired": true,
    "dispatcherSecretRequired": false,
    "contractHeader": "X-PWCE-Approval-Recovery-Contract"
  },
  "maximumRequestBytes": 65536,
  "maximumResponseBytes": 131072,
  "semantics": {
    "lookup": "Exact original principal, request key, fingerprint and snapshot. Missing or changed terms return unknown without an approval identifier.",
    "scope": "Current authenticated original authority must match World, environment, sites, Assistant, endpoint, ordered participants and audience.",
    "evidence": "Original review, snapshot bytes, confirmation digest and Human proof are retained. Timestamps are never renewed. Stored pending status may be past its expiry; readers must check expiresAt before any use.",
    "readOnly": "Never create, approve, expire or change an approval, snapshot or action. Gateway request audit may be appended. Never check targets, dispatch or reconcile effects.",
    "uncertainty": "Unknown is not evidence that no approval request occurred and never authorizes a resend.",
    "deadline": "Current query deadline is at most 30000 ms away. Original review expiry does not create new approval or dispatch authority."
  },
  "digestAlgorithm": "sha256-ordered-path-bytes-v1",
  "bundleDigest": "9c53528c6116123aa64831b8bc96b42c2bfaf1529ebf55094ed316ccf9de7e05",
  "artifacts": [
    {
      "path": "contracts/approval-recovery/profile.json",
      "sha256": "00b03865133ec22d2584c483381db089a0bc90e57e5574dbe3fd5c18bd8be627"
    },
    {
      "path": "contracts/approval-recovery/request.schema.json",
      "sha256": "701d5e687d96cea946341921b4de5fac6b198c6a994d69a2a07f3fb0552b818c"
    },
    {
      "path": "contracts/approval-recovery/response.schema.json",
      "sha256": "58e653c87296768fe1ced774d8919f0cd12ffb8c9e7a9efd89e84c0b157e262d"
    },
    {
      "path": "contracts/approval-recovery/evidence.schema.json",
      "sha256": "2dea45d11dc838b7a8093ca5ab115ec9e7f306186bdba624687f3f0da6767e0a"
    }
  ],
  "schemaArtifacts": [
    {
      "reference": "https://pwce.local/contracts/pwce-approval-recovery-request-1.0.0.schema.json",
      "sha256": "701d5e687d96cea946341921b4de5fac6b198c6a994d69a2a07f3fb0552b818c",
      "byteLength": 2795,
      "mediaType": "application/schema+json",
      "schemaRef": "https://json-schema.org/draft/2020-12/schema"
    },
    {
      "reference": "https://pwce.local/contracts/pwce-approval-recovery-response-1.0.0.schema.json",
      "sha256": "58e653c87296768fe1ced774d8919f0cd12ffb8c9e7a9efd89e84c0b157e262d",
      "byteLength": 13057,
      "mediaType": "application/schema+json",
      "schemaRef": "https://json-schema.org/draft/2020-12/schema"
    },
    {
      "reference": "https://pwce.local/contracts/pwce-approval-evidence-1.0.0.schema.json",
      "sha256": "2dea45d11dc838b7a8093ca5ab115ec9e7f306186bdba624687f3f0da6767e0a",
      "byteLength": 9234,
      "mediaType": "application/schema+json",
      "schemaRef": "https://json-schema.org/draft/2020-12/schema"
    }
  ]
} as const);
export const PWCE_APPROVAL_RECOVERY_REQUEST_SCHEMA=freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://pwce.local/contracts/pwce-approval-recovery-request-1.0.0.schema.json",
  "title": "Read original scoped Human approval; never approve or dispatch",
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
    "approvalProfileId",
    "approvalProfileVersion",
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
    "operation": {
      "const": "authority.recoverApproval"
    },
    "requestFingerprint": {
      "type": "string",
      "minLength": 1,
      "maxLength": 32768
    },
    "originalSnapshotRef": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "approvalProfileId": {
      "const": "pwce-approval-recovery.v1"
    },
    "approvalProfileVersion": {
      "const": "1.0.0"
    }
  }
} as const);
export const PWCE_APPROVAL_RECOVERY_RESPONSE_SCHEMA=freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://pwce.local/contracts/pwce-approval-recovery-response-1.0.0.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "profileId",
    "profileVersion",
    "requestId",
    "correlationId",
    "worldRef",
    "executionEnvironmentRef",
    "approvalProfileId",
    "approvalProfileVersion",
    "status",
    "reason",
    "approvalEvidence"
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
    "approvalProfileId": {
      "const": "pwce-approval-recovery.v1"
    },
    "approvalProfileVersion": {
      "const": "1.0.0"
    },
    "status": {
      "enum": [
        "known",
        "unknown"
      ]
    },
    "reason": {
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
    "approvalEvidence": {
      "anyOf": [
        {
          "$ref": "#/$defs/OriginalApproval"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "$defs": {
    "OriginalApproval": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "https://pwce.local/contracts/pwce-approval-evidence-1.0.0.schema.json",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "schemaVersion",
        "kind",
        "approvalRef",
        "requestKey",
        "requestFingerprint",
        "principalRef",
        "siteRef",
        "capabilityRef",
        "status",
        "createdAt",
        "expiresAt",
        "approvedBy",
        "approvedAt",
        "humanProof",
        "review",
        "snapshot",
        "confirmationDigest"
      ],
      "properties": {
        "schemaVersion": {
          "const": "1.0.0"
        },
        "kind": {
          "const": "pwce.action.approval"
        },
        "approvalRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "requestKey": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "requestFingerprint": {
          "type": "string",
          "minLength": 1,
          "maxLength": 16384
        },
        "principalRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "siteRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "capabilityRef": {
          "const": "home.light.set_level"
        },
        "status": {
          "enum": [
            "pending",
            "approved",
            "expired"
          ]
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time"
        },
        "approvedBy": {
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
        "approvedAt": {
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
        "humanProof": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "principalRef",
                "authenticationMethod",
                "authenticatedAt",
                "verifiedAt"
              ],
              "properties": {
                "principalRef": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "authenticationMethod": {
                  "enum": [
                    "password",
                    "recovery_code"
                  ]
                },
                "authenticatedAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "verifiedAt": {
                  "type": "string",
                  "format": "date-time"
                }
              }
            },
            {
              "type": "null"
            }
          ]
        },
        "review": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "request",
            "idempotencyKey",
            "effectSummary",
            "effectClass"
          ],
          "properties": {
            "request": {
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
                  "minLength": 1,
                  "maxLength": 128
                },
                "targetEntityId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "parameters": {
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
                }
              }
            },
            "idempotencyKey": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "effectSummary": {
              "type": "string",
              "minLength": 1,
              "maxLength": 4096
            },
            "effectClass": {
              "const": "reversible"
            }
          }
        },
        "snapshot": {
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
              "minLength": 1,
              "maxLength": 128
            },
            "sha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
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
        "confirmationDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "status": {
                "const": "approved"
              }
            }
          },
          "then": {
            "properties": {
              "approvedBy": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "approvedAt": {
                "type": "string",
                "format": "date-time"
              },
              "humanProof": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "principalRef",
                  "authenticationMethod",
                  "authenticatedAt",
                  "verifiedAt"
                ],
                "properties": {
                  "principalRef": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "authenticationMethod": {
                    "enum": [
                      "password",
                      "recovery_code"
                    ]
                  },
                  "authenticatedAt": {
                    "type": "string",
                    "format": "date-time"
                  },
                  "verifiedAt": {
                    "type": "string",
                    "format": "date-time"
                  }
                }
              }
            }
          },
          "else": {
            "properties": {
              "approvedBy": {
                "type": "null"
              },
              "approvedAt": {
                "type": "null"
              },
              "humanProof": {
                "type": "null"
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
          "reason": {
            "type": "null"
          },
          "approvalEvidence": {
            "$ref": "#/$defs/OriginalApproval"
          }
        }
      },
      "else": {
        "properties": {
          "reason": {
            "const": "approval_not_found"
          },
          "approvalEvidence": {
            "type": "null"
          }
        }
      }
    }
  ]
} as const);
export const PWCE_APPROVAL_EVIDENCE_SCHEMA=freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://pwce.local/contracts/pwce-approval-evidence-1.0.0.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "kind",
    "approvalRef",
    "requestKey",
    "requestFingerprint",
    "principalRef",
    "siteRef",
    "capabilityRef",
    "status",
    "createdAt",
    "expiresAt",
    "approvedBy",
    "approvedAt",
    "humanProof",
    "review",
    "snapshot",
    "confirmationDigest"
  ],
  "properties": {
    "schemaVersion": {
      "const": "1.0.0"
    },
    "kind": {
      "const": "pwce.action.approval"
    },
    "approvalRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "requestKey": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "requestFingerprint": {
      "type": "string",
      "minLength": 1,
      "maxLength": 16384
    },
    "principalRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "siteRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "capabilityRef": {
      "const": "home.light.set_level"
    },
    "status": {
      "enum": [
        "pending",
        "approved",
        "expired"
      ]
    },
    "createdAt": {
      "type": "string",
      "format": "date-time"
    },
    "expiresAt": {
      "type": "string",
      "format": "date-time"
    },
    "approvedBy": {
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
    "approvedAt": {
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
    "humanProof": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "principalRef",
            "authenticationMethod",
            "authenticatedAt",
            "verifiedAt"
          ],
          "properties": {
            "principalRef": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "authenticationMethod": {
              "enum": [
                "password",
                "recovery_code"
              ]
            },
            "authenticatedAt": {
              "type": "string",
              "format": "date-time"
            },
            "verifiedAt": {
              "type": "string",
              "format": "date-time"
            }
          }
        },
        {
          "type": "null"
        }
      ]
    },
    "review": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "request",
        "idempotencyKey",
        "effectSummary",
        "effectClass"
      ],
      "properties": {
        "request": {
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
              "minLength": 1,
              "maxLength": 128
            },
            "targetEntityId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "parameters": {
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
            }
          }
        },
        "idempotencyKey": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "effectSummary": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        },
        "effectClass": {
          "const": "reversible"
        }
      }
    },
    "snapshot": {
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
          "minLength": 1,
          "maxLength": 128
        },
        "sha256": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
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
    "confirmationDigest": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    }
  },
  "allOf": [
    {
      "if": {
        "properties": {
          "status": {
            "const": "approved"
          }
        }
      },
      "then": {
        "properties": {
          "approvedBy": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "approvedAt": {
            "type": "string",
            "format": "date-time"
          },
          "humanProof": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "principalRef",
              "authenticationMethod",
              "authenticatedAt",
              "verifiedAt"
            ],
            "properties": {
              "principalRef": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "authenticationMethod": {
                "enum": [
                  "password",
                  "recovery_code"
                ]
              },
              "authenticatedAt": {
                "type": "string",
                "format": "date-time"
              },
              "verifiedAt": {
                "type": "string",
                "format": "date-time"
              }
            }
          }
        }
      },
      "else": {
        "properties": {
          "approvedBy": {
            "type": "null"
          },
          "approvedAt": {
            "type": "null"
          },
          "humanProof": {
            "type": "null"
          }
        }
      }
    }
  ]
} as const);

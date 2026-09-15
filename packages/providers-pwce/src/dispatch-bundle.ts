// Generated only from the public PWCE dispatch bundle. Do not edit by hand.
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
export const EXPECTED_PWCE_DISPATCH_BUNDLE = freeze({
  "bundleId": "pwce-trusted-dispatch.bundle.v1",
  "bundleVersion": "1.0.0",
  "dispatchProfileId": "pwce-trusted-dispatch.v1",
  "dispatchProfileVersion": "1.0.0",
  "requiredGatewayBundle": {
    "bundleId": "pwce-agent-gateway.bundle.v1",
    "bundleVersion": "1.0.0",
    "bundleDigest": "32c555ba675b61b4c1ec82245e314a8f6ca537484defbeb48b9fe1b6bdf4e2e2"
  },
  "digestAlgorithm": "sha256-ordered-path-bytes-v1",
  "bundleDigest": "c61b022af86244d9da5f6b1e2222b44df22487289c0a963816f5242e0958e7be",
  "artifacts": [
    {
      "path": "contracts/gateway-dispatch/transport.json",
      "sha256": "89b51459b788f49cfbea04b43121f216c477c79e0248dae525a664e305095bbe"
    },
    {
      "path": "contracts/gateway-dispatch/request.schema.json",
      "sha256": "a727b6cb9f1db9252075d32ce4e3826f036a700c4bc7d6742d9a92eeba25443e"
    },
    {
      "path": "contracts/gateway-dispatch/response.schema.json",
      "sha256": "0ba4d439853235e9638a4d405383c3753f52af12182b00c282a60997b3b13b62"
    }
  ]
} as const);
export const PWCE_DISPATCH_REQUEST_SCHEMA = freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://pwce.local/contracts/pwce-trusted-dispatch-request-1.0.0.schema.json",
  "title": "Trusted dispatcher request; credentials belong exclusively in transport headers",
  "type": "object",
  "required": [
    "dispatchProfileId",
    "dispatchProfileVersion",
    "profileId",
    "profileVersion",
    "operation",
    "authorityContextRef",
    "requestId",
    "correlationId",
    "worldRef",
    "executionEnvironmentRef",
    "deadline",
    "assistantRef",
    "endpointRef",
    "audienceRef",
    "participantRefs",
    "snapshotRef",
    "siteRef",
    "capabilityRef",
    "capabilityVersion",
    "capabilityOperation",
    "targetEntityId",
    "parameters",
    "idempotencyKey",
    "approvalRequired",
    "approvalRef"
  ],
  "properties": {
    "dispatchProfileId": {
      "const": "pwce-trusted-dispatch.v1"
    },
    "dispatchProfileVersion": {
      "const": "1.0.0"
    },
    "profileId": {
      "const": "pwce-agent-gateway.v1"
    },
    "profileVersion": {
      "const": "1.0.0"
    },
    "operation": {
      "enum": [
        "authority.authorizeDispatch",
        "capabilities.invoke"
      ]
    },
    "authorityContextRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
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
    "deadline": {
      "type": "string",
      "format": "date-time",
      "maxLength": 40
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
    "audienceRef": {
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
    "snapshotRef": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "siteRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "capabilityRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "capabilityVersion": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "capabilityOperation": {
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
      "maxProperties": 32
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
    "actionRef": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "additionalProperties": false,
  "allOf": [
    {
      "if": {
        "properties": {
          "operation": {
            "const": "capabilities.invoke"
          }
        }
      },
      "then": {
        "required": [
          "actionRef"
        ]
      },
      "else": {
        "not": {
          "required": [
            "actionRef"
          ]
        }
      }
    }
  ]
} as const);
export const PWCE_DISPATCH_RESPONSE_SCHEMA = freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://pwce.local/contracts/pwce-trusted-dispatch-response-1.0.0.schema.json",
  "title": "Producer dispatch response; admission evidence is not effect confirmation",
  "type": "object",
  "required": [
    "dispatchProfileId",
    "dispatchProfileVersion",
    "profileId",
    "profileVersion",
    "requestId",
    "correlationId",
    "worldRef",
    "executionEnvironmentRef",
    "status"
  ],
  "properties": {
    "dispatchProfileId": {
      "const": "pwce-trusted-dispatch.v1"
    },
    "dispatchProfileVersion": {
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
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "actionRef": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "decision": {
      "type": "object"
    },
    "duplicate": {
      "type": "boolean"
    },
    "admission": {
      "type": "object",
      "required": [
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
        "grantRevision",
        "targetIdentity",
        "deadlineAt",
        "approvalRequired",
        "approvalRef",
        "gatewayScope",
        "capabilitySnapshot",
        "status",
        "decision",
        "createdAt",
        "result"
      ],
      "properties": {
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
          "type": "string"
        },
        "parameters": {
          "type": "object"
        },
        "capabilitySnapshot": {
          "type": "object",
          "required": [
            "snapshotRef",
            "sha256",
            "expiresAt",
            "snapshotJson"
          ]
        },
        "gatewayScope": {
          "type": "object"
        },
        "result": {
          "type": [
            "object",
            "null"
          ]
        }
      },
      "additionalProperties": true
    },
    "result": {
      "type": "object"
    },
    "outcome": {
      "type": "string"
    },
    "rationaleCodes": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "approvalRef": {
      "type": [
        "string",
        "null"
      ],
      "minLength": 1,
      "maxLength": 128
    },
    "approval": {
      "type": "object"
    }
  },
  "additionalProperties": true
} as const);

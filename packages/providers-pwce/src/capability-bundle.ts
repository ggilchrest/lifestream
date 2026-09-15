// Generated exclusively from PWCE's public capability contract bundle.
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const EXPECTED_PWCE_CAPABILITY_BUNDLE=freeze({
  "bundleId": "pwce-capability-contracts.bundle.v1",
  "bundleVersion": "1.0.0",
  "digestAlgorithm": "sha256-ordered-path-bytes-v1",
  "bundleDigest": "6df58c602d8a43fdababd388c588aef631662e5904139837baa36db9c6730a0c",
  "artifacts": [
    {
      "path": "contracts/capabilities/catalog.json",
      "sha256": "d23f06b1b40814c1f7e5c2fb1ad556bb0f4089c1b1466b7e53af8bd2361d3bed"
    },
    {
      "path": "contracts/capabilities/light-set-level/descriptor.json",
      "sha256": "6e805ece30e0cd3d12b90d5afd7cc82a91e013917f3d75f950cd80e93865d051"
    },
    {
      "path": "contracts/capabilities/light-set-level/input.schema.json",
      "sha256": "cafb6e1ced3bbaa386ec6a59980eda545ab44f410ed9e1de809509be48bc7b6f"
    },
    {
      "path": "contracts/capabilities/light-set-level/result.schema.json",
      "sha256": "98ffa74264afed417b87d4cd385129508e2b90768d579002b6237298cc9460fc"
    }
  ],
  "capabilities": [
    {
      "capabilityRef": "home.light.set_level",
      "operation": "light.set_level",
      "schemaVersion": "1.0.0",
      "title": "Set light brightness",
      "description": "Set the absolute brightness of one light at an authorized site. A level of 0.4 requests 40 percent. Current grants, required Human approval, target availability and final admission are checked separately.",
      "inputSchemaRef": "https://pwce.local/contracts/home-light-set-level-input-1.0.0.schema.json",
      "resultSchemaRef": "https://pwce.local/contracts/home-light-set-level-result-1.0.0.schema.json",
      "effectClass": "reversible",
      "approval": "policy",
      "idempotency": "required",
      "offline": "fixture_only",
      "latencyClass": "bounded",
      "simulationSupported": false,
      "inputSchemaArtifact": {
        "reference": "https://pwce.local/contracts/home-light-set-level-input-1.0.0.schema.json",
        "sha256": "cafb6e1ced3bbaa386ec6a59980eda545ab44f410ed9e1de809509be48bc7b6f",
        "byteLength": 830,
        "mediaType": "application/schema+json",
        "schemaRef": "https://json-schema.org/draft/2020-12/schema"
      },
      "resultSchemaArtifact": {
        "reference": "https://pwce.local/contracts/home-light-set-level-result-1.0.0.schema.json",
        "sha256": "98ffa74264afed417b87d4cd385129508e2b90768d579002b6237298cc9460fc",
        "byteLength": 2006,
        "mediaType": "application/schema+json",
        "schemaRef": "https://json-schema.org/draft/2020-12/schema"
      }
    }
  ]
} as const);

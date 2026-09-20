-- A logical client binding is not a physical DeviceNode or an audience assertion.
CREATE TABLE endpoint_bindings (
 principal_id TEXT NOT NULL,
 binding_key TEXT NOT NULL,
 endpoint_id TEXT NOT NULL,
 PRIMARY KEY (principal_id,binding_key)
);

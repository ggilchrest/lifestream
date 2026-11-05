-- Explicit returning-browser defaults, never inferred from missing/legacy rows.
-- Current authentication and independent audience restrictions still apply.
CREATE TABLE returning_browser_preferences (
 principal_id TEXT NOT NULL REFERENCES local_accounts(principal_id),
 binding_key TEXT NOT NULL,
 endpoint_id TEXT NOT NULL,
 account_epoch INTEGER NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 authority_epoch INTEGER NOT NULL CHECK(authority_epoch>0),
 state TEXT NOT NULL CHECK(state IN ('enabled','withheld','locked','revoked')),
 mode TEXT NOT NULL CHECK(mode IN ('text','audio')),
 audience_scope TEXT NOT NULL CHECK(audience_scope IN ('unknown','authenticatedSession')),
 endpoint_revision INTEGER NOT NULL CHECK(endpoint_revision>0),
 privacy_profile TEXT NOT NULL,
 assistant_id TEXT,
 conversation_id TEXT,
 provenance TEXT NOT NULL CHECK(provenance IN ('savedContext','explicitUnlock','explicitLock','withhold','pendingLock')),
 source_session_id TEXT NOT NULL,
 PRIMARY KEY(principal_id,binding_key),
 CHECK(state!='withheld' OR audience_scope='unknown')
);
CREATE INDEX returning_browser_endpoint ON returning_browser_preferences(principal_id,endpoint_id);
CREATE TRIGGER returning_browser_account_changed AFTER UPDATE OF epoch,disabled ON local_accounts
 WHEN NEW.epoch!=OLD.epoch OR NEW.disabled!=OLD.disabled BEGIN
 UPDATE returning_browser_preferences SET state='revoked',revision=revision+1,authority_epoch=authority_epoch+1 WHERE principal_id=NEW.principal_id;
END;
CREATE TRIGGER returning_browser_binding_removed AFTER DELETE ON endpoint_bindings BEGIN
 UPDATE returning_browser_preferences SET state='revoked',revision=revision+1,authority_epoch=authority_epoch+1
 WHERE principal_id=OLD.principal_id AND binding_key=OLD.binding_key;
END;

CREATE TRIGGER returning_browser_binding_changed AFTER UPDATE OF endpoint_id ON endpoint_bindings WHEN NEW.endpoint_id!=OLD.endpoint_id BEGIN
 UPDATE returning_browser_preferences SET state='revoked',revision=revision+1,authority_epoch=authority_epoch+1
 WHERE principal_id=OLD.principal_id AND binding_key=OLD.binding_key;
END;

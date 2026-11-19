CREATE TABLE `auth_context_cache_state` (
	`id` integer PRIMARY KEY,
	`version` text NOT NULL
);

--> statement-breakpoint
INSERT INTO auth_context_cache_state (id, version) VALUES (1, lower(hex(randomblob(16))));

--> statement-breakpoint
CREATE TRIGGER auth_context_cache_organization_members_insert
AFTER INSERT ON organization_members
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

--> statement-breakpoint
CREATE TRIGGER auth_context_cache_organization_members_update
AFTER UPDATE OF organization_id, user_id, descope_user_id, kind, role, status, custom_permissions, updated_at ON organization_members
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

--> statement-breakpoint
CREATE TRIGGER auth_context_cache_organization_members_delete
AFTER DELETE ON organization_members
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

--> statement-breakpoint
CREATE TRIGGER auth_context_cache_principal_identities_insert
AFTER INSERT ON principal_identities
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

--> statement-breakpoint
CREATE TRIGGER auth_context_cache_principal_identities_update
AFTER UPDATE OF organization_id, principal_type, principal_id, provider, issuer, subject, status ON principal_identities
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

--> statement-breakpoint
CREATE TRIGGER auth_context_cache_principal_identities_delete
AFTER DELETE ON principal_identities
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

--> statement-breakpoint
CREATE TRIGGER auth_context_cache_organizations_insert
AFTER INSERT ON organizations
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

--> statement-breakpoint
CREATE TRIGGER auth_context_cache_organizations_update
AFTER UPDATE OF id, descope_tenant_id, metadata ON organizations
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

--> statement-breakpoint
CREATE TRIGGER auth_context_cache_organizations_delete
AFTER DELETE ON organizations
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

--> statement-breakpoint
CREATE TRIGGER auth_context_cache_users_insert
AFTER INSERT ON users
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

--> statement-breakpoint
CREATE TRIGGER auth_context_cache_users_update
AFTER UPDATE OF id, email, name ON users
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

--> statement-breakpoint
CREATE TRIGGER auth_context_cache_users_delete
AFTER DELETE ON users
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

--> statement-breakpoint
CREATE TRIGGER auth_context_cache_oidc_sessions_insert
AFTER INSERT ON oidc_sessions
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

--> statement-breakpoint
CREATE TRIGGER auth_context_cache_oidc_sessions_update
AFTER UPDATE ON oidc_sessions
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

--> statement-breakpoint
CREATE TRIGGER auth_context_cache_oidc_sessions_delete
AFTER DELETE ON oidc_sessions
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

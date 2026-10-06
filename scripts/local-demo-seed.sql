-- Deterministic, credential-free state for `bun run-local`.
-- Every statement is idempotent so repeated local boots preserve user-created data.

INSERT OR IGNORE INTO organizations (
	id, name, slug, type, descope_tenant_id, apps_count, created_at, updated_at
) VALUES (
	'00000000-0000-4000-8000-000000000001',
	'Local Tedix',
	'local-tedix',
	'personal',
	'personal_local-demo-owner',
	0,
	'2026-08-10T00:00:00.000Z',
	'2026-08-10T00:00:00.000Z'
);

INSERT OR IGNORE INTO users (
	id, email, name, last_login_at, created_at, updated_at
) VALUES (
	'00000000-0000-4000-8000-000000000002',
	'owner@localhost.invalid',
	'Local Owner',
	'2026-08-10T00:00:00.000Z',
	'2026-08-10T00:00:00.000Z',
	'2026-08-10T00:00:00.000Z'
);

INSERT OR IGNORE INTO organization_members (
	id, organization_id, user_id, descope_user_id, email, name, role,
	status, invite_accepted_at, created_at, updated_at
) VALUES (
	'00000000-0000-4000-8000-000000000003',
	'00000000-0000-4000-8000-000000000001',
	'00000000-0000-4000-8000-000000000002',
	'local-demo-owner',
	'owner@localhost.invalid',
	'Local Owner',
	'owner',
	'active',
	'2026-08-10T00:00:00.000Z',
	'2026-08-10T00:00:00.000Z',
	'2026-08-10T00:00:00.000Z'
);

INSERT OR IGNORE INTO principal_identities (
	id, organization_id, principal_type, principal_id, provider, issuer,
	subject, status, metadata, last_verified_at, created_at, updated_at
) VALUES
	(
		'00000000-0000-4000-8000-000000000005',
		NULL,
		'user',
		'00000000-0000-4000-8000-000000000002',
		'descope',
		'http://localhost/tedix-local-demo',
		'local-demo-owner',
		'active',
		'{}',
		'2026-08-10T00:00:00.000Z',
		'2026-08-10T00:00:00.000Z',
		'2026-08-10T00:00:00.000Z'
	),
	(
		'00000000-0000-4000-8000-000000000006',
		'00000000-0000-4000-8000-000000000001',
		'organization',
		'00000000-0000-4000-8000-000000000001',
		'descope',
		'http://localhost/tedix-local-demo',
		'personal_local-demo-owner',
		'active',
		'{}',
		'2026-08-10T00:00:00.000Z',
		'2026-08-10T00:00:00.000Z',
		'2026-08-10T00:00:00.000Z'
	);

-- Repair state created by earlier demo revisions while keeping user data.
UPDATE principal_identities
SET organization_id = NULL
WHERE id = '00000000-0000-4000-8000-000000000005';

INSERT OR IGNORE INTO tedis (
	id, organization_id, owner_user_id, scope, name, slug, display_name,
	personality, avatar, timezone, language, status, billing_state,
	mcp_capability_profile, runtime_profile_id, policy_pack_id,
	workspace_template_set_id, runtime_state, runtime_status, runtime_kind,
	isolate_agent_id, created_at, updated_at
) VALUES (
	'00000000-0000-4000-8000-000000000004',
	'00000000-0000-4000-8000-000000000001',
	'local-demo-owner',
	'personal',
	'Local Tedi',
	'local-tedi',
	'Local Tedi',
	'You are a local Tedix demo worker. Explain what is available locally and clearly identify provider-backed capabilities that are not configured.',
	'🌱',
	'UTC',
	'en',
	'active',
	'cold',
	'standard',
	'5c125da4-25b9-40de-9a80-3e8a231bc85b',
	'd395b649-3a06-43d4-99cc-697340df2ca5',
	'000542d5-b75c-4760-9cd9-c5713bd94979',
	'standby',
	'unknown',
	'agent',
	'local-tedi',
	'2026-08-10T00:00:00.000Z',
	'2026-08-10T00:00:00.000Z'
);

INSERT OR IGNORE INTO os_workspaces (
	id, organization_id, name, description, status, created_by_kind,
	created_by_id, created_at, updated_at
) VALUES (
	'00000000-0000-4000-8000-000000000007',
	'00000000-0000-4000-8000-000000000001',
	'Revenue Ops',
	'Durable Workspace seeded for the credential-free local Tedix OS.',
	'active',
	'user',
	'local-demo-owner',
	'2026-08-10T00:00:00.000Z',
	'2026-08-10T00:00:00.000Z'
);

INSERT OR IGNORE INTO os_outputs (
	id, organization_id, workspace_id, kind, title, status,
	current_revision_id, created_by_kind, created_by_id, created_at, updated_at
) VALUES (
	'00000000-0000-4000-8000-000000000008',
	'00000000-0000-4000-8000-000000000001',
	'00000000-0000-4000-8000-000000000007',
	'document',
	'Local Shared Draft',
	'active',
	'00000000-0000-4000-8000-000000000009',
	'user',
	'local-demo-owner',
	'2026-08-10T00:00:00.000Z',
	'2026-08-10T00:00:00.000Z'
);

INSERT OR IGNORE INTO os_output_revisions (
	id, organization_id, output_id, revision, content, note,
	created_by_kind, created_by_id, created_at
) VALUES (
	'00000000-0000-4000-8000-000000000009',
	'00000000-0000-4000-8000-000000000001',
	'00000000-0000-4000-8000-000000000008',
	1,
	'{"kind":"document","blocks":[{"type":"paragraph","text":"Shared local draft"}]}',
	'Credential-free collaboration seed',
	'user',
	'local-demo-owner',
	'2026-08-10T00:00:00.000Z'
);

-- Provider-neutral local entitlement. This admits an operator-supplied model
-- only when the launcher separately enables its paid inference bridge; the
-- default credential-free lane still has no model transport.
INSERT OR IGNORE INTO billing_accounts (
	organization_id, plan_version_id, status, billing_mode,
	period_start, period_end, entitlement_version, metadata,
	created_at, updated_at
) VALUES (
	'00000000-0000-4000-8000-000000000001',
	'starter-v1',
	'active',
	'internal',
	'2026-01-01T00:00:00.000Z',
	'2099-01-01T00:00:00.000Z',
	1,
	'{"runtimeEntitlementSource":"operator","runtimeEntitlementGrants":[{"key":"local-inference","status":"active","source":"operator"}]}',
	'2026-08-10T00:00:00.000Z',
	'2026-08-10T00:00:00.000Z'
);

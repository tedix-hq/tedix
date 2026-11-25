BEGIN;
ALTER TABLE "external_agent_attributions" ADD CONSTRAINT "chk_external_agent_attribution_target" CHECK (length("external_agent_attributions"."target_id") > 0);
--> statement-breakpoint
ALTER TABLE "external_agent_exchange_limits" ADD CONSTRAINT "chk_external_agent_exchange_count" CHECK ("external_agent_exchange_limits"."request_count" BETWEEN 1 AND 30);
--> statement-breakpoint
ALTER TABLE "external_agent_mcp_credentials" ADD CONSTRAINT "chk_external_agent_mcp_credential_state" CHECK (("external_agent_mcp_credentials"."status" = 'active' AND "external_agent_mcp_credentials"."revoked_at" IS NULL) OR ("external_agent_mcp_credentials"."status" = 'revoked' AND "external_agent_mcp_credentials"."revoked_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "external_agent_mcp_issuance_leases" ADD CONSTRAINT "chk_external_agent_mcp_issuance_lease_expiry" CHECK ("external_agent_mcp_issuance_leases"."expires_at" > "external_agent_mcp_issuance_leases"."updated_at");
--> statement-breakpoint
ALTER TABLE "external_agent_principals" ADD CONSTRAINT "chk_external_agent_principal_key" CHECK (length("external_agent_principals"."key") > 0);
--> statement-breakpoint
ALTER TABLE "external_agent_principals" ADD CONSTRAINT "chk_external_agent_principal_binding" CHECK (length("external_agent_principals"."credential_binding_id") > 0);
--> statement-breakpoint
ALTER TABLE "external_agent_review_evidence" ADD CONSTRAINT "chk_external_agent_review_principal_type" CHECK ("external_agent_review_evidence"."reviewer_principal_type" IN ('user', 'certification_service', 'external_agent'));
--> statement-breakpoint
ALTER TABLE "external_agent_review_evidence" ADD CONSTRAINT "chk_external_agent_review_no_self_review" CHECK ("external_agent_review_evidence"."reviewer_principal_type" != 'external_agent' OR "external_agent_review_evidence"."reviewer_principal_id" != "external_agent_review_evidence"."subject_principal_id");
--> statement-breakpoint
ALTER TABLE "external_agent_review_evidence" ADD CONSTRAINT "chk_external_agent_review_session_shape" CHECK (("external_agent_review_evidence"."reviewer_principal_type" = 'external_agent' AND "external_agent_review_evidence"."reviewer_session_id" IS NOT NULL) OR ("external_agent_review_evidence"."reviewer_principal_type" != 'external_agent' AND "external_agent_review_evidence"."reviewer_session_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "external_agent_review_evidence" ADD CONSTRAINT "chk_external_agent_review_score" CHECK ("external_agent_review_evidence"."score" >= 0 AND "external_agent_review_evidence"."score" <= 1 AND "external_agent_review_evidence"."policy_violation_severity" >= 0 AND "external_agent_review_evidence"."policy_violation_severity" <= 10);
--> statement-breakpoint
ALTER TABLE "external_agent_review_evidence" ADD CONSTRAINT "chk_external_agent_review_outcome_coherence" CHECK (("external_agent_review_evidence"."outcome" = 'success' AND "external_agent_review_evidence"."score" >= 0.5 AND "external_agent_review_evidence"."policy_violation_severity" = 0) OR ("external_agent_review_evidence"."outcome" = 'partial' AND "external_agent_review_evidence"."policy_violation_severity" = 0) OR ("external_agent_review_evidence"."outcome" = 'failure' AND "external_agent_review_evidence"."score" <= 0.5 AND "external_agent_review_evidence"."policy_violation_severity" = 0) OR ("external_agent_review_evidence"."outcome" = 'policy_violation' AND "external_agent_review_evidence"."score" <= 0.5 AND "external_agent_review_evidence"."policy_violation_severity" >= 1));
--> statement-breakpoint
ALTER TABLE "external_agent_review_evidence" ADD CONSTRAINT "chk_external_agent_review_context" CHECK (length("external_agent_review_evidence"."task_family") > 0 AND length("external_agent_review_evidence"."repository_key") > 0 AND length("external_agent_review_evidence"."repository_version") > 0 AND length("external_agent_review_evidence"."environment") > 0 AND jsonb_array_length("external_agent_review_evidence"."evidence_refs") > 0);
--> statement-breakpoint
ALTER TABLE "external_agent_review_evidence" ADD CONSTRAINT "chk_external_agent_review_resolution" CHECK (("external_agent_review_evidence"."resolution_status" = 'open' AND "external_agent_review_evidence"."resolution_evidence_ref" IS NULL AND "external_agent_review_evidence"."resolved_by_type" IS NULL AND "external_agent_review_evidence"."resolved_by_id" IS NULL AND "external_agent_review_evidence"."resolved_at" IS NULL) OR ("external_agent_review_evidence"."resolution_status" = 'remediated' AND "external_agent_review_evidence"."resolution_evidence_ref" IS NOT NULL AND "external_agent_review_evidence"."resolved_by_type" IS NOT NULL AND "external_agent_review_evidence"."resolved_by_id" IS NOT NULL AND "external_agent_review_evidence"."resolved_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "external_agent_sessions" ADD CONSTRAINT "chk_external_agent_session_key" CHECK (length("external_agent_sessions"."external_session_key") > 0);
--> statement-breakpoint
ALTER TABLE "external_agent_sessions" ADD CONSTRAINT "chk_external_agent_session_derived_credit" CHECK ("external_agent_sessions"."identity_source" != 'derived' OR "external_agent_sessions"."credit_eligible" = false);
--> statement-breakpoint
ALTER TABLE "external_agent_sessions" ADD CONSTRAINT "chk_external_agent_session_end_state" CHECK (("external_agent_sessions"."status" = 'active' AND "external_agent_sessions"."ended_at" IS NULL) OR ("external_agent_sessions"."status" = 'ended' AND "external_agent_sessions"."ended_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "external_agent_workload_token_uses" ADD CONSTRAINT "chk_external_agent_workload_token_lifetime" CHECK ("external_agent_workload_token_uses"."token_expires_at" > "external_agent_workload_token_uses"."token_issued_at");
--> statement-breakpoint
CREATE UNIQUE INDEX organizations_descope_tenant_id_unique ON organizations(descope_tenant_id) WHERE descope_tenant_id IS NOT NULL;
LOCK TABLE organization_members, principal_identities, organizations, users, oidc_sessions, os_workspaces, os_workspace_access_edges, os_workspace_share_links, tedis, apps, app_tools, connection_instances IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO auth_context_cache_state(id, version) VALUES (1, gen_random_uuid()::text)
ON CONFLICT(id) DO UPDATE SET version = excluded.version;
--> statement-breakpoint
CREATE FUNCTION advance_auth_context_cache() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE auth_context_cache_state SET version = gen_random_uuid()::text WHERE id = 1;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_organization_members_insert AFTER INSERT ON organization_members
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_organization_members_update AFTER UPDATE OF organization_id, user_id, descope_user_id, kind, role, status, custom_permissions, updated_at ON organization_members
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_organization_members_delete AFTER DELETE ON organization_members
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_principal_identities_insert AFTER INSERT ON principal_identities
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_principal_identities_update AFTER UPDATE OF organization_id, principal_type, principal_id, provider, issuer, subject, status ON principal_identities
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_principal_identities_delete AFTER DELETE ON principal_identities
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_organizations_insert AFTER INSERT ON organizations
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_organizations_update AFTER UPDATE OF id, descope_tenant_id, metadata ON organizations
FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id
    OR NEW.descope_tenant_id IS DISTINCT FROM OLD.descope_tenant_id
    OR ((NEW.metadata ->> 'retiredAt') IS NULL) IS DISTINCT FROM ((OLD.metadata ->> 'retiredAt') IS NULL)
    OR (NEW.metadata -> 'identityProvider') IS DISTINCT FROM (OLD.metadata -> 'identityProvider'))
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_organizations_delete AFTER DELETE ON organizations
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_users_insert AFTER INSERT ON users
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_users_update AFTER UPDATE OF id, email, name ON users
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_users_delete AFTER DELETE ON users
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_oidc_sessions_insert AFTER INSERT ON oidc_sessions
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_oidc_sessions_update AFTER UPDATE ON oidc_sessions
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_oidc_sessions_delete AFTER DELETE ON oidc_sessions
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspaces_insert AFTER INSERT ON os_workspaces
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspaces_update AFTER UPDATE OF id, organization_id, status, visibility, owner_user_id ON os_workspaces
FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id
  OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
  OR NEW.status IS DISTINCT FROM OLD.status
  OR NEW.visibility IS DISTINCT FROM OLD.visibility
  OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id)
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspaces_delete AFTER DELETE ON os_workspaces
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspace_access_edges_insert AFTER INSERT ON os_workspace_access_edges
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspace_access_edges_update AFTER UPDATE ON os_workspace_access_edges
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspace_access_edges_delete AFTER DELETE ON os_workspace_access_edges
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspace_share_links_insert AFTER INSERT ON os_workspace_share_links
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspace_share_links_update AFTER UPDATE ON os_workspace_share_links
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_os_workspace_share_links_delete AFTER DELETE ON os_workspace_share_links
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_tedis_insert AFTER INSERT ON tedis
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_tedis_update AFTER UPDATE OF id, organization_id, status, scope, owner_user_id ON tedis
FOR EACH ROW WHEN (NEW.id IS DISTINCT FROM OLD.id
  OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
  OR NEW.status IS DISTINCT FROM OLD.status
  OR NEW.scope IS DISTINCT FROM OLD.scope
  OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id)
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE TRIGGER auth_context_cache_tedis_delete AFTER DELETE ON tedis
FOR EACH ROW
EXECUTE FUNCTION advance_auth_context_cache();
--> statement-breakpoint
CREATE FUNCTION tenant_policy_app_insert_generation_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO "tenant_tool_policy_resource_generations" ("organization_id", "resource_kind", "resource_id", "generation") VALUES (NEW."organization_id", 'app', NEW."id", 1)
	ON CONFLICT ("organization_id", "resource_kind", "resource_id") DO UPDATE SET "generation" = tenant_tool_policy_resource_generations.generation + 1;
RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_policy_app_insert_generation AFTER INSERT ON "apps"
FOR EACH ROW
EXECUTE FUNCTION tenant_policy_app_insert_generation_fn();
--> statement-breakpoint
CREATE FUNCTION tenant_policy_app_update_generation_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO "tenant_tool_policy_resource_generations" ("organization_id", "resource_kind", "resource_id", "generation") VALUES (NEW."organization_id", 'app', NEW."id", 1)
	ON CONFLICT ("organization_id", "resource_kind", "resource_id") DO UPDATE SET "generation" = tenant_tool_policy_resource_generations.generation + 1;
RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_policy_app_update_generation AFTER UPDATE ON "apps"
FOR EACH ROW WHEN (OLD."metadata" IS DISTINCT FROM NEW."metadata" OR OLD."slug" IS DISTINCT FROM NEW."slug" OR OLD."visibility" IS DISTINCT FROM NEW."visibility" OR OLD."source_app_id" IS DISTINCT FROM NEW."source_app_id" OR OLD."active_config_version_id" IS DISTINCT FROM NEW."active_config_version_id" OR OLD."latest_config_version" IS DISTINCT FROM NEW."latest_config_version" OR OLD."gating_metadata" IS DISTINCT FROM NEW."gating_metadata" OR OLD."custom_mcp_domain" IS DISTINCT FROM NEW."custom_mcp_domain" OR OLD."organization_id" IS DISTINCT FROM NEW."organization_id")
EXECUTE FUNCTION tenant_policy_app_update_generation_fn();
--> statement-breakpoint
CREATE FUNCTION tenant_policy_app_delete_generation_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO "tenant_tool_policy_resource_generations" ("organization_id", "resource_kind", "resource_id", "generation")
	SELECT OLD."organization_id", 'app', OLD."id", 1 WHERE EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organization_id")
	ON CONFLICT ("organization_id", "resource_kind", "resource_id") DO UPDATE SET "generation" = tenant_tool_policy_resource_generations.generation + 1;
RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_policy_app_delete_generation BEFORE DELETE ON "apps"
FOR EACH ROW
EXECUTE FUNCTION tenant_policy_app_delete_generation_fn();
--> statement-breakpoint
CREATE FUNCTION tenant_policy_tool_insert_generation_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO "tenant_tool_policy_resource_generations" ("organization_id", "resource_kind", "resource_id", "generation")
	SELECT "organization_id", 'tool', NEW."id", 1 FROM "apps" WHERE "id" = NEW."app_id"
	ON CONFLICT ("organization_id", "resource_kind", "resource_id") DO UPDATE SET "generation" = tenant_tool_policy_resource_generations.generation + 1;
RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_policy_tool_insert_generation AFTER INSERT ON "app_tools"
FOR EACH ROW
EXECUTE FUNCTION tenant_policy_tool_insert_generation_fn();
--> statement-breakpoint
CREATE FUNCTION tenant_policy_tool_update_generation_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO "tenant_tool_policy_resource_generations" ("organization_id", "resource_kind", "resource_id", "generation")
	SELECT "organization_id", 'tool', NEW."id", 1 FROM "apps" WHERE "id" = NEW."app_id"
	ON CONFLICT ("organization_id", "resource_kind", "resource_id") DO UPDATE SET "generation" = tenant_tool_policy_resource_generations.generation + 1;
RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_policy_tool_update_generation AFTER UPDATE ON "app_tools"
FOR EACH ROW
EXECUTE FUNCTION tenant_policy_tool_update_generation_fn();
--> statement-breakpoint
CREATE FUNCTION tenant_policy_tool_delete_generation_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO "tenant_tool_policy_resource_generations" ("organization_id", "resource_kind", "resource_id", "generation")
	SELECT "organization_id", 'tool', OLD."id", 1 FROM "apps" WHERE "id" = OLD."app_id"
	ON CONFLICT ("organization_id", "resource_kind", "resource_id") DO UPDATE SET "generation" = tenant_tool_policy_resource_generations.generation + 1;
RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_policy_tool_delete_generation BEFORE DELETE ON "app_tools"
FOR EACH ROW
EXECUTE FUNCTION tenant_policy_tool_delete_generation_fn();
--> statement-breakpoint
CREATE FUNCTION tenant_policy_connection_insert_generation_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO "tenant_tool_policy_resource_generations" ("organization_id", "resource_kind", "resource_id", "generation") VALUES (NEW."organization_id", 'connection', NEW."id", 1)
	ON CONFLICT ("organization_id", "resource_kind", "resource_id") DO UPDATE SET "generation" = tenant_tool_policy_resource_generations.generation + 1;
RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_policy_connection_insert_generation AFTER INSERT ON "connection_instances"
FOR EACH ROW WHEN (NEW."organization_id" IS DISTINCT FROM NULL)
EXECUTE FUNCTION tenant_policy_connection_insert_generation_fn();
--> statement-breakpoint
CREATE FUNCTION tenant_policy_connection_update_generation_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO "tenant_tool_policy_resource_generations" ("organization_id", "resource_kind", "resource_id", "generation") VALUES (NEW."organization_id", 'connection', NEW."id", 1)
	ON CONFLICT ("organization_id", "resource_kind", "resource_id") DO UPDATE SET "generation" = tenant_tool_policy_resource_generations.generation + 1;
RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_policy_connection_update_generation AFTER UPDATE ON "connection_instances"
FOR EACH ROW WHEN (NEW."organization_id" IS DISTINCT FROM NULL AND (OLD."organization_id" IS DISTINCT FROM NEW."organization_id" OR OLD."provider_id" IS DISTINCT FROM NEW."provider_id" OR OLD."owner_user_id" IS DISTINCT FROM NEW."owner_user_id" OR OLD."token_ids" IS DISTINCT FROM NEW."token_ids" OR OLD."token_sub" IS DISTINCT FROM NEW."token_sub" OR OLD."allowed_resources" IS DISTINCT FROM NEW."allowed_resources"))
EXECUTE FUNCTION tenant_policy_connection_update_generation_fn();
--> statement-breakpoint
CREATE FUNCTION tenant_policy_connection_delete_generation_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO "tenant_tool_policy_resource_generations" ("organization_id", "resource_kind", "resource_id", "generation")
	SELECT OLD."organization_id", 'connection', OLD."id", 1 WHERE EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organization_id")
	ON CONFLICT ("organization_id", "resource_kind", "resource_id") DO UPDATE SET "generation" = tenant_tool_policy_resource_generations.generation + 1;
RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tenant_policy_connection_delete_generation BEFORE DELETE ON "connection_instances"
FOR EACH ROW WHEN (OLD."organization_id" IS DISTINCT FROM NULL)
EXECUTE FUNCTION tenant_policy_connection_delete_generation_fn();
--> statement-breakpoint
INSERT INTO tenant_tool_policy_resource_generations(organization_id, resource_kind, resource_id, generation)
SELECT organization_id, 'app', id, 1 FROM apps
UNION ALL SELECT a.organization_id, 'tool', t.id, 1 FROM app_tools t JOIN apps a ON a.id = t.app_id
UNION ALL SELECT organization_id, 'connection', id, 1 FROM connection_instances WHERE organization_id IS NOT NULL
ON CONFLICT(organization_id, resource_kind, resource_id) DO UPDATE SET generation = tenant_tool_policy_resource_generations.generation + 1;
--> statement-breakpoint
COMMIT;

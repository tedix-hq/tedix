DROP TRIGGER auth_context_cache_organizations_update;
--> statement-breakpoint
-- Both identity resolvers exclude retired organizations. OIDC also checks
-- the full provider configuration against the session's configuration digest.
CREATE TRIGGER auth_context_cache_organizations_update
AFTER UPDATE OF id, descope_tenant_id, metadata ON organizations
WHEN NEW.id IS NOT OLD.id
  OR NEW.descope_tenant_id IS NOT OLD.descope_tenant_id
  OR (NEW.metadata IS NOT OLD.metadata AND iif(
    NOT json_valid(coalesce(NEW.metadata, '{}'))
      OR NOT json_valid(coalesce(OLD.metadata, '{}')),
    1,
    (json_extract(NEW.metadata, '$.retiredAt') IS NULL)
      IS NOT (json_extract(OLD.metadata, '$.retiredAt') IS NULL)
      OR (NEW.metadata -> '$.identityProvider') IS NOT (OLD.metadata -> '$.identityProvider')
  ))
BEGIN
  UPDATE auth_context_cache_state SET version = lower(hex(randomblob(16))) WHERE id = 1;
END;

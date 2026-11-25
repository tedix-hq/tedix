CREATE UNIQUE INDEX cms_domain_claims_site_pending_unique
ON cms_domain_claims (site_id) WHERE status = 'pending';

CREATE UNIQUE INDEX cms_domain_claims_organization_unique
ON cms_domain_claims (organization_id) WHERE kind = 'organization';

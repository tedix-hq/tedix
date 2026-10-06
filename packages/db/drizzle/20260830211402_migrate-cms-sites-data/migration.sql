INSERT INTO cms_sites (
	id, organization_id, slug, name, description, status, canonical_url,
	custom_domain, public_path_prefix, database_id, template_slug, config,
	mcp_app_id, authoring_app_id, created_at, updated_at
)
SELECT
	a.id, a.organization_id, a.slug, a.name, a.description,
	CASE WHEN a.visibility = 'disabled' THEN 'paused' ELSE 'active' END,
	COALESCE(
		json_extract(a.metadata, '$.publicSiteUrl'),
		CASE WHEN json_extract(a.metadata, '$.blogConfig.cmsDomain') IS NOT NULL
			THEN 'https://' || json_extract(a.metadata, '$.blogConfig.cmsDomain') END,
		'unconfigured'
	),
	json_extract(a.metadata, '$.blogConfig.cmsDomain'),
	json_extract(a.metadata, '$.blogConfig.publicPathPrefix'),
	json_extract(a.metadata, '$.cmsD1DatabaseId'),
	COALESCE(json_extract(a.metadata, '$.blogConfig.templateSlug'), 'tedix'),
	json_object(
		'branding', json_extract(a.metadata, '$.branding'),
		'socialLinks', json_extract(a.metadata, '$.socialLinks'),
		'seo', json_extract(a.metadata, '$.seoConfig'),
		'analytics', json_extract(a.metadata, '$.analyticsConfig'),
		'blog', json_extract(a.metadata, '$.blogConfig')
	),
	CASE WHEN EXISTS (SELECT 1 FROM app_tools t WHERE t.app_id = a.id)
		THEN a.id ELSE NULL END,
	(SELECT proxy.id FROM apps proxy
		WHERE proxy.organization_id = a.organization_id
			AND proxy.slug = 'cms-' || a.slug LIMIT 1),
	COALESCE(a.created_at, datetime('now')),
	COALESCE(a.updated_at, datetime('now'))
FROM apps a
WHERE json_extract(a.metadata, '$.cmsD1DatabaseId') IS NOT NULL;
--> statement-breakpoint
UPDATE apps
SET metadata = json_remove(
	COALESCE(metadata, '{}'), '$.cmsD1DatabaseId', '$.blogConfig',
	'$.publicSiteUrl', '$.templateSlug'
)
WHERE id IN (SELECT id FROM cms_sites WHERE mcp_app_id IS NOT NULL);
--> statement-breakpoint
DELETE FROM apps
WHERE id IN (SELECT id FROM cms_sites WHERE mcp_app_id IS NULL);

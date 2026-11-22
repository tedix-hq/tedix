-- The old backfill discarded selection provenance, so every stored Auto slot
-- moves, including pinned historical revisions. Keep the original policy on
-- each affected profile for operator recovery; later explicit choices are free
-- to use Auto again. This is a one-time migration, not a write-time rule.
UPDATE runtime_profiles
SET config = json_set(
	config,
	'$.modelPolicyBeforeAutoToTerra20261122', json_extract(config, '$.modelPolicy'),
	'$.modelPolicy', json_patch(
		json_extract(config, '$.modelPolicy'),
		json_patch(
			json_patch(
				CASE WHEN json_extract(config, '$.modelPolicy.chatModelRef') = 'cloudflare/auto'
					THEN json_object('chatModelRef', 'azure-openai/gpt-6.1-terra') ELSE '{}' END,
				CASE WHEN json_extract(config, '$.modelPolicy.cronModelRef') = 'cloudflare/auto'
					THEN json_object('cronModelRef', 'azure-openai/gpt-6.1-terra') ELSE '{}' END
			),
			CASE WHEN json_extract(config, '$.modelPolicy.observerModelRef') = 'cloudflare/auto'
				THEN json_object('observerModelRef', 'azure-openai/gpt-6.1-terra') ELSE '{}' END
		)
	)
)
WHERE json_extract(config, '$.modelPolicy.chatModelRef') = 'cloudflare/auto'
	OR json_extract(config, '$.modelPolicy.cronModelRef') = 'cloudflare/auto'
	OR json_extract(config, '$.modelPolicy.observerModelRef') = 'cloudflare/auto';

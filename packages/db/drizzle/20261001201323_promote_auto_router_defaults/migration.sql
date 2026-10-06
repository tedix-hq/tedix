-- Canonicalize every stored runtime-profile revision before removing the
-- optional-field compatibility path. Existing explicit model pins remain
-- fixed; only absent slots inherit the adaptive platform default.
UPDATE runtime_profiles
SET config = json_set(
	json_set(
		json_set(
			config,
			'$.modelPolicy.chatModelRef',
			COALESCE(
				json_extract(config, '$.modelPolicy.chatModelRef'),
				'cloudflare/auto'
			)
		),
		'$.modelPolicy.cronModelRef',
		COALESCE(
			json_extract(config, '$.modelPolicy.cronModelRef'),
			'cloudflare/auto'
		)
	),
	'$.modelPolicy.observerModelRef',
	COALESCE(
		json_extract(config, '$.modelPolicy.observerModelRef'),
		'cloudflare/auto'
	)
)
WHERE json_extract(config, '$.modelPolicy.chatModelRef') IS NULL
	OR json_extract(config, '$.modelPolicy.cronModelRef') IS NULL
	OR json_extract(config, '$.modelPolicy.observerModelRef') IS NULL;

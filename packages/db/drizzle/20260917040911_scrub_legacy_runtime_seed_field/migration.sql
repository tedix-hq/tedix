UPDATE runtime_profiles
SET config = json_remove(config, '$.runtimePolicy.openclawVersion')
WHERE id = '5c125da4-25b9-40de-9a80-3e8a231bc85b'
	AND json_extract(config, '$.runtimePolicy.openclawVersion') IS NOT NULL;
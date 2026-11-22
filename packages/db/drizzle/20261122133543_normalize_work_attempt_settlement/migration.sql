-- Normalize older repository receipts before readers require typed settlement.
-- Keep non-repository receipts and the original non-settlement metadata intact.
WITH eligible AS (
	SELECT id, metadata, json_extract(metadata, '$.settlement.mode') AS mode
	FROM work_attempts
	WHERE json_extract(metadata, '$.settlement.mode') IN ('commit', 'existing_commits')
		OR (json_extract(metadata, '$.settlement.mode') IS NULL AND (
			json_type(metadata, '$.settlement') = 'object'
			OR json_type(metadata, '$.commitShas') IS NOT NULL
			OR json_type(metadata, '$.commits') IS NOT NULL
			OR json_type(metadata, '$.commitSha') IS NOT NULL
			OR json_type(metadata, '$.sourceCommit') IS NOT NULL
		))
),
reported_commits AS (
	SELECT e.id, 1 AS priority, j.key AS position, j.value AS sha
	FROM eligible e, json_each(e.metadata, '$.settlement.commitShas') j
	WHERE j.type = 'text'
	UNION ALL
	SELECT id, 2, 0, json_extract(metadata, '$.settlement.commitSha') FROM eligible
	UNION ALL
	SELECT e.id, 3, j.key, j.value
	FROM eligible e, json_each(e.metadata, '$.commitShas') j
	WHERE j.type = 'text' AND e.mode IS NULL
	UNION ALL
	SELECT e.id, 4, j.key, CASE j.type WHEN 'object' THEN json_extract(j.value, '$.sha') ELSE j.value END
	FROM eligible e, json_each(e.metadata, '$.commits') j
	WHERE j.type IN ('object', 'text') AND e.mode IS NULL
	UNION ALL
	SELECT id, 5, 0, json_extract(metadata, '$.commitSha') FROM eligible WHERE mode IS NULL
),
candidates AS (
	SELECT id, priority, position, sha FROM reported_commits
	UNION ALL
	SELECT id, 6, 0, json_extract(metadata, '$.sourceCommit') FROM eligible WHERE mode IS NULL
),
valid AS (
	SELECT id, lower(trim(sha)) AS sha, priority, position
	FROM candidates
	WHERE typeof(sha) = 'text' AND length(trim(sha)) = 40 AND lower(trim(sha)) NOT GLOB '*[^0-9a-f]*'
),
unique_commits AS (
	SELECT id, sha, priority, position,
		row_number() OVER (PARTITION BY id, sha ORDER BY priority, position) AS occurrence
	FROM valid
),
receipts AS (
	SELECT e.id, e.metadata, e.mode,
		(SELECT json_group_array(sha) FROM (
			SELECT sha FROM unique_commits
			WHERE id = e.id AND occurrence = 1 ORDER BY priority, position LIMIT 100
		)) AS commits,
		(SELECT min(priority) FROM valid WHERE id = e.id) AS first_priority
	FROM eligible e
)
UPDATE work_attempts
SET metadata = json_set(work_attempts.metadata, '$.settlement', json_patch(
	json_object(
		'mode', CASE WHEN r.mode = 'existing_commits' OR r.first_priority = 6 THEN 'existing_commits' ELSE 'commit' END,
		'commitShas', json(r.commits)
	),
	CASE WHEN r.mode = 'existing_commits'
		AND json_type(r.metadata, '$.settlement.repository') = 'text'
		AND length(json_extract(r.metadata, '$.settlement.repository')) BETWEEN 1 AND 300
		THEN json_object('repository', json_extract(r.metadata, '$.settlement.repository'))
		ELSE '{}' END
))
FROM receipts r
WHERE work_attempts.id = r.id AND r.first_priority IS NOT NULL;

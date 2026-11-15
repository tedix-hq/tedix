-- Carry every milestone into an epic (work_cases) before milestones are removed.
-- Sprints carry nothing forward. The milestone and sprint tables stay untouched
-- here; a later migration drops them.
--
-- The epic reuses the milestone id, so every statement can run again without
-- creating duplicates, and none of them does anything on empty tables.
--
-- Mapping:
--   kind                 'other' (no epic kind means "delivery checkpoint")
--   title, description   copied; a cancelled milestone gets a leading note
--   project, target_at   project_id, target_resolution_at
--   proof_ref            proof_ref (blank becomes NULL)
--   owner                copied while still active in the organization, else
--                        system/tedix (the epic triggers reject inactive owners)
--   status               proposed, planned -> planning; active -> executing;
--                        done, cancelled -> closed
--   metadata.carriedFrom the milestone status, original owner, sort order, end
--                        times, and the open tasks left off a cancelled milestone
--
-- A closed epic may hold only finished tasks. So a cancelled milestone keeps
-- only its finished task links, and a done milestone whose task was reopened
-- stays open in 'monitoring' instead of failing this migration.
--
-- Counts to read after it ran:
--   SELECT count(*) FROM work_milestones;                 -- milestones
--   SELECT stage, count(*) FROM work_cases
--     WHERE id IN (SELECT id FROM work_milestones) GROUP BY stage;  -- epics
--   SELECT count(*) FROM work_milestone_items;            -- old task links
--   SELECT count(*) FROM work_case_items
--     WHERE case_id IN (SELECT id FROM work_milestones);  -- carried task links
--   SELECT count(*) FROM work_case_dependencies
--     WHERE dependent_case_id IN (SELECT id FROM work_milestones);
--   SELECT count(*) FROM work_sprints;                    -- not carried
--   SELECT count(*) FROM work_sprint_items;               -- not carried
WITH source AS (
	SELECT m.*,
		(
			(m.`accountable_owner_type` = 'user' AND EXISTS (
				SELECT 1 FROM `organization_members` om
				WHERE om.`organization_id` = m.`org_id`
					AND om.`user_id` = m.`accountable_owner_id`
					AND om.`status` = 'active'))
			OR (m.`accountable_owner_type` = 'tedi' AND EXISTS (
				SELECT 1 FROM `tedis` t
				WHERE t.`organization_id` = m.`org_id`
					AND t.`id` = m.`accountable_owner_id`
					AND t.`retired_at` IS NULL))
			OR (m.`accountable_owner_type` = 'system'
				AND m.`accountable_owner_id` = 'tedix')
		) AS owner_active
	FROM `work_milestones` m
	WHERE NOT EXISTS (SELECT 1 FROM `work_cases` c WHERE c.`id` = m.`id`)
)
INSERT INTO `work_cases` (
	`id`, `org_id`, `project_id`, `objective_id`, `title`, `description`, `kind`,
	`stage`, `accountable_owner_type`, `accountable_owner_id`, `opened_at`,
	`target_resolution_at`, `proof_ref`, `metadata`, `created_at`, `updated_at`,
	`closed_at`, `version`
)
SELECT
	s.`id`, s.`org_id`, s.`project_id`, NULL,
	substr(s.`title`, 1, 500),
	CASE WHEN s.`status` = 'cancelled' THEN substr(
		'Cancelled milestone, carried over as a closed epic.'
			|| CASE WHEN s.`description` IS NULL OR s.`description` = '' THEN ''
				ELSE char(10) || char(10) || s.`description` END,
		1, 10000)
		ELSE substr(s.`description`, 1, 10000) END,
	'other',
	CASE s.`status`
		WHEN 'active' THEN 'executing'
		WHEN 'done' THEN 'monitoring'
		ELSE 'planning' END,
	CASE WHEN s.owner_active THEN s.`accountable_owner_type` ELSE 'system' END,
	CASE WHEN s.owner_active THEN s.`accountable_owner_id` ELSE 'tedix' END,
	s.`created_at`,
	s.`target_at`,
	nullif(trim(substr(s.`proof_ref`, 1, 2000)), ''),
	json_object('carriedFrom', json_object(
		'kind', 'milestone',
		'status', s.`status`,
		'ownerType', s.`accountable_owner_type`,
		'ownerId', s.`accountable_owner_id`,
		'sortOrder', s.`sort_order`,
		'doneAt', s.`done_at`,
		'cancelledAt', s.`cancelled_at`,
		'openWorkItemIdsLeftOff', json((
			SELECT json_group_array(mi.`work_item_id`)
			FROM `work_milestone_items` mi
			JOIN `work_items` wi
				ON wi.`org_id` = mi.`org_id` AND wi.`id` = mi.`work_item_id`
			WHERE s.`status` = 'cancelled'
				AND mi.`org_id` = s.`org_id` AND mi.`milestone_id` = s.`id`
				AND wi.`disposition` NOT IN ('completed', 'cancelled')
		))
	)),
	s.`created_at`, s.`updated_at`, NULL, 1
FROM source s;--> statement-breakpoint

-- Task links. Epics that are already closed accept no new links.
INSERT INTO `work_case_items` (
	`id`, `org_id`, `case_id`, `work_item_id`, `rationale`, `discovered_at`
)
SELECT
	lower(
		hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4'
			|| substr(hex(randomblob(2)), 2) || '-'
			|| substr('89ab', 1 + (abs(random()) % 4), 1)
			|| substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
	),
	mi.`org_id`, mi.`milestone_id`, mi.`work_item_id`, NULL, mi.`created_at`
FROM `work_milestone_items` mi
JOIN `work_milestones` m
	ON m.`org_id` = mi.`org_id` AND m.`id` = mi.`milestone_id`
JOIN `work_cases` c
	ON c.`org_id` = mi.`org_id` AND c.`id` = mi.`milestone_id`
		AND c.`stage` <> 'closed'
JOIN `work_items` wi
	ON wi.`org_id` = mi.`org_id` AND wi.`id` = mi.`work_item_id`
WHERE (m.`status` <> 'cancelled'
		OR wi.`disposition` IN ('completed', 'cancelled'))
	AND NOT EXISTS (
		SELECT 1 FROM `work_case_items` ci
		WHERE ci.`org_id` = mi.`org_id` AND ci.`case_id` = mi.`milestone_id`
			AND ci.`work_item_id` = mi.`work_item_id`
	);--> statement-breakpoint

-- Dependencies between the carried epics.
INSERT INTO `work_case_dependencies` (
	`id`, `org_id`, `prerequisite_case_id`, `dependent_case_id`, `created_at`
)
SELECT
	lower(
		hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4'
			|| substr(hex(randomblob(2)), 2) || '-'
			|| substr('89ab', 1 + (abs(random()) % 4), 1)
			|| substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
	),
	md.`org_id`, md.`prerequisite_milestone_id`, md.`dependent_milestone_id`,
	md.`created_at`
FROM `work_milestone_dependencies` md
JOIN `work_cases` p
	ON p.`org_id` = md.`org_id` AND p.`id` = md.`prerequisite_milestone_id`
		AND p.`stage` <> 'closed'
JOIN `work_cases` d
	ON d.`org_id` = md.`org_id` AND d.`id` = md.`dependent_milestone_id`
		AND d.`stage` <> 'closed'
WHERE md.`prerequisite_milestone_id` <> md.`dependent_milestone_id`
	AND NOT EXISTS (
		SELECT 1 FROM `work_case_dependencies` cd
		WHERE cd.`org_id` = md.`org_id`
			AND cd.`prerequisite_case_id` = md.`prerequisite_milestone_id`
			AND cd.`dependent_case_id` = md.`dependent_milestone_id`
	);--> statement-breakpoint

-- Close the epics of done and cancelled milestones, last, because a closed
-- epic accepts no links. One with unfinished tasks stays open.
UPDATE `work_cases` SET
	`stage` = 'closed',
	`closed_at` = (
		SELECT coalesce(m.`done_at`, m.`cancelled_at`, m.`updated_at`, m.`created_at`)
		FROM `work_milestones` m WHERE m.`id` = `work_cases`.`id`),
	`updated_at` = (
		SELECT coalesce(m.`updated_at`, m.`done_at`, m.`cancelled_at`, m.`created_at`)
		FROM `work_milestones` m WHERE m.`id` = `work_cases`.`id`),
	`version` = `version` + 1
WHERE `stage` <> 'closed'
	AND EXISTS (
		SELECT 1 FROM `work_milestones` m
		WHERE m.`id` = `work_cases`.`id` AND m.`org_id` = `work_cases`.`org_id`
			AND m.`status` IN ('done', 'cancelled'))
	AND NOT EXISTS (
		SELECT 1 FROM `work_case_items` ci
		JOIN `work_items` wi
			ON wi.`org_id` = ci.`org_id` AND wi.`id` = ci.`work_item_id`
		WHERE ci.`org_id` = `work_cases`.`org_id`
			AND ci.`case_id` = `work_cases`.`id`
			AND wi.`disposition` NOT IN ('completed', 'cancelled'));

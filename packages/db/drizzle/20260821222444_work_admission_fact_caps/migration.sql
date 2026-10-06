CREATE TRIGGER `work_admission_fact_cap_insert_guard` BEFORE INSERT ON `work_admissions`
WHEN NEW.`decision` = 'admitted'
BEGIN
	SELECT RAISE(ABORT, 'resource requirement facts exceed admission cap')
	WHERE (
		SELECT COUNT(*)
		FROM `work_resource_requirements` requirement
		WHERE requirement.`org_id` = NEW.`org_id`
			AND requirement.`work_item_id` = NEW.`work_item_id`
	) > 500;

	SELECT RAISE(ABORT, 'budget envelope facts exceed admission cap')
	WHERE (
		SELECT COUNT(*)
		FROM `work_budget_envelopes` envelope
		WHERE envelope.`org_id` = NEW.`org_id`
			AND envelope.`enabled` = 1
			AND (
				(envelope.`scope_type` = 'organization' AND envelope.`scope_id` = NEW.`org_id`)
				OR (envelope.`scope_type` = 'work_item' AND envelope.`scope_id` = NEW.`work_item_id`)
				OR (
					envelope.`scope_type` = 'project'
					AND envelope.`scope_id` = (
						SELECT item.`project_id`
						FROM `work_items` item
						WHERE item.`org_id` = NEW.`org_id`
							AND item.`id` = NEW.`work_item_id`
					)
				)
				OR (
					envelope.`scope_type` = 'case'
					AND EXISTS (
						SELECT 1
						FROM `work_case_items` case_item
						WHERE case_item.`org_id` = NEW.`org_id`
							AND case_item.`work_item_id` = NEW.`work_item_id`
							AND case_item.`case_id` = envelope.`scope_id`
					)
				)
			)
	) > 1000;
END;

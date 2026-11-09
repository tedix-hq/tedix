-- Built-in Doc/Sheet/Slides editor templates were named "<Kind> editor (<id prefix>)".
-- Drop the id suffix where the plain name is still free in that organization.
UPDATE `os_blueprints`
SET `name` = substr(`name`, 1, length(`name`) - 11)
WHERE `name` IN (
		'Doc editor (' || substr(`id`, 1, 8) || ')',
		'Sheet editor (' || substr(`id`, 1, 8) || ')',
		'Slides editor (' || substr(`id`, 1, 8) || ')'
	)
	AND NOT EXISTS (
		SELECT 1 FROM `os_blueprints` AS `taken`
		WHERE `taken`.`organization_id` = `os_blueprints`.`organization_id`
			AND `taken`.`name` = substr(`os_blueprints`.`name`, 1, length(`os_blueprints`.`name`) - 11)
	);

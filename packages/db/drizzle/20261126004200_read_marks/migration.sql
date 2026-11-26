CREATE TABLE `read_marks` (
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`row_id` text NOT NULL,
	`last_read_on` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `read_marks_pk` PRIMARY KEY(`organization_id`, `kind`, `row_id`),
	CONSTRAINT `fk_read_marks_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_read_marks_strings" CHECK(length("row_id") BETWEEN 1 AND 128
				AND length("last_read_on") = 10
				AND length("updated_at") BETWEEN 1 AND 64)
);

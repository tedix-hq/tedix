UPDATE `tedis`
SET `channels` = json_remove(`channels`, '$.discord', '$.slack')
WHERE json_type(`channels`, '$.discord') IS NOT NULL
   OR json_type(`channels`, '$.slack') IS NOT NULL;
--> statement-breakpoint
DELETE FROM `tedi_secrets`
WHERE `name` IN ('DISCORD_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN');

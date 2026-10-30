ALTER TABLE `tenant_tool_policy_mount_revisions` ADD `subject_key` text;
--> statement-breakpoint
UPDATE `tenant_tool_policy_mount_revisions`
SET `subject_key` = (
  SELECT CASE
    WHEN json_extract(p.mount_descriptor, '$.kind') = 'profile'
      AND json_type(p.mount_descriptor, '$.actorUserId') = 'text'
      AND length(json_extract(p.mount_descriptor, '$.actorUserId')) > 0
      THEN json_array('user', json_extract(p.mount_descriptor, '$.actorUserId'))
    WHEN json_extract(p.mount_descriptor, '$.kind') IN ('machine', 'native_rpc')
      AND json_extract(p.mount_descriptor, '$.subject.scope') = 'principal'
      AND json_type(p.mount_descriptor, '$.subject.principalId') = 'text'
      AND length(json_extract(p.mount_descriptor, '$.subject.principalId')) > 0
      AND json_type(p.mount_descriptor, '$.subject.mcpServerId') = 'text'
      AND length(json_extract(p.mount_descriptor, '$.subject.mcpServerId')) > 0
      THEN json_array('machine-principal', json_extract(p.mount_descriptor, '$.subject.principalId'), json_extract(p.mount_descriptor, '$.subject.mcpServerId'))
    WHEN json_extract(p.mount_descriptor, '$.kind') IN ('machine', 'native_rpc')
      AND json_extract(p.mount_descriptor, '$.subject.scope') = 'session'
      AND json_type(p.mount_descriptor, '$.subject.principalId') = 'text'
      AND length(json_extract(p.mount_descriptor, '$.subject.principalId')) > 0
      AND json_type(p.mount_descriptor, '$.subject.mcpServerId') = 'text'
      AND length(json_extract(p.mount_descriptor, '$.subject.mcpServerId')) > 0
      AND json_type(p.mount_descriptor, '$.subject.sessionId') = 'text'
      AND length(json_extract(p.mount_descriptor, '$.subject.sessionId')) > 0
      AND json_type(p.mount_descriptor, '$.subject.clientRecordId') = 'text'
      AND length(json_extract(p.mount_descriptor, '$.subject.clientRecordId')) > 0
      THEN json_array('machine-session', json_extract(p.mount_descriptor, '$.subject.principalId'), json_extract(p.mount_descriptor, '$.subject.mcpServerId'), json_extract(p.mount_descriptor, '$.subject.sessionId'), json_extract(p.mount_descriptor, '$.subject.clientRecordId'))
    ELSE NULL END
  FROM tenant_tool_policies AS p
  WHERE p.id = tenant_tool_policy_mount_revisions.policy_id
    AND p.organization_id = tenant_tool_policy_mount_revisions.organization_id
    AND json_valid(p.mount_descriptor)
);

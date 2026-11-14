-- Unknown rows receive a conservative class, never a name-derived bounded write.
-- Keep every row and unrelated metadata; reviewed declarations remain unchanged.
UPDATE app_tools
SET write_capability = CASE
    WHEN json_extract(annotations, '$.destructiveHint') = 1 THEN 'destructive'
    WHEN tool_type_id = 'prompt' THEN 'read'
    WHEN json_extract(annotations, '$.readOnlyHint') = 1 THEN 'read'
    ELSE 'write'
END
WHERE write_capability IS NULL;
--> statement-breakpoint
UPDATE app_tools
SET meta = json_set(
    json_set(coalesce(meta, '{}'), '$."com.tedix/policy"',
        json(CASE WHEN json_type(meta, '$."com.tedix/policy"') = 'object'
            THEN json_extract(meta, '$."com.tedix/policy"') ELSE '{}' END)),
    '$."com.tedix/policy".riskTier', 'high_impact_write',
    '$."com.tedix/policy".blastRadius', 'multi_tenant',
    '$."com.tedix/policy".declared', json('true')
)
WHERE write_capability <> 'read'
AND (
    coalesce(json_extract(meta, '$."com.tedix/policy".declared'), 0) <> 1
    OR json_extract(meta, '$."com.tedix/policy".riskTier') IS NULL
    OR json_extract(meta, '$."com.tedix/policy".riskTier') NOT IN ('bounded_write', 'high_impact_write', 'external_side_effect')
    OR CASE json_extract(meta, '$."com.tedix/policy".riskTier')
        WHEN 'bounded_write' THEN coalesce(json_extract(meta, '$."com.tedix/policy".blastRadius'), '') NOT IN ('single_resource', 'tenant')
        WHEN 'high_impact_write' THEN coalesce(json_extract(meta, '$."com.tedix/policy".blastRadius'), '') NOT IN ('single_resource', 'tenant', 'multi_tenant')
        WHEN 'external_side_effect' THEN coalesce(json_extract(meta, '$."com.tedix/policy".blastRadius'), '') <> 'external_system'
        ELSE 1 END
    OR (write_capability = 'destructive' AND json_extract(meta, '$."com.tedix/policy".riskTier') = 'bounded_write')
);

PRAGMA index_list(audit_events);
EXPLAIN QUERY PLAN SELECT action, resource_id, timestamp FROM audit_events
 WHERE json_extract(metadata, '$.traceId') = 'lookup-probe' AND action LIKE 'mcp.%'
 ORDER BY timestamp;
EXPLAIN QUERY PLAN SELECT action, actor_id, timestamp FROM audit_events
 WHERE json_extract(metadata, '$.executionId') = 'lookup-probe'
 AND action IN ('mcp.code.execute', 'mcp.code.error', 'mcp.tool.execute', 'mcp.tool.error')
 ORDER BY timestamp;
EXPLAIN QUERY PLAN SELECT action, resource_id, timestamp FROM audit_events
 WHERE organization_id = 'lookup-probe' AND json_extract(metadata, '$.appId') = 'lookup-probe'
 ORDER BY timestamp DESC LIMIT 1;
EXPLAIN QUERY PLAN SELECT action, resource_id, timestamp FROM audit_events
 WHERE organization_id = 'lookup-probe' AND actor_id = 'lookup-probe' AND action LIKE 'mcp.%'
 ORDER BY timestamp DESC LIMIT 50;
SELECT name, applied_at FROM tedix_logs_migrations ORDER BY id;
SELECT name, count(*) AS copies FROM tedix_logs_migrations GROUP BY name HAVING count(*) <> 1;
SELECT name FROM sqlite_master WHERE name IN ('audit_events_v2', 'audit_events_pre_lookup', 'audit_events_rebuild', 'audit_events_cleanup_guard') OR name LIKE 'audit_events_rebuild_%';

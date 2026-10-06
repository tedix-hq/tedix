UPDATE tedi_runtime_events AS terminal
SET payload = json_set(terminal.payload, '$.stopReason', 'step_ceiling')
WHERE terminal.kind = 'run.completed'
	AND json_valid(terminal.payload)
	AND json_extract(terminal.payload, '$.stopReason') IS NULL
	AND EXISTS (
		SELECT 1 FROM tedi_runtime_events AS marker
		WHERE marker.tedi_id = terminal.tedi_id
			AND marker.run_id = terminal.run_id
			AND marker.kind = 'message.completed'
			AND (json_extract(marker.payload, '$.role') IS NULL OR json_extract(marker.payload, '$.role') = 'assistant')
			AND instr(COALESCE(json_extract(marker.payload, '$.content'), json_extract(marker.payload, '$.text'), ''), '[Turn stopped early:') > 0
			AND instr(COALESCE(json_extract(marker.payload, '$.content'), json_extract(marker.payload, '$.text'), ''), 'provider-call ceiling reached') > 0
	);
--> statement-breakpoint
UPDATE kernel_runtime_runs
SET metadata = json_set(metadata, '$.childRunStatus', 'partial', '$.childRunStopReason', 'step_ceiling')
WHERE json_valid(metadata)
	AND json_extract(metadata, '$.childRunStopReason') IS NULL
	AND instr(COALESCE(json_extract(metadata, '$.childRunPreview'), preview, ''), '[Turn stopped early:') > 0
	AND instr(COALESCE(json_extract(metadata, '$.childRunPreview'), preview, ''), 'provider-call ceiling reached') > 0;

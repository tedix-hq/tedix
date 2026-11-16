CREATE TABLE audit_metadata_refs (
	organization_id text NOT NULL,
	ref text NOT NULL,
	kind text NOT NULL,
	value text NOT NULL,
	PRIMARY KEY (organization_id, ref)
);
CREATE UNIQUE INDEX audit_metadata_refs_org_kind_value_idx ON audit_metadata_refs (organization_id,kind,value);
CREATE INDEX idx_audit_events_org_app_ref_timestamp ON audit_events (organization_id,json_extract(metadata, '$._r.a'),timestamp);

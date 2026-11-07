CREATE TABLE memory_entries (
  scope text NOT NULL, key text NOT NULL, revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (scope, key)
);
CREATE TABLE memory_revisions (
  scope text NOT NULL, revision_id text NOT NULL, key text NOT NULL, revision integer NOT NULL CHECK (revision > 0), body jsonb NOT NULL,
  PRIMARY KEY (scope, revision_id), UNIQUE (scope, key, revision),
  FOREIGN KEY (scope, key) REFERENCES memory_entries(scope, key)
);
CREATE TABLE change_records (
  scope text NOT NULL, id text NOT NULL, sequence bigint NOT NULL, recorded_at text NOT NULL,
  resource text NOT NULL, actor_id text NOT NULL, body jsonb NOT NULL, PRIMARY KEY (scope, sequence), UNIQUE (scope, id)
);
CREATE INDEX ON change_records(scope, resource, sequence);
CREATE INDEX ON change_records(scope, actor_id, sequence);
CREATE TABLE compliance_decisions (
  scope text NOT NULL, id text PRIMARY KEY, recorded_at text NOT NULL, call jsonb NOT NULL, decision jsonb NOT NULL, outcome jsonb NOT NULL
);
CREATE TABLE compliance_rate_windows (
  scope text NOT NULL, key text NOT NULL, calls bigint[] NOT NULL, PRIMARY KEY (scope, key)
);

CREATE TABLE change_record_heads (scope text PRIMARY KEY, sequence bigint NOT NULL);

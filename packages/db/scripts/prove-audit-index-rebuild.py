"""Offline disk-backed 2M-row rehearsal. Prints JSON; deletes its fixture on exit.

Run: python3 packages/db/scripts/prove-audit-index-rebuild.py
No provider credentials or network access are used.
"""
import json
from pathlib import Path
import sqlite3
import tempfile
import time

MIGRATIONS = Path(__file__).resolve().parent.parent / "logs-db/migrations"
OPERATIONS = MIGRATIONS.parent / "operations"


def statements(sql):
    pending = ""
    for line in sql.splitlines(True):
        pending += line
        if sqlite3.complete_statement(pending):
            yield pending
            pending = ""
    assert not pending.strip(), pending


def migration(db, name):
    timings = []
    start = time.perf_counter()
    db.execute("BEGIN")
    try:
        for sql in statements((MIGRATIONS / name).read_text()):
            tick = time.perf_counter()
            db.execute(sql)
            timings.append({"sql": sql.strip(), "seconds": time.perf_counter() - tick})
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"seconds": time.perf_counter() - start, "statements": timings}


def run():
    with tempfile.TemporaryDirectory(prefix="audit-index-proof-") as tmp:
        db = sqlite3.connect(str(Path(tmp) / "fixture.sqlite"), isolation_level=None)
        # Default durable DELETE journal; no in-memory or synchronous-off shortcut.
        migration(db, "0001_logs_schema.sql")
        db.execute("BEGIN")
        for offset in range(0, 2_000_000, 10_000):
            db.execute("""WITH RECURSIVE n(i) AS (SELECT ? + 1 UNION ALL SELECT i + 1 FROM n WHERE i < ? + 10000)
            INSERT INTO audit_events SELECT
             printf('event-%08d',i), printf('org-%d',i%20), printf('actor-%d',i%100),
             'external_agent','mcp.tool.execute','tool',printf('tool-%d',i%500),
             json_object('traceId',printf('trace-%d',i%100000),'executionId',printf('exec-%d',i%200000),
              'appId',printf('app-%d',i%200),'padding',printf('%0700d',i)),
             NULL,NULL,1800000000+i FROM n""", (offset, offset))
        db.commit()
        migration(db, "0002_log_partition.sql")
        migration(db, "0003_runtime_events_global_kind_index.sql")
        # Production ledger records 0004/0005 with all four indexes absent.
        migration(db, "0005_drop_audit_events_metadata_indexes.sql")
        before = db.execute("PRAGMA page_count").fetchone()[0] * db.execute("PRAGMA page_size").fetchone()[0]
        setup = migration(db, "0006_audit_events_lookup_indexes.sql")
        try:
            migration(db, "0007_audit_events_lookup_swap.sql")
            raise AssertionError("incomplete swap succeeded")
        except sqlite3.IntegrityError:
            pass
        batches = []
        copy_requests = []
        while db.execute("SELECT cursor < stop FROM audit_events_rebuild").fetchone()[0]:
            request_start = time.perf_counter()
            db.execute("BEGIN")
            for sql in statements((OPERATIONS / "audit-events-copy.sql").read_text()):
                tick = time.perf_counter()
                db.execute(sql)
                batches.append(time.perf_counter() - tick)
            db.commit()
            copy_requests.append(time.perf_counter() - request_start)
            if len(copy_requests) == 1:
                db.execute("INSERT INTO audit_events SELECT 'live-tail',organization_id,actor_id,actor_type,action,resource_type,resource_id,metadata,ip_address,user_agent,timestamp FROM audit_events WHERE id='event-00000001'")
                db.execute("UPDATE audit_events SET actor_id='updated' WHERE id IN ('event-00000002','event-01999999')")
                db.execute("DELETE FROM audit_events WHERE id IN ('event-00000003','event-01999998')")
        # Full bidirectional value equality, not just counts.
        assert db.execute("SELECT * FROM audit_events EXCEPT SELECT * FROM audit_events_v2 LIMIT 1").fetchone() is None
        assert db.execute("SELECT * FROM audit_events_v2 EXCEPT SELECT * FROM audit_events LIMIT 1").fetchone() is None
        peak = db.execute("PRAGMA page_count").fetchone()[0] * db.execute("PRAGMA page_size").fetchone()[0]
        swap = migration(db, "0007_audit_events_lookup_swap.sql")
        assert db.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0] == 1_999_999
        cleanup = []
        cleanup_requests = []
        while db.execute("SELECT 1 FROM audit_events_pre_lookup LIMIT 1").fetchone():
            request_start = time.perf_counter()
            db.execute("BEGIN")
            for sql in statements((OPERATIONS / "audit-events-cleanup.sql").read_text()):
                tick = time.perf_counter()
                db.execute(sql)
                cleanup.append(time.perf_counter() - tick)
            db.commit()
            cleanup_requests.append(time.perf_counter() - request_start)
        finish = migration(db, "0008_audit_events_lookup_cleanup.sql")
        assert db.execute("PRAGMA integrity_check").fetchall() == [('ok',)]
        lookups = {
            "trace": ("json_extract(metadata,'$.traceId')='trace-1' AND action LIKE 'mcp.%'", "trace_timestamp"),
            "execution": ("json_extract(metadata,'$.executionId')='exec-1' AND action IN ('mcp.code.execute','mcp.code.error','mcp.tool.execute','mcp.tool.error')", "execution_timestamp"),
            "app": ("organization_id='org-1' AND json_extract(metadata,'$.appId')='app-1'", "org_app_timestamp"),
            "actor": ("organization_id='org-1' AND actor_id='actor-1' AND action LIKE 'mcp.%'", "org_actor_timestamp"),
        }
        plans = {}
        for name, (where, index) in lookups.items():
            sql = f"SELECT * FROM audit_events WHERE {where} ORDER BY timestamp LIMIT 50"
            details = [row[3] for row in db.execute("EXPLAIN QUERY PLAN " + sql)]
            assert any('idx_audit_events_' + index in d for d in details), details
            plans[name] = {"sql": sql, "plan": details}
        print(json.dumps({"sqlite": sqlite3.sqlite_version, "fixtureRows": 2_000_000,
            "metadataPaddingBytes": 700, "beforeBytes": before, "peakBytes": peak,
            "setup": setup, "copyRequestCount": len(copy_requests), "batchStatementCount": len(batches), "batchMaxSeconds": max(batches),
            "batchMeanSeconds": sum(batches)/len(batches), "copyRequestMaxSeconds": max(copy_requests), "swap": swap,
            "cleanupRequestCount": len(cleanup_requests), "cleanupStatementCount": len(cleanup), "cleanupMaxSeconds": max(cleanup),
            "cleanupRequestMaxSeconds": max(cleanup_requests),
            "finish": finish, "plans": plans, "integrity": "ok", "bidirectionalEquality": True}, indent=2))
        assert max(copy_requests) < 5, max(copy_requests)
        assert max(cleanup_requests) < 5, max(cleanup_requests)
        assert max(cleanup) < 5, max(cleanup)
        assert finish['seconds'] < 5, finish
        assert max(batches) < 5, max(batches)
        assert setup['seconds'] < 5, setup
        assert swap['seconds'] < 5, swap
        db.close()


if __name__ == '__main__':
    run()

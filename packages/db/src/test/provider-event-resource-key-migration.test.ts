import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";

// This fixture is the historical schema that the migration must upgrade.
it("preserves calendar and event resource values through the forward column rename", () => {
	const sql = new DatabaseSync(":memory:");
	try {
		sql.exec(
			"CREATE TABLE provider_event_subscriptions (id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL); INSERT INTO provider_event_subscriptions VALUES ('calendar', 'primary'), ('event', 'incident.created');",
		);
		sql.exec(
			readFileSync(
				new URL(
					"../../drizzle/20261113111521_provider_event_resource_key/migration.sql",
					import.meta.url,
				),
				"utf8",
			),
		);
		expect(
			sql
				.prepare(
					"SELECT id, resource_key FROM provider_event_subscriptions ORDER BY id",
				)
				.all(),
		).toEqual([
			{ id: "calendar", resource_key: "primary" },
			{ id: "event", resource_key: "incident.created" },
		]);
		expect(
			sql
				.prepare("PRAGMA table_info(provider_event_subscriptions)")
				.all()
				.map((c) => c.name),
		).toEqual(["id", "resource_key"]);
	} finally {
		sql.close();
	}
});

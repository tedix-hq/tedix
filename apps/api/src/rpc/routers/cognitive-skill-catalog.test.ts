/**
 * `skills.getForMcp` reads skills as the calling tedi: a tedi loads its own
 * tedi-owned skill without restating its id, and cannot read as another tedi.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { skillEntries, skillSchedules } from "@tedix/db/schema/cognitive";
import { dispatcherHealthReports } from "@tedix/db/schema/dispatcher-health";
import {
	osWorkspaceResources,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { projects } from "@tedix/db/schema/projects";
import { tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { skillsGetForMcp, skillsImprove } from "./cognitive-skill-catalog";

const ORG_ID = "org-fixture";
const CTO_TEDI_ID = "tedi-cto";
const OTHER_TEDI_ID = "tedi-other";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			skillEntries,
			skillSchedules,
			dispatcherHealthReports,
			projects,
			osWorkspaces,
			osWorkspaceResources,
			tedis,
		),
	);
	sqlite
		.prepare(
			"INSERT INTO skill_entries (id,organization_id,tedi_id,slug,title,content,visibility) VALUES (?,?,?,?,?,?,?)",
		)
		.run(
			"skill-1",
			ORG_ID,
			CTO_TEDI_ID,
			"daily-intake",
			"Daily intake",
			"# Daily intake",
			"private",
		);
	const facade = createD1Facade(sqlite);
	const tedi = (tediId: string) =>
		createRouterClient(
			{ getForMcp: skillsGetForMcp, improve: skillsImprove },
			{
				context: {
					db: createDbClient(facade) as BaseContext["db"],
					env: { ENVIRONMENT: "test", DB: facade } as unknown as CloudflareEnv,
					organizationId: ORG_ID,
					url: new URL("https://api.tedix.test/rpc/skills/getForMcp"),
					headers: new Headers({
						"X-Service-Binding": "true",
						"X-Tedix-Tedi-Id": tediId,
						"X-Tedix-Tedi-Scopes": "tedis:read tedis:write",
					}),
				} as BaseContext,
			},
		);
	return { tedi, sqlite };
}

describe("skills.getForMcp", () => {
	it("returns a tedi's own skill when the tedi omits tediId", async () => {
		const { tedi } = fixture();
		const result = await tedi(CTO_TEDI_ID).getForMcp({ slug: "daily-intake" });
		expect(result.entry?.id).toBe("skill-1");
	});

	it("does not expose a tedi's private skill to another tedi", async () => {
		const { tedi } = fixture();
		const result = await tedi(OTHER_TEDI_ID).getForMcp({
			slug: "daily-intake",
		});
		expect(result.entry).toBeNull();
	});

	it("rejects a tedi that asks to read as another tedi", async () => {
		const { tedi } = fixture();
		await expect(
			tedi(OTHER_TEDI_ID).getForMcp({
				slug: "daily-intake",
				tediId: CTO_TEDI_ID,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("skills.improve title-only edits", () => {
	function scheduledFixture(appId: string | null = null) {
		const result = fixture();
		result.sqlite
			.prepare(
				`UPDATE skill_entries SET content = ?, files = ?, tool_ids = ?,
			 mcp_app_bindings = ?, app_id = ?, lifecycle_state = 'proven',
			 folder_path = 'operations/intake', revision = 7,
			 revision_reasoning = 'Previous revision' WHERE id = 'skill-1'`,
			)
			.run(
				"---\nmetadata:\n  io.modelcontextprotocol/tools: [legacy_missing_tool]\ncapabilities:\n  schedule:\n    cron: '0 9 * * *'\n    enabled: true\n    params: { mode: intake }\n---\n# Daily intake",
				JSON.stringify({ "references/intake.md": "Keep these instructions" }),
				JSON.stringify(["existing-tool", "existing-tool"]),
				JSON.stringify({ legacy_namespace: "original-app" }),
				appId,
			);
		result.sqlite
			.prepare(
				`INSERT INTO skill_schedules
			 (id, organization_id, skill_id, tedi_id, cron, params, enabled,
			  next_fire_at, last_fire_at, last_run_id, last_error,
			  last_budget_blocked_at, last_budget_blocked_reason, last_budget_reset_at,
			  last_budget_admission_class, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"schedule-1",
				ORG_ID,
				"skill-1",
				CTO_TEDI_ID,
				"0 9 * * *",
				'{"mode":"intake"}',
				"2000-01-01T09:00:00.000Z",
				"1999-12-31T09:00:00.000Z",
				"previous-run",
				"previous error",
				"2000-01-01T09:01:00.000Z",
				"budget exhausted",
				"2000-01-02T00:00:00.000Z",
				"background",
				"1999-12-01T00:00:00.000Z",
				"2000-01-01T09:02:00.000Z",
			);
		return result;
	}

	it.each([null, "original-app"])(
		"preserves the whole overdue schedule and stored bindings with app scope %s",
		async (appId) => {
			const { tedi, sqlite } = scheduledFixture(appId);
			const before = sqlite.prepare("SELECT * FROM skill_entries").get()!;
			const schedule = sqlite.prepare("SELECT * FROM skill_schedules").get();
			const result = await tedi(CTO_TEDI_ID).improve({
				id: "skill-1",
				title: "Intake review",
				revisionReasoning: "Clarify title",
			});
			expect(result.entry.title).toBe("Intake review");
			const after = sqlite.prepare("SELECT * FROM skill_entries").get()!;
			expect(after).toEqual({
				...before,
				title: "Intake review",
				revision: 8,
				revision_reasoning: "Clarify title",
				updated_at: after.updated_at,
			});
			expect(sqlite.prepare("SELECT * FROM skill_schedules").get()).toEqual(
				schedule,
			);
		},
	);

	it("preserves revision reasoning when omitted and does not create a timer", async () => {
		const { tedi, sqlite } = fixture();
		sqlite.exec(
			"UPDATE skill_entries SET revision_reasoning = 'Keep audit' WHERE id = 'skill-1'",
		);
		const result = await tedi(CTO_TEDI_ID).improve({
			id: "skill-1",
			title: "New intake title",
		});
		expect(result.entry.revisionReasoning).toBe("Keep audit");
		expect(sqlite.prepare("SELECT * FROM skill_schedules").all()).toEqual([]);
	});

	it("still rejects substantive content and tool edits without writing either row", async () => {
		const { tedi, sqlite } = scheduledFixture();
		const before = sqlite.prepare("SELECT * FROM skill_entries").get();
		const schedule = sqlite.prepare("SELECT * FROM skill_schedules").get();
		await expect(
			tedi(CTO_TEDI_ID).improve({
				id: "skill-1",
				title: "New title",
				content: "",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			tedi(CTO_TEDI_ID).improve({
				id: "skill-1",
				title: "New title",
				toolSlugs: ["missing_tool"],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(sqlite.prepare("SELECT * FROM skill_entries").get()).toEqual(before);
		expect(sqlite.prepare("SELECT * FROM skill_schedules").get()).toEqual(
			schedule,
		);
	});
});

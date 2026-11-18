import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { decisionSourcesCurrent } from "./decision-sources";

it.each([
	[
		"00000000-0000-4000-8000-000000000001",
		"00000000-0000-4000-8000-000000000006",
		true,
	],
	[
		"00000000-0000-4000-8000-000000000001",
		"00000000-0000-4000-8000-000000000007",
		false,
	],
	[
		"00000000-0000-4000-8000-000000000002",
		"00000000-0000-4000-8000-000000000008",
		false,
	],
	[
		"00000000-0000-4000-8000-000000000003",
		"00000000-0000-4000-8000-000000000009",
		false,
	],
	[
		"00000000-0000-4000-8000-000000000004",
		"00000000-0000-4000-8000-000000000010",
		false,
	],
	[
		"00000000-0000-4000-8000-000000000005",
		"00000000-0000-4000-8000-000000000011",
		false,
	],
] as const)(
	"checks indexed output %s pinned to %s",
	async (id, revisionId, expected) => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
	CREATE TABLE workspace_output_index(output_id TEXT, organization_id TEXT, revision_id TEXT, status TEXT, is_current INTEGER);
	INSERT INTO workspace_output_index VALUES
	('00000000-0000-4000-8000-000000000001','org','00000000-0000-4000-8000-000000000007','active',0),
	('00000000-0000-4000-8000-000000000001','org','00000000-0000-4000-8000-000000000006','active',1),
	('00000000-0000-4000-8000-000000000002','org','00000000-0000-4000-8000-000000000008','archived',1),
	('00000000-0000-4000-8000-000000000003','org','00000000-0000-4000-8000-000000000009','active',0),
	('00000000-0000-4000-8000-000000000004','other','00000000-0000-4000-8000-000000000010','active',1);
	`);
		expect(
			await decisionSourcesCurrent(
				createDbQueryClient(createD1Facade(sqlite)),
				"org",
				{
					status: "open",
					kind: "question",
					targetType: "user",
					subject: "Review plan",
					prompt: "Is the plan ready?",
					metadata: { decisionSources: [{ kind: "output", id, revisionId }] },
				},
			),
		).toBe(expected);
		sqlite.close();
	},
);

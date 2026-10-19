import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { workInteractions } from "../../schema/work-factory";
import { tedis } from "../../schema/tedis";
import { createD1Facade } from "../../test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "../../test/schema-ddl";
import {
	supersedeSupportDraftInteractions,
	sweepSupersededSupportDraftInteractions,
} from "./interactions";

it("expires only older open drafts for the same ticket, organization and recipient, retaining an audit trail", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(`${canonicalWorkFactoryDdl()}\n${schemaDdl(workInteractions)}`);
		for (const org of ["org", "other-org"])
			sqlite
				.prepare("INSERT INTO organizations(id,name,slug) VALUES (?,?,?)")
				.run(org, org, org);
		const insert = sqlite.prepare(`INSERT INTO work_interactions
			(id,org_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,status,metadata)
			VALUES (?,?,'question','Draft','Original source reply','user','author','user',?,'2026-01-01T00:00:00.000Z',?,?)`);
		for (const [id, org, target, ticket, version, status, source] of [
			["older", "org", "robin", "ticket", 1, "open", "support-draft"],
			["latest", "org", "robin", "ticket", 3, "open", "support-draft"],
			["stale-retry", "org", "robin", "ticket", 2, "open", "support-draft"],
			["answered", "org", "robin", "ticket", 1, "resolved", "support-draft"],
			["other-ticket", "org", "robin", "elsewhere", 1, "open", "support-draft"],
			["other-user", "org", "sam", "ticket", 1, "open", "support-draft"],
			["other-org", "other-org", "robin", "ticket", 1, "open", "support-draft"],
			["other-source", "org", "robin", "ticket", 1, "open", "manual"],
		] as const)
			insert.run(
				id,
				org,
				target,
				status,
				JSON.stringify({
					source,
					supportTicketId: ticket,
					supportVersion: version,
					retained: "evidence",
				}),
			);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const input = {
			orgId: "org",
			targetId: "robin",
			ticketId: "ticket",
			now: "2026-10-19T12:00:00.000Z",
		};
		expect(
			(await supersedeSupportDraftInteractions(db, input))
				.map((row) => row.id)
				.sort(),
		).toEqual(["older", "stale-retry"]);
		expect(await supersedeSupportDraftInteractions(db, input)).toEqual([]);
		for (const id of ["older", "stale-retry"]) {
			const row = sqlite
				.prepare(
					"SELECT status,version,prompt,metadata FROM work_interactions WHERE id=?",
				)
				.get(id)!;
			expect(row).toMatchObject({
				status: "expired",
				version: 2,
				prompt: "Original source reply",
			});
			expect(JSON.parse(String(row.metadata))).toMatchObject({
				retained: "evidence",
				supersession: {
					reason: "newer_support_draft",
					supersededBy: "latest",
					at: input.now,
				},
			});
		}
		expect(
			sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM work_interactions WHERE status='open'",
				)
				.get()?.count,
		).toBe(5);
	} finally {
		sqlite.close();
	}
});

function supportFixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		`${canonicalWorkFactoryDdl()}\n${schemaDdl(workInteractions, tedis)}`,
	);
	for (const org of ["org", "elsewhere"])
		sqlite
			.prepare("INSERT INTO organizations(id,name,slug) VALUES (?,?,?)")
			.run(org, org, org);
	const insert = (
		id: string,
		metadata: Record<string, unknown>,
		scope: {
			org?: string;
			target?: string;
			status?: string;
			project?: string;
		} = {},
	) => {
		sqlite
			.prepare(`INSERT INTO work_interactions(id,org_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,status,metadata,project_id)
		VALUES (?,?,'question','Draft','Retained source reply','user','author','user',?,'2026-01-01T00:00:00.000Z',?,?,?)`)
			.run(
				id,
				scope.org ?? "org",
				scope.target ?? "robin",
				scope.status ?? "open",
				JSON.stringify(metadata),
				scope.project ?? null,
			);
	};
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)), insert };
}
const canonical = (ticket: string, version: number) => ({
	source: "support-draft",
	supportTicketId: ticket,
	supportVersion: version,
});
const adapter = (ticket: string, version: number) => ({
	source: "night-source-adapter",
	originalSource: "support-work-draft",
	sourceKey: `support-draft:${ticket}:${version}`,
	supportTicketId: ticket,
	supportVersion: version,
	decisionDeck: { classId: "support.reply", kind: "outbound" },
});
const sweepInput = {
	orgId: "org",
	targetId: "robin",
	now: "2026-10-19T12:00:00.000Z",
	limit: 50,
};

it("only accepts exact older adapter representations and never promotes an adapter to canonical winner", async () => {
	const { sqlite, db, insert } = supportFixture();
	try {
		insert("latest", canonical("ticket", 3));
		insert("older", canonical("ticket", 1));
		insert("adapter-old", adapter("ticket", 2));
		insert("adapter-same", adapter("ticket", 3));
		insert("adapter-newer", adapter("ticket", 4));
		insert("wrong-source", {
			...adapter("ticket", 2),
			originalSource: "other-work",
		});
		insert("wrong-key", {
			...adapter("ticket", 2),
			sourceKey: "support-draft:other:2",
		});
		insert("wrong-class", {
			...adapter("ticket", 2),
			decisionDeck: { classId: "customer.reply", kind: "outbound" },
		});
		insert("wrong-kind", {
			...adapter("ticket", 2),
			decisionDeck: { classId: "support.reply", kind: "question" },
		});
		insert("wrong-version-type", {
			...adapter("ticket", 2),
			supportVersion: "2",
		});
		insert("other-ticket", adapter("other", 2));
		insert("other-org", adapter("ticket", 2), { org: "elsewhere" });
		insert("other-user", adapter("ticket", 2), { target: "sam" });
		insert("answered", adapter("ticket", 2), { status: "resolved" });
		expect(
			(
				await supersedeSupportDraftInteractions(db, {
					...sweepInput,
					ticketId: "ticket",
				})
			)
				.map((row) => row.id)
				.sort(),
		).toEqual(["adapter-old", "older"]);
		for (const id of ["adapter-old", "older"]) {
			const row = sqlite
				.prepare(
					"SELECT prompt,metadata,status FROM work_interactions WHERE id=?",
				)
				.get(id)!;
			expect(row).toMatchObject({
				prompt: "Retained source reply",
				status: "expired",
			});
			expect(JSON.parse(String(row.metadata)).supersession).toMatchObject({
				supersededBy: "latest",
				reason: "newer_support_draft",
				at: sweepInput.now,
			});
		}
		expect(
			sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM work_interactions WHERE status='open'",
				)
				.get()?.count,
		).toBe(11);
		expect(
			await sweepSupersededSupportDraftInteractions(db, sweepInput),
		).toEqual({ superseded: 0, scanned: 0, hasMore: false });
	} finally {
		sqlite.close();
	}
});

it("bounds eligible candidates and makes progress past already-clean tickets", async () => {
	const { sqlite, db, insert } = supportFixture();
	try {
		insert("00-clean", canonical("clean", 3));
		for (const ticket of ["a", "b", "c"]) {
			insert(`${ticket}-old`, adapter(ticket, 1));
			insert(`${ticket}-new`, canonical(ticket, 3));
		}
		expect(
			await sweepSupersededSupportDraftInteractions(db, {
				...sweepInput,
				limit: 2,
			}),
		).toEqual({ superseded: 2, scanned: 2, hasMore: true });
		expect(
			await sweepSupersededSupportDraftInteractions(db, {
				...sweepInput,
				limit: 2,
			}),
		).toEqual({ superseded: 1, scanned: 1, hasMore: false });
		expect(
			await sweepSupersededSupportDraftInteractions(db, {
				...sweepInput,
				limit: 2,
			}),
		).toEqual({ superseded: 0, scanned: 0, hasMore: false });
		expect(
			sqlite.prepare("SELECT COUNT(*) AS count FROM work_interactions").get()
				?.count,
		).toBe(7);
	} finally {
		sqlite.close();
	}
});

it("keeps a project refresh inside that recipient's requested project", async () => {
	const { sqlite, db, insert } = supportFixture();
	try {
		for (const project of ["a", "b"])
			sqlite
				.prepare(
					"INSERT INTO projects(id,org_id,key,name,created_at) VALUES (?,'org',?,?,?)",
				)
				.run(project, project, project, sweepInput.now);
		insert("latest", canonical("ticket", 3));
		insert("project-a", adapter("ticket", 1), { project: "a" });
		insert("project-b", adapter("ticket", 1), { project: "b" });
		sqlite
			.prepare(
				"INSERT INTO work_items(id,org_id,project_id,title,created_at) VALUES ('work-a','org','a','Support',?)",
			)
			.run(sweepInput.now);
		insert("inherited-project", adapter("ticket", 1));
		sqlite
			.prepare(
				"UPDATE work_interactions SET work_item_id='work-a' WHERE id='inherited-project'",
			)
			.run();
		expect(
			await sweepSupersededSupportDraftInteractions(db, {
				...sweepInput,
				projectId: "a",
			}),
		).toEqual({ superseded: 2, scanned: 2, hasMore: false });
		expect(
			sqlite
				.prepare("SELECT status FROM work_interactions WHERE id='project-b'")
				.get()?.status,
		).toBe("open");
	} finally {
		sqlite.close();
	}
});

it("does not overwrite an answer that wins the race between selection and the expiry batch", async () => {
	const { sqlite, insert } = supportFixture();
	try {
		insert("old", adapter("ticket", 1));
		insert("latest", canonical("ticket", 3));
		const facade = createD1Facade(sqlite);
		const db = createDbQueryClient(
			new Proxy(facade, {
				get(target, key, receiver) {
					if (key === "batch")
						return async (statements: D1PreparedStatement[]) => {
							sqlite
								.prepare(
									"UPDATE work_interactions SET status='resolved',version=2 WHERE id='old'",
								)
								.run();
							return target.batch(statements);
						};
					return Reflect.get(target, key, receiver);
				},
			}),
		);
		expect(
			await sweepSupersededSupportDraftInteractions(db, sweepInput),
		).toEqual({ superseded: 0, scanned: 1, hasMore: false });
		const row = sqlite
			.prepare("SELECT status,metadata FROM work_interactions WHERE id='old'")
			.get()!;
		expect(row.status).toBe("resolved");
		expect(JSON.parse(String(row.metadata)).supersession).toBeUndefined();
	} finally {
		sqlite.close();
	}
});

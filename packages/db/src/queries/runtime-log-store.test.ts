/**
 * Merged reads across the main database and the logs database for the
 * runtime event and artifact tables, which the retention job's
 * `move_to_logs_db` mode spreads across both stores.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { configureLogStore, createDbClient } from "../client";
import { skillRunArtifacts } from "../schema/cognitive";
import {
	kernelRuntimeEvents,
	tediRuntimeEvents,
} from "../schema/cognitive-runtime";
import { logPartition } from "../schema/logs-db";
import { createD1Facade } from "../test/d1-facade";
import { tableDdl } from "../test/schema-ddl";
import {
	getTediRuntimeEventById,
	listTediConversationTranscriptRows,
	listTediRuntimeEventsForRouter,
} from "./cognitive-runtime";
import {
	getKernelRuntimeEventById,
	listKernelRuntimeEvents,
	listTediRuntimeEvents,
} from "./kernel-runtime-events";
import {
	getRunArtifact,
	listRunArtifacts,
	listRunArtifactsPage,
} from "./skill-run-artifacts";

const ORG = "org-fictional-lighthouse";
const TEDI = "tedi-ada";

function store() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		[tediRuntimeEvents, kernelRuntimeEvents, skillRunArtifacts, logPartition]
			.flatMap((table) => tableDdl(table, { foreignKeys: false }))
			.join("\n"),
	);
	const binding = createD1Facade(sqlite);
	const insertTedi = sqlite.prepare(
		"INSERT INTO tedi_runtime_events(id, organization_id, tedi_id, kind, conversation_id, run_id, runtime_backend, payload, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
	);
	const insertKernel = sqlite.prepare(
		"INSERT INTO kernel_runtime_events(id, organization_id, kind, conversation_id, run_id, runtime_backend, payload, created_at) VALUES(?,?,?,?,?,?,?,?)",
	);
	const insertArtifact = sqlite.prepare(
		"INSERT INTO skill_run_artifacts(id, run_id, path, created_at) VALUES(?,?,?,?)",
	);
	return {
		binding,
		db: createDbClient(binding),
		tedi: (id: string, at: string, kind = "message.completed") =>
			insertTedi.run(
				id,
				ORG,
				TEDI,
				kind,
				"conv-1",
				"run-1",
				"custom",
				JSON.stringify({ id }),
				at,
			),
		kernel: (id: string, at: string) =>
			insertKernel.run(
				id,
				ORG,
				"message.completed",
				"conv-1",
				"run-1",
				"custom",
				JSON.stringify({ id }),
				at,
			),
		artifact: (id: string, path: string, at: string) =>
			insertArtifact.run(id, "run-1", path, at),
	};
}

/** Older rows in the logs store, newer rows in the main store, one overlap. */
function split() {
	const main = store();
	const logs = store();
	logs.tedi("e1", "2026-09-01T00:00:00.000Z");
	logs.tedi("e2", "2026-09-02T00:00:00.000Z");
	logs.tedi("e3", "2026-09-03T00:00:00.000Z"); // mid-move: in both stores
	main.tedi("e3", "2026-09-03T00:00:00.000Z");
	main.tedi("e4", "2026-10-01T00:00:00.000Z");
	main.tedi("e5", "2026-10-02T00:00:00.000Z");
	logs.kernel("k1", "2026-09-01T00:00:00.000Z");
	logs.kernel("k2", "2026-09-02T00:00:00.000Z");
	main.kernel("k3", "2026-10-01T00:00:00.000Z");
	logs.artifact("a1", "old.json", "2026-09-01T00:00:00.000Z");
	main.artifact("a2", "new.json", "2026-10-01T00:00:00.000Z");
	configureLogStore(main.db, { LOGS_DB: logs.binding });
	return { main, logs };
}

describe("merged runtime event reads", () => {
	it("orders, offsets and limits across both stores without duplicates", async () => {
		const { main } = split();
		const all = await listTediRuntimeEvents(main.db, {
			organizationId: ORG,
			tediId: TEDI,
			order: "asc",
		});
		expect(all.map((row) => row.id)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
		const page = await listTediRuntimeEvents(main.db, {
			organizationId: ORG,
			tediId: TEDI,
			order: "desc",
			limit: 2,
			offset: 1,
		});
		expect(page.map((row) => row.id)).toEqual(["e4", "e3"]);
		const kernel = await listKernelRuntimeEvents(main.db, {
			organizationId: ORG,
			conversationId: "conv-1",
			order: "asc",
			limit: 2,
			offset: 1,
		});
		expect(kernel.map((row) => row.id)).toEqual(["k2", "k3"]);
	});

	it("applies the same cursor in both stores", async () => {
		const { main } = split();
		const before = await listTediRuntimeEventsForRouter(main.db, {
			tediId: TEDI,
			runId: "run-1",
			order: "desc",
			limit: 2,
			before: { createdAt: "2026-10-01T00:00:00.000Z", id: "e4" },
		});
		expect(before.map((row) => row.id)).toEqual(["e3", "e2"]);
		const transcript = await listTediConversationTranscriptRows(main.db, {
			tediId: TEDI,
			conversationId: "conv-1",
			before: "2026-09-03T00:00:00.000Z",
			limit: 5,
		});
		expect(transcript.map((row) => row.id)).toEqual(["e2", "e1"]);
	});

	it("finds a single row in whichever store holds it", async () => {
		const { main } = split();
		expect((await getTediRuntimeEventById(main.db, "e1"))?.id).toBe("e1");
		expect((await getTediRuntimeEventById(main.db, "e5"))?.id).toBe("e5");
		expect(await getTediRuntimeEventById(main.db, "missing")).toBeNull();
		expect((await getKernelRuntimeEventById(main.db, "k1"))?.id).toBe("k1");
		expect(await getKernelRuntimeEventById(main.db, "missing")).toBeUndefined();
	});

	it("lists a run's artifacts from both stores", async () => {
		const { main } = split();
		expect(
			(await listRunArtifacts(main.db, "run-1")).map((row) => row.path),
		).toEqual(["old.json", "new.json"]);
		expect(
			(
				await listRunArtifactsPage(main.db, "run-1", { limit: 1, offset: 1 })
			).map((row) => row.path),
		).toEqual(["new.json"]);
		expect((await getRunArtifact(main.db, "run-1", "old.json"))?.id).toBe("a1");
	});

	it("reads the main store only when there is no logs binding", async () => {
		const main = store();
		const logs = store();
		logs.tedi("e1", "2026-09-01T00:00:00.000Z");
		main.tedi("e2", "2026-10-01T00:00:00.000Z");
		const rows = await listTediRuntimeEvents(main.db, {
			organizationId: ORG,
			tediId: TEDI,
			order: "asc",
		});
		expect(rows.map((row) => row.id)).toEqual(["e2"]);
	});

	it("keeps rotated runtime events and artifacts visible across multiple bindings", async () => {
		const { main, logs } = split();
		const active = store();
		active.tedi("e5", "2026-10-02T00:00:00.000Z");
		active.tedi("e6", "2026-10-03T00:00:00.000Z");
		configureLogStore(main.db, {
			LOGS_DB: active.binding,
			LOGS_DB_3: logs.binding,
		});
		const page = await listTediRuntimeEvents(main.db, {
			organizationId: ORG,
			tediId: TEDI,
			order: "asc",
			offset: 1,
			limit: 4,
		});
		expect(page.map((row) => row.id)).toEqual(["e2", "e3", "e4", "e5"]);
		expect((await getTediRuntimeEventById(main.db, "e1"))?.id).toBe("e1");
		expect((await getKernelRuntimeEventById(main.db, "k1"))?.id).toBe("k1");
		expect((await getRunArtifact(main.db, "run-1", "old.json"))?.id).toBe("a1");
		expect(
			await listTediRuntimeEvents(main.db, {
				organizationId: "org-other",
				tediId: TEDI,
			}),
		).toEqual([]);
	});
});

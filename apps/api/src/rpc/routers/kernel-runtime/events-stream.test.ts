/**
 * Per-conversation SSE stream: exact replay after Last-Event-ID, multi-run
 * interleaving in (created_at, id) order, grant enforcement, and org binding —
 * against a real D1 facade over the actual schema DDL.
 */

import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import {
	kernelConversationGrants,
	kernelRuntimeEvents,
} from "@tedix/db/schema/cognitive-runtime";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { openConversationEventsStream } from "./events-stream";

let sqlite: DatabaseSync;

function db() {
	return createDbClient(createD1Facade(sqlite));
}

function seedEvent(
	id: string,
	runId: string,
	createdAt: string,
	kind = "message.delta",
	delta: string | null = null,
) {
	sqlite
		.prepare(
			`INSERT INTO kernel_runtime_events
				(id, organization_id, kind, conversation_id, run_id, delta, created_at)
				VALUES (?, 'org-1', ?, 'home:main', ?, ?, ?)`,
		)
		.run(id, kind, runId, delta, createdAt);
}

interface ParsedFrame {
	id?: string;
	event?: string;
	data?: unknown;
}

function parseSse(text: string): ParsedFrame[] {
	return text
		.split("\n\n")
		.filter((block) => block.trim().length > 0)
		.map((block) => {
			const frame: ParsedFrame = {};
			for (const line of block.split("\n")) {
				if (line.startsWith("id: ")) frame.id = line.slice(4);
				else if (line.startsWith("event: ")) frame.event = line.slice(7);
				else if (line.startsWith("data: "))
					frame.data = JSON.parse(line.slice(6));
			}
			return frame;
		})
		.filter((frame) => frame.id ?? frame.event ?? frame.data);
}

const FAST = { pollMs: 5, heartbeatMs: 60_000, maxSessionMs: 120 };

async function collect(
	params: Omit<
		Parameters<typeof openConversationEventsStream>[0],
		"db" | "timing"
	>,
) {
	const response = await openConversationEventsStream({
		db: db(),
		timing: FAST,
		...params,
	});
	if (response.status !== 200) return { response, frames: [] as ParsedFrame[] };
	return { response, frames: parseSse(await response.text()) };
}

describe("openConversationEventsStream", () => {
	beforeEach(() => {
		sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF;");
		sqlite.exec(schemaDdl(kernelRuntimeEvents, kernelConversationGrants));
	});

	it("flushes the SSE handshake before the first event or heartbeat", async () => {
		const response = await openConversationEventsStream({
			db: db(),
			organizationId: "org-1",
			descopeUserId: "user-1",
			conversationId: "home:main",
			lastEventId: null,
			timing: FAST,
		});
		const reader = response.body?.getReader();
		const first = await reader?.read();
		expect(new TextDecoder().decode(first?.value)).toBe(": connected\n\n");
		await reader?.cancel();
	});

	it("replays every event across concurrent runs in (created_at, id) order", async () => {
		// Two runs interleaved in time; ids break the created_at tie on the last pair.
		seedEvent("ev-a1", "run-a", "2026-08-13T20:00:01.000Z", "run.started");
		seedEvent("ev-b1", "run-b", "2026-08-13T20:00:02.000Z", "run.started");
		seedEvent(
			"ev-a2",
			"run-a",
			"2026-08-13T20:00:03.000Z",
			"message.delta",
			"hel",
		);
		seedEvent(
			"ev-a3",
			"run-a",
			"2026-08-13T20:00:04.000Z",
			"message.delta",
			"lo",
		);
		seedEvent("ev-b2", "run-b", "2026-08-13T20:00:04.000Z", "run.completed");

		const { frames } = await collect({
			organizationId: "org-1",
			descopeUserId: "user-1",
			conversationId: "home:main",
			lastEventId: null,
		});

		const data = frames.filter((frame) => frame.id);
		expect(data.map((frame) => (frame.data as { id: string }).id)).toEqual([
			"ev-a1",
			"ev-b1",
			"ev-a2",
			"ev-a3",
			"ev-b2",
		]);
		expect(data.map((frame) => frame.id)).toEqual([
			"home:main:0",
			"home:main:1",
			"home:main:2",
			"home:main:3",
			"home:main:4",
		]);
		expect((data[2]?.data as { delta?: string }).delta).toBe("hel");
	});

	it("resumes exactly after the Last-Event-ID offset, ignoring foreign tokens", async () => {
		for (let index = 0; index < 5; index++) {
			seedEvent(`ev-${index}`, "run-a", `2026-08-13T20:00:0${index}.000Z`);
		}
		const resumed = await collect({
			organizationId: "org-1",
			descopeUserId: "user-1",
			conversationId: "home:main",
			lastEventId: "home:main:2",
		});
		expect(
			resumed.frames
				.filter((frame) => frame.id)
				.map((frame) => (frame.data as { id: string }).id),
		).toEqual(["ev-3", "ev-4"]);

		// A token minted for another conversation must not skip anything.
		const foreign = await collect({
			organizationId: "org-1",
			descopeUserId: "user-1",
			conversationId: "home:main",
			lastEventId: "home:other:2",
		});
		expect(foreign.frames.filter((frame) => frame.id)).toHaveLength(5);
	});

	it("streams live events appended after the stream opened", async () => {
		seedEvent("ev-0", "run-a", "2026-08-13T20:00:00.000Z");
		const response = await openConversationEventsStream({
			db: db(),
			organizationId: "org-1",
			descopeUserId: "user-1",
			conversationId: "home:main",
			lastEventId: null,
			timing: { pollMs: 5, heartbeatMs: 60_000, maxSessionMs: 200 },
		});
		// Append while the stream is polling at the head.
		setTimeout(() => {
			seedEvent("ev-live", "run-a", "2026-08-13T20:00:09.000Z");
		}, 30);
		const frames = parseSse(await response.text());
		expect(
			frames
				.filter((frame) => frame.id)
				.map((frame) => (frame.data as { id: string }).id),
		).toEqual(["ev-0", "ev-live"]);
	});

	it("enforces grants when present and stays org-bound", async () => {
		seedEvent("ev-0", "run-a", "2026-08-13T20:00:00.000Z");
		sqlite
			.prepare(
				`INSERT INTO kernel_conversation_grants
					(id, organization_id, conversation_id, grantee_descope_user_id, access, created_at, updated_at)
					VALUES ('g-1', 'org-1', 'home:main', 'user-1', 'read', '2026-08-13T20:00:00.000Z', '2026-08-13T20:00:00.000Z')`,
			)
			.run();

		const granted = await collect({
			organizationId: "org-1",
			descopeUserId: "user-1",
			conversationId: "home:main",
			lastEventId: null,
		});
		expect(granted.response.status).toBe(200);
		expect(granted.frames.filter((frame) => frame.id)).toHaveLength(1);

		const denied = await collect({
			organizationId: "org-1",
			descopeUserId: "intruder",
			conversationId: "home:main",
			lastEventId: null,
		});
		expect(denied.response.status).toBe(403);

		// A different organization sees no events even with grants absent there.
		const foreignOrg = await collect({
			organizationId: "org-2",
			descopeUserId: "user-1",
			conversationId: "home:main",
			lastEventId: null,
		});
		expect(foreignOrg.frames.filter((frame) => frame.id)).toHaveLength(0);
	});
});

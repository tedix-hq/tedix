import { DatabaseSync } from "node:sqlite";
import { listAgentSessionRequests } from "@tedix/db/queries/agent-session-requests";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	agentSessionEvents,
	agentSessionRequests,
} from "@tedix/db/schema/agent-session-requests";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import {
	acceptAgentSessionEvents,
	type LedgerModel,
	observeAgentSessionRequests,
	processAgentSessionEvents,
	reflectAgentSessionRequests,
} from "./agent-session-request-ledger";

const SCOPE = {
	organizationId: "org-example",
	userId: "user-ada",
	harness: "claude-code" as const,
	sessionKey: "11111111-2222-4333-8444-555555555555",
};
const T0 = "2026-10-06T10:00:00.000Z";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(agentSessionRequests));
	sqlite.exec(schemaDdl(agentSessionEvents));
	return createDbQueryClient(createD1Facade(sqlite));
}

/** A model that answers with fixed JSON and records what it was asked. */
function scripted(...replies: Array<string | null>) {
	const prompts: string[] = [];
	const model: LedgerModel = async (_system, prompt) => {
		prompts.push(prompt);
		return replies.shift() ?? null;
	};
	model.verify = async (checks) => new Set(checks.map(({ ref }) => ref));
	return { model, prompts };
}

function observe(
	db: ReturnType<typeof fixture>,
	model: LedgerModel,
	message: string,
	sourceAt = T0,
) {
	return observeAgentSessionRequests(db, model, {
		...SCOPE,
		message,
		sourceAt,
		repository: "example/app",
		now: sourceAt,
	});
}

const rows = (db: ReturnType<typeof fixture>) =>
	listAgentSessionRequests(db, {
		organizationId: SCOPE.organizationId,
		userId: SCOPE.userId,
	});

describe("request ledger observer", () => {
	it("records each extracted request as an open row, once", async () => {
		const db = fixture();
		const reply = JSON.stringify({
			requests: [
				{ kind: "request", text: "Add a dark mode toggle" },
				{ kind: "question", text: "Why is the build slow?" },
			],
			cancelled: [],
		});
		const { model } = scripted(reply, reply);
		const first = await observe(db, model, "add dark mode; why is build slow?");
		expect(first).toMatchObject({ status: "recorded", cancelled: 0 });
		await observe(db, model, "add dark mode; why is build slow?");
		expect((await rows(db)).map((row) => [row.text, row.status])).toEqual([
			["Add a dark mode toggle", "open"],
			["Why is the build slow?", "open"],
		]);
	});

	it("skips restated rows and cancels withdrawn ones", async () => {
		const db = fixture();
		const { model, prompts } = scripted(
			JSON.stringify({
				requests: [{ kind: "request", text: "Add a dark mode toggle" }],
			}),
			JSON.stringify({
				requests: [{ kind: "request", text: "add a dark-mode toggle" }],
				cancelled: ["r1"],
			}),
		);
		await observe(db, model, "add dark mode");
		await observe(db, model, "forget dark mode", "2026-10-06T10:01:00.000Z");
		expect(prompts[1]).toContain(
			"ref=r1 [open] (request) Add a dark mode toggle",
		);
		const [row, ...rest] = await rows(db);
		expect(rest).toEqual([]);
		expect(row).toMatchObject({ status: "cancelled" });
	});

	it("stores nothing when the model fails", async () => {
		const db = fixture();
		expect(await observe(db, scripted(null).model, "ship it")).toEqual({
			status: "unavailable",
		});
		expect(await rows(db)).toEqual([]);
	});
});

describe("request ledger reflector", () => {
	async function seeded() {
		const db = fixture();
		await observe(
			db,
			scripted(
				JSON.stringify({
					requests: [
						{ kind: "request", text: "Fix the login page" },
						{ kind: "request", text: "Add a changeset" },
					],
				}),
			).model,
			"fix login and add a changeset",
		);
		return db;
	}

	function reflect(
		db: ReturnType<typeof fixture>,
		model: LedgerModel,
		turn: string,
		activity: string | null = null,
	) {
		return reflectAgentSessionRequests(db, model, {
			...SCOPE,
			turn,
			activity,
			repository: "example/app",
			sourceAt: T0,
			now: T0,
		});
	}

	it("closes a row only with evidence from the turn or its activity", async () => {
		const db = await seeded();
		const { model } = scripted(
			JSON.stringify({
				updates: [
					{ ref: "r1", status: "done", evidence: "4f2a9c1e" },
					{ ref: "r2", status: "done", evidence: "changeset added" },
				],
			}),
		);
		const result = await reflect(
			db,
			model,
			"Fixed the login page.",
			"git push: main 4f2a9c1e",
		);
		expect(result.status).toBe("reflected");
		expect(
			(await rows(db)).map((row) => [row.text, row.status, row.evidence]),
		).toEqual([
			["Fix the login page", "done", "4f2a9c1e"],
			["Add a changeset", "in_progress", null],
		]);
	});

	it("records the agent's promises and open loops as new rows", async () => {
		const db = await seeded();
		const { model, prompts } = scripted(
			JSON.stringify({
				updates: [],
				new: [
					{ kind: "promise", text: "Report the deploy result" },
					{ kind: "open_loop", text: "Codex lane on the docs page" },
					{ kind: "request", text: "Not owed by the agent" },
				],
			}),
		);
		await reflect(
			db,
			model,
			"I'll report the deploy result.",
			"Started agent: docs page",
		);
		expect(prompts[0]).toContain("ACTIVITY:\n<<<\nStarted agent: docs page");
		expect(
			(await rows(db))
				.map((row) => [row.kind, row.text, row.status].join(" | "))
				.sort(),
		).toEqual([
			"open_loop | Codex lane on the docs page | open",
			"promise | Report the deploy result | open",
			"request | Add a changeset | open",
			"request | Fix the login page | open",
		]);
	});

	it("does not infer abandonment from elapsed turns", async () => {
		const db = await seeded();
		let atRisk = 0;
		for (let turn = 0; turn < 6; turn++) {
			const result = await reflect(
				db,
				scripted(
					JSON.stringify({
						updates: [{ ref: "r1", status: "in_progress" }],
					}),
				).model,
				`Still on the login page (${turn}).`,
			);
			atRisk = result.status === "reflected" ? result.atRisk : -1;
		}
		expect(atRisk).toBe(0);
		expect((await rows(db)).map((row) => row.status)).toEqual([
			"in_progress",
			"open",
		]);
	});
});

describe("session event pipeline", () => {
	const owner = { organizationId: SCOPE.organizationId, userId: SCOPE.userId };
	const event = (kind: "prompt" | "turn", text: string, sourceAt: string) => ({
		kind,
		harness: SCOPE.harness,
		sessionKey: SCOPE.sessionKey,
		sourceAt,
		text,
	});

	it("stores events once and processes them in session order", async () => {
		const db = fixture();
		const events = [
			event("turn", "Fixed it in 4f2a9c1e.", "2026-10-06T10:01:00Z"),
			event("prompt", "fix the login page", "2026-10-06T10:00:00Z"),
		];
		expect(
			await acceptAgentSessionEvents(db, { ...owner, events, now: T0 }),
		).toEqual({ accepted: 2, duplicates: 0 });
		expect(
			await acceptAgentSessionEvents(db, { ...owner, events, now: T0 }),
		).toEqual({ accepted: 0, duplicates: 2 });
		const { model, prompts } = scripted(
			JSON.stringify({
				requests: [{ kind: "request", text: "Fix the login page" }],
			}),
			JSON.stringify({
				updates: [{ ref: "r1", status: "done", evidence: "4f2a9c1e" }],
			}),
		);
		expect(await processAgentSessionEvents(db, model, owner)).toBe(2);
		expect(prompts[0]).toContain("NEW MESSAGE");
		expect(prompts[1]).toContain("TURN");
		expect((await rows(db)).map((row) => row.status)).toEqual(["done"]);
		expect(await processAgentSessionEvents(db, model, owner)).toBe(0);
	});

	it("leaves an event pending when the model fails", async () => {
		const db = fixture();
		await acceptAgentSessionEvents(db, {
			...owner,
			events: [event("prompt", "ship it", T0)],
			now: T0,
		});
		expect(
			await processAgentSessionEvents(db, scripted(null).model, owner),
		).toBe(0);
		const ok = scripted(
			JSON.stringify({ requests: [{ kind: "request", text: "Ship it" }] }),
		);
		expect(await processAgentSessionEvents(db, ok.model, owner)).toBe(1);
	});
});

describe("agent asks and semantic support", () => {
	const input = { ...SCOPE, sourceAt: T0, now: T0, repository: "example/app" };
	const reflect = (
		db: ReturnType<typeof fixture>,
		model: LedgerModel,
		turn: string,
	) =>
		reflectAgentSessionRequests(db, model, { ...input, turn, activity: null });
	it("keeps an ask waiting through agent claims and closes it from a short user reply", async () => {
		const db = fixture();
		await reflect(
			db,
			scripted(
				JSON.stringify({
					updates: [],
					new: [{ kind: "ask", text: "Approve the README publication" }],
				}),
			).model,
			"Summary: README needs your OK. Say go.",
		);
		expect((await rows(db))[0]).toMatchObject({
			kind: "ask",
			status: "waiting_on_user",
		});
		await reflect(
			db,
			scripted(
				JSON.stringify({
					updates: [
						{
							ref: "r1",
							status: "done",
							evidence: "I approved the README publication",
						},
					],
				}),
			).model,
			"I approved the README publication.",
		);
		expect((await rows(db))[0]?.status).toBe("waiting_on_user");
		await observe(
			db,
			scripted(
				JSON.stringify({
					requests: [],
					answered: [{ ref: "r1", evidence: "go" }],
				}),
			).model,
			"go",
			"2026-10-06T10:01:00.000Z",
		);
		expect((await rows(db))[0]).toMatchObject({
			status: "done",
			evidence: "go",
		});
	});
	it("preserves previous state when evidence is unrelated or the verifier is unavailable", async () => {
		const db = fixture();
		await observe(
			db,
			scripted(
				JSON.stringify({
					requests: [{ kind: "request", text: "Deploy the login fix" }],
				}),
			).model,
			"Deploy the login fix",
		);
		for (const status of ["done", "dropped_risk"] as const) {
			const { model } = scripted(
				JSON.stringify({
					updates: [
						{ ref: "r1", status, evidence: "The documentation is updated" },
					],
				}),
			);
			model.verify = async () => new Set();
			await reflect(db, model, "The documentation is updated.");
			expect((await rows(db))[0]?.status).toBe("open");
			delete model.verify;
			await reflect(db, model, "The documentation is updated.");
			expect((await rows(db))[0]?.status).toBe("open");
		}
	});
	it("does not close an ask from an unrelated reply or invented quote", async () => {
		const db = fixture();
		await reflect(
			db,
			scripted(
				JSON.stringify({
					updates: [],
					new: [{ kind: "ask", text: "Approve publishing the legal page" }],
				}),
			).model,
			"Legal page needs your OK.",
		);
		const reply = JSON.stringify({
			requests: [],
			answered: [{ ref: "r1", evidence: "yes" }],
		});
		await observe(db, scripted(reply).model, "Continue fixing tests");
		expect((await rows(db))[0]?.status).toBe("waiting_on_user");
		const { model } = scripted(reply);
		model.verify = async () => new Set();
		await observe(db, model, "yes to tests, leave publishing undecided");
		expect((await rows(db))[0]?.status).toBe("waiting_on_user");
	});
});

it("does not let an overlapping pass overtake a message still being analysed", async () => {
	const db = fixture();
	const owner = { organizationId: SCOPE.organizationId, userId: SCOPE.userId };
	await acceptAgentSessionEvents(db, {
		...owner,
		now: T0,
		events: [
			{
				kind: "prompt",
				harness: SCOPE.harness,
				sessionKey: SCOPE.sessionKey,
				sourceAt: T0,
				text: "Fix the login page",
			},
			{
				kind: "turn",
				harness: SCOPE.harness,
				sessionKey: SCOPE.sessionKey,
				sourceAt: "2026-10-06T10:01:00Z",
				text: "Fixed the login page in 4f2a9c1e.",
			},
		],
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const model: LedgerModel = async () => {
		started();
		await gate;
		return JSON.stringify({
			requests: [{ kind: "request", text: "Fix the login page" }],
		});
	};
	const first = processAgentSessionEvents(db, model, owner, { limit: 1 });
	await ready;
	expect(await processAgentSessionEvents(db, scripted(null).model, owner)).toBe(
		0,
	);
	release();
	expect(await first).toBe(1);
	const answer = scripted(
		JSON.stringify({
			updates: [
				{
					ref: "r1",
					status: "done",
					evidence: "Fixed the login page in 4f2a9c1e",
				},
			],
		}),
	).model;
	expect(await processAgentSessionEvents(db, answer, owner)).toBe(1);
	expect((await rows(db))[0]?.status).toBe("done");
});

it("does not close a future ask from a late-uploaded older user message", async () => {
	const db = fixture();
	await reflectAgentSessionRequests(
		db,
		scripted(
			JSON.stringify({
				updates: [],
				new: [{ kind: "ask", text: "Approve README publication" }],
			}),
		).model,
		{
			...SCOPE,
			sourceAt: "2026-10-06T10:02:00Z",
			now: T0,
			repository: "example/app",
			turn: "README needs your OK.",
			activity: null,
		},
	);
	await observe(
		db,
		scripted(
			JSON.stringify({
				requests: [],
				answered: [{ ref: "r1", evidence: "go" }],
			}),
		).model,
		"go",
		T0,
	);
	expect((await rows(db))[0]?.status).toBe("waiting_on_user");
});

it("treats delegation back to the agent as an answered ask while keeping execution open", async () => {
	const db = fixture();
	await reflectAgentSessionRequests(
		db,
		scripted(
			JSON.stringify({
				updates: [],
				new: [{ kind: "ask", text: "Click the six checkboxes and Submit" }],
			}),
		).model,
		{
			...SCOPE,
			sourceAt: T0,
			now: T0,
			repository: "example/app",
			turn: "Please click the six checkboxes and Submit.",
			activity: null,
		},
	);
	const { model } = scripted(
		JSON.stringify({
			requests: [
				{ kind: "request", text: "Automate the checkbox and Submit clicks" },
			],
			answered: [{ ref: "r1", evidence: "hand that to Codex and the browser" }],
		}),
	);
	let checks: unknown;
	model.verify = async (input) => {
		checks = input;
		return new Set(input.map((c) => c.ref));
	};
	await observe(
		db,
		model,
		"I won't be awake; hand that to Codex and the browser",
		"2026-10-06T10:01:00Z",
	);
	expect(checks).toEqual([
		{
			ref: "r1",
			request: "Click the six checkboxes and Submit",
			status: "done",
			evidence: "hand that to Codex and the browser",
			userReply: true,
		},
	]);
	expect((await rows(db)).map((r) => [r.kind, r.status])).toEqual([
		["ask", "done"],
		["request", "open"],
	]);
});

it("recovers a supported answer that the extractor missed, without closing an agent ask", async () => {
	const db = fixture();
	await observe(
		db,
		scripted(
			JSON.stringify({
				requests: [
					{ kind: "question", text: "What happens to factory feedback?" },
				],
			}),
		).model,
		"What happens to factory feedback?",
	);
	const { model } = scripted(
		JSON.stringify({
			updates: [],
			new: [{ kind: "ask", text: "Approve publishing the legal page" }],
		}),
	);
	model.findCompletions = async () => [
		{ ref: "r1", evidence: "The factory reads feedback and proposes rules." },
	];
	await reflectAgentSessionRequests(db, model, {
		...SCOPE,
		sourceAt: "2026-10-06T10:01:00Z",
		now: T0,
		repository: "example/app",
		turn: "The factory reads feedback and proposes rules.",
		activity: null,
	});
	expect((await rows(db)).map((r) => [r.kind, r.status])).toEqual([
		["question", "done"],
		["ask", "waiting_on_user"],
	]);
});

it("never closes an ask from an automatic completion suggestion", async () => {
	const db = fixture();
	const input = {
		...SCOPE,
		sourceAt: T0,
		now: T0,
		repository: "example/app",
		activity: null,
	};
	await reflectAgentSessionRequests(
		db,
		scripted(
			JSON.stringify({
				updates: [],
				new: [{ kind: "ask", text: "Approve publishing the legal page" }],
			}),
		).model,
		{ ...input, turn: "Publishing the legal page needs your OK." },
	);
	const { model } = scripted(JSON.stringify({ updates: [] }));
	model.findCompletions = async () => [
		{ ref: "r1", evidence: "I approved publishing the legal page" },
	];
	await reflectAgentSessionRequests(db, model, {
		...input,
		turn: "I approved publishing the legal page",
	});
	expect((await rows(db))[0]?.status).toBe("waiting_on_user");
});

import { settleRequestsWithCompletedWork } from "./agent-session-request-completion";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { DatabaseSync } from "node:sqlite";
import { listAgentSessionRequests } from "@tedix/db/queries/agent-session-requests";
import { createDbQueryClient } from "@tedix/db/query-client";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import {
	osWorkspaces,
	osWorkspaceProjects,
} from "@tedix/db/schema/os-workspaces";
import { workEvents, workItems } from "@tedix/db/schema/work-items";
import { workAgentSessions } from "@tedix/db/schema/work-agent-sessions";
import { projects } from "@tedix/db/schema/projects";
import { organizations } from "@tedix/db/schema/organizations";
import { tediObjectives } from "@tedix/db/schema/tedi-objectives";
import { workInteractions } from "@tedix/db/schema/work-factory";
import {
	agentSessionEvents,
	agentSessionRequests,
} from "@tedix/db/schema/agent-session-requests";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	acceptAgentSessionEvents,
	type LedgerModel,
	LEDGER_SILENCE_TURNS,
	workersAiLedgerModel,
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

it("passes cited failure/fix pairs across stored turns to the learning pipeline", async () => {
	const db = fixture();
	const failure = "Failed native upload: payload exceeds inline limit";
	const fix =
		"Native uploader saved successfully after bypassing the inline limit";
	await acceptAgentSessionEvents(db, {
		...SCOPE,
		events: [
			{
				kind: "turn",
				harness: SCOPE.harness,
				sessionKey: SCOPE.sessionKey,
				sourceAt: T0,
				text: "Inline limit reached",
				activity: failure,
			},
		],
		now: T0,
	});
	const { model, prompts } = scripted(JSON.stringify({ updates: [] }));
	model.reflectLessons = vi.fn(async () =>
		JSON.stringify({
			lessons: [
				{
					rule: "Inline uploads fail → use the native uploader. Why: the inline limit.",
					failure,
					fix,
				},
			],
		}),
	);
	model.learn = vi.fn(async () => {});
	await reflectAgentSessionRequests(db, model, {
		...SCOPE,
		sourceEventId: "fix-event",
		turn: fix,
		activity: null,
		repository: "example/app",
		sourceAt: "2026-10-06T10:01:00.000Z",
		now: T0,
	});
	// Recovery history belongs to lesson extraction, not request status inference.
	expect(prompts[0]).not.toContain(failure);
	expect(model.reflectLessons).toHaveBeenCalledWith(
		expect.arrayContaining([
			expect.objectContaining({ activity: failure }),
			expect.objectContaining({ id: "fix-event", body: fix }),
		]),
	);
	expect(model.learn).toHaveBeenCalledWith(
		[
			expect.objectContaining({
				failure,
				fix,
				failureEventId: expect.any(String),
				fixEventId: "fix-event",
			}),
		],
		expect.objectContaining({ sessionKey: SCOPE.sessionKey }),
	);
});

it("does not lose lesson extraction failures or malformed output as successful reflection", async () => {
	for (const reply of [null, "{}", "not JSON"]) {
		const db = fixture();
		const { model } = scripted('{"updates":[]}');
		model.reflectLessons = async () => reply;
		model.learn = vi.fn(async () => {});
		await expect(
			reflectAgentSessionRequests(db, model, {
				...SCOPE,
				sourceEventId: "source",
				turn: "Upload saved successfully",
				activity: "Failed upload: payload limit",
				repository: "example/app",
				sourceAt: T0,
				now: T0,
			}),
		).rejects.toThrow();
		expect(model.learn).not.toHaveBeenCalled();
	}
});

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(organizations));
	sqlite.exec(schemaDdl(agentSessionRequests));
	sqlite.exec(schemaDdl(agentSessionEvents));
	sqlite.exec(schemaDdl(workInteractions));
	sqlite.exec(schemaDdl(projects));
	sqlite.exec(schemaDdl(userConfigs));
	sqlite.exec(schemaDdl(tediObjectives));
	for (const table of [
		learningInteractionEvents,
		osWorkspaces,
		osWorkspaceProjects,
		workItems,
		workEvents,
		workAgentSessions,
	])
		sqlite.exec(schemaDdl(table));
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
	it("files semantic matches only against the current organization's project briefs", async () => {
		const db = fixture();
		await db.insert(projects).values({
			id: "project-example",
			orgId: SCOPE.organizationId,
			key: "DOCS",
			name: "Documentation",
			description: "Installation and onboarding guides",
			createdAt: T0,
		});
		const model: LedgerModel = async (_system, prompt, surface) => {
			if (surface === "agent-session-project-routing") {
				const input = JSON.parse(prompt);
				expect(input.columns.projects).toEqual(["id", "name", "brief"]);
				expect(input.projects.map((p: string[]) => p[0])).toEqual([
					"project-example",
				]);
				return JSON.stringify({
					projectId: "project-example",
					name: "Documentation",
					brief: "Installation and onboarding guides",
					container: "project",
					actionable: true,
					reason: "Matches installation brief",
				});
			}
			return JSON.stringify({
				requests: [{ kind: "request", text: "Improve the installation guide" }],
			});
		};
		model.routeProjects = true;
		model.scoreProjectFit = async () => 0.9;
		await observe(db, model, "Improve the installation guide");
		expect((await rows(db))[0]?.projectId).toBe("project-example");
	});
	it("ignores scheduled prompts before calling either model or touching rows", async () => {
		const db = fixture();
		const { model, prompts } = scripted(null);
		model.reflectReplies = vi.fn();
		for (const message of [
			"Lead NIGHT SHIFT v3 tick. Follow guardrails; prepare morning brief.",
			"[SYSTEM NOTIFICATION: wakeup] Start lanes",
			"<task-notification>Done</task-notification> Check health",
			"CronCreate: Run health check",
		]) {
			expect(await observe(db, model, message)).toEqual({
				status: "recorded",
				recorded: [],
				cancelled: 0,
			});
		}
		expect(prompts).toEqual([]);
		expect(model.reflectReplies).not.toHaveBeenCalled();
		expect(await rows(db)).toEqual([]);
	});

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
			["Add a changeset", "open", null],
		]);
	});

	it("records the agent's promises and open loops as new rows", async () => {
		const db = await seeded();
		const { model, prompts } = scripted(
			JSON.stringify({
				updates: [],
				new: [
					{
						kind: "promise",
						text: "Report the deploy result",
						evidence: "I’ll report the deploy result.",
					},
					{
						kind: "open_loop",
						text: "Codex lane on the docs page",
						evidence: "I’ll report the docs lane result.",
					},
					{ kind: "request", text: "Not owed by the agent" },
				],
			}),
		);
		await reflect(
			db,
			model,
			"I’ll report the deploy result. I’ll report the docs lane result.",
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
						updates: [
							{
								ref: "r1",
								status: "in_progress",
								evidence: "Still on the login page",
							},
						],
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

	it("skips identical prompts at later ticks without skipping changed messages or other sessions", async () => {
		const db = fixture();
		await acceptAgentSessionEvents(db, {
			...owner,
			events: [event("prompt", "Check the lanes", T0)],
			now: T0,
		});
		const { model, prompts } = scripted('{"requests":[]}', '{"requests":[]}');
		expect(
			await observe(db, model, "Check the lanes", "2026-10-06T10:15:00Z"),
		).toEqual({ status: "recorded", recorded: [], cancelled: 0 });
		expect(prompts).toEqual([]);
		await observe(
			db,
			model,
			"Check the lanes and fix failures",
			"2026-10-06T10:16:00Z",
		);
		await observeAgentSessionRequests(db, model, {
			...SCOPE,
			sessionKey: "another-session",
			message: "Check the lanes",
			sourceAt: "2026-10-06T10:15:00Z",
			now: T0,
			repository: null,
		});
		expect(prompts).toHaveLength(2);
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
					new: [
						{
							kind: "ask",
							text: "Approve the README publication",
							evidence: "README needs your OK",
						},
					],
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
	it("preserves previous state when evidence is absent from the source", async () => {
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
						{
							ref: "r1",
							status,
							evidence: "The login deployment has been verified",
						},
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
					new: [
						{
							kind: "ask",
							text: "Approve publishing the legal page",
							evidence: "legal page needs your OK",
						},
					],
				}),
			).model,
			"The legal page needs your OK.",
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
				new: [
					{
						kind: "ask",
						text: "Approve README publication",
						evidence: "README needs your OK",
					},
				],
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
				new: [
					{
						kind: "ask",
						text: "Click the six checkboxes and Submit",
						evidence: "click the six checkboxes and Submit",
					},
				],
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

it("keeps an answer open when the reflector did not propose a supported closure", async () => {
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
			new: [
				{
					kind: "ask",
					text: "Approve publishing the legal page",
					evidence: "legal page needs your OK",
				},
			],
		}),
	);
	await reflectAgentSessionRequests(db, model, {
		...SCOPE,
		sourceAt: "2026-10-06T10:01:00Z",
		now: T0,
		repository: "example/app",
		turn: "The factory reads feedback and proposes rules. The legal page needs your OK.",
		activity: null,
	});
	expect((await rows(db)).map((r) => [r.kind, r.status])).toEqual([
		["question", "open"],
		["ask", "waiting_on_user"],
	]);
});

it("never closes an ask from an unproposed agent approval claim", async () => {
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
				new: [
					{
						kind: "ask",
						text: "Approve publishing the legal page",
						evidence: "legal page needs your OK",
					},
				],
			}),
		).model,
		{ ...input, turn: "Publishing the legal page needs your OK." },
	);
	const { model } = scripted(JSON.stringify({ updates: [] }));
	await reflectAgentSessionRequests(db, model, {
		...input,
		turn: "I approved publishing the legal page",
	});
	expect((await rows(db))[0]?.status).toBe("waiting_on_user");
});

it("uses the Gateway for reflection, intake and filing while keeping the observer small", async () => {
	const run = vi.fn().mockResolvedValue({ response: '{"requests":[]}' });
	const fetch = vi.fn().mockResolvedValue(
		Response.json({
			status: "completed",
			output: [
				{
					type: "message",
					content: [{ type: "output_text", text: '{"updates":[]}' }],
				},
			],
		}),
	);
	const model = workersAiLedgerModel({
		AI: { run, fetch } as unknown as Ai,
		AI_GATEWAY_LLM_ID: "example-gateway",
		AI_GATEWAY_BINDING_PROVIDERS: "azure-openai",
		AZURE_OPENAI_RESOURCE: "example-resource",
	});
	expect(
		await model("system", "prompt", "agent-session-request-observer"),
	).toBe('{"requests":[]}');
	expect(run.mock.calls[0]?.[0]).toBe(
		"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	);
	expect(
		await model("system", "full turn", "agent-session-request-reflector"),
	).toBe('{"updates":[]}');
	expect(run).toHaveBeenCalledTimes(1);
	const [url, init] = fetch.mock.calls[0]!;
	expect(String(url)).toContain(
		"/azure-openai/example-resource/openai/v1/responses",
	);
	expect(JSON.parse(init.body)).toMatchObject({
		model: "gpt-6-astra",
		input: "full turn",
	});
	fetch.mockResolvedValueOnce(
		Response.json({
			status: "completed",
			output: [
				{
					type: "message",
					content: [{ type: "output_text", text: '{"new":[]}' }],
				},
			],
		}),
	);
	expect(
		await model.extractObligations!([], "Lead words", "User request"),
	).toBe('{"new":[]}');
	expect(run).toHaveBeenCalledTimes(1);
	const longSources = [
		{
			id: "long-turn",
			body: "Completed work. ".repeat(14_000),
			activity: "Failed upload",
		},
	];
	fetch.mockResolvedValueOnce(
		Response.json({
			status: "completed",
			output: [
				{
					type: "message",
					content: [{ type: "output_text", text: '{"lessons":[]}' }],
				},
			],
		}),
	);
	expect(await model.reflectLessons!(longSources)).toBe('{"lessons":[]}');
	expect(run).toHaveBeenCalledTimes(1);
	expect(JSON.parse(fetch.mock.calls.at(-1)![1].body).input).toBe(
		JSON.stringify(longSources),
	);
	fetch.mockResolvedValueOnce(
		Response.json({
			status: "completed",
			output: [
				{
					type: "message",
					content: [
						{ type: "output_text", text: '{"projectId":"project-docs"}' },
					],
				},
			],
		}),
	);
	expect(
		await model("system", "portfolio", "agent-session-project-routing"),
	).toBe('{"projectId":"project-docs"}');
	expect(run).toHaveBeenCalledTimes(1);
	expect(JSON.parse(fetch.mock.calls.at(-1)![1].body).input).toBe("portfolio");
	fetch.mockResolvedValueOnce(new Response("", { status: 503 }));
	expect(
		await model("system", "prompt", "agent-session-request-reflector"),
	).toBeNull();
	fetch.mockResolvedValueOnce(
		new Response("private upstream detail", { status: 429 }),
	);
	await expect(
		model("system", "portfolio", "agent-session-project-routing"),
	).rejects.toThrow("Request filing model HTTP 429");
	fetch.mockRejectedValueOnce(
		new DOMException("private upstream detail", "TimeoutError"),
	);
	await expect(
		model("system", "portfolio", "agent-session-project-routing"),
	).rejects.toThrow("Request filing model exceeded its 24-second deadline");
	expect(run).toHaveBeenCalledTimes(1);
});

it("ages only after five distinct silent turns, resets on mention, and protects running lanes", async () => {
	const db = fixture();
	await observe(
		db,
		scripted(
			JSON.stringify({
				requests: [{ kind: "request", text: "Verify the deployed login fix" }],
			}),
		).model,
		"Verify the deployed login fix",
	);
	let tick = 0;
	const reflect = async (
		body: unknown,
		turn = "An unrelated status update.",
	) => {
		const sourceAt = new Date(Date.parse(T0) + ++tick * 60000).toISOString();
		return reflectAgentSessionRequests(
			db,
			scripted(JSON.stringify(body)).model,
			{
				...SCOPE,
				turn,
				activity: null,
				repository: "example/app",
				sourceAt,
				now: sourceAt,
			},
		);
	};
	for (let i = 0; i < LEDGER_SILENCE_TURNS - 1; i++)
		await reflect({ updates: [] });
	expect((await rows(db))[0]?.status).toBe("open");
	await reflect(
		{
			updates: [],
			mentioned: [
				{
					ref: "r1",
					evidence: "The deployed login fix still needs verification",
				},
			],
		},
		"The deployed login fix still needs verification.",
	);
	expect((await rows(db))[0]?.turnsUnaddressed).toBe(0);
	for (let i = 0; i < LEDGER_SILENCE_TURNS - 1; i++)
		await reflect({ updates: [] });
	expect((await rows(db))[0]?.status).toBe("open");
	await reflect({ updates: [] });
	expect((await rows(db))[0]?.status).toBe("dropped_risk");
	await reflect(
		{
			updates: [
				{
					ref: "r1",
					status: "in_progress",
					evidence: "The login deployment is running",
				},
			],
			lanes: [
				{
					ref: "r1",
					running: true,
					evidence: "The login deployment is running",
				},
			],
		},
		"The login deployment is running.",
	);
	for (let i = 0; i < LEDGER_SILENCE_TURNS + 2; i++)
		await reflect({ updates: [] });
	expect((await rows(db)).find((r) => r.kind === "request")?.status).toBe(
		"in_progress",
	);
	const lastAt = new Date(Date.parse(T0) + tick * 60000).toISOString();
	const before = (await rows(db)).find(
		(r) => r.kind === "request",
	)!.turnsUnaddressed;
	await reflectAgentSessionRequests(db, scripted('{"updates":[]}').model, {
		...SCOPE,
		turn: "An unrelated status update.",
		activity: null,
		repository: "example/app",
		sourceAt: lastAt,
		now: lastAt,
	});
	expect(
		(await rows(db)).find((r) => r.kind === "request")?.turnsUnaddressed,
	).toBe(before);
});

it("retains the canonical row and merge provenance when a completed request is restated", async () => {
	const db = fixture();
	await observe(
		db,
		scripted(
			'{"requests":[{"kind":"request","text":"Publish the README update"}]}',
		).model,
		"Publish the README update",
	);
	const reflect = (body: unknown, turn: string, at: string) =>
		reflectAgentSessionRequests(db, scripted(JSON.stringify(body)).model, {
			...SCOPE,
			turn,
			activity: null,
			repository: "example/app",
			sourceAt: at,
			now: at,
		});
	await reflect(
		{
			updates: [
				{
					ref: "r1",
					status: "done",
					evidence: "Published README and read it back",
				},
			],
		},
		"Published README and read it back.",
		"2026-10-06T10:01:00Z",
	);
	await observe(
		db,
		scripted(
			'{"requests":[{"kind":"request","text":"Ship the updated README"}]}',
		).model,
		"Ship the updated README",
		"2026-10-06T10:02:00Z",
	);
	await reflect(
		{
			updates: [],
			merges: [{ ref: "r1", into: "r2", evidence: "Ship the updated README" }],
		},
		"The README was already published.",
		"2026-10-06T10:03:00Z",
	);
	const all = await rows(db);
	expect(all.map((r) => r.status)).toEqual(["done", "cancelled"]);
	expect(all[1]?.evidence).toContain(all[0]!.id);
});

it("uses the reply reflector to recover an answered ask missed by the small observer", async () => {
	const db = fixture();
	await reflectAgentSessionRequests(
		db,
		scripted(
			'{"updates":[],"new":[{"kind":"ask","text":"Click the checkbox and Submit","evidence":"click the checkbox and Submit"}]}',
		).model,
		{
			...SCOPE,
			turn: "Please click the checkbox and Submit.",
			activity: null,
			repository: "example/app",
			sourceAt: T0,
			now: T0,
		},
	);
	const { model } = scripted('{"requests":[],"answered":[]}');
	model.reflectReplies = async () =>
		'{"requests":[],"answered":[{"ref":"r1","evidence":"you do it"}],"cancelled":[]}';
	model.verify = async () => {
		throw Error("Small verifier must not override the reply reflector");
	};
	await observe(db, model, "you do it", "2026-10-06T10:01:00Z");
	expect((await rows(db))[0]).toMatchObject({
		status: "done",
		evidence: "you do it",
	});
});

it("retires operational asks from saved outcome evidence while preserving reserved approvals", async () => {
	const db = fixture();
	const reflect = (body: unknown, turn: string, at: string) =>
		reflectAgentSessionRequests(db, scripted(JSON.stringify(body)).model, {
			...SCOPE,
			turn,
			activity: null,
			repository: "example/app",
			sourceAt: at,
			now: at,
		});
	await observe(
		db,
		scripted(
			'{"requests":[{"kind":"request","text":"Fix editor synchronization"}]}',
		).model,
		"Fix editor synchronization",
	);
	await reflect(
		{
			updates: [
				{
					ref: "r1",
					status: "done",
					evidence: "Editor synchronization verified on the live page",
				},
			],
			new: [
				{
					kind: "ask",
					text: "Reload the deck editor tab",
					evidence: "Reload the deck editor tab",
				},
				{
					kind: "ask",
					text: "Approve the public README publication",
					evidence: "Approve the public README publication",
				},
			],
		},
		"Editor synchronization verified on the live page. Reload the deck editor tab. Approve the public README publication.",
		"2026-10-06T10:01:00Z",
	);
	await reflect(
		{
			updates: [
				{
					ref: "r1",
					status: "done",
					operational: true,
					evidence: "Editor synchronization verified on the live page",
				},
				{
					ref: "r2",
					status: "done",
					operational: true,
					evidence: "Editor synchronization verified on the live page",
				},
			],
		},
		"Continuing with another task.",
		"2026-10-06T10:02:00Z",
	);
	expect((await rows(db)).map((r) => [r.text, r.status])).toEqual([
		["Fix editor synchronization", "done"],
		["Reload the deck editor tab", "done"],
		["Approve the public README publication", "waiting_on_user"],
	]);
});

it("a running lane protects its own request while an unrelated silent request becomes at risk", async () => {
	const db = fixture();
	await observe(
		db,
		scripted(
			'{"requests":[{"kind":"request","text":"Verify the login deployment"},{"kind":"request","text":"Write the unrelated release summary"}]}',
		).model,
		"Verify the login deployment; write the unrelated release summary",
	);
	for (let tick = 1; tick <= LEDGER_SILENCE_TURNS; tick++) {
		const at = new Date(Date.parse(T0) + tick * 60000).toISOString();
		await reflectAgentSessionRequests(
			db,
			scripted(
				JSON.stringify({
					updates: [],
					lanes:
						tick === 1
							? [
									{
										ref: "r1",
										running: true,
										evidence: "The login deployment is running",
									},
								]
							: [],
				}),
			).model,
			{
				...SCOPE,
				sourceAt: at,
				now: at,
				repository: "example/app",
				turn:
					tick === 1
						? "The login deployment is running."
						: "An unrelated update.",
				activity: null,
			},
		);
	}
	const all = await rows(db);
	expect(all[0]).toMatchObject({ status: "open", laneRunning: true });
	expect(all[1]).toMatchObject({
		status: "dropped_risk",
		laneRunning: false,
		turnsUnaddressed: LEDGER_SILENCE_TURNS,
	});
});

it("an approval closes the ask while retaining the exact unfinished execution criteria once", async () => {
	const db = fixture();
	const text = "Make doc creation <=5 seconds and questions <=3 seconds";
	const proposal = `Say go to ${text}.`;
	await acceptAgentSessionEvents(db, {
		organizationId: SCOPE.organizationId,
		userId: SCOPE.userId,
		events: [{ ...SCOPE, kind: "turn", text: proposal, sourceAt: T0 }],
		now: T0,
	});
	await reflectAgentSessionRequests(
		db,
		scripted(
			JSON.stringify({
				updates: [],
				new: [{ kind: "ask", text, evidence: proposal }],
			}),
		).model,
		{
			...SCOPE,
			sourceAt: T0,
			now: T0,
			turn: proposal,
			activity: null,
			repository: "example/app",
		},
	);
	const { model } = scripted(
		JSON.stringify({ requests: [{ kind: "request", text }] }),
	);
	model.reflectReplies = async (_rows, _message, previous) => {
		expect(previous).toBe(proposal);
		return JSON.stringify({
			requests: [{ kind: "request", text }],
			answered: [{ ref: "r1", evidence: "go" }],
			cancelled: [],
		});
	};
	await observe(db, model, "go", "2026-10-06T10:01:00Z");
	expect((await rows(db)).map((r) => [r.kind, r.text, r.status])).toEqual([
		["ask", text, "done"],
		["request", text, "open"],
	]);
});

it("can adopt a preceding proposal even when there are no open rows", async () => {
	const db = fixture();
	await acceptAgentSessionEvents(db, {
		organizationId: SCOPE.organizationId,
		userId: SCOPE.userId,
		events: [
			{
				...SCOPE,
				kind: "turn",
				text: "Shall I write the release summary?",
				sourceAt: T0,
			},
		],
		now: T0,
	});
	const { model } = scripted('{"requests":[]}');
	model.reflectReplies = async (_rows, _message, previous) => {
		expect(previous).toBe("Shall I write the release summary?");
		return '{"requests":[{"kind":"request","text":"Write the release summary"}],"answered":[],"cancelled":[]}';
	};
	await observe(db, model, "yes, do that", "2026-10-06T10:01:00Z");
	expect((await rows(db))[0]).toMatchObject({
		kind: "request",
		text: "Write the release summary",
		status: "open",
	});
});

it("does not count a repeated saved progress citation as a new mention", async () => {
	const db = fixture();
	await observe(
		db,
		scripted(
			'{"requests":[{"kind":"request","text":"Verify the deployed login fix"}]}',
		).model,
		"Verify the deployed login fix",
	);
	const evidence = "The code is fixed but the live check is still pending";
	const reply = JSON.stringify({
		updates: [{ ref: "r1", status: "in_progress", evidence }],
	});
	for (let i = 0; i <= LEDGER_SILENCE_TURNS; i++) {
		const at = new Date(Date.parse(T0) + (i + 1) * 60000).toISOString();
		await reflectAgentSessionRequests(db, scripted(reply).model, {
			...SCOPE,
			turn: i === 0 ? evidence : "Unrelated work was checked.",
			activity: null,
			repository: "example/app",
			sourceAt: at,
			now: at,
		});
	}
	expect((await rows(db))[0]).toMatchObject({
		status: "dropped_risk",
		turnsUnaddressed: LEDGER_SILENCE_TURNS,
	});
});

it("requires an explicit retry to restart a failed duplicate event", async () => {
	const db = fixture();
	const input = {
		organizationId: SCOPE.organizationId,
		userId: SCOPE.userId,
		now: T0,
		events: [
			{
				...SCOPE,
				kind: "prompt" as const,
				text: "Check the example import",
				sourceAt: T0,
			},
		],
	};
	await acceptAgentSessionEvents(db, input);
	for (let i = 0; i < 3; i++)
		await processAgentSessionEvents(db, scripted(null).model, SCOPE, {
			limit: 1,
			now: () => T0,
		});
	expect((await db.select().from(agentSessionEvents))[0]).toMatchObject({
		status: "failed",
		attempts: 3,
	});
	expect(await acceptAgentSessionEvents(db, input)).toEqual({
		accepted: 0,
		duplicates: 1,
	});
	expect((await db.select().from(agentSessionEvents))[0]?.status).toBe(
		"failed",
	);
	expect(
		await acceptAgentSessionEvents(db, { ...input, retryFailed: true }),
	).toEqual({ accepted: 0, duplicates: 1, retried: 1 });
	await processAgentSessionEvents(
		db,
		scripted(
			'{"requests":[{"kind":"request","text":"Check the example import"}]}',
		).model,
		SCOPE,
		{ limit: 1, now: () => T0 },
	);
	expect((await db.select().from(agentSessionEvents))[0]).toMatchObject({
		status: "processed",
		attempts: 1,
		body: input.events[0]!.text,
	});
	expect(await rows(db)).toHaveLength(1);
});

it.each(["request", "idea", "issue"])(
	"keeps original %s scope separate from a later implementation request",
	async (kind) => {
		const db = fixture();
		const original = "Review authentication and report findings.";
		await acceptAgentSessionEvents(db, {
			organizationId: SCOPE.organizationId,
			userId: SCOPE.userId,
			now: T0,
			events: [
				{ ...SCOPE, kind: "prompt", sourceAt: T0, text: original },
				{
					...SCOPE,
					kind: "prompt",
					sourceAt: "2026-10-06T10:01:00.000Z",
					text: "Implement and deploy the findings.",
				},
			],
		});
		await observe(
			db,
			scripted(
				JSON.stringify({
					requests: [
						{ kind, text: "Review authentication" },
						{ kind, text: "Report findings" },
					],
				}),
			).model,
			original,
		);
		const { model, prompts } = scripted(
			'{"updates":[{"ref":"r1","status":"done","evidence":"Review findings delivered in the report."}]}',
		);
		await reflectAgentSessionRequests(db, model, {
			...SCOPE,
			sourceAt: "2026-10-06T10:02:00.000Z",
			now: T0,
			repository: "example/app",
			turn: "Review findings delivered in the report. Implementation is still running.",
			activity: null,
		});
		expect(prompts[0]).toContain(
			`ORIGINAL REQUEST SCOPES:\n<<<\nr1, r2:\n${original}`,
		);
		expect(prompts[0]).toContain(
			"USER MESSAGE:\n<<<\nImplement and deploy the findings.",
		);
		expect((await rows(db))[0]?.status).toBe("done");
	},
);

it("keeps quoted mention evidence through silence so a later turn can recover closure", async () => {
	const db = fixture();
	await observe(
		db,
		scripted(
			'{"requests":[{"kind":"request","text":"Rename the widget to App"}]}',
		).model,
		"Rename the widget to App",
	);
	const evidence = "The widget is now called App (4f2a9c1).";
	let tick = 0;
	const reflect = (model: LedgerModel, turn: string) => {
		const at = new Date(Date.parse(T0) + ++tick * 60000).toISOString();
		return reflectAgentSessionRequests(db, model, {
			...SCOPE,
			turn,
			activity: null,
			sourceAt: at,
			now: at,
			repository: "example/app",
		});
	};
	await reflect(
		scripted(JSON.stringify({ updates: [], mentioned: { r1: evidence } }))
			.model,
		evidence,
	);
	expect((await rows(db))[0]).toMatchObject({ status: "open", evidence });
	for (let i = 0; i < LEDGER_SILENCE_TURNS; i++)
		await reflect(
			scripted('{"updates":[]}').model,
			"An unrelated check passed.",
		);
	expect((await rows(db))[0]).toMatchObject({
		status: "dropped_risk",
		evidence,
	});
	const { model, prompts } = scripted(
		JSON.stringify({ updates: [{ ref: "r1", status: "done", evidence }] }),
	);
	await reflect(model, "Another unrelated check passed.");
	expect(prompts[0]).toContain(evidence);
	expect((await rows(db))[0]).toMatchObject({ status: "done", evidence });
});

it("does not label an agent promise with an unrelated human request's scope", async () => {
	const db = fixture();
	await acceptAgentSessionEvents(db, {
		organizationId: SCOPE.organizationId,
		userId: SCOPE.userId,
		now: T0,
		events: [
			{ ...SCOPE, kind: "prompt", sourceAt: T0, text: "Review the docs." },
		],
	});
	await observe(
		db,
		scripted('{"requests":[{"kind":"request","text":"Review the docs"}]}')
			.model,
		"Review the docs.",
	);
	await reflectAgentSessionRequests(
		db,
		scripted(
			'{"updates":[],"new":[{"kind":"promise","text":"Deliver a release report","evidence":"I will deliver a release report."}]}',
		).model,
		{
			...SCOPE,
			sourceAt: "2026-10-06T10:01:00Z",
			now: T0,
			repository: "example/app",
			turn: "I will deliver a release report.",
			activity: null,
		},
	);
	const { model, prompts } = scripted('{"updates":[]}');
	await reflectAgentSessionRequests(db, model, {
		...SCOPE,
		sourceAt: "2026-10-06T10:02:00Z",
		now: T0,
		repository: "example/app",
		turn: "Another check passed.",
		activity: null,
	});
	const scopes = prompts[0]!
		.split("ORIGINAL REQUEST SCOPES:\n<<<\n")[1]!
		.split("\n>>>\n\nUSER MESSAGE:")[0];
	expect(scopes).toBe("r1:\nReview the docs.");
	expect(prompts[0]).toContain("Deliver a release report");
});

it("closes a question from the assistant response following that same prompt", async () => {
	const db = fixture();
	const prompt = "Is the Example CLI connected?";
	await acceptAgentSessionEvents(db, {
		...SCOPE,
		events: [{ ...SCOPE, kind: "prompt", text: prompt, sourceAt: T0 }],
		now: T0,
	});
	await observe(
		db,
		scripted(JSON.stringify({ requests: [{ kind: "question", text: prompt }] }))
			.model,
		prompt,
	);
	const answer = "The Example CLI is connected; the plugin is unavailable.";
	const { model, prompts } = scripted(
		JSON.stringify({
			updates: [{ ref: "r1", status: "done", evidence: answer }],
		}),
	);
	await reflectAgentSessionRequests(db, model, {
		...SCOPE,
		turn: answer,
		activity: null,
		repository: null,
		sourceAt: "2026-10-06T10:01:00Z",
		now: T0,
	});
	expect(prompts[0]).toContain(prompt);
	expect(prompts[0]).toContain(answer);
	expect((await rows(db))[0]?.status).toBe("done");
});

it("reads a later delegated lane result without admitting its old promises", async () => {
	const db = fixture();
	await observe(
		db,
		scripted(
			JSON.stringify({
				requests: [{ kind: "request", text: "Create Bea's private workspace" }],
			}),
		).model,
		"Create Bea's private workspace",
	);
	const evidence =
		"Bea's private workspace is created and read back; her separate consent is pending.";
	await acceptAgentSessionEvents(db, {
		...SCOPE,
		events: [
			{
				...SCOPE,
				kind: "turn",
				text: "I will create the workspace.",
				activity: evidence,
				sourceAt: "2026-10-06T10:01:00Z",
			},
		],
		now: T0,
	});
	const { model, prompts } = scripted(
		JSON.stringify({ updates: [{ ref: "r1", status: "done", evidence }] }),
	);
	await reflectAgentSessionRequests(db, model, {
		...SCOPE,
		turn: `<agent-message>${evidence}</agent-message>`,
		activity: null,
		repository: null,
		sourceAt: "2026-10-06T10:02:00Z",
		now: T0,
	});
	expect(prompts[0]).toContain(evidence);
	expect((await rows(db))[0]?.status).toBe("done");
	expect(await rows(db)).toHaveLength(1);
});

it("uses independent intake instead of a status reflector's mistaken new obligation", async () => {
	const db = fixture();
	await observe(
		db,
		scripted('{"requests":[{"kind":"request","text":"Repair the CLI"}]}').model,
		"Repair the CLI",
	);
	const { model } = scripted(
		JSON.stringify({
			updates: [],
			new: [
				{
					kind: "promise",
					text: "Fix the linked-project error",
					evidence: "Codex is fixing the linked-project error.",
				},
			],
		}),
	);
	model.extractObligations = vi.fn(async (known, turn) => {
		expect(known[0]?.text).toBe("Repair the CLI");
		expect(turn).toContain("Codex is fixing");
		return '{"new":[]}';
	});
	await reflectAgentSessionRequests(db, model, {
		...SCOPE,
		turn: "Codex is fixing the linked-project error.",
		activity: null,
		repository: null,
		sourceAt: "2026-10-06T10:01:00Z",
		now: T0,
	});
	expect(await rows(db)).toHaveLength(1);
});

it.each([null, "not JSON", '{"updates":[]}'])(
	"keeps the event retryable when intake is unavailable: %s",
	async (intake) => {
		const db = fixture();
		await observe(
			db,
			scripted(
				'{"requests":[{"kind":"question","text":"Check the CLI connection"}]}',
			).model,
			"Check the CLI connection",
		);
		const evidence = "The CLI connection is verified.";
		const { model } = scripted(
			JSON.stringify({ updates: [{ ref: "r1", status: "done", evidence }] }),
		);
		model.extractObligations = async () => intake;
		const result = await reflectAgentSessionRequests(db, model, {
			...SCOPE,
			turn: evidence,
			activity: null,
			repository: null,
			sourceAt: "2026-10-06T10:01:00Z",
			now: T0,
		});
		expect(result.status).toBe("unavailable");
		expect((await rows(db))[0]?.status).toBe("open");
	},
);

it.each([
	["Decide whether to trim the seven Work tabs", "cancelled"],
	["Decide whether to remove the duplicate attention panel", "cancelled"],
	["Approve publishing the new navigation layout", "waiting_on_user"],
	["Choose whether agents may accept rules in the panel", "waiting_on_user"],
	["Authorize deleting files through the sidebar", "waiting_on_user"],
])(
	"withdraws only obsolete routine UI dependencies: %s",
	async (text, expected) => {
		const db = fixture();
		const quote = `Please decide: ${text}.`;
		await reflectAgentSessionRequests(
			db,
			scripted(
				JSON.stringify({
					updates: [],
					new: [{ kind: "ask", text, evidence: quote }],
				}),
			).model,
			{
				...SCOPE,
				turn: quote,
				activity: null,
				repository: null,
				sourceAt: T0,
				now: T0,
			},
		);
		const evidence =
			"The Work page now has three tabs; the duplicate panel is removed and verified live.";
		await reflectAgentSessionRequests(
			db,
			scripted(
				JSON.stringify({
					updates: [
						{ ref: "r1", status: "cancelled", operational: true, evidence },
					],
				}),
			).model,
			{
				...SCOPE,
				turn: evidence,
				activity: null,
				repository: null,
				sourceAt: "2026-10-06T10:01:00Z",
				now: T0,
			},
		);
		expect((await rows(db))[0]?.status).toBe(expected);
	},
);

it("rebuilds derived rows after a failed event and later processed work", async () => {
	const db = fixture();
	const input = {
		...SCOPE,
		now: T0,
		events: [
			{
				...SCOPE,
				kind: "prompt" as const,
				sourceAt: T0,
				text: "Check the example import",
			},
			{
				...SCOPE,
				kind: "turn" as const,
				sourceAt: "2026-10-06T10:01:00.000Z",
				text: "Import checked",
			},
		],
	};
	await acceptAgentSessionEvents(db, input);
	await observe(
		db,
		scripted(
			'{"requests":[{"kind":"request","text":"Check the example import"}]}',
		).model,
		input.events[0]!.text,
	);
	const events = await db.select().from(agentSessionEvents);
	await db.update(agentSessionEvents).set({ status: "failed", attempts: 3 });
	await db
		.update(agentSessionEvents)
		.set({ status: "processed", attempts: 1 })
		.where(eq(agentSessionEvents.sourceAt, input.events[1]!.sourceAt));
	const failed = {
		...input,
		rebuildFailedSession: {
			harness: SCOPE.harness,
			sessionKey: SCOPE.sessionKey,
			expectedEvents: 2,
			expectedRequests: 2,
		},
	};
	expect(await acceptAgentSessionEvents(db, failed)).toEqual({
		accepted: 0,
		duplicates: 2,
		rebuilt: 0,
	});
	expect(await rows(db)).toHaveLength(1);
	expect(
		await acceptAgentSessionEvents(db, {
			...failed,
			rebuildFailedSession: {
				...failed.rebuildFailedSession,
				expectedRequests: 1,
			},
		}),
	).toEqual({ accepted: 0, duplicates: 2, rebuilt: 2 });
	expect(await rows(db)).toEqual([]);
	expect(
		(await db.select().from(agentSessionEvents)).map((e) => e.id).sort(),
	).toEqual(events.map((e) => e.id).sort());
	expect(
		(await db.select().from(agentSessionEvents)).every(
			(e) => e.status === "pending" && e.attempts === 0,
		),
	).toBe(true);
	await processAgentSessionEvents(
		db,
		scripted(
			'{"requests":[{"kind":"request","text":"Check the example import"}]}',
			'{"updates":[{"ref":"r1","status":"done","evidence":"Import checked"}]}',
		).model,
		SCOPE,
		{ limit: 2, now: () => T0 },
	);
	expect((await rows(db))[0]?.status).toBe("done");
});

it("settles only this session's requests with completed Work explicitly linked in saved evidence", async () => {
	const db = fixture();
	const completed = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const pending = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	const foreign = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
	await db.insert(workItems).values([
		{
			id: completed,
			orgId: SCOPE.organizationId,
			title: "Fictional delivered result",
			disposition: "completed",
			projectId: "project-orchid",
			createdAt: T0,
		},
		{
			id: pending,
			orgId: SCOPE.organizationId,
			title: "Fictional unfinished result",
			disposition: "accepted",
			projectId: "project-orchid",
			createdAt: T0,
		},
		{
			id: foreign,
			orgId: "org-cedar",
			title: "Another organization",
			disposition: "completed",
			projectId: "project-orchid",
			createdAt: T0,
		},
	]);
	const cases = [
		{ id: "verified", evidence: `Work=${completed}` },
		{ id: "pending", evidence: `Work=${pending}` },
		{ id: "foreign", evidence: `Work=${foreign}` },
		{ id: "missing-evidence", evidence: null },
		{ id: "ask", evidence: `Work=${completed}`, kind: "ask" as const },
		{
			id: "other-session",
			evidence: `Work=${completed}`,
			sessionKey: "other-session",
		},
		{
			id: "other-project",
			evidence: `Work=${completed}`,
			projectId: "project-cedar",
		},
		{ id: "partial", evidence: `Work=${completed} Work=${pending}` },
	];
	for (const c of cases)
		await db.insert(agentSessionRequests).values({
			...SCOPE,
			projectId: "project-orchid",
			kind: "request" as const,
			text: c.id,
			status: "open" as const,
			sourceAt: T0,
			sourceKey: c.id,
			statusChangedAt: T0,
			createdAt: T0,
			updatedAt: T0,
			...c,
		});
	const before = await rows(db);
	const result = await settleRequestsWithCompletedWork(
		db,
		{ ...SCOPE, now: T0 },
		before,
	);
	expect([...result]).toEqual(["verified"]);
	const after = await rows(db);
	expect(after.find((row) => row.id === "verified")).toMatchObject({
		status: "done",
		evidence: expect.stringContaining(completed),
	});
	expect(after.filter((row) => row.status === "open")).toHaveLength(7);
});

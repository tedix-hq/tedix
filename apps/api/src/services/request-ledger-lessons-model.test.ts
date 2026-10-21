import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import {
	learningInteractionEvents,
	learningImprovementProposals,
} from "@tedix/db/schema/learning-feedback";
import { memoryFacts } from "@tedix/db/schema/memory-graph";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
	ledgerLessonNoveltyModel,
	recordLedgerLessonCandidates,
} from "./request-ledger-lessons";

const mocks = vi.hoisted(() => ({ judge: vi.fn(), route: vi.fn() }));
vi.mock("./jev-judgment", () => ({ executeJevJudgment: mocks.judge }));
vi.mock("./jev-memory-policy", () => ({
	resolveMemoryJudgmentRoute: mocks.route,
}));

const db = {} as never;
const env = {} as CloudflareEnv;
const boundary = { db, organizationId: "org-example", ownerUserId: "ada" };
const prompt = JSON.stringify({
	existing: ["Use native uploads for oversized bodies"],
	candidates: [
		{ index: 0, rule: "Large inline bodies fail; use native upload" },
		{ index: 1, rule: "Native uploads time out; increase their timeout" },
		{
			index: 2,
			rule: "Native uploads are now broken; use chunked inline bodies",
		},
		{
			index: 3,
			rule: "Increase the native uploader timeout when it times out",
		},
	],
});
function verdict(choice: string) {
	return {
		type: "choice",
		choice,
		probabilities: { [choice]: 1 },
		confidence: 1,
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.route.mockResolvedValue({
		mode: "enforce",
		model: "@cf/cloudflare/clef-flash",
		transport: "cloudflare",
		timeoutMs: 1800,
	});
	mocks.judge.mockResolvedValue({
		answers: {
			candidate_0: verdict("duplicate"),
			candidate_1: verdict("novel"),
			candidate_2: verdict("contradictory"),
			candidate_3: verdict("duplicate"),
		},
	});
});

it("uses bounded decisions for paraphrases, distinct fixes, newer contradictions and first equivalents", async () => {
	const model = ledgerLessonNoveltyModel(env);
	expect(JSON.parse((await model(prompt, boundary))!)).toEqual({
		novel: [1, 2],
	});
	expect(mocks.route).toHaveBeenCalledWith(db, "org-example", "memoryQuality");
	const call = mocks.judge.mock.calls[0]![0];
	expect(call).toMatchObject({
		db,
		env,
		context: { organizationId: "org-example", sessionKey: expect.any(String) },
		model: "@cf/cloudflare/clef-flash",
		transport: "cloudflare",
		timeoutMs: 1800,
		source: "system:agent-session-lesson-dedup",
		billingSource: "system",
	});
	expect(call.context.sessionKey).not.toContain("ada");
	expect(Object.keys(call.questions)).toHaveLength(4);
	for (const question of Object.values(call.questions) as Array<{
		type: string;
		criteria: object;
		instructions: string;
	}>) {
		expect(question.type).toBe("choice");
		expect(Object.keys(question.criteria)).toEqual([
			"novel",
			"duplicate",
			"contradictory",
			"unclear",
		]);
		expect(question.instructions).toContain("earlier");
	}
});

it("takes model and transport from organization policy", async () => {
	mocks.route.mockResolvedValue({
		mode: "enforce",
		model: "typesafe/jev",
		transport: "direct",
		timeoutMs: 2500,
	});
	await ledgerLessonNoveltyModel(env, boundary)(prompt);
	expect(mocks.judge).toHaveBeenCalledWith(
		expect.objectContaining({
			model: "typesafe/jev",
			transport: "direct",
			timeoutMs: 2500,
		}),
	);
});

it.each([null, { mode: "shadow", model: "@cf/cloudflare/clef-flash" }])(
	"does not dispatch when policy is unavailable or shadow: %j",
	async (route) => {
		mocks.route.mockResolvedValue(route);
		await expect(
			ledgerLessonNoveltyModel(env)(prompt, boundary),
		).resolves.toBeNull();
		expect(mocks.judge).not.toHaveBeenCalled();
	},
);

it.each([
	undefined,
	{ ...boundary, ownerUserId: "" },
	{ ...boundary, organizationId: "" },
])(
	"requires an explicit organization and person before dispatch: %j",
	async (scope) => {
		await expect(
			ledgerLessonNoveltyModel(env)(prompt, scope),
		).resolves.toBeNull();
		expect(mocks.route).not.toHaveBeenCalled();
		expect(mocks.judge).not.toHaveBeenCalled();
	},
);

it.each([
	null,
	{ answers: {} },
	{ answers: { candidate_0: verdict("unclear") } },
	{ answers: { candidate_0: verdict("approve") } },
	{ answers: { candidate_0: { type: "noul", noul: 1 } } },
])(
	"retries unavailable, unclear and malformed judgments without selecting a subset: %j",
	async (response) => {
		mocks.judge.mockResolvedValue(response);
		await expect(
			ledgerLessonNoveltyModel(env)(prompt, boundary),
		).resolves.toBeNull();
	},
);

it("rejects malformed candidate input before model dispatch", async () => {
	for (const raw of [
		"bad JSON",
		'{"novel":[0]}',
		'{"existing":[],"candidates":[{"index":4,"rule":"bad index"}]}',
	]) {
		await expect(
			ledgerLessonNoveltyModel(env)(raw, boundary),
		).resolves.toBeNull();
	}
	expect(mocks.judge).not.toHaveBeenCalled();
});

function ledgerFixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			learningInteractionEvents,
			learningImprovementProposals,
			memoryFacts,
		),
	);
	sqlite
		.prepare(`INSERT INTO memory_facts
		(id,organization_id,content,fact_type,confidence,visibility,review_status,status)
		VALUES ('memory','org-example','Use native uploads for oversized bodies','observation',0.9,'org','confirmed','active')`)
		.run();
	const db = createDbClient(createD1Facade(sqlite));
	const lessons = (
		JSON.parse(prompt).candidates as Array<{ rule: string }>
	).map(({ rule }, index) => ({
		rule,
		failure: "Failed upload",
		fix: "Upload succeeded",
		failureEventId: `failure-${index}`,
		fixEventId: `fix-${index}`,
	}));
	const scope = {
		organizationId: "org-example",
		ownerUserId: "ada",
		repository: "example/app",
		harness: "codex",
		sessionKey: "example-session",
		sourceAt: "2026-10-21T10:00:00Z",
	};
	return { sqlite, db, lessons, scope };
}

it("keeps the first distinct fix and newer contradiction proposed without approving or superseding memory", async () => {
	const { sqlite, db, lessons, scope } = ledgerFixture();
	try {
		const memory = sqlite.prepare("SELECT * FROM memory_facts").all();
		await recordLedgerLessonCandidates(
			db,
			lessons,
			scope,
			ledgerLessonNoveltyModel(env),
		);
		expect(
			sqlite
				.prepare(
					"SELECT recommendation,status,scope_kind,scope_id FROM learning_improvement_proposals ORDER BY recommendation",
				)
				.all(),
		).toEqual(
			[lessons[1]!, lessons[2]!]
				.map(({ rule }) => ({
					recommendation: rule,
					status: "proposed",
					scope_kind: "personal",
					scope_id: "ada",
				}))
				.sort((a, b) => a.recommendation.localeCompare(b.recommendation)),
		);
		expect(sqlite.prepare("SELECT * FROM memory_facts").all()).toEqual(memory);
		expect(mocks.judge.mock.calls[0]![0].context.organizationId).toBe(
			scope.organizationId,
		);
	} finally {
		sqlite.close();
	}
});

it.each(["unavailable", "unclear", "malformed", "timeout"])(
	"leaves the entire event retryable on %s, then records the successful retry",
	async (failure) => {
		const { sqlite, db, lessons, scope } = ledgerFixture();
		try {
			if (failure === "timeout")
				mocks.judge.mockRejectedValueOnce(new Error("timeout"));
			else if (failure === "unavailable")
				mocks.judge.mockResolvedValueOnce(null);
			else
				mocks.judge.mockResolvedValueOnce({
					answers: {
						candidate_0: verdict("duplicate"),
						candidate_1: verdict("novel"),
						candidate_2: verdict(failure === "unclear" ? "unclear" : "approve"),
						candidate_3: verdict("duplicate"),
					},
				});
			const model = ledgerLessonNoveltyModel(env);
			await expect(
				recordLedgerLessonCandidates(db, lessons, scope, model),
			).rejects.toThrow();
			expect(
				sqlite
					.prepare("SELECT count(*) n FROM learning_improvement_proposals")
					.get(),
			).toEqual({ n: 0 });
			expect(
				sqlite
					.prepare("SELECT count(*) n FROM learning_interaction_events")
					.get(),
			).toEqual({ n: 0 });
			await recordLedgerLessonCandidates(db, lessons, scope, model);
			expect(
				sqlite
					.prepare("SELECT count(*) n FROM learning_improvement_proposals")
					.get(),
			).toEqual({ n: 2 });
		} finally {
			sqlite.close();
		}
	},
);

it("accounts for each person and organization with a distinct opaque correlation", async () => {
	const model = ledgerLessonNoveltyModel(env);
	await model(prompt, boundary);
	await model(prompt, { ...boundary, ownerUserId: "bea" });
	await model(prompt, { ...boundary, organizationId: "org-elsewhere" });
	const calls = mocks.judge.mock.calls.map(([call]) => call);
	expect(new Set(calls.map((call) => call.context.sessionKey)).size).toBe(3);
	expect(calls[2].context.organizationId).toBe("org-elsewhere");
	for (const call of calls) {
		expect(JSON.stringify(call.state)).not.toContain("ownerUserId");
	}
});

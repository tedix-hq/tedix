/**
 * Conversation auto-title unit coverage: the pure helpers (prompt building,
 * sanitizer, guard decision) plus the fail-soft orchestration of
 * `generateAndPersistHomeConversationTitle` (guard short-circuits, LLM failure
 * tolerance, persist payload shape) with the `ai` module mocked and a scripted
 * chainable db stub — no network, no real D1.
 */

import type { DbClient } from "@tedix/db/client";
import { describe, expect, it, vi } from "vite-plus/test";

const mockGenerateText = vi.fn();
// The kernel's inference goes through the traced AI SDK namespace
// (`src/lib/traced-ai.ts`), so that is the module to intercept — mocking "ai"
// would leave the wrapper calling the real SDK.
vi.mock("../../../lib/traced-ai", () => ({
	tracedAi: {
		generateText: (...args: unknown[]) => mockGenerateText(...args),
	},
}));

import type { BaseContext } from "../../orpc";
import {
	buildConversationTitlePrompt,
	evaluateAutoTitleGuard,
	generateAndPersistHomeConversationTitle,
} from "./conversation-title";
import {
	fallbackConversationTitle,
	KERNEL_AUTO_TITLE_SOURCE,
	sanitizeConversationTitle,
} from "./conversation-index";

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("buildConversationTitlePrompt", () => {
	it("removes context envelopes before truncating the operator request", () => {
		const prompt = buildConversationTitlePrompt({
			userContent: `[[tedix-context:workspace:id:${"Long%20label".repeat(100)}]]\n\nReview supplier delivery`,
			assistantContent: "Here is the review.",
		});
		expect(prompt).toBe(
			"User: Review supplier delivery\n\nAssistant: Here is the review.",
		);
	});
	it("renders both sides of the exchange", () => {
		const prompt = buildConversationTitlePrompt({
			userContent: "  How do invoices sync to globex?  ",
			assistantContent: "They sync via the connector.",
		});
		expect(prompt).toBe(
			"User: How do invoices sync to globex?\n\nAssistant: They sync via the connector.",
		);
	});

	it("truncates each side to 500 chars", () => {
		const prompt = buildConversationTitlePrompt({
			userContent: "u".repeat(2000),
			assistantContent: "a".repeat(2000),
		});
		const [userLine, assistantLine] = prompt.split("\n\n");
		expect(userLine).toBe(`User: ${"u".repeat(500)}`);
		expect(assistantLine).toBe(`Assistant: ${"a".repeat(500)}`);
	});
});

describe("fallbackConversationTitle", () => {
	it("uses the request after an encoded workspace reference", () => {
		expect(
			fallbackConversationTitle(
				"[[tedix-context:workspace:abc:Supplier%20review]]\n\nCreate a workspace document.",
			),
		).toBe("Create a workspace document");
	});
	it("omits reference-only and incomplete metadata titles", () => {
		expect(
			fallbackConversationTitle("[[tedix-context:output:abc:Report]]"),
		).toBeNull();
		expect(
			sanitizeConversationTitle(
				"[[tedix-context:workspace:abc:Supplier%20review",
			),
		).toBeNull();
	});
	it("preserves ordinary bracketed text", () => {
		expect(fallbackConversationTitle("Review [draft] supplier terms.")).toBe(
			"Review [draft] supplier terms",
		);
	});
	it("derives a bounded durable title from the first user sentence", () => {
		expect(
			fallbackConversationTitle(
				"List exactly three active tedis in this workspace. Only names.",
			),
		).toBe("List exactly three active tedis in this workspace");
	});
});

describe("sanitizeConversationTitle", () => {
	it("passes a clean 3-6 word title through", () => {
		expect(sanitizeConversationTitle("Quarterly Revenue Sync Question")).toBe(
			"Quarterly Revenue Sync Question",
		);
	});

	it("strips wrapping quotes and trailing punctuation", () => {
		expect(sanitizeConversationTitle('"Globex Invoice Sync."')).toBe(
			"Globex Invoice Sync",
		);
		expect(sanitizeConversationTitle("“Deploy Pipeline Review”")).toBe(
			"Deploy Pipeline Review",
		);
		expect(sanitizeConversationTitle("`Kernel Routing Question`")).toBe(
			"Kernel Routing Question",
		);
	});

	it("strips a Title: prefix and markdown decoration", () => {
		expect(sanitizeConversationTitle("Title: Budget Forecast Help")).toBe(
			"Budget Forecast Help",
		);
		expect(sanitizeConversationTitle("# Budget Forecast Help")).toBe(
			"Budget Forecast Help",
		);
	});

	it("takes the first non-empty line and collapses whitespace", () => {
		expect(
			sanitizeConversationTitle("\n\n  Weekly   Report   Plan  \nextra line"),
		).toBe("Weekly Report Plan");
	});

	it("caps runaway output at 8 words", () => {
		expect(
			sanitizeConversationTitle(
				"one two three four five six seven eight nine ten",
			),
		).toBe("one two three four five six seven eight");
	});

	it("rejects refusal/apology-shaped output (observed live)", () => {
		expect(
			sanitizeConversationTitle("I’m sorry, but I can’t help with that"),
		).toBeNull();
		expect(sanitizeConversationTitle("I'm sorry, I cannot do that")).toBeNull();
		expect(sanitizeConversationTitle("Sorry, that is out of scope")).toBeNull();
		expect(sanitizeConversationTitle("I cannot assist with this")).toBeNull();
		expect(sanitizeConversationTitle("Unable to generate a title")).toBeNull();
		expect(sanitizeConversationTitle("As an AI I cannot answer")).toBeNull();
		expect(sanitizeConversationTitle("I apologize, no title fits")).toBeNull();
		// Refusal words NOT in opener position stay legal titles.
		expect(sanitizeConversationTitle("Apology Email Draft Review")).toBe(
			"Apology Email Draft Review",
		);
		expect(sanitizeConversationTitle("Drafting a Sorry Note")).toBe(
			"Drafting a Sorry Note",
		);
	});

	it("rejects empty and placeholder output", () => {
		expect(sanitizeConversationTitle(null)).toBeNull();
		expect(sanitizeConversationTitle(undefined)).toBeNull();
		expect(sanitizeConversationTitle("   ")).toBeNull();
		expect(sanitizeConversationTitle('"..."')).toBeNull();
		expect(sanitizeConversationTitle("Chat")).toBeNull();
		expect(sanitizeConversationTitle("Untitled chat")).toBeNull();
		expect(sanitizeConversationTitle("New")).toBeNull();
	});
});

describe("evaluateAutoTitleGuard", () => {
	const base = {
		conversationId: "home:abc-123",
		conversationUpdatedCount: 0,
		completedMessageCount: 1,
	};

	it("allows the first settled exchange of an unlabelled topical conversation", () => {
		expect(evaluateAutoTitleGuard(base)).toBe(true);
	});

	it("never titles the org's main Home thread", () => {
		expect(
			evaluateAutoTitleGuard({ ...base, conversationId: "home:main" }),
		).toBe(false);
	});

	it("yields to any existing conversation.updated event (rename OR prior auto-title)", () => {
		expect(
			evaluateAutoTitleGuard({ ...base, conversationUpdatedCount: 1 }),
		).toBe(false);
	});

	it("only fires on the FIRST assistant settlement", () => {
		expect(evaluateAutoTitleGuard({ ...base, completedMessageCount: 2 })).toBe(
			false,
		);
		// Zero is fine too (clock skew / event insert raced) — still "first".
		expect(evaluateAutoTitleGuard({ ...base, completedMessageCount: 0 })).toBe(
			true,
		);
	});

	it("never titles marker-per-CI-run smoke/evidence conversations", () => {
		expect(
			evaluateAutoTitleGuard({
				...base,
				conversationId:
					"home:kernel-steering:kernel-steering-live-smoke-1783401787106",
			}),
		).toBe(false);
		expect(
			evaluateAutoTitleGuard({
				...base,
				conversationId: "home:mcp-tasks-live-smoke-1783400706413",
			}),
		).toBe(false);
	});

	it("titles a real CLI session (home:cli:* is not ephemeral)", () => {
		expect(
			evaluateAutoTitleGuard({
				...base,
				conversationId: "home:cli:thread:kernel-depth-redrive",
			}),
		).toBe(true);
		expect(
			evaluateAutoTitleGuard({
				...base,
				conversationId: "home:cli:-Users-ada-Documents-GitHub-tedix:mr9qmhs7",
			}),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// orchestration (mocked ai + scripted db)
// ---------------------------------------------------------------------------

/**
 * Chainable thenable db proxy: each `await` on a query chain resolves the next
 * scripted result (last result repeats). `.values(...)` calls are captured so
 * the persisted event row can be asserted.
 */
function scriptedDb(
	results: unknown[][],
	insertedValues: unknown[] = [],
): DbClient {
	let step = 0;
	const proxy: unknown = new Proxy(function noop() {}, {
		get(_target, prop) {
			if (prop === "then") {
				const value = results[Math.min(step, results.length - 1)] ?? [];
				step += 1;
				return (resolve: (value: unknown) => void) => resolve(value);
			}
			if (prop === "values") {
				return (value: unknown) => {
					insertedValues.push(value);
					return proxy;
				};
			}
			return proxy;
		},
		apply() {
			return proxy;
		},
	});
	return proxy as DbClient;
}

function modelEnv(): CloudflareEnv {
	return {
		AZURE_OPENAI_BASE_URL: "https://test.openai.azure.com",
		AZURE_CHAT_DEPLOYMENT: "gpt-test",
		AI_GATEWAY_ACCOUNT_ID: "account",
		AI_GATEWAY_LLM_ID: "gateway",
		CF_AI_GATEWAY_TOKEN: "token",
	} as unknown as CloudflareEnv;
}

function contextWith(db: DbClient, env: CloudflareEnv): BaseContext {
	return { db, env } as unknown as BaseContext;
}

/** Row shape run-store's insert `.returning()` resolves for normalizeHomeEvent. */
function insertedEventRow() {
	return {
		id: "event-1",
		organizationId: "org-1",
		kind: "conversation.updated",
		conversationId: "home:abc-123",
		runId: "run-1",
		messageId: null,
		delegatedTediId: null,
		childRunId: null,
		sequence: null,
		delta: null,
		payload: {},
		runtimeBackend: "custom",
		runtimeExternalId: null,
		runtimeExternalUrl: null,
		runtimeMetadata: null,
		traceId: null,
		createdAt: "2026-07-06T00:00:00.000Z",
	};
}

function turnInput() {
	return {
		organizationId: "org-1",
		conversationId: "home:abc-123",
		runId: "run-1",
		userContent: "How do invoices sync to globex?",
		assistantContent: "They sync via the connector.",
	};
}

describe("generateAndPersistHomeConversationTitle", () => {
	it("persists a private title without putting title or conversation content in logs", async () => {
		const title = "Confidential supplier contract review";
		const conversationId = "home:cli:/private/customer-workspace";
		const userContent = "Review our private acquisition terms";
		mockGenerateText.mockReset();
		mockGenerateText.mockResolvedValue({ text: title });
		const inserted: unknown[] = [];
		const db = scriptedDb(
			[[{ kind: "message.completed", count: 1 }], [insertedEventRow()]],
			inserted,
		);
		const logs = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await generateAndPersistHomeConversationTitle(
				contextWith(db, modelEnv()),
				{
					...turnInput(),
					conversationId,
					userContent,
				},
			);
			expect(
				(inserted[0] as { payload: { title: string } }).payload.title,
			).toBe(title);
			expect(logs).toHaveBeenCalledWith({
				component: "kernel.conversation_title",
				event: "auto_title_set",
			});
			const logText = JSON.stringify(logs.mock.calls);
			expect(logText).not.toContain(title);
			expect(logText).not.toContain(userContent);
			expect(logText).not.toContain(conversationId);
		} finally {
			logs.mockRestore();
		}
	});

	it("keeps provider text out of failure logs while persisting the fallback", async () => {
		const providerText = "Bearer sk-private-provider-response";
		const causeText = "private prompt body";
		mockGenerateText.mockReset();
		mockGenerateText.mockRejectedValue(
			new Error(providerText, { cause: new TypeError(causeText) }),
		);
		const inserted: unknown[] = [];
		const db = scriptedDb(
			[[{ kind: "message.completed", count: 1 }], [insertedEventRow()]],
			inserted,
		);
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		const logs = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await generateAndPersistHomeConversationTitle(
				contextWith(db, modelEnv()),
				turnInput(),
			);
			expect(
				(inserted[0] as { payload: { title: string } }).payload.title,
			).toBe("How do invoices sync to globex");
			expect(warnings).toHaveBeenCalledWith({
				component: "kernel.conversation_title",
				event: "auto_title_model_failed",
				exception: { type: "Error", cause: { type: "TypeError" } },
			});
			const logText = JSON.stringify([
				...warnings.mock.calls,
				...logs.mock.calls,
			]);
			expect(logText).not.toContain(providerText);
			expect(logText).not.toContain(causeText);
			expect(logText).not.toContain("How do invoices sync to globex");
		} finally {
			warnings.mockRestore();
			logs.mockRestore();
		}
	});

	it("logs a failed guard read without exposing its error text or content", async () => {
		const privateText = "customer token in database failure";
		const db = {
			select: () => {
				throw new Error(privateText, {
					cause: new TypeError("private SQL parameter"),
				});
			},
		} as unknown as DbClient;
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(
				generateAndPersistHomeConversationTitle(
					contextWith(db, modelEnv()),
					turnInput(),
				),
			).resolves.toBeUndefined();
			expect(warnings).toHaveBeenCalledWith({
				component: "kernel.conversation_title",
				event: "auto_title_failed",
				exception: { type: "Error", cause: { type: "TypeError" } },
			});
			const logText = JSON.stringify(warnings.mock.calls);
			expect(logText).not.toContain(privateText);
			expect(logText).not.toContain("private SQL parameter");
			expect(logText).not.toContain(turnInput().conversationId);
		} finally {
			warnings.mockRestore();
		}
	});

	it("happy path: guard passes → cheap LLM call → conversation.updated persisted with the autoTitle source", async () => {
		mockGenerateText.mockReset();
		mockGenerateText.mockResolvedValue({ text: '"Globex Invoice Sync."' });
		const inserted: unknown[] = [];
		const db = scriptedDb(
			[
				// guard: only the just-inserted assistant settlement exists
				[{ kind: "message.completed", count: 1 }],
				// insert .returning()
				[insertedEventRow()],
			],
			inserted,
		);

		await generateAndPersistHomeConversationTitle(
			contextWith(db, modelEnv()),
			turnInput(),
		);

		expect(mockGenerateText).toHaveBeenCalledTimes(1);
		const call = mockGenerateText.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(call.system).toContain("3-6 word title");
		expect(inserted).toHaveLength(1);
		const row = inserted[0] as {
			id: string;
			kind: string;
			conversationId: string;
			payload: Record<string, unknown>;
		};
		expect(row.kind).toBe("conversation.updated");
		expect(row.conversationId).toBe("home:abc-123");
		// Idempotency: the event id is keyed to the settled run.
		expect(row.id).toContain("run-1");
		expect(row.payload).toEqual({
			conversation: { title: "Globex Invoice Sync" },
			title: "Globex Invoice Sync",
			source: KERNEL_AUTO_TITLE_SOURCE,
		});
	});

	it("existing conversation.updated event (user rename or prior auto-title) → no LLM call, no write", async () => {
		mockGenerateText.mockReset();
		const inserted: unknown[] = [];
		const db = scriptedDb(
			[
				[
					{ kind: "conversation.updated", count: 1 },
					{ kind: "message.completed", count: 1 },
				],
			],
			inserted,
		);

		await generateAndPersistHomeConversationTitle(
			contextWith(db, modelEnv()),
			turnInput(),
		);

		expect(mockGenerateText).not.toHaveBeenCalled();
		expect(inserted).toHaveLength(0);
	});

	it("not the first exchange → no LLM call, no write", async () => {
		mockGenerateText.mockReset();
		const inserted: unknown[] = [];
		const db = scriptedDb(
			[[{ kind: "message.completed", count: 3 }]],
			inserted,
		);

		await generateAndPersistHomeConversationTitle(
			contextWith(db, modelEnv()),
			turnInput(),
		);

		expect(mockGenerateText).not.toHaveBeenCalled();
		expect(inserted).toHaveLength(0);
	});

	it("home:main is never auto-titled", async () => {
		mockGenerateText.mockReset();
		const inserted: unknown[] = [];
		const db = scriptedDb([], inserted);

		await generateAndPersistHomeConversationTitle(contextWith(db, modelEnv()), {
			...turnInput(),
			conversationId: "home:main",
		});

		expect(mockGenerateText).not.toHaveBeenCalled();
		expect(inserted).toHaveLength(0);
	});

	it("unconfigured model env persists a deterministic first-message fallback", async () => {
		mockGenerateText.mockReset();
		const inserted: unknown[] = [];
		const db = scriptedDb(
			[[{ kind: "message.completed", count: 1 }], [insertedEventRow()]],
			inserted,
		);

		await generateAndPersistHomeConversationTitle(
			contextWith(db, {} as CloudflareEnv),
			turnInput(),
		);

		expect(mockGenerateText).not.toHaveBeenCalled();
		expect(inserted).toHaveLength(1);
		expect((inserted[0] as { payload: { title: string } }).payload.title).toBe(
			"How do invoices sync to globex",
		);
	});

	it("LLM failure is swallowed and persists the deterministic fallback", async () => {
		mockGenerateText.mockReset();
		mockGenerateText.mockRejectedValue(new Error("provider down"));
		const inserted: unknown[] = [];
		const db = scriptedDb(
			[[{ kind: "message.completed", count: 1 }], [insertedEventRow()]],
			inserted,
		);

		await expect(
			generateAndPersistHomeConversationTitle(
				contextWith(db, modelEnv()),
				turnInput(),
			),
		).resolves.toBeUndefined();

		expect(mockGenerateText).toHaveBeenCalledTimes(1);
		expect(inserted).toHaveLength(1);
	});

	it("placeholder model output falls back to the first user message", async () => {
		mockGenerateText.mockReset();
		mockGenerateText.mockResolvedValue({ text: '"Chat"' });
		const inserted: unknown[] = [];
		const db = scriptedDb(
			[[{ kind: "message.completed", count: 1 }], [insertedEventRow()]],
			inserted,
		);

		await generateAndPersistHomeConversationTitle(
			contextWith(db, modelEnv()),
			turnInput(),
		);

		expect(mockGenerateText).toHaveBeenCalledTimes(1);
		expect(inserted).toHaveLength(1);
		expect((inserted[0] as { payload: { title: string } }).payload.title).toBe(
			"How do invoices sync to globex",
		);
	});

	it("empty exchange sides → quiet no-op before any db read", async () => {
		mockGenerateText.mockReset();
		const inserted: unknown[] = [];
		const db = scriptedDb([], inserted);

		await generateAndPersistHomeConversationTitle(contextWith(db, modelEnv()), {
			...turnInput(),
			assistantContent: "   ",
		});

		expect(mockGenerateText).not.toHaveBeenCalled();
		expect(inserted).toHaveLength(0);
	});
});

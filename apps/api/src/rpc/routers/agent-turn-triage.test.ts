/**
 * Agent-turn triage router: urgency scoring over a mocked Clef binding, the
 * never-throw degradation on model error/timeout, and the policy row's
 * revision compare-and-swap against a real D1 facade.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import type { AgentTurnTriagePolicyInput } from "@tedix/api-contract/schemas/agent-turn-triage";
import { createDbClient } from "@tedix/db/client";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import {
	AGENT_TURN_TRIAGE_NAMESPACE,
	agentTurnTriageContractRouter,
	DEFAULT_AGENT_TURN_TRIAGE_POLICY,
} from "./agent-turn-triage";

const ORG_1 = "00000000-0000-4000-8000-000000000001";

type AiRun = (
	model: string,
	inputs: Record<string, unknown>,
	options?: Record<string, unknown>,
) => Promise<unknown>;

function createEnv(run: AiRun): { env: CloudflareEnv; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(userConfigs));
	return {
		sqlite,
		env: {
			ENVIRONMENT: "test",
			DB: createD1Facade(sqlite),
			AI: { run: vi.fn(run) },
			AI_GATEWAY_LLM_ID: "",
		} as unknown as CloudflareEnv,
	};
}

function userContext(
	env: CloudflareEnv,
	permissions: string[] = ["tedis:read", "tedis:update"],
): BaseContext {
	return {
		authType: "user",
		db: createDbClient(env.DB) as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId: ORG_1,
		userId: "tedix-user-1",
		url: new URL("https://api.tedix.test/rpc/agentTurnTriage"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions,
			roles: [],
			sub: "descope-user-1",
		},
	} as BaseContext;
}

function apiKeyContext(env: CloudflareEnv, scopes: string[]): BaseContext {
	return {
		apiKey: { id: "key-1", name: "test", organizationId: ORG_1, scopes },
		authType: "apikey",
		db: createDbClient(env.DB) as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId: ORG_1,
		url: new URL("https://api.tedix.test/rpc/agentTurnTriage"),
	} as BaseContext;
}

function client(context: BaseContext) {
	return createRouterClient(agentTurnTriageContractRouter, { context });
}

function noulAnswers(probabilities: Record<string, number>) {
	return {
		model: "clef-flash",
		usage: { input_tokens: 400, output_tokens: 0 },
		answers: Object.fromEntries(
			Object.entries(probabilities).map(([id, noul]) => [
				id,
				{ type: "noul", noul },
			]),
		),
	};
}

describe("triage", () => {
	it("sends the Clef request shape and reports later below every threshold", async () => {
		const { env } = createEnv(async () =>
			noulAnswers({
				blocker_or_failure: 0.1,
				human_only_action: 0.2,
				risky_action: 0.49,
			}),
		);
		const result = await client(userContext(env)).triage({
			text: "All checks pass; committed.",
		});
		expect(result).toMatchObject({
			status: "ok",
			urgency: "later",
			labels: {
				blocker_or_failure: 0.1,
				human_only_action: 0.2,
				risky_action: 0.49,
			},
			urgentLabels: [],
			model: "@cf/cloudflare/clef-flash",
			policyVersion: 1,
		});
		const run = env.AI.run as unknown as ReturnType<typeof vi.fn>;
		expect(run).toHaveBeenCalledTimes(1);
		const [model, body, options] = run.mock.calls[0] ?? [];
		expect(model).toBe("@cf/cloudflare/clef-flash");
		expect(body).toEqual({
			model: "clef-flash",
			state: { agent_message: "All checks pass; committed." },
			questions: Object.fromEntries(
				DEFAULT_AGENT_TURN_TRIAGE_POLICY.questions.map((q) => [
					q.id,
					{ type: "noul", instructions: q.instructions },
				]),
			),
		});
		expect(options).toHaveProperty("signal");
	});

	it("answers now when any label reaches its urgentWhen.gte", async () => {
		const { env } = createEnv(async () =>
			noulAnswers({
				blocker_or_failure: 0.5,
				human_only_action: 0.9,
				risky_action: 0.1,
			}),
		);
		const result = await client(userContext(env)).triage({
			text: "Please log in to Descope; the deploy check is failing.",
		});
		expect(result.urgency).toBe("now");
		expect(result.urgentLabels).toEqual([
			"blocker_or_failure",
			"human_only_action",
		]);
	});

	it("degrades to unavailable when the model errors", async () => {
		const { env } = createEnv(async () => {
			throw new Error("5xx from Workers AI");
		});
		const result = await client(userContext(env)).triage({ text: "hi" });
		expect(result).toMatchObject({
			status: "unavailable",
			urgency: "later",
			labels: {},
			urgentLabels: [],
		});
	});

	it("degrades to unavailable on a malformed answer", async () => {
		const { env } = createEnv(async () => ({ answers: { other: 1 } }));
		const result = await client(userContext(env)).triage({ text: "hi" });
		expect(result.status).toBe("unavailable");
	});

	it("degrades to unavailable after the 2.5s timeout", async () => {
		vi.useFakeTimers();
		try {
			const { env } = createEnv(() => new Promise(() => undefined));
			const pending = client(userContext(env)).triage({ text: "hi" });
			await vi.advanceTimersByTimeAsync(2_600);
			await expect(pending).resolves.toMatchObject({
				status: "unavailable",
				urgency: "later",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("skips the model call when the stored policy is disabled", async () => {
		const { env } = createEnv(async () => noulAnswers({}));
		const c = client(userContext(env));
		const { version: _version, ...defaults } = DEFAULT_AGENT_TURN_TRIAGE_POLICY;
		await c.updatePolicy({
			policy: { ...defaults, enabled: false },
			expectedRevision: 0,
		});
		const result = await c.triage({ text: "hi" });
		expect(result).toMatchObject({ status: "unavailable", policyVersion: 2 });
		expect(env.AI.run).not.toHaveBeenCalled();
	});

	it("uses stored questions and thresholds", async () => {
		const { env } = createEnv(async () => noulAnswers({ cost_spike: 0.3 }));
		const c = client(userContext(env));
		await c.updatePolicy({
			policy: {
				enabled: true,
				model: "@cf/cloudflare/clef",
				questions: [
					{
						id: "cost_spike",
						instructions: "Does the agent report unexpected spend?",
						urgentWhen: { gte: 0.25 },
					},
				],
			},
			expectedRevision: 0,
		});
		const result = await c.triage({ text: "Spend doubled today." });
		expect(result).toMatchObject({
			status: "ok",
			urgency: "now",
			urgentLabels: ["cost_spike"],
			model: "@cf/cloudflare/clef",
		});
		const run = env.AI.run as unknown as ReturnType<typeof vi.fn>;
		expect(run.mock.calls[0]?.[1]).toMatchObject({ model: "clef" });
	});

	it("rejects text over 20000 characters", async () => {
		const { env } = createEnv(async () => noulAnswers({}));
		await expect(
			client(userContext(env)).triage({ text: "x".repeat(20_001) }),
		).rejects.toThrow();
	});

	it("requires mcp:messaging.read for machine principals", async () => {
		const { env } = createEnv(async () =>
			noulAnswers({
				blocker_or_failure: 0,
				human_only_action: 0,
				risky_action: 0,
			}),
		);
		await expect(
			client(apiKeyContext(env, ["apps:read"])).triage({ text: "hi" }),
		).rejects.toThrow();
		await expect(
			client(apiKeyContext(env, ["mcp:messaging.read"])).triage({
				text: "hi",
			}),
		).resolves.toMatchObject({ status: "ok", policyVersion: 1 });
	});
});

describe("labelReply", () => {
	it("returns the chosen reply class and its probability", async () => {
		const { env } = createEnv(async () => ({
			model: "clef-flash",
			usage: { input_tokens: 100, output_tokens: 0 },
			answers: {
				reply_class: {
					type: "choice",
					choice: "ship",
					probabilities: { ship: 0.8, continue: 0.2 },
					confidence: 0.7,
				},
			},
		}));
		const result = await client(userContext(env)).labelReply({
			turnText: "Tests pass. Commit?",
			replyText: "commit and push",
		});
		expect(result).toEqual({
			status: "ok",
			label: "ship",
			p: 0.8,
			model: "@cf/cloudflare/clef-flash",
		});
		const run = env.AI.run as unknown as ReturnType<typeof vi.fn>;
		const body = run.mock.calls[0]?.[1] as {
			state: unknown;
			questions: { reply_class: { type: string; criteria: object } };
		};
		expect(body.state).toEqual({
			agent_last_message: "Tests pass. Commit?",
			operator_reply: "commit and push",
		});
		expect(body.questions.reply_class.type).toBe("choice");
		expect(Object.keys(body.questions.reply_class.criteria)).toEqual([
			"continue",
			"approve",
			"ship",
			"fan-out",
			"simplify",
			"verify",
			"challenge",
			"correction",
			"plain-english",
			"status",
			"frustration",
			"question",
			"instruction",
		]);
	});

	it("degrades to unavailable when the model errors or picks an unknown class", async () => {
		const failing = createEnv(async () => {
			throw new Error("boom");
		});
		await expect(
			client(userContext(failing.env)).labelReply({
				turnText: "",
				replyText: "ok",
			}),
		).resolves.toEqual({
			status: "unavailable",
			label: null,
			p: null,
			model: "@cf/cloudflare/clef-flash",
		});
		const unknown = createEnv(async () => ({
			answers: {
				reply_class: {
					type: "choice",
					choice: "invented",
					probabilities: { invented: 1 },
					confidence: 1,
				},
			},
		}));
		await expect(
			client(userContext(unknown.env)).labelReply({
				turnText: "",
				replyText: "ok",
			}),
		).resolves.toMatchObject({ status: "unavailable" });
	});
});

describe("policy", () => {
	let env: CloudflareEnv;
	let sqlite: DatabaseSync;
	beforeEach(() => {
		({ env, sqlite } = createEnv(async () => noulAnswers({})));
	});

	const CUSTOM: AgentTurnTriagePolicyInput = {
		enabled: true,
		model: "@cf/cloudflare/clef-flash",
		questions: [
			{
				id: "needs_review",
				instructions: "Does this need review?",
				urgentWhen: { gte: 0.7 },
			},
		],
		turnTypeChoices: ["report", "question"],
	};

	it("returns the versioned asset defaults when nothing is stored", async () => {
		const state = await client(userContext(env)).getPolicy({});
		expect(state).toEqual({
			policy: DEFAULT_AGENT_TURN_TRIAGE_POLICY,
			source: "default",
			revision: 0,
			updatedAt: null,
		});
		expect(state.policy.enabled).toBe(true);
		expect(state.policy.questions.map((q) => q.id)).toEqual([
			"blocker_or_failure",
			"human_only_action",
			"risky_action",
		]);
		expect(state.policy.questions.every((q) => q.urgentWhen.gte === 0.5)).toBe(
			true,
		);
	});

	it("stores under work.turn-triage keyed by org and bumps the version", async () => {
		const c = client(userContext(env));
		const saved = await c.updatePolicy({ policy: CUSTOM, expectedRevision: 0 });
		expect(saved).toMatchObject({
			source: "stored",
			revision: 1,
			policy: { ...CUSTOM, version: 2 },
		});
		const rows = sqlite
			.prepare(
				"SELECT namespace, key, value, revision FROM user_configs WHERE user_id = ?",
			)
			.all("tedix-user-1") as {
			namespace: string;
			key: string;
			value: string;
			revision: number;
		}[];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.namespace).toBe(AGENT_TURN_TRIAGE_NAMESPACE);
		expect(rows[0]?.key).toBe(ORG_1);
		expect(JSON.parse(rows[0]?.value ?? "null")).toEqual({
			...CUSTOM,
			drafting: { enabled: false },
			eligibility: { minRate: 0.9, minDrafts: 50 },
			autoSend: { enabled: false, maxConsecutive: 3 },
			version: 2,
		});

		const again = await c.updatePolicy({ policy: CUSTOM, expectedRevision: 1 });
		expect(again).toMatchObject({ revision: 2, policy: { version: 3 } });
		await expect(c.getPolicy({})).resolves.toMatchObject({
			source: "stored",
			revision: 2,
			policy: { version: 3 },
		});
	});

	it("refuses a stale revision with CONFLICT and writes nothing", async () => {
		const c = client(userContext(env));
		await c.updatePolicy({ policy: CUSTOM, expectedRevision: 0 });
		await expect(
			c.updatePolicy({
				policy: { ...CUSTOM, enabled: false },
				expectedRevision: 0,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { expectedRevision: 0, currentRevision: 1 },
		});
		await expect(
			c.updatePolicy({ policy: CUSTOM, expectedRevision: 7 }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(c.getPolicy({})).resolves.toMatchObject({
			revision: 1,
			policy: { enabled: true },
		});
	});

	it("rejects more than 32 questions and duplicate ids", async () => {
		const c = client(userContext(env));
		const question = CUSTOM.questions[0];
		if (!question) throw new Error("fixture");
		await expect(
			c.updatePolicy({
				policy: {
					...CUSTOM,
					questions: Array.from({ length: 33 }, (_, i) => ({
						...question,
						id: `q${i}`,
					})),
				},
				expectedRevision: 0,
			}),
		).rejects.toThrow();
		await expect(
			c.updatePolicy({
				policy: { ...CUSTOM, questions: [question, question] },
				expectedRevision: 0,
			}),
		).rejects.toThrow();
	});

	it("requires mcp:messaging.write for machine updates and a user identity to store", async () => {
		await expect(
			client(apiKeyContext(env, ["mcp:messaging.read"])).updatePolicy({
				policy: CUSTOM,
				expectedRevision: 0,
			}),
		).rejects.toThrow();
		await expect(
			client(apiKeyContext(env, ["mcp:messaging.write"])).updatePolicy({
				policy: CUSTOM,
				expectedRevision: 0,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("requires tedis:update for users", async () => {
		await expect(
			client(userContext(env, ["tedis:read"])).updatePolicy({
				policy: CUSTOM,
				expectedRevision: 0,
			}),
		).rejects.toThrow();
	});
});

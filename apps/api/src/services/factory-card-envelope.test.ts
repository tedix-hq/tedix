import { DatabaseSync } from "node:sqlite";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { CreateWorkItemInputSchema } from "@tedix/api-contract/schemas/work-items";
import { createDbClient } from "@tedix/db/client";
import { osGadgetRevisions, osGadgets } from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";

const outputs = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@orpc/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@orpc/server")>()),
	call: (_procedure: unknown, input: { outputId: string }) =>
		outputs.get(input),
}));
vi.mock("../rpc/routers/os-workspaces", () => ({
	osWorkspacesContractRouter: { outputs: { get: "outputs.get" } },
}));

import { prepareFactoryCard } from "./factory-card-envelope";

const ORG = "org-cards";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SHEET = "22222222-2222-4222-8222-222222222222";

const source = {
	label: "Forum",
	workspaceId: WORKSPACE,
	cardSheetPrefix: "Forum cards ",
	columns: {
		type: "Type",
		source: "Thread",
		why: "Why",
		action: "Action",
		useful: "Useful?",
		reason: "Reason",
		done: "Done?",
		score: "Score",
		timing: "Timing",
	},
	doIt: "approve",
	protectedEffects: ["message"],
	scoring: { weights: { fresh_thread: 0.5 }, maxAgeDays: 3 },
};

async function context() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(osGadgets, osGadgetRevisions));
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(osGadgets).values({
		id: "gadget-review",
		organizationId: ORG,
		workspaceId: WORKSPACE,
		name: "Card review",
		currentRevisionId: "rev-1",
		createdByKind: "user",
		createdById: "owner",
	});
	await db.insert(osGadgetRevisions).values({
		id: "rev-1",
		organizationId: ORG,
		gadgetId: "gadget-review",
		revision: 1,
		manifest: JSON.stringify({
			entry: "tedix:app/card-review",
			capabilities: [],
			config: { version: 1, sources: [source] },
		}),
		createdByKind: "user",
		createdById: "owner",
	});
	return { db } as unknown as BaseContext;
}

function work(patch: Record<string, unknown> = {}) {
	return CreateWorkItemInputSchema.parse({
		title: "Reply to the thread about trail shoes",
		factoryCard: { cardSheetId: SHEET, row: 0 },
		metadata: { origin: "card-review" },
		...patch,
	});
}

beforeEach(() => {
	outputs.get.mockReset().mockResolvedValue({
		output: {
			id: SHEET,
			workspaceId: WORKSPACE,
			title: "Forum cards 2026-10-26",
			createdAt: "2026-10-26T06:00:00.000Z",
		},
		currentRevision: {
			revision: 3,
			content: {
				kind: "sheet",
				columns: [
					"Type",
					"Thread",
					"Why",
					"Action",
					"Useful?",
					"Reason",
					"Done?",
					"Score",
					"Timing",
				],
				rows: [
					[
						"Reply",
						"Trail shoes https://forum.example/t/42",
						"A runner asks which shoe fits wide feet",
						"Draft a reply",
						"",
						"",
						"",
						"0.82",
						"Today",
					],
				],
			},
		},
	});
});

describe("prepareFactoryCard", () => {
	it("stores the card's decision envelope as the Work's metadata.decisionDeck", async () => {
		const prepared = await prepareFactoryCard(await context(), ORG, work());
		expect(outputs.get).toHaveBeenCalledWith({ outputId: SHEET });
		const envelope = DecisionEnvelopeSchema.parse(
			prepared.metadata!.decisionDeck,
		);
		expect(envelope).toMatchObject({
			kind: "proposal",
			classId: "reply",
			proposal: "Draft a reply",
			confidence: 0.82,
			protectedEffects: ["message"],
			costOfWaiting: "Today",
			expiresAt: "2026-10-29T06:00:00.000Z",
		});
		expect(prepared.metadata).toMatchObject({
			origin: "card-review",
			factoryCard: { cardSheetId: SHEET, row: 0, source: "Forum" },
		});
	});

	it("leaves Work without a factory card unchanged", async () => {
		const input = work({ factoryCard: undefined });
		expect(await prepareFactoryCard(await context(), ORG, input)).toBe(input);
		expect(outputs.get).not.toHaveBeenCalled();
	});

	it("refuses a caller-written envelope next to a factory card", async () => {
		await expect(
			prepareFactoryCard(
				await context(),
				ORG,
				work({ metadata: { decisionDeck: { kind: "proposal" } } }),
			),
		).rejects.toThrow(/server-derived/);
	});

	it("rejects a row that is not a card and a sheet no source reads", async () => {
		await expect(
			prepareFactoryCard(
				await context(),
				ORG,
				work({ factoryCard: { cardSheetId: SHEET, row: 5 } }),
			),
		).rejects.toThrow(/not a card/);
		outputs.get.mockResolvedValueOnce({
			output: {
				id: SHEET,
				workspaceId: WORKSPACE,
				title: "Inbox cards 2026-10-26",
				createdAt: "2026-10-26T06:00:00.000Z",
			},
			currentRevision: {
				revision: 1,
				content: { kind: "sheet", columns: [], rows: [] },
			},
		});
		await expect(
			prepareFactoryCard(await context(), ORG, work()),
		).rejects.toThrow(/No Card review or Decisions source/);
	});
});

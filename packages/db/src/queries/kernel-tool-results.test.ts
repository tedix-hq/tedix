import { DatabaseSync } from "node:sqlite";
import { isNull } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import {
	kernelConversations,
	kernelToolResults,
} from "../schema/cognitive-runtime";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getReadableKernelToolResultBySource,
	insertKernelToolResultWithRetention,
} from "./kernel-tool-results";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, kernelConversations, kernelToolResults));
	sqlite.exec(
		"INSERT INTO organizations(id,slug,name) VALUES('org','org','Org')",
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	return { db, sqlite };
}

function row(id: string, createdAt = "2026-09-22T00:00:00.000Z") {
	return {
		id,
		organizationId: "org",
		conversationId: "home:one",
		runId: null,
		sourceKind: "direct_read" as const,
		sourceId: id,
		objectKey: `home-tool-results/org/${id}`,
		sha256: id.padEnd(64, "0"),
		byteSize: 1,
		contentType: "application/json",
		createdAt,
		expiresAt: "2026-09-23T00:00:00.000Z",
		now: "2026-09-22T00:00:00.000Z",
	};
}

describe("kernel tool-result retention", () => {
	it("atomically rejects a delayed result after conversation deletion", async () => {
		const { db } = fixture();
		await db.insert(kernelConversations).values({
			id: "org:home:one",
			organizationId: "org",
			conversationId: "home:one",
			lastMessageAt: "2026-09-22T00:00:00.000Z",
			deletedAt: "2026-09-22T00:01:00.000Z",
		});
		await expect(
			insertKernelToolResultWithRetention(db, row("late")),
		).rejects.toThrow("conversation is unavailable");
		expect(await db.select().from(kernelToolResults)).toEqual([]);
	});

	it("keeps only the twenty newest active rows", async () => {
		const { db } = fixture();
		await db.insert(kernelConversations).values({
			id: "org:home:one",
			organizationId: "org",
			conversationId: "home:one",
			lastMessageAt: "2026-09-22T00:00:00.000Z",
		});
		for (let index = 0; index < 21; index++) {
			await insertKernelToolResultWithRetention(
				db,
				row(`r${index.toString().padStart(2, "0")}`),
			);
		}
		const active = await db
			.select()
			.from(kernelToolResults)
			.where(isNull(kernelToolResults.evictedAt));
		expect(active).toHaveLength(20);
		expect(active.some((item) => item.id === "r00")).toBe(false);
	});

	it("resolves a source only inside its exact organization and conversation", async () => {
		const { db } = fixture();
		await db.insert(kernelConversations).values({
			id: "org:home:one",
			organizationId: "org",
			conversationId: "home:one",
			lastMessageAt: "2026-09-22T00:00:00.000Z",
		});
		await insertKernelToolResultWithRetention(db, row("source-one"));
		const lookup = {
			sourceKind: "direct_read" as const,
			sourceId: "source-one",
			now: "2026-09-22T12:00:00.000Z",
		};
		await expect(
			getReadableKernelToolResultBySource(db, {
				...lookup,
				organizationId: "org",
				conversationId: "home:one",
			}),
		).resolves.toMatchObject({ id: "source-one" });
		await expect(
			getReadableKernelToolResultBySource(db, {
				...lookup,
				organizationId: "org",
				conversationId: "home:other",
			}),
		).resolves.toBeNull();
		await expect(
			getReadableKernelToolResultBySource(db, {
				...lookup,
				organizationId: "org-2",
				conversationId: "home:one",
			}),
		).resolves.toBeNull();
	});
});

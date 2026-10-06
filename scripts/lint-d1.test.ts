import { describe, expect, test } from "bun:test";
import {
	findDuplicateOutputColumns,
	findUnboundedInArrays,
} from "./lint-d1.ts";

describe("findDuplicateOutputColumns", () => {
	test("flags two entries reaching for the same column across a join", () => {
		const findings = findDuplicateOutputColumns(
			"q.ts",
			`const rows = await db
				.select({
					grantId: tediEntrustmentGrants.id,
					activityId: entrustableActivities.id,
					taskFamily: entrustableActivities.taskFamily,
				})
				.from(tediEntrustmentGrants)
				.innerJoin(entrustableActivities, eq(a, b));`,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.column).toBe("id");
		expect(findings[0]?.receivers).toEqual([
			"entrustableActivities",
			"tediEntrustmentGrants",
		]);
	});

	test("reports the line of the projection", () => {
		const findings = findDuplicateOutputColumns(
			"q.ts",
			`// leading comment\n\ndb.select({\n  a: x.id,\n  b: y.id,\n}).from(x).leftJoin(y, on);`,
		);
		expect(findings[0]?.line).toBe(3);
	});

	test("accepts an explicit sql().as() alias", () => {
		// The mcp-governance.ts remedy.
		const findings = findDuplicateOutputColumns(
			"q.ts",
			`db.select({
					workItemId: sql<string>\`\${workItems.id}\`.as("authorization_work_item_id"),
					checkoutId: sql<string>\`\${workItemExecutorCheckouts.id}\`.as("authorization_checkout_id"),
				}).from(workItems).innerJoin(workItemExecutorCheckouts, on);`,
		);
		expect(findings).toEqual([]);
	});

	test("accepts prefixedColumns receivers", () => {
		// The app-adapter-secret-bindings.ts remedy: both tables expose name+hint.
		const findings = findDuplicateOutputColumns(
			"q.ts",
			`const appSecret = prefixedColumns(appSecrets, "appSecret");
			 const orgSecret = prefixedColumns(organizationSecrets, "orgSecret");
			 db.select({
					appSecretName: appSecret.name,
					appSecretHint: appSecret.hint,
					orgSecretName: orgSecret.name,
					orgSecretHint: orgSecret.hint,
				}).from(appAdapterSecretBindings).leftJoin(appSecrets, on);`,
		);
		expect(findings).toEqual([]);
	});

	test("ignores a projection with no join — nothing can collide", () => {
		const findings = findDuplicateOutputColumns(
			"q.ts",
			`db.select({ a: x.id, b: y.id }).from(x).where(cond);`,
		);
		expect(findings).toEqual([]);
	});

	test("does not flag the same table twice for one column", () => {
		const findings = findDuplicateOutputColumns(
			"q.ts",
			`db.select({ a: x.id, b: x.id }).from(x).innerJoin(y, on);`,
		);
		expect(findings).toEqual([]);
	});

	test("ignores non-table receivers such as sql helpers and count()", () => {
		const findings = findDuplicateOutputColumns(
			"q.ts",
			`db.select({
					total: sql<number>\`count(*)\`,
					n: count(),
					flagged: input.id,
					other: ctx.id,
				}).from(x).innerJoin(y, on);`,
		);
		expect(findings).toEqual([]);
	});

	test("is not fooled by a comma inside a nested call or template", () => {
		// A naive comma split would tear the sql`` entry apart and lose the alias.
		const findings = findDuplicateOutputColumns(
			"q.ts",
			`db.select({
					score: sql<number>\`COALESCE(AVG(\${a.confidence}), 0)\`.as("score"),
					id1: alpha.id,
				}).from(alpha).innerJoin(beta, on);`,
		);
		expect(findings).toEqual([]);
	});

	test("finds collisions in more than one projection per file", () => {
		const one = `db.select({ a: p.id, b: q.id }).from(p).innerJoin(q, on);`;
		const two = `db.select({ c: r.name, d: s.name }).from(r).leftJoin(s, on);`;
		const findings = findDuplicateOutputColumns("q.ts", `${one}\n${two}`);
		expect(findings.map((f) => f.column).sort()).toEqual(["id", "name"]);
	});

	test("reports every colliding column in one projection", () => {
		const findings = findDuplicateOutputColumns(
			"q.ts",
			`db.select({
					a: p.name,
					b: q.name,
					c: p.hint,
					d: q.hint,
				}).from(p).innerJoin(q, on);`,
		);
		expect(findings.map((f) => f.column).sort()).toEqual(["hint", "name"]);
	});
});

describe("findUnboundedInArrays", () => {
	test("flags an inArray over a bare caller-supplied list", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`export async function listByIds(db: DbClient, ids: string[]) {
				return db.select().from(items).where(inArray(items.id, ids));
			}`,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.argument).toBe("ids");
	});

	test("reports the line of the call", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`// leading comment\n\nconst rows = await db\n\t.select()\n\t.from(items)\n\t.where(inArray(items.id, ids));`,
		);
		expect(findings[0]?.line).toBe(6);
	});

	test("accepts an array literal", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`db.select().from(runs).where(inArray(runs.status, ["completed", "failed"]));`,
		);
		expect(findings).toEqual([]);
	});

	test("accepts a for-of binding over chunkForBoundParams", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`for (const batchIds of chunkForBoundParams([...new Set(ids)], 50)) {
				rows.push(...(await db.select().from(t).where(inArray(t.id, batchIds))));
			}`,
		);
		expect(findings).toEqual([]);
	});

	test("accepts a map callback over a chunkForBoundParams result", () => {
		// The analytics-hydration.ts idiom.
		const findings = findUnboundedInArrays(
			"q.ts",
			`const queries = chunkForBoundParams(principalIds, 50).map((ids) =>
				applyOrg(inArray(tedis.descopeUserId, ids)),
			);`,
		);
		expect(findings).toEqual([]);
	});

	test("accepts iteration through an intermediate chunk-list variable", () => {
		// The catalog/mcp-tools.ts idiom.
		const findings = findUnboundedInArrays(
			"q.ts",
			`const idChunks = chunkForBoundParams(catalogAppIds, 50);
			for (const ids of idChunks) {
				await db.select().from(t).where(inArray(t.catalogAppId, ids));
			}`,
		);
		expect(findings).toEqual([]);
	});

	test("accepts identifiers named chunk/*Chunk by convention", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`db.select().from(t).where(inArray(t.id, chunk));
			db.select().from(t).where(inArray(t.workItemId, idChunk));`,
		);
		expect(findings).toEqual([]);
	});

	test("accepts a map over a chunk variable", () => {
		// inArray(col, chunk.map((row) => row.id))
		const findings = findUnboundedInArrays(
			"q.ts",
			`for (const chunk of chunkForBoundParams(rows, 50)) {
				await db.select().from(t).where(inArray(t.id, chunk.map((row) => row.id)));
			}`,
		);
		expect(findings).toEqual([]);
	});

	test("accepts the hand-rolled slice window idiom", () => {
		// The memory-graph/edges.ts and app-records.ts shape.
		const findings = findUnboundedInArrays(
			"q.ts",
			`for (let i = 0; i < ids.length; i += SIZE) {
				const batch = ids.slice(i, i + SIZE);
				await db.select().from(t).where(inArray(t.id, batch));
			}
			await db.select().from(t).where(inArray(t.id, keys.slice(index, index + 50)));`,
		);
		expect(findings).toEqual([]);
	});

	test("rejects a bare slice cap — it drops rows and can bust the budget", () => {
		// The skill-run-artifacts.ts bug shape: .slice(0, 200).
		const findings = findUnboundedInArrays(
			"q.ts",
			`db.select().from(t).where(inArray(t.runId, runIds.slice(0, 200)));`,
		);
		expect(findings).toHaveLength(1);
	});

	test("accepts a non-empty const array-literal binding", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`const openStatuses = ["queued", "running"];
			db.select().from(t).where(inArray(t.status, openStatuses));
			db.select().from(t).where(inArray(t.status, [...openStatuses]));`,
		);
		expect(findings).toEqual([]);
	});

	test("does not treat an empty-literal accumulator as bounded", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`const collected: string[] = [];
			for (const row of rows) collected.push(row.id);
			db.select().from(t).where(inArray(t.id, collected));`,
		);
		expect(findings).toHaveLength(1);
	});

	test("accepts SCREAMING_SNAKE_CASE constants and their spreads", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`db.select().from(t).where(inArray(t.status, WARM_LEASE_STATUSES));
			db.select().from(t).where(inArray(t.status, [...WARM_LEASE_STATUSES]));`,
		);
		expect(findings).toEqual([]);
	});

	test("rejects a spread of an unbounded identifier", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`db.select().from(t).where(inArray(t.id, [...ids]));`,
		);
		expect(findings).toHaveLength(1);
	});

	test("rejects a member chain rooted in an unbounded receiver", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`db.select().from(t).where(inArray(t.id, input.runIds));
			db.select().from(t).where(inArray(t.id, rows.map((row) => row.id)));`,
		);
		expect(findings).toHaveLength(2);
	});

	test("accepts an explicit bound-params annotation on the preceding line", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`db.select().from(t).where(
				and(
					eq(t.orgId, orgId),
					// bound-params: scope walk caps the chain at 1 leaf + 5 parents
					inArray(t.workItemId, scopeIds),
				),
			);`,
		);
		expect(findings).toEqual([]);
	});

	test("accepts an annotation up to three lines above a wrapped conditional", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`const conditions = [
				// bound-params: one runId plus its dispatch-alias mappings (sole
				// caller builds a single-run set)
				...(input.runIds
					? [inArray(events.runId, input.runIds)]
					: []),
			];`,
		);
		expect(findings).toEqual([]);
	});

	test("an annotation does not bless a site further away", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`// bound-params: only covers the next site
			const a = 1;
			const b = 2;
			const c = 3;
			db.select().from(t).where(inArray(t.id, ids));`,
		);
		expect(findings).toHaveLength(1);
	});

	test("handles a multi-line inArray call", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`db.select().from(t).where(
				inArray(
					t.feedbackEventId,
					input.feedbackEventIds,
				),
			);`,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.argument).toBe("input.feedbackEventIds");
	});

	test("is not fooled by commas inside nested calls or strings", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`db.select().from(t).where(inArray(t.id, [fn(a, b), "x,y"]));`,
		);
		expect(findings).toEqual([]);
	});

	test("ignores notInArray — different helper, out of scope here", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`db.select().from(t).where(notInArray(t.id, ids));`,
		);
		expect(findings).toEqual([]);
	});

	test("finds every unbounded site in a file", () => {
		const findings = findUnboundedInArrays(
			"q.ts",
			`db.select().from(t).where(inArray(t.id, aIds));
			db.select().from(t).where(inArray(t.slug, ["fixed"]));
			db.select().from(t).where(inArray(t.key, bKeys));`,
		);
		expect(findings.map((finding) => finding.argument).sort()).toEqual([
			"aIds",
			"bKeys",
		]);
	});
});

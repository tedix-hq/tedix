import { describe, expect, it } from "vite-plus/test";
import {
	NEVER_PROMOTION_THRESHOLD,
	PROMOTION_THRESHOLD,
	type RationalePattern,
	type RationaleRecordInput,
	applyPromotionGate,
	classifyDirective,
	clusterByPattern,
	diagnoseDirectiveGap,
	salientTokens,
} from "./compiler.js";

const pattern = (
	successCount: number,
	failureCount: number,
): RationalePattern => ({
	action: "do the thing",
	category: "custom",
	successCount,
	failureCount,
	recordIds: [],
	records: [],
});

const rec = (
	action: string,
	outcomeStatus: "success" | "failure",
	id: string,
): RationaleRecordInput => ({
	id,
	action,
	category: "communication",
	outcomeStatus,
});

describe("salientTokens", () => {
	it("drops stopwords, short tokens, and ID-like tokens", () => {
		const t = salientTokens(
			"The retail agent must authenticate the customer for order W3916020",
		);
		expect(t.has("authenticate")).toBe(true);
		// stopwords / roles dropped
		expect(t.has("retail")).toBe(false);
		expect(t.has("agent")).toBe(false);
		expect(t.has("customer")).toBe(false);
		expect(t.has("order")).toBe(false);
		expect(t.has("must")).toBe(false);
		// ID-like dropped
		expect(t.has("w3916020")).toBe(false);
		// short dropped
		expect(t.has("the")).toBe(false);
	});
});

describe("clusterByPattern — semantic collapse (regression for directiveCount:0)", () => {
	// These are real-shaped retail rationale records: the SAME rule
	// ("authenticate before acting") phrased many different ways. The previous
	// first-3-words exact key shattered them into singletons → 0 directives.
	const authRecords: RationaleRecordInput[] = [
		rec(
			"The retail agent must authenticate the customer before any order action",
			"success",
			"1",
		),
		rec(
			"Authenticate the customer first using either email or name and ZIP",
			"success",
			"2",
		),
		rec(
			"The assistant chose to ask for authentication before performing the exchange",
			"success",
			"3",
		),
		rec(
			"The retail workflow requires authenticating the customer before any order lookup",
			"success",
			"4",
		),
		rec(
			"Account-specific actions cannot proceed until authentication succeeds",
			"failure",
			"5",
		),
		rec(
			"The assistant cannot use the order number as a substitute for authentication",
			"failure",
			"6",
		),
	];

	it("collapses semantically-identical auth rationale into one cluster", () => {
		const patterns = clusterByPattern(authRecords);
		// The dominant auth pattern must be a single cluster, not 6 singletons.
		const biggest = patterns.sort(
			(a, b) =>
				b.successCount + b.failureCount - (a.successCount + a.failureCount),
		)[0]!;
		expect(biggest.successCount + biggest.failureCount).toBeGreaterThanOrEqual(
			5,
		);
	});

	it("the collapsed auth cluster crosses the promotion gate", () => {
		const promoted = applyPromotionGate(clusterByPattern(authRecords));
		expect(promoted.length).toBeGreaterThanOrEqual(1);
		const auth = promoted.find((p) =>
			p.records.some((r) => /authenticat/i.test(r.action)),
		);
		expect(auth).toBeDefined();
		// Mixed success+failure → classified "prefer" (not all-success "always").
		expect(classifyDirective(auth!.successCount, auth!.failureCount)).toBe(
			"prefer",
		);
	});

	it("does NOT over-merge genuinely different action verbs", () => {
		const mixed: RationaleRecordInput[] = [
			...authRecords.slice(0, 3),
			rec(
				"Cancel the entire pending order as the customer no longer needs it",
				"success",
				"10",
			),
			rec(
				"Cancel the pending order in full per the customer request",
				"success",
				"11",
			),
			rec(
				"Cancel the order rather than modifying individual line items",
				"success",
				"12",
			),
		];
		const patterns = clusterByPattern(mixed);
		// auth cluster and cancel cluster must stay distinct.
		const hasAuth = patterns.some((p) =>
			p.records.every((r) => /authenticat/i.test(r.action)),
		);
		const hasCancel = patterns.some((p) =>
			p.records.every((r) => /cancel/i.test(r.action)),
		);
		expect(hasAuth).toBe(true);
		expect(hasCancel).toBe(true);
	});

	it("partitions by category", () => {
		const crossCat: RationaleRecordInput[] = [
			{
				...rec("authenticate the customer first", "success", "20"),
				category: "communication",
			},
			{
				...rec("authenticate the customer first", "success", "21"),
				category: "security",
			},
		];
		const patterns = clusterByPattern(crossCat);
		expect(patterns.length).toBe(2);
	});
});

describe("diagnoseDirectiveGap — explains zero-directive outcomes", () => {
	const success = (action: string, id: string): RationaleRecordInput => ({
		id,
		action,
		category: "communication",
		outcomeStatus: "success",
	});
	const pending = (action: string, id: string): RationaleRecordInput => ({
		id,
		action,
		category: "communication",
		outcomeStatus: "pending",
	});

	it("returns no_records for an empty corpus", () => {
		const d = diagnoseDirectiveGap([]);
		expect(d.reason).toBe("no_records");
		expect(d.totalRecords).toBe(0);
		expect(d.completedRecords).toBe(0);
	});

	it("returns insufficient_completed when all records are pending", () => {
		const records = [
			pending("fetch pricing", "p1"),
			pending("fetch pricing", "p2"),
			pending("look up order details", "p3"),
		];
		const d = diagnoseDirectiveGap(records);
		expect(d.reason).toBe("insufficient_completed");
		expect(d.totalRecords).toBe(3);
		expect(d.completedRecords).toBe(0);
	});

	it("returns insufficient_completed when completed count is below threshold", () => {
		const records = [
			success("look up order details for a registered customer", "s1"),
			success("retrieve the order history list", "s2"),
			pending("fetch pricing", "p1"),
		];
		const d = diagnoseDirectiveGap(records);
		// Only 2 completed; PROMOTION_THRESHOLD is 3.
		expect(d.reason).toBe("insufficient_completed");
		expect(d.completedRecords).toBe(2);
	});

	it("returns singleton_clusters when each completed action is unique", () => {
		// Three unrelated actions — no salient-token overlap — three singleton clusters.
		const records = [
			success(
				"authenticate the customer before performing any exchange operation",
				"s1",
			),
			success(
				"refund the payment amount back to the original payment method card",
				"s2",
			),
			success(
				"escalate the service ticket to the senior technical support specialist",
				"s3",
			),
		];
		const d = diagnoseDirectiveGap(records);
		expect(d.reason).toBe("singleton_clusters");
		expect(d.clusters).toBe(d.singletonClusters);
		expect(d.promotedClusters).toBe(0);
	});

	it("returns below_threshold when clusters exist but none meet the gate", () => {
		// Two pairs — each pair clusters but neither reaches PROMOTION_THRESHOLD (3).
		const records = [
			success(
				"authenticate the customer before any order action is taken",
				"s1",
			),
			success(
				"authenticate the customer first using email and postal code",
				"s2",
			),
			success(
				"refund the payment back to the original card on file for this order",
				"s3",
			),
			success(
				"refund the original payment method for the customer order charges here",
				"s4",
			),
		];
		const d = diagnoseDirectiveGap(records);
		// Two 2-member clusters; both below promotion threshold of 3.
		expect(d.reason).toBe("below_threshold");
		expect(d.clusters).toBeGreaterThanOrEqual(1);
		expect(d.promotedClusters).toBe(0);
	});

	it("returns ok when at least one cluster clears the promotion gate", () => {
		const records = [
			success(
				"authenticate the customer before any order action is taken",
				"s1",
			),
			success(
				"authenticate the customer first using email and postal code",
				"s2",
			),
			success(
				"authenticate the customer before performing any exchange process",
				"s3",
			),
		];
		const d = diagnoseDirectiveGap(records);
		expect(d.reason).toBe("ok");
		expect(d.promotedClusters).toBeGreaterThanOrEqual(1);
		expect(d.completedRecords).toBe(3);
	});
});

describe("applyPromotionGate — asymmetric NEVER bar (capability-suppression guard)", () => {
	it("promotes an all-success cluster at the normal threshold", () => {
		const promoted = applyPromotionGate([pattern(PROMOTION_THRESHOLD, 0)]);
		expect(promoted.length).toBe(1);
		expect(classifyDirective(PROMOTION_THRESHOLD, 0)).toBe("always");
	});

	it("does NOT promote an all-failure cluster below the higher NEVER bar", () => {
		// 3 failures would classify "never" but must clear NEVER_PROMOTION_THRESHOLD
		const promoted = applyPromotionGate([
			pattern(0, NEVER_PROMOTION_THRESHOLD - 1),
		]);
		expect(promoted.length).toBe(0);
	});

	it("promotes an all-failure cluster once it clears the NEVER bar", () => {
		const promoted = applyPromotionGate([
			pattern(0, NEVER_PROMOTION_THRESHOLD),
		]);
		expect(promoted.length).toBe(1);
		expect(classifyDirective(0, NEVER_PROMOTION_THRESHOLD)).toBe("never");
	});

	it("a mixed cluster at the normal threshold still promotes (not gated as never)", () => {
		const promoted = applyPromotionGate([pattern(1, PROMOTION_THRESHOLD - 1)]);
		expect(promoted.length).toBe(1);
	});
});

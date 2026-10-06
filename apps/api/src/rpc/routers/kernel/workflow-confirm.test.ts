/**
 * Pure-function unit tests for the kernel workflow confirm→dispatch helpers:
 *   - classifyAffirmative(content): conservative affirmative detection.
 *   - readPendingWorkflowHint(db, …): reads a pending `run_workflow` hint from the
 *     most-recent prior run in the conversation (excluding the current run).
 *
 * The end-to-end dispatch path through `runKernelTurnWork` is pinned separately
 * in turn-work.test.ts ("workflow confirm→dispatch intercept").
 */

import type { DbClient } from "@tedix/db/client";
import { describe, expect, it } from "vite-plus/test";
import {
	classifyAffirmative,
	readPendingWorkflowHint,
} from "./workflow-confirm";

describe("classifyAffirmative", () => {
	it("accepts clear, unambiguous affirmatives", () => {
		for (const yes of [
			"yes",
			"Yes",
			"YES",
			"yes please",
			"yep",
			"go ahead",
			"start it",
			"do it",
			"run it",
			"yes start it",
			"ok go ahead",
			"let's do it",
			"confirm",
			"proceed",
			"yes.",
			"go ahead!",
			"yes, go ahead", // internal comma
			"yes, start it",
			"yes, please",
		]) {
			expect(classifyAffirmative(yes), yes).toBe(true);
		}
	});

	it("rejects anything ambiguous, negative, or request-shaped", () => {
		for (const no of [
			"",
			"   ",
			"no",
			"not yet",
			"maybe later",
			"yes?", // question → different intent
			"yes but skip the email step", // qualified → re-routing
			"actually run the offboarding workflow instead", // new request
			"why would you do that", // 5 words, not in set
			"start the customer onboarding workflow for acme corp now", // 8+ words
			"hmm",
			"ok", // bare "ok" alone is NOT in the affirmative set (too weak)
		]) {
			expect(classifyAffirmative(no), JSON.stringify(no)).toBe(false);
		}
	});
});

/**
 * Minimal db stub: resolves the chained select to a fixed set of rows. Only the
 * `.orderBy(...).limit(...)` terminal await matters; every intermediate call
 * returns the same thenable proxy.
 */
function dbReturning(rows: unknown[]): DbClient {
	const proxy: unknown = new Proxy(function noop() {}, {
		get(_t, prop) {
			if (prop === "then") {
				return (resolve: (v: unknown[]) => void) => resolve(rows);
			}
			return proxy;
		},
		apply() {
			return proxy;
		},
	});
	return proxy as DbClient;
}

const READ_ARGS = {
	organizationId: "org-1",
	conversationId: "home:main",
	excludeRunId: "run-current",
};

describe("readPendingWorkflowHint", () => {
	it("returns the workflowHint from the most-recent prior completed run_workflow run", async () => {
		const db = dbReturning([
			// current run (excluded)
			{ id: "run-current", status: "running", metadata: {} },
			// prior run carrying the pending workflow route
			{
				id: "run-prev",
				status: "completed",
				metadata: {
					kernelRoute: {
						routeKind: "run_workflow",
						workflowHint: "customer-onboarding",
					},
				},
			},
		]);
		await expect(readPendingWorkflowHint(db, READ_ARGS)).resolves.toBe(
			"customer-onboarding",
		);
	});

	it("trims the workflowHint from a completed run_workflow prior run", async () => {
		const db = dbReturning([
			{ id: "run-current", status: "running", metadata: {} },
			{
				id: "run-prev",
				status: "completed",
				metadata: {
					kernelRoute: {
						routeKind: "run_workflow",
						workflowHint: "  weekly-report  ",
					},
				},
			},
		]);
		await expect(readPendingWorkflowHint(db, READ_ARGS)).resolves.toBe(
			"weekly-report",
		);
	});

	it("returns null when the prior run was a different route kind", async () => {
		const db = dbReturning([
			{ id: "run-current", status: "running", metadata: {} },
			{
				id: "run-prev",
				status: "completed",
				metadata: {
					kernelRoute: {
						routeKind: "answer_in_home",
						workflowHint: null,
					},
				},
			},
		]);
		await expect(readPendingWorkflowHint(db, READ_ARGS)).resolves.toBeNull();
	});

	it("returns null when run_workflow has no usable workflowHint", async () => {
		const db = dbReturning([
			{ id: "run-current", status: "running", metadata: {} },
			{
				id: "run-prev",
				status: "completed",
				metadata: {
					kernelRoute: { routeKind: "run_workflow", workflowHint: "  " },
				},
			},
		]);
		await expect(readPendingWorkflowHint(db, READ_ARGS)).resolves.toBeNull();
	});

	it("no-double-dispatch: a confirm run (kernelWorkflowConfirm meta, no kernelRoute) shadows the original pending route", async () => {
		// After the first affirmative dispatches, the most-recent completed run is
		// the workflow-confirm run itself — it carries `kernelWorkflowConfirm` but
		// NO `kernelRoute.run_workflow`, so a second affirmative finds no pending
		// hint (returns null) instead of re-dispatching.
		const db = dbReturning([
			{ id: "run-current", status: "running", metadata: {} },
			{
				id: "run-confirm",
				status: "completed",
				metadata: {
					kernelWorkflowConfirm: {
						workflowSlug: "customer-onboarding",
						status: "dispatched",
					},
				},
			},
			{
				id: "run-orig",
				status: "completed",
				metadata: {
					kernelRoute: {
						routeKind: "run_workflow",
						workflowHint: "customer-onboarding",
					},
				},
			},
		]);
		await expect(readPendingWorkflowHint(db, READ_ARGS)).resolves.toBeNull();
	});

	it("returns null when the prior run is not yet completed", async () => {
		const db = dbReturning([
			{ id: "run-current", status: "running", metadata: {} },
			{
				id: "run-prev",
				status: "requires_approval",
				metadata: {
					kernelRoute: {
						routeKind: "run_workflow",
						workflowHint: "customer-onboarding",
					},
				},
			},
		]);
		await expect(readPendingWorkflowHint(db, READ_ARGS)).resolves.toBeNull();
	});

	it("returns null when only the current run exists (no prior turn)", async () => {
		const db = dbReturning([
			{ id: "run-current", status: "running", metadata: {} },
		]);
		await expect(readPendingWorkflowHint(db, READ_ARGS)).resolves.toBeNull();
	});

	it("fail-soft: returns null when the read throws", async () => {
		const throwingDb: unknown = new Proxy(function noop() {}, {
			get(_t, prop) {
				if (prop === "then") {
					return (_r: unknown, reject: (e: unknown) => void) =>
						reject(new Error("db down"));
				}
				throw new Error("db down");
			},
			apply() {
				throw new Error("db down");
			},
		});
		await expect(
			readPendingWorkflowHint(throwingDb as DbClient, READ_ARGS),
		).resolves.toBeNull();
	});
});

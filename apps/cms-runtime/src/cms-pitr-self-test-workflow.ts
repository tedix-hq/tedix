import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import type { Env } from "./index";

// The underscores make this name impossible for a CMS site slug or hostname.
export const CMS_PITR_SELF_TEST_DO_NAME = "__tedix_cms_pitr_self_test__";
// Wrangler must use --id with this value. Workflow instance identity is the
// single-run claim; another trigger cannot race the same reserved DO.
export const CMS_PITR_SELF_TEST_INSTANCE_ID = "cms-pitr-self-test-v1";
export const CMS_PITR_SELF_TEST_RECEIPT_KEY =
	"recovery/self-test/cms-pitr-v1/receipt.json";

export type CmsPitrSelfTestReceipt =
	| { version: 1; state: "preparing" }
	| { version: 1; state: "restore-scheduled"; undoBookmark: string }
	| {
			version: 1;
			state: "undo-scheduled";
			undoBookmark: string;
			redoBookmark: string;
	  }
	| { version: 1; state: "verified" };

interface CmsPitrSelfTestStub {
	preparePitrSelfTest(): Promise<void>;
	restartPitrSelfTest(): Promise<void>;
	readPitrSelfTestState(): Promise<"missing" | "before" | "after">;
	readPitrSelfTestReceiptState(): Promise<
		"missing" | CmsPitrSelfTestReceipt["state"]
	>;
	schedulePitrSelfTestUndo(): Promise<void>;
	completePitrSelfTest(): Promise<void>;
}

function selfTestStub(env: Pick<Env, "DB_DO">): CmsPitrSelfTestStub {
	return env.DB_DO.get(
		env.DB_DO.idFromName(CMS_PITR_SELF_TEST_DO_NAME),
	) as unknown as CmsPitrSelfTestStub;
}

/** Triggerable by authenticated Wrangler only; no HTTP route or caller-selected target. */
export async function runCmsPitrSelfTest(
	env: Pick<Env, "DB_DO">,
	step: WorkflowStep,
	instanceId: string,
	payload: unknown,
): Promise<{
	status: "verified";
	evidence: "fresh" | "prior";
	restored: "before";
	undone: "after";
}> {
	if (instanceId !== CMS_PITR_SELF_TEST_INSTANCE_ID)
		throw new Error(
			"CMS PITR self-test requires its fixed Workflow instance ID",
		);
	if (
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload) ||
		Object.keys(payload).length !== 0
	)
		throw new Error("CMS PITR self-test accepts only empty parameters");
	const receiptState = await step.do("inspect-reserved-do-receipt", () =>
		selfTestStub(env).readPitrSelfTestReceiptState(),
	);
	if (receiptState === "verified")
		return {
			status: "verified",
			evidence: "prior",
			restored: "before",
			undone: "after",
		};
	if (receiptState !== "undo-scheduled") {
		await step.do("prepare-reserved-do-restore", () =>
			selfTestStub(env).preparePitrSelfTest(),
		);
		await step.do("restart-and-verify-restore", async () => {
			try {
				await selfTestStub(env).restartPitrSelfTest();
			} catch {
				// ctx.abort() disconnects the RPC. The fresh read is the only success proof.
			}
			const state = await selfTestStub(env).readPitrSelfTestState();
			if (state !== "before")
				throw new Error("CMS PITR self-test restore did not recover marker");
			return state;
		});
		await step.do("schedule-reserved-do-undo", () =>
			selfTestStub(env).schedulePitrSelfTestUndo(),
		);
	}
	await step.do("restart-and-verify-undo", async () => {
		try {
			await selfTestStub(env).restartPitrSelfTest();
		} catch {
			// See above: a disconnect is expected, but the next read must prove undo.
		}
		const state = await selfTestStub(env).readPitrSelfTestState();
		if (state !== "after")
			throw new Error("CMS PITR self-test undo did not recover marker");
		return state;
	});
	await step.do("record-verified-undo", () =>
		selfTestStub(env).completePitrSelfTest(),
	);
	return {
		status: "verified",
		evidence: "fresh",
		restored: "before",
		undone: "after",
	};
}

export class CmsPitrSelfTestWorkflow extends WorkflowEntrypoint<Env, object> {
	async run(event: WorkflowEvent<object>, step: WorkflowStep) {
		return runCmsPitrSelfTest(this.env, step, event.instanceId, event.payload);
	}
}

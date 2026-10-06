import assert from "node:assert/strict";
import { memoryStorage, workflowImageBucketProbe } from "../test/tedi-do";
import {
	describeWorkflowImages,
	persistWorkflowImages,
	type WorkflowImageBucket,
} from "./workflow-image-handoff";
import {
	WorkflowImageCleanup,
	WORKFLOW_IMAGE_CLEANUP_PREFIX,
	type WorkflowImageCleanupInput,
	type WorkflowImageCleanupAuthority,
} from "./workflow-image-cleanup";
const image = {
	kind: "base64" as const,
	data: "aGk=",
	mediaType: "image/png",
	fileName: "image.png",
};
function fixture() {
	const storage = memoryStorage(),
		store = workflowImageBucketProbe();
	const claims = new Map<
		string,
		{ input: string; authority: WorkflowImageCleanupAuthority }
	>();
	let active = true,
		canceled = false,
		status = "not_found",
		admitted = 0,
		completed = 0,
		retries = 0;
	const original = async (
		authority: WorkflowImageCleanupAuthority,
		input: WorkflowImageCleanupInput,
	) => {
		const prior = claims.get(input.runId);
		assert.ok(prior);
		assert.deepEqual(authority, prior.authority);
		assert.equal(JSON.stringify(input), prior.input);
	};
	const deps = {
		storage: storage as unknown as DurableObjectStorage,
		owner: () => ({ tediId: "tedi", orgId: "org" }),
		bucket: () => store.bucket as unknown as WorkflowImageBucket,
		admitCleanup: async (input: WorkflowImageCleanupInput) => {
			if (!active || canceled) throw new Error("original upload denied");
			admitted++;
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(JSON.stringify(input)),
			);
			const authority = {
				runId: `workflow-image-cleanup:${input.runId}`,
				generation: 7,
				requestHash: Array.from(new Uint8Array(digest), (n) =>
					n.toString(16).padStart(2, "0"),
				).join(""),
			};
			claims.set(input.runId, { input: JSON.stringify(input), authority });
			return authority;
		},
		assertCleanupOriginal: original,
		assertCleanupActive: async (
			authority: WorkflowImageCleanupAuthority,
			input: WorkflowImageCleanupInput,
		) => {
			await original(authority, input);
			if (!active) throw new Error("cleanup held");
			return () => {
				if (
					!active ||
					JSON.stringify(claims.get(input.runId)?.authority) !==
						JSON.stringify(authority) ||
					claims.get(input.runId)?.input !== JSON.stringify(input)
				)
					throw new Error("cleanup held or changed");
			};
		},
		completeCleanup: async (
			authority: WorkflowImageCleanupAuthority,
			input: WorkflowImageCleanupInput,
			receipt: { truncated: boolean },
		) => {
			await original(authority, input);
			assert.equal(receipt.truncated, false);
			completed++;
		},
		nativeStatus: async () => status,
		canceled: async () => canceled,
		scheduleRetry: async () => {
			retries++;
		},
	};
	return {
		storage,
		store,
		deps,
		fresh: () => new WorkflowImageCleanup(deps),
		hold: () => {
			active = false;
		},
		release: () => {
			active = true;
		},
		cancel: () => {
			canceled = true;
		},
		status: (s: string) => {
			status = s;
		},
		counts: () => ({ admitted, completed, retries }),
	};
}
async function prepare(f: ReturnType<typeof fixture>) {
	const journal = f.fresh(),
		refs = await describeWorkflowImages("tedi", "run", [image]);
	await journal.withRun("run", async () => {
		await journal.claim("run", "workflow-run", refs, "main");
		await persistWorkflowImages(
			f.store.bucket as unknown as WorkflowImageBucket,
			"tedi",
			"run",
			[image],
			() => journal.assertUploadReady("run"),
		);
	});
	return { journal, refs };
}
const key = `${WORKFLOW_IMAGE_CLEANUP_PREFIX}run`;
// Original independent authority is persisted before every upload; altered input denies.
{
	const f = fixture(),
		put = f.store.bucket.put;
	f.store.bucket.put = async (...args) => {
		const row = f.storage.data.get(key) as {
			authority: WorkflowImageCleanupAuthority;
			orgId: string;
			sessionKey: string;
		};
		assert.equal(row.orgId, "org");
		assert.equal(row.sessionKey, "main");
		assert.equal(row.authority.generation, 7);
		return put(...args);
	};
	const { journal, refs } = await prepare(f);
	await journal.claim("run", "workflow-run", refs, "main");
	assert.equal(f.counts().admitted, 1);
	await assert.rejects(journal.claim("run", "other", refs, "main"), /conflict/);
	await assert.rejects(
		journal.claim("run", "workflow-run", refs, "other"),
		/conflict/,
	);
	await assert.rejects(
		journal.claim(
			"run",
			"workflow-run",
			[{ ...refs[0]!, fileName: "changed" }],
			"main",
		),
		/conflict/,
	);
	f.deps.owner = () => ({ tediId: "tedi", orgId: "foreign" });
	assert.equal(await journal.attempt("run"), "failed");
	assert.ok(f.store.objects.size);
}
// Cancellation cannot invent a new cleanup obligation.
{
	const f = fixture();
	f.cancel();
	await assert.rejects(prepare(f), /original upload denied/);
	assert.equal(f.counts().admitted, 0);
	assert.equal(f.store.objects.size, 0);
}
// Revocation during list stops the first delete and retry scheduling.
{
	const f = fixture(),
		{ journal } = await prepare(f);
	f.status("complete");
	const list = f.store.bucket.list;
	let deletes = 0;
	f.store.bucket.list = async (...args) => {
		const page = await list(...args);
		f.hold();
		return page;
	};
	f.store.bucket.delete = async () => {
		deletes++;
	};
	assert.equal(
		await journal.terminal({
			runId: "run",
			workflowInstanceId: "workflow-run",
			intent: "terminal",
		}),
		"failed",
	);
	assert.equal(deletes, 0);
	assert.equal(f.counts().retries, 0);
}
// Actual final delete ACK survives hold and a fresh coordinator.
{
	const f = fixture(),
		{ journal } = await prepare(f);
	f.status("complete");
	const del = f.store.bucket.delete;
	f.store.bucket.delete = async (...args) => {
		await del(...args);
		f.hold();
	};
	assert.equal(await journal.attempt("run"), "cleaned");
	const row = f.storage.data.get(key) as {
		completed: boolean;
		page: { stage: string };
	};
	assert.equal(row.completed, true);
	assert.equal(row.page.stage, "acknowledged");
	assert.equal(f.store.objects.size, 0);
	assert.equal(await f.fresh().attempt("run"), "cleaned");
}
// A nonfinal ACK is retained but hold prevents another page/delete/schedule.
{
	const f = fixture(),
		{ journal } = await prepare(f);
	f.status("complete");
	let lists = 0,
		deletes = 0;
	const list = f.store.bucket.list,
		del = f.store.bucket.delete;
	f.store.bucket.list = async (...args) => {
		lists++;
		const page = await list(...args);
		return {
			...page,
			objects: page.objects.slice(0, 1),
			truncated: true,
			cursor: "page-2",
		};
	};
	f.store.bucket.delete = async (...args) => {
		deletes++;
		await del(...args);
		f.hold();
	};
	assert.equal(
		await journal.terminal({
			runId: "run",
			workflowInstanceId: "workflow-run",
			intent: "terminal",
		}),
		"failed",
	);
	assert.equal(lists, 1);
	assert.equal(deletes, 1);
	assert.equal(f.counts().completed, 0);
	assert.equal(f.counts().retries, 0);
	const row = f.storage.data.get(key) as {
		page: { stage: string; nextCursor: string };
	};
	assert.equal(row.page.stage, "acknowledged");
	assert.equal(row.page.nextCursor, "page-2");
}
// Lost delete ACK remains issued, including eviction. Never replay an unknown effect.
{
	const f = fixture(),
		{ journal } = await prepare(f);
	f.status("complete");
	let deletes = 0;
	const del = f.store.bucket.delete;
	f.store.bucket.delete = async (...args) => {
		deletes++;
		await del(...args);
		throw new Error("ack lost");
	};
	assert.equal(await journal.attempt("run"), "failed");
	assert.equal(await f.fresh().attempt("run"), "failed");
	assert.equal(deletes, 1);
	assert.equal(f.counts().completed, 0);
}
// Claimless historical rows never acquire authority through late callbacks.
{
	const f = fixture(),
		refs = await describeWorkflowImages("tedi", "run", [image]);
	await f.storage.put("wfimages:run", {
		hasImages: true,
		workflowInstanceId: "workflow-run",
		refs,
	});
	await f.storage.put(key, {
		tediId: "tedi",
		runId: "run",
		workflowInstanceId: "workflow-run",
		refs,
		dispatchRequested: true,
	});
	assert.equal(
		await f.fresh().terminal({
			runId: "run",
			workflowInstanceId: "workflow-run",
			intent: "cancelled",
		}),
		"failed",
	);
	await assert.rejects(
		f.fresh().claim("run", "workflow-run", refs, "main"),
		/conflict|authority/,
	);
	assert.equal(f.counts().admitted, 0);
}
// Live consumers and ambiguous requested dispatch still retain objects.
{
	const f = fixture(),
		{ journal } = await prepare(f);
	await journal.beforeDispatch("run", "workflow-run");
	assert.equal(await journal.attempt("run"), "retained");
	f.status("complete");
	await f.storage.put("wfctx:workflow-run", { runId: "run" });
	assert.equal(await journal.attempt("run"), "retained");
}
console.log("workflow-image-cleanup tests passed");
// An ACK whose durable write is lost remains uncertain after eviction, never reissued.
{
	const f = fixture(),
		{ journal } = await prepare(f);
	f.status("complete");
	let deletes = 0;
	const put = f.storage.put.bind(f.storage),
		del = f.store.bucket.delete;
	f.storage.put = async (key, value) => {
		if (
			(value as { page?: { stage?: string } })?.page?.stage === "acknowledged"
		)
			throw new Error("receipt write lost");
		return put(key, value);
	};
	f.store.bucket.delete = async (...args) => {
		deletes++;
		await del(...args);
	};
	assert.equal(await journal.attempt("run"), "failed");
	assert.equal(
		(f.storage.data.get(key) as { page: { stage: string } }).page.stage,
		"issued",
	);
	assert.equal(await f.fresh().attempt("run"), "failed");
	assert.equal(deletes, 1);
}
// Revocation during a manifest read denies the first actual upload.
{
	const f = fixture(),
		journal = f.fresh(),
		refs = await describeWorkflowImages("tedi", "run", [image]);
	await journal.claim("run", "workflow-run", refs, "main");
	const get = f.store.bucket.get;
	f.store.bucket.get = async (...args) => {
		const result = await get(...args);
		f.hold();
		return result;
	};
	await assert.rejects(
		persistWorkflowImages(
			f.store.bucket as unknown as WorkflowImageBucket,
			"tedi",
			"run",
			[image],
			() => journal.assertUploadReady("run"),
		),
		/held/,
	);
	assert.equal(f.store.objects.size, 0);
}
// Unknown run-prefix objects are not part of immutable refs and may not be deleted.
{
	const f = fixture(),
		{ journal } = await prepare(f);
	f.status("complete");
	f.store.objects.set(
		"__runtime/workflow-images/tedi/run/unowned.json",
		"unknown",
	);
	assert.equal(await journal.attempt("run"), "failed");
	assert.equal(f.store.objects.size, 3);
}
// Final known ACK recovery reuses the exact receipt shape, without another delete.
{
	const f = fixture(),
		{ journal } = await prepare(f);
	f.status("complete");
	const receipts: string[] = [];
	const complete = f.deps.completeCleanup;
	let fail = true,
		deletes = 0;
	const del = f.store.bucket.delete;
	f.deps.completeCleanup = async (authority, input, receipt) => {
		receipts.push(JSON.stringify(receipt));
		if (fail) {
			fail = false;
			throw new Error("terminal receipt write lost");
		}
		return complete(authority, input, receipt);
	};
	f.store.bucket.delete = async (...args) => {
		deletes++;
		return del(...args);
	};
	assert.equal(await journal.attempt("run"), "failed");
	f.hold();
	assert.equal(await f.fresh().attempt("run"), "cleaned");
	assert.equal(deletes, 1);
	assert.equal(receipts.length, 2);
	assert.equal(receipts[0], receipts[1]);
}

// The last preparation await cannot authorize deletion after its issued journal
// is changed or disappears. Preserve bytes and the unresolved obligation.
for (const mode of ["page", "missing"] as const) {
	const f = fixture(),
		{ journal } = await prepare(f);
	const assertActive = f.deps.assertCleanupActive;
	f.deps.assertCleanupActive = async (authority, input) => {
		const guard = await assertActive(authority, input);
		const row = f.storage.kv.get<any>(key);
		if (row?.page?.stage === "issued")
			queueMicrotask(() => {
				if (mode === "missing") f.storage.kv.delete(key);
				else f.storage.kv.put(key, { ...row, page: { ...row.page, keys: [] } });
			});
		return guard;
	};
	assert.equal(
		await journal.terminal({
			runId: "run",
			workflowInstanceId: "workflow-run",
			intent: "terminal",
		}),
		"failed",
	);
	assert.equal(f.store.deleted.length, 0);
	assert.ok(f.store.objects.size > 0);
	assert.equal(f.counts().completed, 0);
}

import type { DbQueryClient } from "@tedix/db/query-client";
import type { WorkspaceOutputRuntime } from "@tedix/db/queries/durable-sqlite/output-rpc";
import {
	getOutputAssetMigrationBounds,
	listObjectOutputAssetCandidates,
	listSharedOutputAssetCandidates,
	rewriteObjectOutputIndexBody,
	rewriteSharedOutputRevisionBody,
} from "@tedix/db/queries/os-workspaces/output-asset-migration";
import { getInlineOutputBody } from "@tedix/db/queries/os-workspaces/output-body-offload";
import type { OsOutputRevisionRow } from "@tedix/db/schema/os-workspaces";
import {
	isLargeEmbeddedImage,
	listOutputImageSources,
} from "@tedix/api-contract/utils/os-output-assets";
import {
	externalizeOutputAssets,
	type OutputAssetBucket,
} from "./os-output-assets";
import {
	hydrateOutputRevision,
	type OutputBodyBucket,
	storeOutputRevisionBody,
	verifyStoredOutputRevisionBody,
} from "./os-output-revision-body-store";

/**
 * One-time move of embedded images out of stored presentation and document
 * bodies. New writes already store images apart; this rewrites the bodies
 * written before that.
 *
 * Each tick walks one rowid window past a cursor kept in R2. For every
 * revision whose body still embeds images it stores each image with the
 * file, writes the body again with references (a new digest and key), reads
 * the new body back and compares every byte, then moves the revision's
 * pointer and its index row to the new body. The old body object is left for
 * the body sweep to remove. Revisions this database owns go first, then
 * revisions a workspace object owns, found through their index rows.
 *
 * Nothing runs until an operator starts it: with no state object in R2 a
 * tick does nothing. Writing `{"version":1,"phase":"shared","cursor":0}` to
 * the state key starts the migration; adding `"dryRun":true` starts a count
 * instead, which reads the same bodies, changes nothing and totals how many
 * revisions would be rewritten and how many bytes of embedded images they
 * hold. Either run ends once: when both passes reach the newest row the
 * state says `done` and later ticks do nothing. A failed row is named in the
 * tick receipt and keeps its embedded images, which stay readable. Set
 * `paused` in the state to stop; write a fresh state to run again.
 */

export const OUTPUT_ASSET_MIGRATION_PREFIX = "os-output-asset-migration/v1/";
export const OUTPUT_ASSET_MIGRATION_STATE_KEY = `${OUTPUT_ASSET_MIGRATION_PREFIX}state.json`;

type MigrationBucket = OutputBodyBucket &
	Pick<OutputAssetBucket, "put" | "head">;

export interface OutputAssetMigrationState {
	version: 1;
	phase: "shared" | "objects" | "done";
	cursor: number;
	/** Count what a run would change and write nothing but this state. */
	dryRun?: boolean;
	paused?: boolean;
	updatedAt?: string;
	completedAt?: string;
	totals: {
		scanned: number;
		/** Revisions rewritten, or in a dry run the revisions that would be. */
		rewritten: number;
		/** Bytes of embedded images in those revisions' bodies. */
		embeddedBytes: number;
		failures: number;
	};
}

export interface OutputAssetMigrationLimits {
	/** Rows scanned per tick. */
	windowRows: number;
	/** Presentation and document revisions read per tick. */
	maxRows: number;
	/** Wall-clock budget; the row in flight still completes. */
	maxMs: number;
}

export const DEFAULT_OUTPUT_ASSET_MIGRATION_LIMITS: OutputAssetMigrationLimits =
	{ windowRows: 500, maxRows: 40, maxMs: 20_000 };

const EMPTY_TOTALS: OutputAssetMigrationState["totals"] = {
	scanned: 0,
	rewritten: 0,
	embeddedBytes: 0,
	failures: 0,
};

/** The operator's state object, or null when the migration was never started. */
async function readState(
	bucket: MigrationBucket,
): Promise<OutputAssetMigrationState | null> {
	const object = await bucket.get(OUTPUT_ASSET_MIGRATION_STATE_KEY);
	if (!object) return null;
	const parsed = JSON.parse(
		new TextDecoder().decode(await object.arrayBuffer()),
	) as Partial<OutputAssetMigrationState>;
	if (
		parsed.version !== 1 ||
		!Number.isSafeInteger(parsed.cursor) ||
		!["shared", "objects", "done"].includes(parsed.phase ?? "")
	)
		throw new Error("Output asset migration state is unreadable");
	return {
		...parsed,
		totals: { ...EMPTY_TOTALS, ...parsed.totals },
	} as OutputAssetMigrationState;
}

async function writeJson(bucket: MigrationBucket, key: string, value: unknown) {
	await bucket.put(key, await new Blob([JSON.stringify(value)]).arrayBuffer());
}

export interface OutputAssetMigrationTickResult {
	status: "not_started" | "paused" | "done" | "swept";
	phase: OutputAssetMigrationState["phase"];
	dryRun: boolean;
	cursor: number;
	scanned: number;
	rewritten: number;
	embeddedBytes: number;
	failures: { revisionId: string; reason: string }[];
	receiptKey: string | null;
}

export async function runOutputAssetMigrationTick(input: {
	db: DbQueryClient;
	bucket: MigrationBucket;
	/** The workspace objects, where an installation has them. */
	runtime?: Pick<WorkspaceOutputRuntime, "outputQuery">;
	now: Date;
	limits?: Partial<OutputAssetMigrationLimits>;
}): Promise<OutputAssetMigrationTickResult> {
	const { db, bucket, runtime } = input;
	const limits = { ...DEFAULT_OUTPUT_ASSET_MIGRATION_LIMITS, ...input.limits };
	const startedAt = input.now.toISOString();
	const started = Date.now();
	const state = await readState(bucket);
	const result: OutputAssetMigrationTickResult = {
		status: "swept",
		phase: state?.phase ?? "shared",
		dryRun: state?.dryRun === true,
		cursor: state?.cursor ?? 0,
		scanned: 0,
		rewritten: 0,
		embeddedBytes: 0,
		failures: [],
		receiptKey: null,
	};
	if (!state) return { ...result, status: "not_started" };
	if (state.paused) return { ...result, status: "paused" };
	if (state.phase === "done") return { ...result, status: "done" };
	const phase = state.phase;
	const bounds = await getOutputAssetMigrationBounds(db);
	const maxRowid = phase === "shared" ? bounds.revisions : bounds.index;
	const after = state.cursor;
	const through = Math.min(after + limits.windowRows, maxRowid);
	const window = { after, through, limit: limits.maxRows };
	const candidates =
		phase === "shared"
			? await listSharedOutputAssetCandidates(db, window)
			: await listObjectOutputAssetCandidates(db, window);
	let cursor =
		candidates.length === limits.maxRows ? candidates.at(-1)!.rowid : through;

	/** Returns true when the revision was rewritten, false when it needed nothing. */
	const migrate = async (
		candidate: (typeof candidates)[number],
	): Promise<boolean> => {
		const inline =
			"inlineBytes" in candidate && candidate.inlineBytes > 0
				? await getInlineOutputBody(db, {
						rowid: candidate.rowid,
						id: candidate.revisionId,
						organizationId: candidate.organizationId,
					})
				: undefined;
		const { content } = await hydrateOutputRevision(
			{
				organizationId: candidate.organizationId,
				content: inline?.content ?? "",
				bodyR2Key: candidate.bodyR2Key,
				contentSha256: candidate.contentSha256,
				contentBytes: candidate.contentBytes,
			} as OsOutputRevisionRow,
			bucket,
		);
		const embedded = content.includes("data:")
			? listOutputImageSources(JSON.parse(content), isLargeEmbeddedImage)
			: [];
		if (embedded.length === 0) return false;
		const embeddedBytes = embedded.reduce(
			(bytes, source) => bytes + source.length,
			0,
		);
		if (state.dryRun) {
			result.embeddedBytes += embeddedBytes;
			return true;
		}
		const rewritten = await externalizeOutputAssets(
			{
				organizationId: candidate.organizationId,
				outputId: candidate.outputId,
			},
			content,
			bucket,
		);
		if (rewritten === content) return false;
		const body = await storeOutputRevisionBody(
			bucket,
			candidate.organizationId,
			rewritten,
		);
		await verifyStoredOutputRevisionBody(
			bucket,
			candidate.organizationId,
			rewritten,
			body,
		);
		const scope = {
			organizationId: candidate.organizationId,
			revisionId: candidate.revisionId,
		};
		if (!("workspaceId" in candidate)) {
			if (
				!(await rewriteSharedOutputRevisionBody(db, {
					...scope,
					...body,
					rowid: candidate.rowid,
					previousSha256: candidate.contentSha256,
					previousInlineBytes: candidate.inlineBytes,
				}))
			)
				throw new MigrationSkip("revision_changed");
			result.embeddedBytes += embeddedBytes;
			return true;
		}
		if (!runtime || !candidate.contentSha256)
			throw new MigrationSkip("workspace_object_unavailable");
		const workspace = {
			organizationId: candidate.organizationId,
			workspaceId: candidate.workspaceId,
		};
		const moved = await runtime.outputQuery(workspace, {
			op: "rebody",
			revisionId: candidate.revisionId,
			previousSha256: candidate.contentSha256,
			...body,
		});
		// An earlier tick may have moved the object and stopped before the index.
		if (
			!moved &&
			(
				await runtime.outputQuery(workspace, {
					op: "revision",
					revisionId: candidate.revisionId,
				})
			)?.contentSha256 !== body.contentSha256
		)
			throw new MigrationSkip("revision_changed");
		await rewriteObjectOutputIndexBody(db, {
			...scope,
			...body,
			previousSha256: candidate.contentSha256,
		});
		result.embeddedBytes += embeddedBytes;
		return true;
	};

	for (const candidate of candidates) {
		if (Date.now() - started >= limits.maxMs) {
			cursor = candidate.rowid - 1;
			break;
		}
		result.scanned++;
		try {
			if (await migrate(candidate)) result.rewritten++;
		} catch (error) {
			// Driver and image errors can carry content; receipts keep codes only.
			result.failures.push({
				revisionId: candidate.revisionId,
				reason:
					error instanceof MigrationSkip
						? error.message
						: (error as { code?: unknown })?.code === "BAD_REQUEST"
							? "image_refused"
							: "failed",
			});
		}
	}

	state.cursor = cursor;
	if (cursor >= maxRowid) {
		state.phase = phase === "shared" ? "objects" : "done";
		state.cursor = 0;
		if (state.phase === "done") state.completedAt = startedAt;
	}
	state.updatedAt = startedAt;
	state.totals.scanned += result.scanned;
	state.totals.rewritten += result.rewritten;
	state.totals.embeddedBytes += result.embeddedBytes;
	state.totals.failures += result.failures.length;
	if (!state.dryRun && (result.rewritten > 0 || result.failures.length > 0)) {
		result.receiptKey = `${OUTPUT_ASSET_MIGRATION_PREFIX}receipts/${startedAt}-${crypto.randomUUID()}.json`;
		await writeJson(bucket, result.receiptKey, {
			version: 1,
			startedAt,
			finishedAt: new Date().toISOString(),
			phase,
			after,
			through,
			cursor,
			scanned: result.scanned,
			rewritten: result.rewritten,
			failures: result.failures,
		});
	}
	await writeJson(bucket, OUTPUT_ASSET_MIGRATION_STATE_KEY, state);
	return { ...result, phase: state.phase, cursor: state.cursor };
}

class MigrationSkip extends Error {}

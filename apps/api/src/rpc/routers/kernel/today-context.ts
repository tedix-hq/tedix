import type { DbClient } from "@tedix/db/client";
import { listOsWorkApps } from "@tedix/db/queries/os-workspaces/gadgets";
import {
	getOsOutput,
	getOsOutputRevision,
} from "@tedix/db/queries/os-workspaces/outputs";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { ActivityFeedConfigSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import {
	OsGadgetManifestSchema,
	OsOutputContentSchema,
} from "@tedix/api-contract/schemas/os-workspaces";

export async function readSavedToday(
	db: DbClient,
	organizationId: string,
	personId: string,
) {
	const apps = await listOsWorkApps(db, organizationId, { userIds: [] }, 201);
	if (apps.length > 200) return null;
	const feed = apps
		.map((app) =>
			OsGadgetManifestSchema.parse(JSON.parse(app.revision.manifest)),
		)
		.find((manifest) => manifest.entry === "tedix:app/activity-feed");
	const config = ActivityFeedConfigSchema.safeParse(feed?.config);
	const today = config.success ? config.data.today : undefined;
	if (!today || today.personId !== personId) return null;
	const output = await getOsOutput(db, {
		organizationId,
		outputId: today.outputId,
	});
	if (
		!output?.currentRevisionId ||
		!output.workspaceId ||
		output.status !== "active"
	)
		return null;
	const workspace = await getOsWorkspace(db, {
		organizationId,
		workspaceId: output.workspaceId,
	});
	if (workspace?.visibility !== "org" || workspace.status !== "active")
		return null;
	const revision = await getOsOutputRevision(db, {
		organizationId,
		revisionId: output.currentRevisionId,
	});
	if (!revision || revision.outputId !== output.id) return null;
	if (revision.accessEnvelope) {
		const envelope = JSON.parse(revision.accessEnvelope);
		if (
			envelope.version !== 1 ||
			!Array.isArray(envelope.sources) ||
			envelope.sources.length
		)
			return null;
	}
	const parsed = OsOutputContentSchema.safeParse(JSON.parse(revision.content));
	if (!parsed.success || parsed.data.kind !== "document") return null;
	const blocks = parsed.data.blocks;
	const paragraphs = blocks.filter((b) => b.type === "paragraph");
	const table = blocks.find(
		(b) =>
			b.type === "table" &&
			b.headers.join("|") ===
				"Project|Goal|Progress|Running|Needs you|Project link|Receipts link|Deck link",
	);
	if (paragraphs.length < 3 || table?.type !== "table") return null;
	const rows = table.rows.filter(
		(r) =>
			r.length === 8 &&
			r
				.slice(5)
				.every(
					(link) =>
						/^\/work(?:\/projects\/|[?#]|$)/.test(link) &&
						!/[\\\u0000-\u0020]/.test(link),
				),
	);
	const text = [
		paragraphs[0]!.text,
		paragraphs[1]!.text,
		...rows.map(
			([name, goal, progress, running, needs, project, receipts, deck]) =>
				`[${name}](${project}): ${goal} [${progress}](${receipts}) ${running} [${needs} need${needs === "1" ? "s" : ""} you](${deck}).`,
		),
		paragraphs[2]!.text,
	]
		.filter(Boolean)
		.join("\n\n");
	return (
		text.slice(0, 20_000) +
		(text.length > 20_000 ? "\nMore projects are in Feed." : "")
	);
}

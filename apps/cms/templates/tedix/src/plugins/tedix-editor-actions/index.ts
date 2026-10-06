import { env as cfEnv } from "cloudflare:workers";
import { definePlugin } from "emdash";
import { editorActionsMetadata } from "./metadata";
export type NativeEditorRouteContext = Parameters<
	NonNullable<Parameters<typeof definePlugin>[0]["routes"]>[string]["handler"]
>[0];
type RouteContext = NativeEditorRouteContext;
import { getCmsEditorSession } from "../../auth/descope";
import { callEditorPlatformRpc } from "../../lib/platform-rpc";

type Draft = {
	collection: string;
	entryId: string;
	locale: string | null;
	baseRevision: string;
	invocationId: string;
	fields: Record<string, unknown>;
};
type Proposal = {
	invocationId: string;
	entryId: string;
	locale: string | null;
	baseRevision: string;
	values: Record<string, unknown>;
	seo?: { title: string; description: string };
};
const environment = () =>
	cfEnv as unknown as Record<string, string | undefined>;

async function propose(
	ctx: RouteContext,
	action: "rewrite" | "translate" | "seo",
): Promise<Proposal> {
	const input = ctx.input as { draft?: Draft };
	const draft = input.draft;
	if (
		!ctx.user ||
		!ctx.ui?.entry ||
		!draft ||
		ctx.ui.entry.id !== draft.entryId ||
		ctx.ui.entry.collection !== draft.collection ||
		(ctx.ui.entry.locale ?? null) !== draft.locale
	)
		throw new Error("A current editor draft is required");
	const session = getCmsEditorSession(ctx.request);
	if (!session) throw new Error("Sign in to the CMS to propose edits");
	const config = environment();
	const siteId = config.CMS_SITE_ID;
	const apiUrl = config.PLATFORM_API_URL;
	if (!siteId || !apiUrl || !ctx.http)
		throw new Error("CMS editor proposals are not configured");
	const targetLocale =
		action === "translate"
			? (draft.locale ?? ctx.ui.contentLocale ?? ctx.ui.locale)
			: undefined;
	const result = await callEditorPlatformRpc<Proposal>(
		apiUrl,
		["sites", "proposeCmsEditorDraft"],
		{
			siteId,
			action,
			draft: {
				collection: draft.collection,
				entryId: draft.entryId,
				locale: draft.locale,
				baseRevision: draft.baseRevision,
				invocationId: draft.invocationId,
				fields: draft.fields,
			},
			...(targetLocale ? { targetLocale } : {}),
		},
		session,
		ctx.http.fetch,
	);
	if (
		result.invocationId !== draft.invocationId ||
		result.entryId !== draft.entryId ||
		result.locale !== draft.locale ||
		result.baseRevision !== draft.baseRevision ||
		!result.values ||
		typeof result.values !== "object" ||
		Array.isArray(result.values)
	)
		throw new Error("Editing proposal does not match this draft");
	if (
		Object.keys(result.values).some(
			(field) => !Object.hasOwn(draft.fields, field),
		) ||
		new TextEncoder().encode(JSON.stringify(result)).byteLength > 48 * 1024
	)
		throw new Error("Editing proposal exceeds the selected draft");
	return result;
}

/** Native host validation binds the returned whole patch to the invocation receipt and unsaved generation. */
export async function proposeTextAction(
	ctx: RouteContext,
	action: "rewrite" | "translate",
) {
	try {
		const result = await propose(ctx, action);
		const operations = Object.entries(result.values).map(([field, value]) => ({
			op: "set" as const,
			field,
			value,
		}));
		if (!operations.length) throw new Error("No selected text fields");
		return {
			patch: { type: "editor-draft-patch" as const, operations },
			toast: {
				type: "info" as const,
				message: "Review proposed edits before saving.",
			},
		};
	} catch {
		return {
			toast: {
				type: "error" as const,
				message:
					"Could not propose edits. Check your CMS session, selected text fields and editor access, then retry.",
			},
		};
	}
}
export async function seoPanel(ctx: RouteContext) {
	const input = ctx.input as { type?: string; action_id?: string };
	if (input.type !== "block_action" || input.action_id !== "propose_seo")
		return {
			blocks: [
				{
					type: "section",
					text: "Propose SEO title and description from the current draft. Suggestions do not change saved or unsaved SEO metadata.",
				},
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "propose_seo",
							label: "Propose SEO",
							style: "primary",
						},
					],
				},
			],
		};
	try {
		const result = await propose(ctx, "seo");
		if (
			!result.seo ||
			typeof result.seo.title !== "string" ||
			typeof result.seo.description !== "string" ||
			result.seo.title.length > 160 ||
			result.seo.description.length > 320
		)
			throw new Error("Invalid SEO suggestions");
		return {
			blocks: [
				{
					type: "fields",
					fields: [
						{ label: "Suggested title", value: result.seo.title },
						{ label: "Suggested description", value: result.seo.description },
					],
				},
				{
					type: "section",
					text: "Review and copy these suggestions into the SEO fields. Nothing was saved or published.",
				},
			],
		};
	} catch {
		return {
			blocks: [
				{
					type: "section",
					text: "Could not propose SEO. Check your CMS session and selected text fields, then reopen this panel.",
				},
			],
		};
	}
}
export default definePlugin({
	id: editorActionsMetadata.id,
	version: editorActionsMetadata.version,
	capabilities: editorActionsMetadata.capabilities,
	allowedHosts: editorActionsMetadata.allowedHosts,
	routes: {
		rewrite: {
			permission: "content:edit_any",
			handler: (ctx) => proposeTextAction(ctx, "rewrite"),
		},
		translate: {
			permission: "content:edit_any",
			handler: (ctx) => proposeTextAction(ctx, "translate"),
		},
		seo: { permission: "content:edit_any", handler: seoPanel },
	},
	admin: {
		editorActions: editorActionsMetadata.editorActions,
		editorPanels: editorActionsMetadata.editorPanels,
	},
});

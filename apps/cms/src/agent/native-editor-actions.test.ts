import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CmsEditorDraftSchema } from "@tedix/api-contract/schemas/cms-editor-proposals";
import type { NativeEditorRouteContext as RouteContext } from "../../templates/tedix/src/plugins/tedix-editor-actions/index";
import plugin, {
	proposeTextAction,
	seoPanel,
} from "../../templates/tedix/src/plugins/tedix-editor-actions/index";
import { editorActionsMetadata } from "../../templates/tedix/src/plugins/tedix-editor-actions/metadata";
import { callEditorPlatformRpc } from "../../templates/tedix/src/lib/platform-rpc";
// Exercise the installed native host without importing vendor TypeScript into the CMS type-check scope.
const { validateEditorDraftRequest, validateEditorDraftPatch } = await import(
	new URL(
		"../../templates/tedix/node_modules/emdash/src/plugins/editor-draft.ts",
		import.meta.url,
	).href
);

const { adaptSandboxEntry } = await import(
	new URL(
		"../../templates/tedix/node_modules/emdash/src/plugins/adapt-sandbox-entry.ts",
		import.meta.url,
	).href
);
const { generatePluginsModule } = await import(
	new URL(
		"../../templates/tedix/node_modules/emdash/src/astro/integration/virtual-modules.ts",
		import.meta.url,
	).href
);
// The installed compiled context contains its media dependencies; its packed
// source counterpart imports development-only packages absent from consumers.
const nativeDist = resolve(
	dirname(
		createRequire(
			new URL(
				"../../templates/tedix/src/plugins/tedix-editor-actions/index.ts",
				import.meta.url,
			),
		).resolve("emdash/astro"),
	),
	"..",
);
const contextChunk = readdirSync(nativeDist).find(
	(file) => file.startsWith("context-") && file.endsWith(".mjs"),
);
if (!contextChunk) throw new Error("Installed native context chunk not found");
const contextPath = resolve(nativeDist, contextChunk);
const httpExport = readFileSync(contextPath, "utf8").match(
	/createHttpAccess as ([A-Za-z_$][\w$]*)/,
);
if (!httpExport)
	throw new Error("Installed native HTTP boundary export not found");
const createHttpAccess = (await import(pathToFileURL(contextPath).href))[
	httpExport[1]!
];

vi.mock("cloudflare:workers", () => ({
	env: {
		PLATFORM_API_URL: "https://api.tedix.dev",
		CMS_SITE_ID: "11111111-1111-4111-8111-111111111111",
	},
}));
vi.mock("emdash", () => ({
	definePlugin: (definition: unknown) => definition,
}));
const draft = {
	collection: "posts",
	entryId: "entry",
	locale: "de",
	baseRevision: "rev",
	invocationId: "invocation-123456",
	fields: { title: "Unsaved title" },
};
const proposed = (): {
	invocationId: string;
	entryId: string;
	locale: string;
	baseRevision: string;
	values: Record<string, unknown>;
	seo?: { title: string; description: string };
} => ({
	invocationId: draft.invocationId,
	entryId: draft.entryId,
	locale: draft.locale,
	baseRevision: draft.baseRevision,
	values: { title: "Proposed title" },
});
let calls: Array<{ url: string; headers: Headers; body: Record<string, any> }>;
const context = (result = proposed()): RouteContext =>
	({
		input: { type: "editor_action", draft },
		request: new Request(
			"https://acme.cms.tedix.dev/_emdash/api/editor/actions/rewrite",
			{ headers: { Cookie: "DS=editor-session; DSR=never-forward-refresh" } },
		),
		user: { id: "native-user", role: 40 },
		ui: {
			surface: "content-editor-action",
			locale: "en",
			direction: "ltr",
			contentLocale: "de",
			entry: { collection: "posts", id: "entry", locale: "de", version: 1 },
		},
		http: {
			fetch: async (url: string, init: RequestInit) => {
				calls.push({
					url,
					headers: new Headers(init.headers),
					body: JSON.parse(String(init.body)),
				});
				return Response.json({ json: result });
			},
		},
	}) as unknown as RouteContext;
beforeEach(() => {
	calls = [];
});
describe("native editor proposals", () => {
	it("forwards the same editor session and selected unsaved snapshot, returning only an unsaved native patch", async () => {
		const result = await proposeTextAction(context(), "rewrite");
		expect(result.patch).toEqual({
			type: "editor-draft-patch",
			operations: [{ op: "set", field: "title", value: "Proposed title" }],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(
			"https://api.tedix.dev/rpc/sites/proposeCmsEditorDraft",
		);
		expect(calls[0]!.headers.get("Authorization")).toBe(
			"Bearer editor-session",
		);
		expect(calls[0]!.body.json.draft).toEqual(draft);
		expect(JSON.stringify(calls)).not.toContain("never-forward-refresh");
		expect(result).not.toHaveProperty("refresh");
	});
	it("translates to the content locale, preserving entry identity", async () => {
		await proposeTextAction(context(), "translate");
		expect(calls[0]!.body.json.targetLocale).toBe("de");
	});
	it.each(["entryId", "locale", "baseRevision", "invocationId"] as const)(
		"rejects entire mismatched %s proposal",
		async (key) => {
			const result = await proposeTextAction(
				context({ ...proposed(), [key]: "other" }),
				"rewrite",
			);
			expect(result).not.toHaveProperty("patch");
			expect(result.toast.type).toBe("error");
		},
	);
	it("rejects an added unselected field", async () => {
		const result = await proposeTextAction(
			context({ ...proposed(), values: { title: "New", extra: "Denied" } }),
			"rewrite",
		);
		expect(result).not.toHaveProperty("patch");
	});
	it("rejects a changed locale before any model request", async () => {
		const ctx = context();
		ctx.input = { type: "editor_action", draft: { ...draft, locale: "fr" } };
		expect(await proposeTextAction(ctx, "rewrite")).not.toHaveProperty("patch");
		expect(calls).toEqual([]);
	});
	it("refuses missing user sessions without PAT fallback", async () => {
		const ctx = context();
		ctx.request = new Request(ctx.request.url);
		expect(await proposeTextAction(ctx, "rewrite")).not.toHaveProperty("patch");
		expect(calls).toEqual([]);
	});
	it("SEO panel does not infer on load and returns suggestions without patch on explicit action", async () => {
		const ctx = context({
			...proposed(),
			values: {},
			seo: { title: "SEO title", description: "SEO description" },
		});
		ctx.input = { type: "panel_load" };
		expect(await seoPanel(ctx)).toHaveProperty("blocks");
		expect(calls).toEqual([]);
		ctx.input = { type: "block_action", action_id: "propose_seo", draft };
		const result = await seoPanel(ctx);
		expect(result).not.toHaveProperty("patch");
		expect(result.blocks[0]).toMatchObject({ type: "fields" });
		expect(calls).toHaveLength(1);
	});
	it("declares bounded native text selectors and private editor permissions", () => {
		expect(plugin.id).toBe("tedix-editor-actions");
		for (const action of plugin.admin?.editorActions ?? []) {
			expect(action.draft).toEqual({
				read: { fields: ["title", "meta_description"] },
				patch: { fields: ["title", "meta_description"] },
			});
		}
		expect(plugin.routes?.rewrite?.public).not.toBe(true);
		expect(plugin.routes?.rewrite?.permission).toBe("content:edit_any");
	});
	it("refuses credential forwarding to insecure or credential-bearing origins", async () => {
		const fetch = vi.fn();
		await expect(
			callEditorPlatformRpc(
				"http://attacker.test",
				["sites"],
				{},
				"session",
				fetch,
			),
		).rejects.toThrow("origin");
		await expect(
			callEditorPlatformRpc(
				"https://user:pass@attacker.test",
				["sites"],
				{},
				"session",
				fetch,
			),
		).rejects.toThrow("origin");
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("installed native host draft guards", () => {
	const collection = {
		id: "posts",
		slug: "posts",
		fields: [
			{
				id: "title",
				collectionId: "posts",
				slug: "title",
				label: "Title",
				type: "string",
				columnType: "TEXT",
				translatable: true,
				required: true,
				unique: false,
				sortOrder: 0,
				searchable: false,
				indexed: false,
				createdAt: "2026-10-02",
			},
		],
	};
	const nativeRequest = { ...draft, generation: 4 };
	const validate = (request: unknown) =>
		validateEditorDraftRequest({
			request,
			collection,
			entry: {
				id: draft.entryId,
				locale: draft.locale,
				revision: draft.baseRevision,
			},
			readSelector: { translatable: true },
			patchSelector: { translatable: true },
			canRead: true,
			canPatch: true,
		});
	it("captures the unsaved generation in the host receipt", () => {
		const result = validate(nativeRequest);
		expect(result).not.toHaveProperty("code");
		if ("code" in result) return;
		expect(result.receipt.generation).toBe(4);
		expect(result.snapshot.fields.title).toBe("Unsaved title");
		expect(result.snapshot).not.toHaveProperty("generation");
	});
	it.each(["entryId", "locale", "baseRevision"])(
		"rejects stale %s before invocation",
		(key) => {
			expect(validate({ ...nativeRequest, [key]: "changed" })).toMatchObject({
				code: "EDITOR_DRAFT_STALE",
			});
		},
	);
	it("rejects the whole patch when one field is forbidden or invalid", () => {
		expect(
			validateEditorDraftPatch({
				collection,
				allowedFields: new Set(["title"]),
				patch: {
					type: "editor-draft-patch",
					operations: [
						{ op: "set", field: "title", value: "Valid" },
						{ op: "set", field: "seo", value: "Forbidden" },
					],
				},
			}),
		).toMatchObject({ code: "EDITOR_DRAFT_FIELD_FORBIDDEN" });
		expect(
			validateEditorDraftPatch({
				collection,
				allowedFields: new Set(["title"]),
				patch: {
					type: "editor-draft-patch",
					operations: [{ op: "set", field: "title", value: 42 }],
				},
			}),
		).toMatchObject({ code: "EDITOR_DRAFT_INVALID" });
	});
});

describe("native editor descriptor registration", () => {
	function registerThroughNativeModule() {
		const generated = generatePluginsModule([
			{ ...editorActionsMetadata, entrypoint: "editor-actions-entry" },
		]);
		// Execute the installed generator's actual serialized descriptor boundary.
		const execute = new Function(
			"adaptSandboxEntry",
			"pluginDef0",
			generated
				.replace(/^import .*;$/gm, "")
				.replace("export const plugins =", "return"),
		);
		return execute(adaptSandboxEntry, plugin)[0];
	}

	it("registers actions, panels and egress trust through the native module and adapter", () => {
		const registered = registerThroughNativeModule();
		expect(registered.admin.editorActions).toEqual(
			editorActionsMetadata.editorActions,
		);
		expect(registered.admin.editorPanels).toEqual(
			editorActionsMetadata.editorPanels,
		);
		expect(
			registered.admin.editorActions.map(
				(action: { route: string }) => action.route,
			),
		).toEqual(["rewrite", "translate"]);
		expect(registered.admin.editorPanels[0]).toMatchObject({
			title: "SEO suggestions",
			route: "seo",
			draft: { read: { fields: ["title", "meta_description"] } },
		});
		expect(registered.allowedHosts).toEqual(["api.tedix.dev"]);
	});

	it("preserves the standard plugin's complete single-argument route context", async () => {
		const registered = registerThroughNativeModule();
		const result = await registered.routes.rewrite.handler(context());
		expect(result.patch).toEqual({
			type: "editor-draft-patch",
			operations: [{ op: "set", field: "title", value: "Proposed title" }],
		});
		expect(calls[0]!.body.json.draft).toEqual(draft);
		expect(registered.routes.rewrite.permission).toBe("content:edit_any");
	});

	it("allows only the configured API host at the installed native HTTP boundary", async () => {
		const registered = registerThroughNativeModule();
		const fetch = vi.fn(async () => Response.json({ accepted: true }));
		const http = createHttpAccess(
			registered.id,
			registered.allowedHosts,
			fetch,
		);
		await expect(
			http.fetch("https://api.tedix.dev/rpc/sites/proposeCmsEditorDraft"),
		).resolves.toBeInstanceOf(Response);
		expect(fetch).toHaveBeenCalledTimes(1);
		await expect(
			http.fetch("https://attacker.example/rpc/sites/proposeCmsEditorDraft"),
		).rejects.toThrow(/not allowed/);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe("installed native browser draft capture", () => {
	it("captures only title and description from a homepage larger than the API bound", () => {
		// The admin ships its private helpers in the source map. Execute those
		// installed functions rather than recreate selection/capture in this test.
		const map = JSON.parse(
			readFileSync(
				new URL(
					"../../templates/tedix/node_modules/@emdash-cms/admin/dist/index.js.map",
					import.meta.url,
				),
				"utf8",
			),
		) as { sources: string[]; sourcesContent: string[] };
		const source = (suffix: string) => {
			const index = map.sources.findIndex((path) => path.endsWith(suffix));
			if (index < 0 || !map.sourcesContent[index])
				throw new Error(`Installed admin source missing: ${suffix}`);
			return map.sourcesContent[index]!;
		};
		const nativeRequire = createRequire(
			new URL("../../templates/tedix/package.json", import.meta.url),
		);
		const { transformSync } = nativeRequire("esbuild");
		const compile = (input: string) =>
			transformSync(input, { loader: "ts", format: "cjs", target: "es2022" })
				.code;
		const selectionModule = { exports: {} as Record<string, any> };
		new Function(
			"module",
			"exports",
			compile(source("sandboxed-editor-extensions.ts")),
		)(selectionModule, selectionModule.exports);
		const editor = source("ContentEditor.tsx");
		const captureStart = editor.indexOf(
			"const captureEditorDraft = React.useCallback(",
		);
		const callbackStart = editor.indexOf("(access:", captureStart);
		const callbackEnd = editor.indexOf("\n\t\t[fields],", callbackStart);
		if (captureStart < 0 || callbackStart < 0 || callbackEnd < 0)
			throw new Error("Installed native capture callback missing");
		const captureSource = editor
			.slice(callbackStart, callbackEnd)
			.trim()
			.replace(/,$/, "");
		const formData = {
			title: "Unsaved homepage title",
			meta_description: "Unsaved homepage description",
			content: [
				{ _type: "tedix_hero", headline: "Custom content".repeat(5000) },
			],
			search_text: "Derived search text".repeat(4000),
		};
		const fields = Object.fromEntries(
			Object.keys(formData).map((slug) => [slug, { translatable: true }]),
		);
		const captureModule = { exports: {} as Record<string, any> };
		new Function(
			"module",
			"exports",
			"selectEditorDraftFields",
			"fields",
			"editorContextRef",
			"formDataRef",
			"editorGenerationRef",
			compile(`export default ${captureSource};`),
		)(
			captureModule,
			captureModule.exports,
			selectionModule.exports.selectEditorDraftFields,
			fields,
			{ current: { ...draft, collection: "pages" } },
			{ current: formData },
			{ current: 4 },
		);
		const capture = captureModule.exports.default;
		const full = capture({ read: { translatable: true } });
		expect(
			new TextEncoder().encode(JSON.stringify(full.fields)).byteLength,
		).toBeGreaterThan(48 * 1024);
		const { generation: _fullGeneration, ...fullSnapshot } = full;
		expect(CmsEditorDraftSchema.safeParse(fullSnapshot).success).toBe(false);
		for (const access of [
			...editorActionsMetadata.editorActions.map((action) => action.draft),
			editorActionsMetadata.editorPanels[0]!.draft,
		]) {
			const captured = capture(access);
			expect(captured.fields).toEqual({
				title: formData.title,
				meta_description: formData.meta_description,
			});
			expect(captured).toMatchObject({
				entryId: draft.entryId,
				locale: draft.locale,
				baseRevision: draft.baseRevision,
				generation: 4,
			});
			expect(
				new TextEncoder().encode(JSON.stringify(captured)).byteLength,
			).toBeLessThan(48 * 1024);
			const { generation: _generation, ...snapshot } = captured;
			expect(CmsEditorDraftSchema.safeParse(snapshot).success).toBe(true);
			const collection = {
				slug: "pages",
				fields: ["title", "meta_description"].map((slug) => ({
					slug,
					type: "string",
					translatable: true,
					required: false,
				})),
			};
			const validated = validateEditorDraftRequest({
				request: captured,
				collection,
				entry: {
					id: draft.entryId,
					locale: draft.locale,
					revision: draft.baseRevision,
				},
				readSelector: access.read,
				patchSelector: "patch" in access ? access.patch : undefined,
				canRead: true,
				canPatch: "patch" in access,
			});
			expect(validated).not.toHaveProperty("code");
			expect(validated.snapshot.fields).toEqual(captured.fields);
		}
	});
});

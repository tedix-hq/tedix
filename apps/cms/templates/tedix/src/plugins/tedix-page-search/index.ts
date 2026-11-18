/** Search text follows the stored version of each native block schema. */
import {
	BlockTypeRegistry,
	ContentRepository,
	FTSManager,
	RevisionRepository,
	SchemaRegistry,
} from "emdash";
import type { BlockType, BlockFieldDefinition } from "emdash";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

const SEARCH_FIELD = "search_text";

type SearchField = Pick<BlockFieldDefinition, "slug" | "type" | "validation">;
type BlockSchema = Pick<BlockType, "slug"> & {
	versions: { version: number; fields: SearchField[] }[];
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown, parts: string[]): void {
	if (typeof value !== "string") return;
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized) parts.push(normalized);
}

function media(value: unknown, parts: string[]): void {
	const image = record(value);
	if (!image) return;
	text(image.alt, parts);
	text(image.caption, parts);
	const dark = record(image.darkVariant);
	if (dark) {
		text(dark.alt, parts);
		text(dark.caption, parts);
	}
}

function portableText(value: unknown, parts: string[]): void {
	if (!Array.isArray(value)) return;
	for (const node of value) {
		const block = record(node);
		if (block?._type === "block" && Array.isArray(block.children)) {
			text(
				block.children
					.map((child: unknown) => {
						const span = record(child);
						return span?._type === "span" && typeof span.text === "string"
							? span.text
							: "";
					})
					.join(""),
				parts,
			);
		} else if (block?._type === "image") media(block, parts);
	}
}

function fieldsText(
	value: unknown,
	fields: SearchField[],
	parts: string[],
): void {
	const data = record(value);
	if (!data) return;
	for (const field of fields) {
		const value = data[field.slug];
		switch (field.type) {
			case "string":
				// Older schemas used strings for links; keep URL-only values out.
				if (
					typeof value === "string" &&
					/^(?:https?:\/\/|\/|#|mailto:|tel:)\S*$/i.test(value.trim())
				)
					break;
				text(value, parts);
				break;
			case "text":
				text(value, parts);
				break;
			case "portableText":
				portableText(value, parts);
				break;
			case "image":
				media(value, parts);
				break;
			case "repeater":
				if (Array.isArray(value))
					for (const row of value)
						fieldsText(row, field.validation?.subFields ?? [], parts);
				break;
		}
	}
}

export function projectPageSearchText(
	content: unknown,
	schemas: BlockSchema[],
): string {
	if (!Array.isArray(content))
		throw new TypeError("Native blocks must be an array");
	const parts: string[] = [];
	for (const value of content) {
		const block = record(value);
		const schema = schemas.find((schema) => schema.slug === block?._type);
		const version = schema?.versions.find(
			(version) => version.version === block?._version,
		);
		if (!block || !version)
			throw new TypeError("Native block schema version is unavailable");
		fieldsText(block, version.fields, parts);
	}
	return parts.join("\n");
}

export async function searchCollections(ctx: PluginContext): Promise<string[]> {
	const value = await ctx.settings.get("collections");
	if (value != null && typeof value !== "string")
		throw new TypeError("Search collections must be comma-separated slugs");
	return [
		...new Set(
			(value ?? "pages")
				.split(",")
				.map((slug) => slug.trim())
				.filter(Boolean),
		),
	];
}

async function database() {
	const { getDb } = await import("emdash/runtime");
	return getDb();
}

function projectEntry(
	data: Record<string, unknown>,
	fields: { slug: string }[],
	schemas: BlockSchema[],
): string {
	return fields
		.map((field) => projectPageSearchText(data[field.slug] ?? [], schemas))
		.filter(Boolean)
		.join("\n");
}

/** Bounded, repeatable backfill; cron checkpoints only a successful batch. */
export async function backfillSearch(
	ctx: PluginContext,
	input: { collection: string; cursor?: string },
) {
	if (!(await searchCollections(ctx)).includes(input.collection))
		throw new TypeError("Collection is not configured for native block search");
	const db = await database();
	const registry = new SchemaRegistry(db);
	const collection = await registry.getCollectionWithFields(input.collection);
	if (!collection || !collection.supports.includes("search"))
		throw new TypeError("Collection must support search");
	const fields = collection.fields.filter((field) => field.type === "blocks");
	if (!fields.length)
		throw new TypeError("Collection has no native block fields");
	const existing = collection.fields.find(
		(field) => field.slug === SEARCH_FIELD,
	);
	if (existing && existing.type !== "text")
		throw new TypeError("search_text must be a derived text field");
	const definition = { searchable: true, widget: "derived-search-text" };
	if (!existing)
		await registry.createField(collection.slug, {
			slug: SEARCH_FIELD,
			label: "Generated search text",
			type: "text",
			...definition,
		});
	else if (!existing.searchable || existing.widget !== definition.widget)
		await registry.updateField(collection.slug, SEARCH_FIELD, definition);
	const schemas = await new BlockTypeRegistry(db).listBlockTypes();
	const content = new ContentRepository(db);
	// No locale filter: all published translations need their own projection.
	const page = await content.findMany(collection.slug, {
		limit: 50,
		cursor: input.cursor,
		where: { status: "published" },
		orderBy: { field: "createdAt", direction: "asc" },
	});
	let updated = 0;
	for (const entry of page.items) {
		const projected = projectEntry(entry.data, fields, schemas);
		if (entry.data[SEARCH_FIELD] === projected) continue;
		// update writes only the live column; pending revisions and publication stay intact.
		await content.update(
			collection.slug,
			entry.id,
			{ data: { [SEARCH_FIELD]: projected } },
			{ version: entry.version, updatedAt: entry.updatedAt },
		);
		updated++;
	}
	if (!page.nextCursor) {
		const search = new FTSManager(db);
		const config = await search.getSearchConfig(collection.slug);
		if (config?.enabled)
			await search.rebuildIndex(
				collection.slug,
				await search.getSearchableFields(collection.slug),
				config.weights,
				config.tokenize,
			);
		else await search.enableSearch(collection.slug);
	}
	return {
		collection: collection.slug,
		updated,
		nextCursor: page.nextCursor ?? null,
		rebuilt: !page.nextCursor,
	};
}

const BACKFILL_TASK = "backfill-search";
const BACKFILL_STATE = "state:backfill-search";

type BackfillState = {
	fingerprint: string;
	collections: string[];
	collectionIndex: number;
	cursor?: string;
	done: boolean;
};

/** Reconcile on activation and public renders: config plugins already installed
 * on a site do not receive install/activate again just because a bundle changed. */
export async function armSearchBackfill(ctx: PluginContext): Promise<void> {
	if (!ctx.cron) throw new Error("Native cron is unavailable");
	const collections = (await searchCollections(ctx)).sort();
	const schemas = await new BlockTypeRegistry(
		await database(),
	).listBlockTypes();
	const signature = JSON.stringify([
		collections,
		schemas
			.map(({ slug, versions }) => [slug, versions])
			.sort(([a], [b]) => String(a).localeCompare(String(b))),
	]);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(signature),
	);
	const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const current = await ctx.kv.getVersioned<BackfillState>(BACKFILL_STATE);
	if (current?.value.fingerprint !== fingerprint) {
		const result = await ctx.kv.compareAndSet(
			BACKFILL_STATE,
			current?.revision ?? null,
			{
				fingerprint,
				collections,
				collectionIndex: 0,
				done: false,
			} satisfies BackfillState,
		);
		if (!result.applied) return;
	} else if (current.value.done) return;
	// Do not postpone an existing task on every page request.
	if (!(await ctx.cron.list()).some(({ name }) => name === BACKFILL_TASK))
		await ctx.cron.schedule(BACKFILL_TASK, { schedule: "* * * * *" });
}

async function requestAIReindex(collections: string[]): Promise<void> {
	if (!collections.length) return;
	const { withEmDashRuntime } = await import("emdash/middleware");
	await withEmDashRuntime(async (runtime) => {
		const call = async (path: string, input?: unknown) => {
			const method = input === undefined ? "GET" : "POST";
			const result = await runtime.handlePluginApiRoute(
				"ai-search",
				method,
				`/${path}`,
				new Request(`https://internal.invalid/${path}`, {
					method,
					...(input === undefined
						? {}
						: {
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify(input),
							}),
				}),
			);
			if (!result.success) throw new Error(`AI Search ${path} failed`);
			return record(result.data);
		};
		// A running job is reused by native reindex. Wait for it so our request
		// always starts a fresh pass over the newly projected live content.
		const previous = await call("reindex");
		if (previous && previous.done !== true)
			throw new Error("Waiting for the existing AI Search reindex");
		const config = await call("config");
		if (
			!Array.isArray(config?.collections) ||
			!config.collections.every((slug) => typeof slug === "string")
		)
			throw new Error("AI Search collections are unavailable");
		const union = [...new Set([...config.collections, ...collections])];
		const started = await call("reindex", {
			collections: union,
			onlyMissing: false,
		});
		if (
			!started ||
			typeof started.jobId !== "string" ||
			started.jobId === previous?.jobId ||
			!Array.isArray(started.collections) ||
			!union.every((slug) => (started.collections as unknown[]).includes(slug))
		)
			throw new Error(
				"AI Search did not accept a fresh reindex for all collections",
			);
	});
}

export async function runSearchBackfill(ctx: PluginContext): Promise<void> {
	await armSearchBackfill(ctx);
	const saved = await ctx.kv.getVersioned<BackfillState>(BACKFILL_STATE);
	if (!saved) return;
	const state = { ...saved.value };
	let checkpoint = saved.revision;
	if (!state.done) {
		const collection = state.collections[state.collectionIndex];
		if (collection) {
			const batch = await backfillSearch(ctx, {
				collection,
				cursor: state.cursor,
			});
			state.cursor = batch.nextCursor ?? undefined;
			if (!batch.nextCursor) state.collectionIndex++;
			const result = await ctx.kv.compareAndSet(
				BACKFILL_STATE,
				checkpoint,
				state,
			);
			if (!result.applied) return;
			checkpoint = result.revision;
		}
		if (state.collectionIndex >= state.collections.length) {
			await requestAIReindex(state.collections);
			state.done = true;
			const result = await ctx.kv.compareAndSet(
				BACKFILL_STATE,
				checkpoint,
				state,
			);
			if (!result.applied) return;
		}
	}
	if (state.done) {
		await ctx.cron?.cancel(BACKFILL_TASK);
		// A settings change may have re-armed the task during cancellation.
		await armSearchBackfill(ctx);
	}
}

async function reconcileSearch(ctx: PluginContext): Promise<void> {
	try {
		await armSearchBackfill(ctx);
	} catch (error) {
		ctx.log.error("Could not schedule native block search backfill", {
			error: String(error),
		});
	}
}

export default {
	hooks: {
		"plugin:install": {
			errorPolicy: "continue",
			handler: async (_event, ctx) => reconcileSearch(ctx),
		},
		"plugin:activate": {
			errorPolicy: "continue",
			handler: async (_event, ctx) => reconcileSearch(ctx),
		},
		"page:metadata": {
			errorPolicy: "continue",
			handler: async (_event, ctx) => {
				await reconcileSearch(ctx);
				return null;
			},
		},
		cron: {
			errorPolicy: "continue",
			timeout: 120_000,
			handler: async (event, ctx) => {
				if (event.name !== BACKFILL_TASK) return;
				try {
					await runSearchBackfill(ctx);
				} catch (error) {
					// Keep the last successful cursor. A conflict retries this page
					// against current revisions on the next native cron tick.
					ctx.log.error("Native block search backfill will resume", {
						error: String(error),
					});
				}
			},
		},
		"content:beforeSave": {
			errorPolicy: "abort",
			handler: async ({ collection, content, id }, ctx) => {
				if (!(await searchCollections(ctx)).includes(collection)) return;
				const db = await database();
				const schema = await new SchemaRegistry(db).getCollectionWithFields(
					collection,
				);
				const fields =
					schema?.fields.filter((field) => field.type === "blocks") ?? [];
				if (!fields.length) return;
				if (!fields.some((field) => Object.hasOwn(content, field.slug))) {
					if (Object.hasOwn(content, SEARCH_FIELD))
						throw new TypeError(
							`${collection}.search_text is derived from native blocks`,
						);
					return;
				}
				let previous: Record<string, unknown> = {};
				if (id && fields.some((field) => !Object.hasOwn(content, field.slug))) {
					const entry = await new ContentRepository(db).findById(
						collection,
						id,
					);
					if (!entry) throw new TypeError("Existing entry is unavailable");
					const draft = entry.draftRevisionId
						? await new RevisionRepository(db).findById(entry.draftRevisionId)
						: null;
					if (entry.draftRevisionId && !draft)
						throw new TypeError("Existing draft is unavailable");
					previous = draft?.data ?? entry.data;
				}
				const schemas = await new BlockTypeRegistry(db).listBlockTypes();
				for (const field of fields)
					if (
						Object.hasOwn(content, field.slug) &&
						!Array.isArray(content[field.slug])
					)
						throw new TypeError(`${collection}.${field.slug} must be an array`);
				return {
					...content,
					[SEARCH_FIELD]: projectEntry(
						{ ...previous, ...content },
						fields,
						schemas,
					),
				};
			},
		},
	},
} satisfies SandboxedPlugin;

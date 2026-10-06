import * as z from "zod";

// MCP SDK 1.29 supports Zod v4 at runtime but TS overload resolution
// can't match v4's ZodObject against the SDK's AnySchema union.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const schema = (s: z.ZodType): any => s;

// ---------------------------------------------------------------------------
// Shared output-schema shapes for read-only CMS proxy tools.
//
// These describe the upstream Emdash REST JSON payload that the tool emits
// (stringified into a text content block). Schemas are permissive — they
// model the "shape signal" rather than enforcing strict contracts, because
// Emdash field-level payloads vary by tenant schema. The goal is to give the
// model + audit gate a real type signal that survives upstream catalog
// rescans (instead of the additionalProperties:true placeholder).
// ---------------------------------------------------------------------------

const ContentItemSchema = z
	.object({
		id: z.string(),
		slug: z.string().nullable().optional(),
		status: z.string().optional(),
		locale: z.string().nullable().optional(),
		data: z.record(z.string(), z.unknown()).optional(),
		seo: z.record(z.string(), z.unknown()).nullable().optional(),
		publishedAt: z.string().nullable().optional(),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
		_rev: z.string().optional(),
	})
	.catchall(z.unknown());

const ContentAuthorSchema = z
	.object({
		id: z.string(),
		name: z.string().nullable().optional(),
		email: z.string().nullable().optional(),
		avatarUrl: z.string().nullable().optional(),
		filterableByAuthorId: z.boolean().optional(),
		filterableBylineId: z.boolean().optional(),
		bylineId: z.string().optional(),
		source: z.string().optional(),
	})
	.catchall(z.unknown());

const MediaItemSchema = z
	.object({
		id: z.string(),
		filename: z.string().optional(),
		mimeType: z.string().optional(),
		mime_type: z.string().optional(),
		size: z.number().int().optional(),
		width: z.number().int().nullable().optional(),
		height: z.number().int().nullable().optional(),
		alt: z.string().nullable().optional(),
		caption: z.string().nullable().optional(),
		storageKey: z.string().optional(),
		storage_key: z.string().optional(),
		blurhash: z.string().nullable().optional(),
		folderId: z.string().nullable().optional(),
		usage: z
			.object({
				count: z.number().int().nonnegative().nullable(),
				coverage: z.object({
					scope: z.literal("all_content_collections"),
					status: z.enum([
						"complete",
						"never",
						"running",
						"partial",
						"failed",
						"stale",
						"unknown",
					]),
				}),
			})
			.optional(),
	})
	.catchall(z.unknown());

const MediaFolderSchema = z.object({ id: z.string(), name: z.string() });

const MediaUsageDetailsSchema = z.object({
	items: z.array(
		z
			.object({
				collection: z.string(),
				contentId: z.string(),
				title: z.string().nullable(),
				slug: z.string().nullable(),
				locale: z.string().nullable(),
				status: z.string().nullable(),
				scheduledAt: z.string().nullable(),
				deletedAt: z.string().nullable(),
				sources: z.array(
					z.object({
						variant: z.enum(["columns", "draft_overlay"]),
						occurrences: z.array(
							z.object({
								fieldSlug: z.string(),
								fieldPath: z.string(),
								occurrenceIndex: z.number().int().nonnegative(),
								referenceType: z.enum([
									"image_field",
									"file_field",
									"portable_text_image",
									"unknown",
								]),
							}),
						),
					}),
				),
			})
			.catchall(z.unknown()),
	),
	nextCursor: z.string().optional(),
	siteSettings: z.array(z.object({ setting: z.string() })),
	coverage: z.object({
		scope: z.literal("all_content_collections"),
		status: z.string(),
	}),
});

const MediaUsageDetailsResponseSchema = z
	.object({
		data: MediaUsageDetailsSchema.optional(),
		items: MediaUsageDetailsSchema.shape.items.optional(),
	})
	.catchall(z.unknown());

const FieldDefSchema = z
	.object({
		slug: z.string(),
		label: z.string().optional(),
		type: z.string(),
		required: z.boolean().optional(),
		unique: z.boolean().optional(),
		defaultValue: z.unknown().optional(),
		validation: z.record(z.string(), z.unknown()).optional(),
		widget: z.string().nullable().optional(),
		options: z.record(z.string(), z.unknown()).optional(),
		sortOrder: z.number().int().optional(),
		searchable: z.boolean().optional(),
		translatable: z.boolean().optional(),
	})
	.catchall(z.unknown());

const CollectionSchema = z
	.object({
		slug: z.string(),
		label: z.string().optional(),
		labelSingular: z.string().nullable().optional(),
		description: z.string().nullable().optional(),
		icon: z.string().nullable().optional(),
		supports: z.array(z.string()).optional(),
		urlPattern: z.string().nullable().optional(),
		hasSeo: z.boolean().optional(),
		fields: z.array(FieldDefSchema).optional(),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
	})
	.catchall(z.unknown());

const TaxonomySchema = z
	.object({
		id: z.string().optional(),
		name: z.string(),
		label: z.string().optional(),
		labelSingular: z.string().nullable().optional(),
		hierarchical: z.boolean().optional(),
		collections: z.array(z.string()).optional(),
		locale: z.string().optional(),
		translationGroup: z.string().nullable().optional(),
	})
	.catchall(z.unknown());

const TermSchema = z
	.object({
		id: z.string(),
		slug: z.string().optional(),
		label: z.string().optional(),
		parentId: z.string().nullable().optional(),
		description: z.string().nullable().optional(),
		locale: z.string().optional(),
		translationGroup: z.string().nullable().optional(),
		count: z.number().int().optional(),
	})
	.catchall(z.unknown());

const BylineSchema = z
	.object({
		id: z.string(),
		slug: z.string().optional(),
		displayName: z.string().optional(),
		bio: z.string().nullable().optional(),
		avatarMediaId: z.string().nullable().optional(),
		avatarStorageKey: z.string().nullable().optional(),
		avatarAlt: z.string().nullable().optional(),
		websiteUrl: z.string().nullable().optional(),
		userId: z.string().nullable().optional(),
		isGuest: z.boolean().optional(),
		locale: z.string().optional(),
		translationGroup: z.string().nullable().optional(),
		customFields: z.record(z.string(), z.unknown()).optional(),
	})
	.catchall(z.unknown());

const BylineFieldSchema = z
	.object({
		id: z.string(),
		slug: z.string(),
		label: z.string(),
		type: z.enum(["string", "text", "url", "boolean", "select"]),
		required: z.boolean(),
		translatable: z.boolean(),
		validation: z
			.object({
				options: z.array(z.string()).optional(),
			})
			.nullable()
			.optional(),
		sortOrder: z.number().int(),
		createdAt: z.string().optional(),
		updatedAt: z.string().optional(),
	})
	.catchall(z.unknown());

const BylineFieldUsageSchema = z
	.object({
		translatableValueCount: z.number().int().nonnegative(),
		groupValueCount: z.number().int().nonnegative(),
		totalAffectedRows: z.number().int().nonnegative(),
	})
	.catchall(z.unknown());

const MenuItemSchema: z.ZodType = z.lazy(() =>
	z
		.object({
			id: z.string(),
			label: z.string().optional(),
			type: z.string().optional(),
			customUrl: z.string().nullable().optional(),
			referenceCollection: z.string().nullable().optional(),
			referenceId: z.string().nullable().optional(),
			titleAttr: z.string().nullable().optional(),
			target: z.string().nullable().optional(),
			cssClasses: z.string().nullable().optional(),
			parentId: z.string().nullable().optional(),
			sortOrder: z.number().int().optional(),
			children: z.array(MenuItemSchema).optional(),
		})
		.catchall(z.unknown()),
);

const MenuSchema = z
	.object({
		id: z.string().optional(),
		name: z.string(),
		label: z.string().optional(),
		locale: z.string().nullable().optional(),
		translationGroup: z.string().nullable().optional(),
		items: z.array(MenuItemSchema).optional(),
	})
	.catchall(z.unknown());

const RevisionSchema = z
	.object({
		id: z.string(),
		contentId: z.string().optional(),
		collection: z.string().optional(),
		revision: z.number().int().optional(),
		createdAt: z.string().optional(),
		createdBy: z.string().nullable().optional(),
		summary: z.string().nullable().optional(),
	})
	.catchall(z.unknown());

const MediaProviderSchema = z
	.object({
		id: z.string(),
		label: z.string().optional(),
		enabled: z.boolean().optional(),
		kind: z.string().optional(),
	})
	.catchall(z.unknown());

const MediaProviderItemSchema = z
	.object({
		id: z.string(),
		previewUrl: z.string().optional(),
		filename: z.string().optional(),
		mimeType: z.string().optional(),
		width: z.number().int().optional(),
		height: z.number().int().optional(),
		alt: z.string().nullable().optional(),
	})
	.catchall(z.unknown());

const SearchHitSchema = z
	.object({
		collection: z.string(),
		id: z.string(),
		title: z.string().optional(),
		excerpt: z.string().optional(),
		score: z.number().optional(),
		locale: z.string().nullable().optional(),
	})
	.catchall(z.unknown());

const PluginSchema = z
	.object({
		id: z.string(),
		name: z.string().optional(),
		version: z.string().optional(),
		source: z.string().optional(),
		status: z.string().optional(),
		enabled: z.boolean().optional(),
		requires: z.record(z.string(), z.unknown()).optional(),
		compatibility: z.record(z.string(), z.unknown()).optional(),
		envCompatibility: z.record(z.string(), z.unknown()).optional(),
		artifacts: z.record(z.string(), z.unknown()).optional(),
		sections: z.record(z.string(), z.unknown()).optional(),
		sbom: z.record(z.string(), z.unknown()).optional(),
	})
	.catchall(z.unknown());

// Emdash omits secret values from `values` and reports only their presence.
const PluginSettingsSchema = z.object({
	success: z.literal(true),
	data: z.object({
		schema: z.record(
			z.string(),
			z.object({ type: z.string() }).catchall(z.unknown()),
		),
		values: z.record(z.string(), z.unknown()),
		secretsSet: z.record(z.string(), z.boolean()),
	}),
});

/** Lists expose a single success/data/items envelope, including normalized menu lists. */
const ListResponseSchema = <T extends z.ZodType>(item: T) =>
	z.object({
		success: z.literal(true),
		data: z
			.object({
				items: z.array(item),
				nextCursor: z.string().nullable().optional(),
			})
			.catchall(z.unknown()),
	});

const TranslationsResponseSchema = <T extends z.ZodType>(item: T) =>
	z
		.object({
			data: z
				.object({
					translationGroup: z.string().nullable(),
					translations: z.array(item),
				})
				.catchall(z.unknown())
				.optional(),
			translationGroup: z.string().nullable().optional(),
			translations: z.array(item).optional(),
		})
		.catchall(z.unknown());

const TaxonomyListResponseSchema = z
	.object({
		data: z
			.object({ taxonomies: z.array(TaxonomySchema) })
			.catchall(z.unknown()),
	})
	.catchall(z.unknown());

const TaxonomyGetResponseSchema = z
	.object({
		data: z.object({ taxonomy: TaxonomySchema }).catchall(z.unknown()),
	})
	.catchall(z.unknown());

const TaxonomyTermsResponseSchema = z
	.object({
		data: z.object({ terms: z.array(TermSchema) }).catchall(z.unknown()),
	})
	.catchall(z.unknown());

/** Select the actual native handler shape when registering each tool. */
const GetResponseSchema = <T extends z.ZodType>(item: T, wrapped = true) =>
	z.object({
		success: z.literal(true),
		data: wrapped
			? z.object({ item, _rev: z.string().optional() }).catchall(z.unknown())
			: item,
	});

const ContentCreateResponseSchema = z
	.object({
		id: z.string(),
		data: ContentItemSchema,
		item: ContentItemSchema,
		_rev: z.string().optional(),
	})
	.catchall(z.unknown());

export {
	BylineFieldSchema,
	BylineFieldUsageSchema,
	BylineSchema,
	CollectionSchema,
	ContentAuthorSchema,
	ContentCreateResponseSchema,
	ContentItemSchema,
	GetResponseSchema,
	ListResponseSchema,
	MediaItemSchema,
	MediaFolderSchema,
	MediaUsageDetailsResponseSchema,
	MediaProviderItemSchema,
	MediaProviderSchema,
	MenuSchema,
	PluginSchema,
	PluginSettingsSchema,
	RevisionSchema,
	schema,
	SearchHitSchema,
	TaxonomySchema,
	TaxonomyGetResponseSchema,
	TaxonomyListResponseSchema,
	TaxonomyTermsResponseSchema,
	TermSchema,
	TranslationsResponseSchema,
};

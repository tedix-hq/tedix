import {
	blockFieldDefinitionSchema as NativeBlockFieldSchema,
	blockTypeSchema as NativeBlockTypeSchema,
	contentSeoInput,
	contentBylineInputSchema,
	calendarQuery,
	createCollectionBody,
	updateCollectionBody,
	createFieldBody,
	updateFieldBody,
	searchEnableBody,
} from "emdash/api/schemas";
import * as z from "zod";

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
	SearchHitSchema,
	TaxonomySchema,
	TaxonomyGetResponseSchema,
	TaxonomyListResponseSchema,
	TaxonomyTermsResponseSchema,
	TermSchema,
	TranslationsResponseSchema,
};

const CmsLocaleSchema = z.string().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i);

// Native JSON Schema is the boundary between independently resolved Zod versions.
const BlockFieldSchema = z.fromJSONSchema(
	NativeBlockFieldSchema.toJSONSchema(),
);
const BlockTypeSchema = z.fromJSONSchema(NativeBlockTypeSchema.toJSONSchema());

const OverviewCollectionSchema = CollectionSchema.extend({
	fields: CollectionSchema.shape.fields.nullable(),
	fieldCount: z.number().int().nullable(),
});
const OverviewErrorsSchema = z
	.object({ schemas: z.record(z.string(), z.string()).optional() })
	.catchall(z.string());
const CollectionDeletionItemSchema = z.object({
	collectionId: z.string(),
	collectionSlug: z.string(),
	state: z.enum(["pending", "retry", "leased", "failed"]),
	phase: z.enum([
		"fence",
		"registry",
		"table",
		"work",
		"sources",
		"status",
		"finalize",
	]),
	attemptCount: z.number().int().min(0),
	nextAttemptAt: z.string(),
	leaseExpiresAt: z.string().nullable(),
	lastErrorCode: z.string().nullable(),
	updatedAt: z.string(),
});
const CollectionDeletionListResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		items: z.array(CollectionDeletionItemSchema).max(100),
		nextCursor: z.string().optional(),
	}),
});

const blockSlug = z
	.string()
	.min(1)
	.max(63)
	.regex(/^[a-z][a-z0-9_]*$/);
const mediaFolderId = z.string().min(1).max(64);
const mediaFolderName = z.string().refine((name) => {
	const length = name.trim().length;
	return length >= 1 && length <= 200;
});
const referencesSchema = z
	.record(blockSlug, z.array(z.string()).max(1000))
	.describe(
		"Reference field slugs mapped to entry IDs; publish the draft to make links live",
	);
const relationLabelsSchema = z.object({
	parentLabel: z.string().min(1).max(200).optional(),
	parentLabelSingular: z.string().min(1).max(200).nullable().optional(),
	childLabel: z.string().min(1).max(200).optional(),
	childLabelSingular: z.string().min(1).max(200).nullable().optional(),
	maxChildrenPerParent: z.number().int().positive().nullable().optional(),
	maxParentsPerChild: z.number().int().positive().nullable().optional(),
});
const transferOperationId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/);
const transferApprovalId = z.string().min(1).max(64);
const transferDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const portableId = z
	.string()
	.min(1)
	.max(1024)
	.regex(/^[\x21-\x7e]+$/);
const importDecisions = z.strictObject({
	principalMappings: z.record(portableId, portableId.nullable()).optional(),
	siteTitle: z.enum(["package", "target"]).optional(),
	siteTagline: z.enum(["package", "target"]).optional(),
});

const bridgeInput = z.object({
	sourceSlug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
	targetSlug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
	exportOperationId: transferOperationId,
});
const bylineFieldInput = z.object({
	slug: z
		.string()
		.regex(/^[a-z][a-z0-9_]*$/)
		.describe("Lowercase field slug, e.g. job_title or linkedin_url"),
	label: z.string().describe("Human-readable field label"),
	type: z.enum(["string", "text", "url", "boolean", "select"]),
	required: z.boolean().optional(),
	translatable: z
		.boolean()
		.optional()
		.describe(
			"Whether values are locale-specific. Set false for shared identifiers like LinkedIn URLs.",
		),
	validation: z
		.object({
			options: z.array(z.string()).optional(),
		})
		.nullable()
		.optional(),
	sortOrder: z.number().int().min(0).optional(),
});
export const CMS_PROXY_TOOL_SCHEMAS = {
	site_transfer_prepare_export: {
		input: bridgeInput,
	},
	site_transfer_create_import: {
		input: bridgeInput.extend({
			importOperationId: transferOperationId.optional(),
			limit: z.number().int().min(1).max(2).optional(),
			cursor: z.string().min(1).max(2048).optional(),
		}),
	},
	site_transfer_capabilities: {
		input: z.object({}),
	},
	site_export_start: {
		input: z.object({
			comments: z.boolean().optional(),
			approvalId: transferApprovalId.optional(),
		}),
	},
	site_export_status: {
		input: z.object({
			operationId: transferOperationId,
			advance: z.boolean().optional(),
		}),
	},
	site_import_analyze: {
		input: z.object({
			operationId: transferOperationId,
			decisions: importDecisions.optional(),
		}),
	},
	site_import_start: {
		input: z.object({
			operationId: transferOperationId,
			packageDigest: transferDigest,
			planDigest: transferDigest,
			approvalId: transferApprovalId.optional(),
		}),
	},
	site_import_status: {
		input: z.object({ operationId: transferOperationId }),
	},
	site_import_resume: {
		input: z.object({ operationId: transferOperationId }),
	},
	site_import_receipt: {
		input: z.object({ operationId: transferOperationId }),
	},
	get_site_overview: {
		input: z.object({
			locale: z
				.string()
				.optional()
				.describe("Locale for menu and recent-content context"),
			collections: z
				.array(z.string())
				.optional()
				.describe(
					"Collections to sample when includeRecentContent=true. Defaults to posts/pages when present.",
				),
			includeRecentContent: z
				.boolean()
				.optional()
				.describe(
					"Include a small recent-content sample per selected collection. Defaults to false.",
				),
			recentLimit: z
				.number()
				.int()
				.min(1)
				.max(20)
				.optional()
				.describe("Recent content items per selected collection"),
			includeMenus: z
				.boolean()
				.optional()
				.describe("Include menu summaries. Defaults to true."),
			includeTaxonomies: z
				.boolean()
				.optional()
				.describe("Include taxonomy summaries. Defaults to true."),
			includePlugins: z
				.boolean()
				.optional()
				.describe("Include plugin source/status summary. Defaults to true."),
			maxFieldsPerCollection: z
				.number()
				.int()
				.min(0)
				.max(50)
				.optional()
				.describe("Maximum field summaries per collection. Defaults to 16."),
		}),
		output: z
			.object({
				orgSlug: z.string(),
				environment: z.string(),
				site: z.object({
					templateSlug: z.string().nullable(),
					publicUrl: z.string().nullable(),
					activeBundleVersion: z.number().int().nullable(),
					sourceRevision: z
						.object({
							kind: z.enum(["artifacts_commit", "editable_source_digest"]),
							value: z.string(),
						})
						.nullable(),
					hotCssRevision: z.string().nullable(),
				}),
				locale: z.string().optional(),
				authModes: z.array(z.enum(["jwt", "pat", "internal"])),
				settings: z.record(z.string(), z.unknown()).optional(),
				collections: z.array(OverviewCollectionSchema),
				menus: z.array(MenuSchema).optional(),
				taxonomies: z.array(TaxonomySchema).optional(),
				plugins: z.record(z.string(), z.unknown()).optional(),
				databaseRuntime: z.record(z.string(), z.unknown()).optional(),
				mediaRuntime: z.record(z.string(), z.unknown()).optional(),
				recentContent: z
					.record(z.string(), z.array(ContentItemSchema))
					.optional(),
				errors: OverviewErrorsSchema.optional(),
				operatorHints: z.array(z.string()),
			})
			.catchall(z.unknown()),
	},
	content_list: {
		input: z.object({
			collection: z
				.string()
				.describe("Collection slug (e.g. 'posts', 'pages')"),
			q: z.string().optional().describe("Native Emdash content search query"),
			status: z
				.enum(["draft", "published", "scheduled"])
				.optional()
				.describe("Filter by status"),
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe("Max items (default 50)"),
			cursor: z.string().optional().describe("Pagination cursor"),
			orderBy: z.string().optional().describe("Field to sort by"),
			order: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
			locale: z.string().optional().describe("Filter by locale"),
			authorId: z
				.string()
				.optional()
				.describe(
					"Filter to entries authored by this Emdash user ID. Use list_content_authors first when you need valid IDs.",
				),
			dateField: z
				.enum(["createdAt", "updatedAt", "publishedAt"])
				.optional()
				.describe(
					"Timestamp field for dateFrom/dateTo filtering. Required when using either date bound.",
				),
			dateFrom: z
				.string()
				.optional()
				.describe(
					"Inclusive ISO date or datetime lower bound. Requires dateField.",
				),
			dateTo: z
				.string()
				.optional()
				.describe(
					"Inclusive ISO date or datetime upper bound. Requires dateField.",
				),
		}),
		output: ListResponseSchema(ContentItemSchema),
	},
	list_content_authors: {
		input: z.object({
			collection: z
				.string()
				.describe("Collection slug (e.g. 'posts', 'pages')"),
		}),
		output: ListResponseSchema(ContentAuthorSchema),
	},
	list_content_byline_entries: {
		input: z.object({
			collection: z
				.string()
				.describe("Collection slug (e.g. 'posts', 'pages')"),
			bylineId: z
				.string()
				.optional()
				.describe(
					"Byline row ID or translation group. Accepts IDs from list_content_authors byline-only rows or byline_list.",
				),
			bylineIds: z
				.array(z.string())
				.optional()
				.describe(
					"One or more byline row IDs or translation groups. Matches any supplied ID.",
				),
			q: z.string().optional().describe("Native Emdash content search query"),
			status: z
				.enum(["draft", "published", "scheduled"])
				.optional()
				.describe("Native status filter"),
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe("Max matching items to return (default 50)"),
			includeInferredBylines: z
				.boolean()
				.optional()
				.describe(
					"Also include credits inferred from the entry author when there is no explicit credit; defaults to false",
				),
			cursor: z
				.string()
				.optional()
				.describe(
					"Opaque native cursor returned by the previous filtered page.",
				),
			orderBy: z.string().optional().describe("Field to sort by"),
			order: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
			locale: z.string().optional().describe("Native locale filter"),
			authorId: z
				.string()
				.optional()
				.describe("Optional native authorId prefilter"),
			dateField: z
				.enum(["createdAt", "updatedAt", "publishedAt"])
				.optional()
				.describe(
					"Timestamp field for dateFrom/dateTo prefiltering. Required when using either date bound.",
				),
			dateFrom: z
				.string()
				.optional()
				.describe(
					"Inclusive ISO date or datetime lower bound. Requires dateField.",
				),
			dateTo: z
				.string()
				.optional()
				.describe(
					"Inclusive ISO date or datetime upper bound. Requires dateField.",
				),
		}),
		output: ListResponseSchema(ContentItemSchema),
	},
	list_calendar_entries: {
		input: z
			.fromJSONSchema(calendarQuery.toJSONSchema({ io: "input" }))
			.refine((args) => calendarQuery.safeParse(args).success, {
				message:
					"Invalid native calendar range; to must be after from and at most 62 days later",
			}),
		output: z.object({
			success: z.literal(true),
			data: z.object({
				items: z.array(
					z.object({
						collection: z.string(),
						id: z.string(),
						locale: z.string(),
						title: z.string(),
						status: z.string(),
						kind: z.enum(["published", "scheduled"]),
						at: z.string(),
					}),
				),
				nextCursor: z.string().optional(),
			}),
		}),
	},
	content_get: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID (ULID) or slug"),
			locale: z.string().optional().describe("Locale for slug lookup"),
		}),
		output: GetResponseSchema(ContentItemSchema),
	},
	content_preview_url: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug"),
			expiresIn: z
				.enum(["15m", "1h", "4h", "24h"])
				.optional()
				.describe("Preview lifetime; defaults to one hour"),
			pathPattern: z
				.string()
				.max(256)
				.regex(/^\/(?!\/)[^?#]*$/)
				.regex(
					/^(?:[^{}]|\{(?:collection|id|locale)\})*$/,
					"Preview overrides support only {collection}, {id}, and {locale}; omit pathPattern to use the collection URL pattern with {slug}, or provide a concrete path",
				)
				.optional()
				.describe(
					"Absolute site path, such as /, /de/, or /posts/{id}; supports {collection}, {id}, and {locale}, not {slug}; no query or fragment",
				),
		}),
		output: z.object({
			success: z.literal(true),
			data: z.object({
				url: z
					.string()
					.regex(/^\/(?!\/)[^\s#]*[?&]_preview=/)
					.describe("Site-relative URL with Emdash's signed preview token"),
				expiresAt: z.number().int(),
			}),
		}),
	},
	content_create: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			data: z
				.record(z.string(), z.unknown())
				.describe("Field values matching collection schema"),
			slug: z
				.string()
				.optional()
				.describe("URL slug (auto-generated if omitted)"),
			status: z
				.enum(["draft"])
				.optional()
				.describe(
					"Initial status. Emdash creates drafts; use cms_*.content_publish to publish.",
				),
			locale: z.string().optional().describe("Locale"),
			translationOf: z
				.string()
				.optional()
				.describe("ID of item this is a translation of"),
			references: referencesSchema.optional(),
		}),
		output: ContentCreateResponseSchema,
	},
	content_update: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug"),
			data: z
				.record(z.string(), z.unknown())
				.optional()
				.describe("Custom field values to update"),
			slug: z.string().optional().describe("New URL slug"),
			status: z
				.enum(["draft"])
				.optional()
				.describe("New status. Use cms_*.content_publish to publish."),
			seo: contentSeoInput
				.optional()
				.describe(
					"Native SEO metadata; omitted fields remain unchanged, null clears",
				),
			bylines: z
				.array(z.fromJSONSchema(contentBylineInputSchema.toJSONSchema()))
				.optional()
				.describe(
					"Author bylines (replaces existing list); roleLabel is optional and null clears it",
				),
			publishedAt: z
				.string()
				.optional()
				.describe(
					"ISO timestamp; back-date or schedule (requires content:publish_any scope)",
				),
			references: referencesSchema.optional(),
			migrateBlocks: z
				.boolean()
				.optional()
				.describe("Allow retained blocks to move to the active type version"),
			replaceBlocks: z
				.boolean()
				.optional()
				.describe(
					"Replace an existing blocks array with an entirely keyless array",
				),
			_rev: z.string().describe("Revision token for conflict detection"),
			overrideLock: z
				.boolean()
				.optional()
				.describe(
					"Write anyway if a human editor has this entry open (409 ENTRY_LOCKED). Only set this after checking who holds the lock — it can discard their unsaved changes.",
				),
		}),
	},
	content_get_terms: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug"),
			taxonomy: z.string().describe("Taxonomy name (e.g. 'tag' or 'category')"),
		}),
		output: z
			.object({
				terms: z.array(TermSchema).optional(),
				items: z.array(TermSchema).optional(),
				data: z
					.object({
						terms: z.array(TermSchema).optional(),
						items: z.array(TermSchema).optional(),
					})
					.catchall(z.unknown())
					.optional(),
			})
			.catchall(z.unknown()),
	},
	content_set_terms: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug"),
			taxonomy: z.string().describe("Taxonomy name (e.g. 'tag' or 'category')"),
			termIds: z
				.array(z.string())
				.describe("Term IDs to assign; empty array clears the taxonomy."),
		}),
	},
	content_delete: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug"),
			locale: z
				.string()
				.optional()
				.describe("Locale for slug lookup on multi-locale sites"),
			overrideLock: z
				.boolean()
				.optional()
				.describe(
					"Delete anyway if a human editor has this entry open (409 ENTRY_LOCKED).",
				),
		}),
	},
	content_restore: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug"),
		}),
	},
	content_permanent_delete: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug"),
			overrideLock: z
				.boolean()
				.optional()
				.describe(
					"Delete anyway if a human editor has this entry open (409 ENTRY_LOCKED).",
				),
		}),
	},
	content_publish: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug"),
			locale: z
				.string()
				.optional()
				.describe("Locale for slug lookup on multi-locale sites"),
			publishedAt: z
				.string()
				.optional()
				.describe(
					"ISO publication timestamp override (requires publish-any access)",
				),
			_rev: z
				.string()
				.describe(
					"Opaque revision token from content_get for conflict detection",
				),
			overrideLock: z
				.boolean()
				.optional()
				.describe(
					"Publish anyway if a human editor has this entry open (409 ENTRY_LOCKED).",
				),
		}),
	},
	content_unpublish: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug"),
			locale: z
				.string()
				.optional()
				.describe("Locale for slug lookup on multi-locale sites"),
			_rev: z
				.string()
				.describe(
					"Required opaque token from content_get; re-read after CONFLICT",
				),
			overrideLock: z
				.boolean()
				.optional()
				.describe(
					"Unpublish anyway if a human editor has this entry open (409 ENTRY_LOCKED).",
				),
		}),
	},
	content_schedule: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug"),
			locale: z
				.string()
				.optional()
				.describe("Locale for slug lookup on multi-locale sites"),
			scheduledAt: z
				.string()
				.describe("ISO 8601 datetime (e.g. '2025-06-01T09:00:00Z')"),
			_rev: z
				.string()
				.describe(
					"Required opaque token from content_get; re-read after CONFLICT",
				),
			overrideLock: z
				.boolean()
				.optional()
				.describe(
					"Schedule anyway if a human editor has this entry open (409 ENTRY_LOCKED).",
				),
		}),
	},
	content_unschedule: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug"),
			locale: z
				.string()
				.optional()
				.describe("Locale for slug lookup on multi-locale sites"),
		}),
	},
	content_compare: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug"),
			locale: z
				.string()
				.optional()
				.describe("Locale for slug lookup on multi-locale sites"),
		}),
		output: z
			.object({
				hasChanges: z.boolean().optional(),
				hasDraft: z.boolean().optional(),
				hasPublished: z.boolean().optional(),
				published: ContentItemSchema.nullable().optional(),
				draft: ContentItemSchema.nullable().optional(),
				diff: z.record(z.string(), z.unknown()).optional(),
				data: z.record(z.string(), z.unknown()).optional(),
			})
			.catchall(z.unknown()),
	},
	content_discard_draft: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug"),
			locale: z
				.string()
				.optional()
				.describe("Locale for slug lookup on multi-locale sites"),
			_rev: z
				.string()
				.describe(
					"Required opaque token from content_get; re-read after CONFLICT",
				),
			overrideLock: z
				.boolean()
				.optional()
				.describe(
					"Discard anyway if a human editor has this entry open (409 ENTRY_LOCKED).",
				),
		}),
	},
	content_list_trashed: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			limit: z.number().int().min(1).max(100).optional().describe("Max items"),
			cursor: z.string().optional().describe("Pagination cursor"),
		}),
		output: ListResponseSchema(ContentItemSchema),
	},
	content_duplicate: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug to duplicate"),
		}),
	},
	content_translations: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug"),
		}),
		output: z
			.object({
				translations: z
					.array(
						z
							.object({
								locale: z.string(),
								id: z.string(),
								slug: z.string().optional(),
								status: z.string().optional(),
							})
							.catchall(z.unknown()),
					)
					.optional(),
				items: z.array(ContentItemSchema).optional(),
				data: z.record(z.string(), z.unknown()).optional(),
			})
			.catchall(z.unknown()),
	},
	schema_list_collections: {
		input: z.object({}),
		output: ListResponseSchema(CollectionSchema),
	},
	schema_get_collection: {
		input: z.object({
			slug: z.string().describe("Collection slug"),
		}),
		output: GetResponseSchema(CollectionSchema),
	},
	schema_list_block_types: {
		input: z.object({}),
		output: ListResponseSchema(BlockTypeSchema),
	},
	schema_get_block_type: {
		input: z.object({ slug: blockSlug }),
		output: GetResponseSchema(BlockTypeSchema),
	},
	schema_create_block_type: {
		input: z
			.object({
				slug: blockSlug,
				label: z.string().min(1).max(200),
				description: z.string().optional(),
				icon: z.string().optional(),
				category: z.string().optional(),
				fields: z.array(BlockFieldSchema),
			})
			.strict(),
		output: GetResponseSchema(BlockTypeSchema),
	},
	schema_update_block_type: {
		input: z
			.object({
				slug: blockSlug,
				expectedFingerprint: z.string().min(1),
				label: z.string().min(1).max(200).optional(),
				description: z.string().nullish(),
				icon: z.string().nullish(),
				category: z.string().nullish(),
				fields: z.array(BlockFieldSchema).optional(),
				breaking: z.boolean().optional(),
			})
			.strict(),
		output: GetResponseSchema(BlockTypeSchema),
	},
	schema_activate_block_type_version: {
		input: z
			.object({
				slug: blockSlug,
				version: z.number().int().positive(),
				expectedFingerprint: z.string().min(1),
			})
			.strict(),
		output: GetResponseSchema(BlockTypeSchema),
	},
	schema_create_collection: {
		input: z.fromJSONSchema(
			createCollectionBody.omit({ source: true }).toJSONSchema(),
		),
	},
	schema_update_collection: {
		input: z.fromJSONSchema(
			updateCollectionBody
				.extend({ slug: createCollectionBody.shape.slug })
				.toJSONSchema(),
		),
	},
	schema_delete_collection: {
		input: z.object({
			slug: z.string().describe("Collection slug to delete"),
			force: z
				.boolean()
				.optional()
				.describe("Force deletion even if collection has content"),
		}),
	},
	schema_create_field: {
		input: z.fromJSONSchema(
			createFieldBody
				.extend({
					collection: blockSlug,
					allowedTypes: z
						.array(z.string())
						.optional()
						.describe(
							"Image/file MIME allowlist; merged into validation.allowedMimeTypes",
						),
				})
				.toJSONSchema(),
		),
	},
	update_schema_field: {
		input: z.fromJSONSchema(
			updateFieldBody
				.extend({
					collection: blockSlug,
					fieldSlug: blockSlug,
				})
				.toJSONSchema(),
		),
	},
	schema_delete_field: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			fieldSlug: z.string().describe("Field slug to remove"),
		}),
	},
	list_relations: {
		input: z.object({ collection: blockSlug.optional() }),
	},
	get_relation: {
		input: z.object({ id: z.string().min(1) }),
	},
	create_relation: {
		input: relationLabelsSchema.extend({
			slug: blockSlug,
			parentCollection: blockSlug,
			childCollection: blockSlug,
			parentLabel: z.string().min(1).max(200),
			childLabel: z.string().min(1).max(200),
		}),
	},
	update_relation: {
		input: relationLabelsSchema
			.extend({ id: z.string().min(1) })
			.refine(
				(value) =>
					Object.entries(value).some(
						([key, field]) => key !== "id" && field !== undefined,
					),
				{ message: "At least one relation field is required" },
			),
	},
	delete_relation: {
		input: z.object({ id: z.string().min(1) }),
	},
	media_list: {
		input: z.object({
			mimeType: z
				.string()
				.optional()
				.describe("Filter by MIME type prefix (e.g. 'image/')"),
			folderId: z
				.string()
				.min(1)
				.max(64)
				.optional()
				.describe("Media folder ID, or 'unfiled' for the Main library"),
			includeUsage: z
				.boolean()
				.optional()
				.describe("Include usage count and index coverage on each item"),
			limit: z.number().int().min(1).max(100).optional(),
			cursor: z.string().optional(),
		}),
		output: ListResponseSchema(MediaItemSchema),
	},
	list_media_folders: {
		input: z.object({
			limit: z.number().int().min(1).max(100).optional(),
			cursor: z.string().min(1).optional(),
			q: z.string().trim().min(1).max(200).optional(),
		}),
		output: ListResponseSchema(MediaFolderSchema),
	},
	get_media_folder: {
		input: z.object({ id: mediaFolderId }),
		output: GetResponseSchema(MediaFolderSchema),
	},
	create_media_folder: {
		input: z.object({ name: mediaFolderName }),
		output: GetResponseSchema(MediaFolderSchema),
	},
	rename_media_folder: {
		input: z.object({ id: mediaFolderId, name: mediaFolderName }),
		output: GetResponseSchema(MediaFolderSchema),
	},
	delete_media_folder: {
		input: z.object({ id: mediaFolderId }),
	},
	media_create: {
		input: z.object({
			filename: z.string().describe("Original filename"),
			mimeType: z.string().describe("MIME type"),
			storageKey: z.string().describe("Storage key the file was uploaded to"),
			size: z.number().int().optional(),
			width: z.number().int().optional(),
			height: z.number().int().optional(),
			contentHash: z.string().optional(),
			blurhash: z.string().optional(),
			dominantColor: z.string().optional(),
		}),
	},
	media_get: {
		input: z.object({
			id: z.string().describe("Media item ID"),
			includeUsage: z.boolean().optional(),
		}),
		output: GetResponseSchema(MediaItemSchema),
	},
	get_media_usage: {
		input: z.object({
			id: z.string().min(1).describe("Media item ID"),
			limit: z.number().int().min(1).max(100).optional(),
			cursor: z.string().min(1).max(2048).optional(),
		}),
		output: MediaUsageDetailsResponseSchema,
	},
	get_media_usage_activation: {
		input: z.object({}).strict(),
	},
	activate_media_usage: {
		input: z.object({ writersDrained: z.literal(true) }).strict(),
	},
	get_media_usage_progress: {
		input: z.object({}),
	},
	list_collection_deletions: {
		input: z
			.object({
				state: z.enum(["pending", "retry", "leased", "failed"]).optional(),
				limit: z.number().int().min(1).max(100).optional(),
				cursor: z.string().min(1).max(2048).optional(),
			})
			.strict(),
		output: CollectionDeletionListResponseSchema,
	},
	advance_media_usage_index: {
		input: z.object({}).strict(),
	},
	repair_media_usage: {
		input: z.discriminatedUnion("scope", [
			z
				.object({ scope: z.literal("collection"), collection: blockSlug })
				.strict(),
			z.object({ scope: z.literal("all") }).strict(),
		]),
	},
	media_update: {
		input: z.object({
			id: z.string().describe("Media item ID"),
			alt: z.string().optional(),
			caption: z.string().optional(),
			width: z.number().int().optional(),
			height: z.number().int().optional(),
			folderId: mediaFolderId.nullable().optional(),
		}),
	},
	media_delete: {
		input: z.object({
			id: z.string().describe("Media item ID"),
		}),
	},
	media_upload: {
		input: z
			.object({
				filename: z
					.string()
					.min(1)
					.describe("Original filename — informs MIME detection + display"),
				mimeType: z.string().min(1).describe("Content type, e.g. image/png"),
				dataBase64: z.string().min(1).describe("Base64-encoded file bytes"),
				alt: z
					.string()
					.optional()
					.describe("Accessibility alt text (recommended for images)"),
				caption: z.string().optional().describe("Caption / description"),
			})
			.strict(),
	},
	media_search: {
		input: z.object({
			q: z.string().optional().describe("Native Emdash media search query"),
			query: z
				.string()
				.optional()
				.describe("Alias for q when calling the Site Builder MCP tool"),
			mimeType: z
				.string()
				.optional()
				.describe("MIME prefix filter, e.g. 'image/'"),
			limit: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Max items returned by native Emdash media search"),
			cursor: z.string().optional().describe("Pagination cursor"),
		}),
		output: z
			.object({
				items: z.array(MediaItemSchema).optional(),
				q: z.string().optional(),
				query: z.string().optional(),
				nextCursor: z.string().nullable().optional(),
				data: z
					.object({ items: z.array(MediaItemSchema).optional() })
					.catchall(z.unknown())
					.optional(),
			})
			.catchall(z.unknown()),
	},
	media_providers_list: {
		input: z.object({}),
		output: ListResponseSchema(MediaProviderSchema),
	},
	media_providers_browse: {
		input: z.object({
			providerId: z.string().describe("Provider ID, e.g. 'unsplash'"),
			query: z
				.string()
				.optional()
				.describe("Search text (provider-defined search semantics)"),
			mimeType: z.string().optional().describe("MIME prefix filter"),
			limit: z.number().int().positive().optional(),
			cursor: z.string().optional(),
		}),
		output: ListResponseSchema(MediaProviderItemSchema),
	},
	media_to_field_value: {
		input: z.object({
			mediaId: z.string().optional().describe("Local media item ID (mode 1)"),
			providerId: z
				.string()
				.optional()
				.describe("External provider ID (mode 2)"),
			providerItemId: z
				.string()
				.optional()
				.describe("Provider's item ID (mode 2)"),
			previewUrl: z
				.string()
				.optional()
				.describe("Provider preview URL (mode 2)"),
			filename: z.string().optional(),
			mimeType: z.string().optional(),
			width: z.number().int().optional(),
			height: z.number().int().optional(),
			alt: z.string().optional(),
		}),
		output: z
			.object({
				provider: z.string(),
				id: z.union([z.string(), z.number()]).optional(),
				src: z.string().optional(),
				filename: z.string().optional(),
				mimeType: z.string().optional(),
				width: z.number().int().nullable().optional(),
				height: z.number().int().nullable().optional(),
				alt: z.string().nullable().optional(),
				caption: z.string().nullable().optional(),
				meta: z.record(z.string(), z.unknown()).optional(),
			})
			.catchall(z.unknown()),
	},
	search: {
		input: z.object({
			query: z.string().describe("Search query text"),
			collections: z
				.array(z.string())
				.optional()
				.describe("Limit to specific collection slugs"),
			locale: z.string().optional(),
			limit: z.number().int().min(1).max(50).optional(),
		}),
		output: ListResponseSchema(SearchHitSchema),
	},
	configure_search: {
		input: z.fromJSONSchema(searchEnableBody.toJSONSchema()),
	},
	taxonomy_list: {
		input: z.object({ locale: CmsLocaleSchema.optional() }),
		output: TaxonomyListResponseSchema,
	},
	taxonomy_get: {
		input: z.object({ name: z.string(), locale: CmsLocaleSchema.optional() }),
		output: TaxonomyGetResponseSchema,
	},
	taxonomy_translations: {
		input: z.object({ name: z.string(), locale: CmsLocaleSchema.optional() }),
		output: TranslationsResponseSchema(TaxonomySchema),
	},
	taxonomy_create: {
		input: z.object({
			name: z
				.string()
				.regex(/^[a-z][a-z0-9_]*$/)
				.max(63),
			label: z.string().min(1).max(200),
			labelSingular: z.string().min(1).max(200).optional(),
			hierarchical: z.boolean().optional(),
			collections: z
				.array(
					z
						.string()
						.regex(/^[a-z][a-z0-9_]*$/)
						.max(63),
				)
				.max(100)
				.optional(),
			locale: CmsLocaleSchema.optional(),
			translationOf: z.string().min(1).optional(),
		}),
	},
	taxonomy_update: {
		input: z.object({
			name: z.string(),
			label: z.string().min(1).max(200).optional(),
			labelSingular: z.string().min(1).max(200).nullable().optional(),
			hierarchical: z.boolean().optional(),
			collections: z.array(z.string()).max(100).optional(),
			locale: CmsLocaleSchema.optional(),
		}),
	},
	taxonomy_delete: {
		input: z.object({ name: z.string() }),
	},
	taxonomy_list_terms: {
		input: z
			.object({
				taxonomy: z
					.string()
					.describe("Taxonomy name (e.g. 'categories', 'tags')"),
				locale: CmsLocaleSchema.optional(),
				includeCounts: z.boolean().optional(),
				resolveFallback: z.boolean().optional(),
			})
			.strict(),
		output: TaxonomyTermsResponseSchema,
	},
	taxonomy_term_translations: {
		input: z.object({
			taxonomy: z.string(),
			termSlug: z.string(),
			locale: CmsLocaleSchema.optional(),
		}),
		output: TranslationsResponseSchema(TermSchema),
	},
	taxonomy_create_term: {
		input: z.object({
			taxonomy: z.string().describe("Taxonomy name"),
			slug: z
				.string()
				.min(1)
				.optional()
				.describe("URL-safe identifier; omit to derive from label"),
			label: z.string().describe("Display name"),
			parentId: z
				.string()
				.nullable()
				.optional()
				.describe("Parent term ID for hierarchical taxonomies"),
			description: z.string().optional(),
			locale: CmsLocaleSchema.optional(),
			translationOf: z
				.string()
				.min(1)
				.optional()
				.describe("Existing term ID to create a locale translation from"),
		}),
	},
	taxonomy_update_term: {
		input: z.object({
			taxonomy: z.string().describe("Taxonomy name"),
			termSlug: z.string().describe("Current slug of the term"),
			slug: z.string().optional().describe("New slug"),
			label: z.string().optional().describe("New label"),
			parentId: z
				.string()
				.nullable()
				.optional()
				.describe("New parent ID or null to detach"),
			description: z.string().optional(),
			locale: CmsLocaleSchema.optional().describe(
				"Locale for a slug shared by translated terms",
			),
		}),
	},
	taxonomy_delete_term: {
		input: z.object({
			taxonomy: z.string().describe("Taxonomy name"),
			termSlug: z.string().describe("Slug of the term to delete"),
			locale: CmsLocaleSchema.optional().describe(
				"Locale for a slug shared by translated terms",
			),
		}),
	},
	byline_list: {
		input: z.object({
			search: z.string().optional().describe("Search display names and slugs"),
			isGuest: z.boolean().optional().describe("Filter guest bylines"),
			userId: z.string().optional().describe("Filter by linked Emdash user ID"),
			locale: z
				.string()
				.optional()
				.describe(
					"Strict locale filter. Emdash 0.15+ byline credits hydrate only from a matching-locale byline.",
				),
			cursor: z.string().optional().describe("Pagination cursor"),
			limit: z.number().int().min(1).max(100).optional(),
		}),
		output: ListResponseSchema(BylineSchema),
	},
	byline_get: {
		input: z.object({
			id: z.string().describe("Byline ID"),
		}),
		output: GetResponseSchema(BylineSchema, false),
	},
	byline_create: {
		input: z.object({
			slug: z.string().describe("URL-safe byline slug"),
			displayName: z.string().describe("Public author name"),
			bio: z.string().nullable().optional(),
			avatarMediaId: z.string().nullable().optional(),
			websiteUrl: z.string().url().nullable().optional(),
			userId: z.string().nullable().optional(),
			isGuest: z.boolean().optional(),
			locale: z.string().optional().describe("Locale for this byline row"),
			translationOf: z
				.string()
				.optional()
				.describe(
					"Existing byline ID whose translation group should be reused",
				),
			customFields: z
				.record(z.string(), z.unknown())
				.optional()
				.describe(
					"Native Emdash 0.17 byline custom-field values keyed by registered field slug.",
				),
		}),
	},
	byline_update: {
		input: z.object({
			id: z.string().describe("Byline ID"),
			slug: z.string().optional(),
			displayName: z.string().optional(),
			bio: z.string().nullable().optional(),
			avatarMediaId: z.string().nullable().optional(),
			websiteUrl: z.string().url().nullable().optional(),
			userId: z.string().nullable().optional(),
			isGuest: z.boolean().optional(),
			customFields: z
				.record(z.string(), z.unknown())
				.optional()
				.describe(
					"Partial native Emdash 0.17 byline custom-field values keyed by registered field slug. Omit to preserve existing custom-field values.",
				),
		}),
	},
	byline_delete: {
		input: z.object({ id: z.string().min(1).describe("Byline ID") }),
		output: z.object({
			success: z.literal(true),
			data: z.object({ deleted: z.literal(true) }),
		}),
	},
	byline_translations: {
		input: z.object({
			id: z.string().describe("Source byline ID"),
		}),
		output: ListResponseSchema(BylineSchema),
	},
	byline_create_translation: {
		input: z.object({
			id: z.string().describe("Source byline ID"),
			locale: z.string().describe("Target locale"),
			slug: z.string().optional(),
			displayName: z.string().optional(),
			bio: z.string().nullable().optional(),
			avatarMediaId: z.string().nullable().optional(),
			websiteUrl: z.string().url().nullable().optional(),
		}),
	},
	list_byline_fields: {
		input: z.object({}),
		output: ListResponseSchema(BylineFieldSchema),
	},
	get_byline_field: {
		input: z.object({
			slug: z.string().describe("Byline field slug"),
		}),
		output: GetResponseSchema(BylineFieldSchema, false),
	},
	create_byline_field: {
		input: bylineFieldInput,
		output: GetResponseSchema(BylineFieldSchema, false),
	},
	update_byline_field: {
		input: bylineFieldInput
			.omit({ type: true })
			.extend({
				label: z.string().optional(),
			})
			.refine(
				(value) =>
					value.label !== undefined ||
					value.required !== undefined ||
					value.translatable !== undefined ||
					value.validation !== undefined ||
					value.sortOrder !== undefined,
				{ message: "At least one update field is required" },
			),
		output: GetResponseSchema(BylineFieldSchema, false),
	},
	delete_byline_field: {
		input: z.object({
			slug: z.string().describe("Byline field slug"),
		}),
	},
	get_byline_field_usage: {
		input: z.object({
			slug: z.string().describe("Byline field slug"),
		}),
		output: GetResponseSchema(BylineFieldUsageSchema, false),
	},
	reorder_byline_fields: {
		input: z.object({
			slugs: z
				.array(z.string())
				.describe(
					"Exact set of currently registered field slugs in desired order",
				),
		}),
		output: ListResponseSchema(BylineFieldSchema),
	},
	menu_list: {
		input: z.object({
			locale: z
				.string()
				.optional()
				.describe("Locale filter, e.g. 'en' or 'de'"),
		}),
		output: ListResponseSchema(MenuSchema),
	},
	menu_get: {
		input: z.object({
			name: z.string().describe("Menu name"),
			locale: z
				.string()
				.optional()
				.describe("Locale to resolve when the menu exists in multiple locales"),
		}),
		output: GetResponseSchema(MenuSchema, false),
	},
	menu_translations: {
		input: z.object({ name: z.string(), locale: CmsLocaleSchema.optional() }),
		output: TranslationsResponseSchema(MenuSchema),
	},
	menu_create: {
		input: z.object({
			name: z.string().describe("Stable identifier (lowercase, underscores)"),
			label: z.string().describe("Display name"),
			locale: z
				.string()
				.optional()
				.describe("Locale for this menu, e.g. 'en' or 'de'"),
			translationOf: z
				.string()
				.optional()
				.describe(
					"Existing menu ID to create this locale variant from; requires locale",
				),
		}),
	},
	menu_update: {
		input: z.object({
			name: z.string().describe("Menu name"),
			label: z.string().describe("New display label"),
			locale: z.string().optional().describe("Locale of the menu to update"),
		}),
	},
	menu_delete: {
		input: z.object({
			name: z.string().describe("Menu name"),
			locale: z.string().optional().describe("Locale of the menu to delete"),
		}),
	},
	menu_set_items: {
		input: z.object({
			name: z.string().describe("Menu name"),
			locale: z.string().optional().describe("Locale of the menu to rewrite"),
			items: z.array(
				z.object({
					label: z.string().describe("Item display text"),
					type: z
						.enum(["custom", "page", "post", "taxonomy", "collection"])
						.describe("Item kind"),
					customUrl: z.string().optional().describe("URL for type='custom'"),
					referenceCollection: z.string().optional(),
					referenceId: z.string().optional(),
					titleAttr: z.string().optional(),
					target: z.string().optional(),
					cssClasses: z.string().optional(),
					parentIndex: z
						.number()
						.int()
						.nonnegative()
						.optional()
						.describe("Array index of parent item for nesting"),
				}),
			),
		}),
	},
	revision_list: {
		input: z.object({
			collection: z.string().describe("Collection slug"),
			id: z.string().describe("Content item ID or slug"),
			limit: z.number().int().min(1).max(50).optional(),
		}),
		output: ListResponseSchema(RevisionSchema),
	},
	revision_restore: {
		input: z.object({
			revisionId: z.string().describe("Revision ID to restore"),
			overrideLock: z
				.boolean()
				.optional()
				.describe(
					"Restore anyway if another editor holds this entry. Only set after checking the holder; this can discard their unsaved changes.",
				),
		}),
	},
	settings_get: {
		input: z.object({}),
		output: z
			.object({
				title: z.string().nullable().optional(),
				tagline: z.string().nullable().optional(),
				logo: z.record(z.string(), z.unknown()).nullable().optional(),
				favicon: z.record(z.string(), z.unknown()).nullable().optional(),
				url: z.string().nullable().optional(),
				postsPerPage: z.number().int().nullable().optional(),
				dateFormat: z.string().nullable().optional(),
				timezone: z.string().nullable().optional(),
				social: z.record(z.string(), z.unknown()).nullable().optional(),
				seo: z.record(z.string(), z.unknown()).nullable().optional(),
				data: z.record(z.string(), z.unknown()).optional(),
			})
			.catchall(z.unknown()),
	},
	settings_update: {
		input: z.object({
			title: z.string().optional().describe("Site title"),
			tagline: z.string().optional(),
			logo: z
				.object({ mediaId: z.string(), alt: z.string().optional() })
				.describe(
					"Native Emdash logo media reference. Use media_upload or media_search first.",
				)
				.optional(),
			favicon: z
				.object({ mediaId: z.string(), alt: z.string().optional() })
				.describe(
					"Native Emdash favicon media reference. Use media_upload or media_search first.",
				)
				.optional(),
			url: z.string().optional().describe("Canonical site URL"),
			postsPerPage: z.number().int().min(1).max(100).optional(),
			dateFormat: z.string().optional(),
			timezone: z.string().optional(),
			social: z
				.object({
					twitter: z.string().optional(),
					github: z.string().optional(),
					facebook: z.string().optional(),
					instagram: z.string().optional(),
					linkedin: z.string().optional(),
					youtube: z.string().optional(),
				})
				.optional(),
			seo: z
				.object({
					titleSeparator: z.string().optional(),
					defaultOgImage: z
						.object({ mediaId: z.string(), alt: z.string().optional() })
						.describe(
							"Native Emdash site-wide fallback social image. EmDashHead emits it as og:image, twitter:image, and BlogPosting image when a page has no own image.",
						)
						.optional(),
					robotsTxt: z.string().optional(),
					googleVerification: z.string().optional(),
					bingVerification: z.string().optional(),
				})
				.optional(),
		}),
	},
	registry_status: {
		input: z.object({}),
		output: z.object({
			registry: z.object({
				installationState: z.literal("unverified"),
				reason: z.string(),
				policy: z.string(),
				manifestVisible: z.boolean(),
				manifestError: z.string().optional(),
			}),
			plugins: z.object({
				total: z.number().int(),
				bySource: z.record(z.string(), z.number().int()),
				byStatus: z.record(z.string(), z.number().int()),
				registryInstalled: z.number().int(),
				registrySignals: z.object({
					withRequires: z.number().int(),
					withArtifacts: z.number().int(),
					withProfileSections: z.number().int(),
					withSbom: z.number().int(),
					withCompatibilityWarnings: z.number().int(),
				}),
				items: z.array(PluginSchema),
			}),
			updates: z.object({
				total: z.number().int(),
				items: z.array(PluginSchema),
				registrySignals: z.object({
					withRequires: z.number().int(),
					withArtifacts: z.number().int(),
					withProfileSections: z.number().int(),
					withSbom: z.number().int(),
					withCompatibilityWarnings: z.number().int(),
				}),
				warning: z.string().optional(),
			}),
		}),
	},
	plugin_list: {
		input: z.object({
			source: z.enum(["config", "marketplace", "registry"]).optional(),
			status: z.enum(["active", "inactive"]).optional(),
		}),
		output: z.object({
			items: z.array(PluginSchema),
			summary: z.object({
				total: z.number().int(),
				bySource: z.record(z.string(), z.number().int()),
				byStatus: z.record(z.string(), z.number().int()),
				registrySignals: z.object({
					withRequires: z.number().int(),
					withArtifacts: z.number().int(),
					withProfileSections: z.number().int(),
					withSbom: z.number().int(),
					withCompatibilityWarnings: z.number().int(),
				}),
			}),
		}),
	},
	plugin_get: {
		input: z.object({
			id: z.string().describe("Plugin id"),
		}),
		output: GetResponseSchema(PluginSchema),
	},
	plugin_updates: {
		input: z.object({}),
		output: z
			.object({
				data: z
					.object({
						items: z.array(PluginSchema).optional(),
						warning: z.string().optional(),
					})
					.catchall(z.unknown())
					.optional(),
				items: z.array(PluginSchema).optional(),
				warning: z.string().optional(),
			})
			.catchall(z.unknown()),
	},
	plugin_enable: {
		input: z.object({ id: z.string().min(1).describe("Plugin ID") }),
		output: GetResponseSchema(PluginSchema),
	},
	plugin_disable: {
		input: z.object({ id: z.string().min(1).describe("Plugin ID") }),
		output: GetResponseSchema(PluginSchema),
	},
	set_plugin_mcp: {
		input: z.strictObject({
			id: z.literal("emdash-forms"),
			enabled: z.boolean(),
		}),
	},
	complete_existing_setup: {
		input: z.object({}).strict(),
	},
	list_forms: {
		input: z.record(z.string(), z.unknown()),
	},
	create_form: {
		input: z.record(z.string(), z.unknown()),
	},
	update_form: {
		input: z.record(z.string(), z.unknown()),
	},
	list_form_submissions: {
		input: z.record(z.string(), z.unknown()),
	},
	get_form_submission: {
		input: z.record(z.string(), z.unknown()),
	},
	plugin_settings_get: {
		input: z.object({ id: z.string().min(1).describe("Plugin ID") }),
		output: PluginSettingsSchema,
	},
	plugin_settings_update: {
		input: z.object({
			id: z.string().min(1).describe("Plugin ID"),
			values: z
				.record(z.string(), z.unknown())
				.describe("Setting keys and new values"),
		}),
		output: PluginSettingsSchema,
	},
	plugin_verify: {
		input: z.object({
			did: z.string().regex(/^did:[a-z]+:/),
			slug: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
			version: z.string().optional(),
		}),
	},
	plugin_install: {
		input: z.object({
			did: z
				.string()
				.regex(/^did:[a-z]+:/)
				.describe("Publisher DID resolved from the registry aggregator"),
			slug: z
				.string()
				.regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
				.describe("Registry package slug"),
			version: z.string().optional().describe("Optional explicit version"),
			acknowledgedDeclaredAccess: z
				.unknown()
				.optional()
				.describe(
					"Declared access returned by plugin_verify and acknowledged by the operator",
				),
			acknowledgedMcpTools: z.unknown().optional(),
			acknowledgedPublicRoutes: z.unknown().optional(),
			acknowledgedProfileCid: z.string().min(1).max(256).optional(),
			acknowledgedReleaseCid: z.string().min(1).max(256).optional(),
		}),
	},
	plugin_update: {
		input: z.object({
			id: z.string().describe("Plugin id"),
			source: z
				.enum(["marketplace", "registry"])
				.default("registry")
				.describe("Plugin source update endpoint"),
			version: z.string().optional().describe("Target version"),
			confirmCapabilityChanges: z.boolean().optional(),
			confirmRouteVisibilityChanges: z.boolean().optional(),
		}),
	},
	plugin_uninstall: {
		input: z.object({
			id: z.string().describe("Plugin id"),
			source: z
				.enum(["marketplace", "registry"])
				.default("registry")
				.describe("Plugin source uninstall endpoint"),
			deleteData: z.boolean().optional(),
		}),
	},
} as const;

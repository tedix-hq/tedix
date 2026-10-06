/**
 * Tedix Component Catalog for json-render
 *
 * Uses @json-render/shadcn for standard UI components and defines
 * custom Tedix-specific components on top.
 *
 * @module @tedix/mcp-ui/json-render/catalog
 */

import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import * as z from "zod";

// =============================================================================
// PROP SCHEMAS (reusable across custom components)
// =============================================================================

const alignmentSchema = z
	.enum(["left", "center", "right"])
	.nullable()
	.describe("Content alignment");

const badgeVariantSchema = z
	.enum([
		"default",
		"secondary",
		"destructive",
		"success",
		"warning",
		"outline",
	])
	.nullable()
	.describe("Badge variant");

const richBadgeVariantSchema = z
	.enum([
		"default",
		"soft",
		"secondary",
		"destructive",
		"outline",
		"ghost",
		"link",
		"success",
		"warning",
		"info",
		"discovery",
		"caution",
		"rating",
		"price",
		"overlay",
		"overlay-light",
	])
	.nullable()
	.describe("Extended badge variant");

const primitiveToneSchema = z
	.enum(["default", "success", "warning", "danger", "info"])
	.nullable()
	.describe("Semantic color tone");

const numberOrStringSchema = z
	.union([z.number(), z.string()])
	.describe("Numeric or formatted text value");

const responsiveColumnsSchema = z
	.object({
		mobile: z.number().min(1).max(4).describe("Columns on mobile"),
		tablet: z.number().min(1).max(6).nullable().describe("Columns on tablet"),
		desktop: z.number().min(1).max(8).nullable().describe("Columns on desktop"),
	})
	.describe("Responsive column configuration");

const comparisonLayoutItemSchema = z.object({
	id: z.string().describe("Stable item ID"),
	title: z.string().describe("Primary result title"),
	subtitle: z.string().optional(),
	description: z.string().optional(),
	image: z.string().optional(),
	images: z.array(z.string()).optional(),
	price: z
		.object({
			amount: z.number(),
			currency: z.string(),
			original: z.number().optional(),
			formatted: z.string().optional(),
		})
		.optional(),
	rating: z
		.object({
			value: z.number(),
			count: z.number().optional(),
			max: z.number().optional(),
		})
		.optional(),
	badge: z
		.object({
			text: z.string(),
			variant: badgeVariantSchema.unwrap(),
		})
		.optional(),
	url: z.string().optional(),
	offerCount: z.number().optional(),
	offers: z
		.array(
			z.object({
				merchantId: z.string().optional(),
				merchantName: z.string(),
				merchantLogo: z.string().optional(),
				price: z.number(),
				currency: z.string(),
				url: z.string().optional(),
				shippingCost: z.number().optional(),
				deliveryDays: z.number().optional(),
				stockStatus: z.string().optional(),
				verified: z.boolean().optional(),
				paymentMethods: z.array(z.string()).optional(),
			}),
		)
		.optional(),
	seller: z
		.object({
			id: z.string().optional(),
			name: z.string(),
			avatar: z.string().optional(),
			verified: z.boolean().optional(),
			rating: z.number().optional(),
		})
		.optional(),
	location: z
		.object({
			lat: z.number().optional(),
			lng: z.number().optional(),
			address: z.string().optional(),
			city: z.string().optional(),
			country: z.string().optional(),
		})
		.optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

const comparisonFilterStateSchema = z.object({
	freeShipping: z.boolean().optional(),
	inStock: z.boolean().optional(),
	topRated: z.boolean().optional(),
});

const comparisonWidgetStateSchema = z.object({
	selectedIds: z.array(z.string()).optional(),
	sortBy: z.enum(["relevance", "price", "rating", "delivery"]).optional(),
	filters: comparisonFilterStateSchema.optional(),
	view: z.enum(["results", "compare", "alert"]).optional(),
});

const listingGroupSchema = z.object({
	query: z.string().describe("Product query for this result group"),
	items: z
		.array(comparisonLayoutItemSchema)
		.describe("Results for this product query"),
	totalResults: z.number().describe("Total results found for this group"),
	error: z.string().optional().describe("Optional group-level error message"),
});

const chartDatumSchema = z.record(
	z.string(),
	z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

const chartSeriesSchema = z.object({
	key: z.string().describe("Numeric field in each data row"),
	label: z.string().nullable().describe("Human label for this series"),
	color: z
		.enum(["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6"])
		.nullable()
		.describe("Internal palette token. Do not use arbitrary CSS colors."),
	stack: z
		.string()
		.nullable()
		.describe("Optional stack group for stacked area/bar charts"),
});

const dataChartPropsSchema = z.object({
	title: z.string().nullable().describe("Optional chart title"),
	description: z.string().nullable().describe("Optional chart description"),
	data: z.array(chartDatumSchema).describe("Chart data rows"),
	variant: z
		.enum(["line", "area", "bar", "donut"])
		.nullable()
		.describe("Chart visualization type"),
	xKey: z
		.string()
		.nullable()
		.describe("Field for x-axis labels on line/area/bar charts"),
	yKeys: z
		.array(z.string())
		.nullable()
		.describe("Numeric fields to plot when series is not provided"),
	series: z
		.array(chartSeriesSchema)
		.nullable()
		.describe("Explicit series definitions for line/area/bar charts"),
	nameKey: z.string().nullable().describe("Label field for donut slices"),
	valueKey: z
		.string()
		.nullable()
		.describe("Numeric value field for donut slices"),
	height: z
		.number()
		.min(140)
		.max(520)
		.nullable()
		.describe("Chart height in pixels"),
	showLegend: z.boolean().nullable().describe("Show chart legend"),
	showTooltip: z.boolean().nullable().describe("Show chart tooltip"),
	stacked: z.boolean().nullable().describe("Stack series where supported"),
});

// =============================================================================
// CATALOG DEFINITION
// =============================================================================

export const tedixCatalog = defineCatalog(schema, {
	components: {
		// =====================================================================
		// from @json-render/shadcn (standard UI components)
		// =====================================================================

		// Layout
		Stack: shadcnComponentDefinitions.Stack,
		Grid: shadcnComponentDefinitions.Grid,
		Card: shadcnComponentDefinitions.Card,
		Tabs: shadcnComponentDefinitions.Tabs,
		Accordion: shadcnComponentDefinitions.Accordion,
		Separator: shadcnComponentDefinitions.Separator,

		// Typography & Media
		Heading: shadcnComponentDefinitions.Heading,
		Text: shadcnComponentDefinitions.Text,
		Image: shadcnComponentDefinitions.Image,
		Avatar: shadcnComponentDefinitions.Avatar,
		Badge: shadcnComponentDefinitions.Badge,

		// Form Controls
		Button: shadcnComponentDefinitions.Button,
		Link: shadcnComponentDefinitions.Link,
		Input: shadcnComponentDefinitions.Input,
		Textarea: shadcnComponentDefinitions.Textarea,
		Select: shadcnComponentDefinitions.Select,
		Checkbox: shadcnComponentDefinitions.Checkbox,
		Radio: shadcnComponentDefinitions.Radio,
		Switch: shadcnComponentDefinitions.Switch,
		Slider: shadcnComponentDefinitions.Slider,
		Toggle: shadcnComponentDefinitions.Toggle,
		ToggleGroup: shadcnComponentDefinitions.ToggleGroup,

		// Feedback & Status
		Alert: shadcnComponentDefinitions.Alert,
		Progress: shadcnComponentDefinitions.Progress,
		Skeleton: shadcnComponentDefinitions.Skeleton,
		Spinner: shadcnComponentDefinitions.Spinner,

		// Navigation
		Pagination: shadcnComponentDefinitions.Pagination,

		// Data
		Table: shadcnComponentDefinitions.Table,

		// =====================================================================
		// CUSTOM LAYOUT (Tedix-specific)
		// =====================================================================

		Section: {
			props: z.object({
				title: z.string().nullable().describe("Section heading"),
				description: z.string().nullable().describe("Section description"),
				collapsible: z.boolean().nullable().describe("Allow collapsing"),
			}),
			// `children` is the default slot — json-render 0.20 warns when a spec
			// uses `slots.default`, so only genuinely named regions belong here.
			// `header` and `footer` let a spec put real components (badge rows,
			// action buttons, summaries) around the body instead of being limited
			// to the flat title/description strings above.
			slots: ["header", "footer"],
			description:
				"Content section with optional heading, description, and collapsible behavior. Use the `header` slot for controls or badges beside the heading and the `footer` slot for actions or summaries below the body; plain body content goes in children.",
		},

		Divider: {
			props: z.object({
				label: z.string().nullable().describe("Optional divider label"),
			}),
			description: "Horizontal divider/separator with optional label",
		},

		SectionHeader: {
			props: z.object({
				title: z.string().nullable().describe("Primary section title"),
				description: z
					.string()
					.nullable()
					.describe("Short supporting section copy"),
				eyebrow: z
					.string()
					.nullable()
					.describe("Small uppercase context label above the title"),
				meta: z
					.string()
					.nullable()
					.describe("Small secondary metadata such as date range or scope"),
				badge: z.string().nullable().describe("Optional status/count badge"),
				badgeVariant: richBadgeVariantSchema,
				actionLabel: z
					.string()
					.nullable()
					.describe("Optional compact header action label"),
				align: alignmentSchema,
				density: z
					.enum(["compact", "comfortable"])
					.nullable()
					.describe("Header spacing and type scale"),
				divider: z
					.boolean()
					.nullable()
					.describe("Render a subtle bottom divider"),
			}),
			description:
				"Compact section header with eyebrow, title, description, metadata, badge, and optional action. Use instead of hand-built Heading/Text/Badge stacks.",
		},

		// =====================================================================
		// DATA COMPONENTS (Tedix Custom)
		// =====================================================================

		MetricCard: {
			props: z.object({
				label: z.string().describe("Metric label (e.g., 'Revenue')"),
				value: z.string().describe("Metric value (e.g., '$142,500')"),
				change: z
					.string()
					.nullable()
					.describe("Change indicator (e.g., '+12%')"),
				changeType: z
					.enum(["positive", "negative", "neutral"])
					.nullable()
					.describe("Change sentiment"),
				icon: z.string().nullable().describe("Optional icon"),
				format: z
					.enum(["number", "currency", "percent"])
					.nullable()
					.describe("Value format hint"),
			}),
			description:
				"Dashboard KPI metric tile. Shows a labeled value with optional change indicator.",
		},

		MetricTrend: {
			props: z.object({
				label: z.string().describe("Metric label"),
				value: numberOrStringSchema.describe("Metric value"),
				unit: z
					.string()
					.nullable()
					.describe("Unit suffix shown beside the value"),
				trend: z
					.string()
					.nullable()
					.describe("Trend delta text such as '12%' or '$4.2k'"),
				trendLabel: z
					.string()
					.nullable()
					.describe("Context for the trend, such as 'vs last week'"),
				direction: z
					.enum(["up", "down", "flat"])
					.nullable()
					.describe("Trend direction"),
				description: z
					.string()
					.nullable()
					.describe("Short supporting metric note"),
				badge: z.string().nullable().describe("Optional metric badge"),
				badgeVariant: richBadgeVariantSchema,
				tone: primitiveToneSchema,
				format: z
					.enum(["number", "currency", "percent", "text"])
					.nullable()
					.describe("Value formatter for numeric values"),
				currency: z
					.string()
					.nullable()
					.describe("Currency code for currency formatting"),
				variant: z
					.enum(["card", "plain", "inline"])
					.nullable()
					.describe("Visual container style"),
			}),
			description:
				"Single compact KPI/trend primitive for summaries, headers, and dense dashboards. Use StatGrid for multiple related metrics.",
		},

		DataTable: {
			props: z.object({
				columns: z
					.array(
						z.object({
							header: z.string().describe("Column header text"),
							field: z.string().describe("Field path in row data"),
							format: z
								.enum([
									"text",
									"number",
									"currency",
									"percent",
									"date",
									"badge",
								])
								.nullable()
								.describe("Cell format"),
							align: alignmentSchema,
							sortable: z.boolean().nullable().describe("Allow sorting"),
							width: z
								.string()
								.nullable()
								.describe("Column width (e.g., '200px', '30%')"),
						}),
					)
					.describe("Column definitions"),
				data: z
					.array(z.record(z.string(), z.unknown()))
					.describe("Row data array"),
				pageSize: z.number().nullable().describe("Rows per page"),
				striped: z.boolean().nullable().describe("Striped row styling"),
				compact: z.boolean().nullable().describe("Compact row height"),
			}),
			description:
				"Sortable, paginated data table. Define columns with field mappings and format hints.",
		},

		DataChart: {
			props: dataChartPropsSchema,
			description:
				"Agent-safe chart primitive for trends, time series, categorical counts, and compact dashboards. Use this instead of raw Recharts or hand-built chart markup.",
		},

		StatGrid: {
			props: z.object({
				title: z.string().nullable().describe("Optional grid heading"),
				description: z
					.string()
					.nullable()
					.describe("Optional grid description"),
				stats: z
					.array(
						z.object({
							label: z.string().describe("Metric label"),
							value: numberOrStringSchema.describe("Metric value"),
							unit: z
								.string()
								.nullable()
								.describe("Unit suffix shown beside the value"),
							description: z
								.string()
								.nullable()
								.describe("Short supporting text"),
							change: z
								.string()
								.nullable()
								.describe("Change indicator such as '+12%'"),
							changeType: z
								.enum(["positive", "negative", "neutral"])
								.nullable()
								.describe("Change sentiment"),
							badge: z
								.string()
								.nullable()
								.describe("Optional small badge text"),
							badgeVariant: richBadgeVariantSchema,
							tone: primitiveToneSchema,
							progress: z
								.number()
								.min(0)
								.max(100)
								.nullable()
								.describe("Optional 0-100 progress bar"),
							format: z
								.enum(["number", "currency", "percent", "text"])
								.nullable()
								.describe("Value formatter for numeric values"),
							currency: z
								.string()
								.nullable()
								.describe("Currency code for currency formatting"),
						}),
					)
					.describe("Stat cards to render"),
				columns: responsiveColumnsSchema.nullable(),
				variant: z
					.enum(["cards", "panel", "minimal"])
					.nullable()
					.describe("Visual container style"),
				density: z
					.enum(["compact", "comfortable"])
					.nullable()
					.describe("Spacing density"),
			}),
			description:
				"Responsive dashboard stat grid with badges, change indicators, semantic tones, and optional progress bars.",
		},

		KeyValuePanel: {
			props: z.object({
				title: z.string().nullable().describe("Optional panel heading"),
				description: z
					.string()
					.nullable()
					.describe("Optional panel description"),
				items: z
					.array(
						z.object({
							label: z.string().describe("Field label"),
							value: z
								.union([z.string(), z.number(), z.boolean()])
								.nullable()
								.describe("Field value"),
							description: z
								.string()
								.nullable()
								.describe("Optional supporting text"),
							badge: z.string().nullable().describe("Optional badge text"),
							badgeVariant: richBadgeVariantSchema,
							tone: primitiveToneSchema,
							href: z
								.string()
								.nullable()
								.describe("Optional link for the value"),
						}),
					)
					.describe("Key/value rows"),
				columns: z
					.number()
					.min(1)
					.max(3)
					.nullable()
					.describe("Responsive column count"),
				density: z
					.enum(["compact", "comfortable"])
					.nullable()
					.describe("Spacing density"),
				variant: z
					.enum(["card", "plain"])
					.nullable()
					.describe("Visual container style"),
			}),
			description:
				"Compact facts panel for metadata, account details, object properties, and summaries.",
		},

		BarList: {
			props: z.object({
				title: z.string().nullable().describe("Optional list heading"),
				description: z
					.string()
					.nullable()
					.describe("Optional list description"),
				items: z
					.array(
						z.object({
							label: z.string().describe("Bar label"),
							value: z.number().describe("Numeric bar value"),
							max: z
								.number()
								.nullable()
								.describe("Optional item-specific max value"),
							valueLabel: z
								.string()
								.nullable()
								.describe("Preformatted value label"),
							description: z
								.string()
								.nullable()
								.describe("Optional supporting text"),
							badge: z.string().nullable().describe("Optional badge text"),
							badgeVariant: richBadgeVariantSchema,
							tone: primitiveToneSchema,
						}),
					)
					.describe("Bars to render"),
				maxValue: z
					.number()
					.nullable()
					.describe("Shared max value for all bars"),
				format: z
					.enum(["number", "currency", "percent"])
					.nullable()
					.describe("Value formatter"),
				currency: z
					.string()
					.nullable()
					.describe("Currency code for currency formatting"),
				showValues: z.boolean().nullable().describe("Show numeric labels"),
				showPercent: z
					.boolean()
					.nullable()
					.describe("Show normalized percentages instead of raw values"),
				sort: z
					.enum(["asc", "desc", "none"])
					.nullable()
					.describe("Optional value sort order"),
				limit: z.number().nullable().describe("Maximum number of bars to show"),
				variant: z
					.enum(["card", "plain"])
					.nullable()
					.describe("Visual container style"),
			}),
			description:
				"Horizontal bar list for rankings, distributions, progress summaries, and scored outputs.",
		},

		StatusTimeline: {
			props: z.object({
				title: z.string().nullable().describe("Optional timeline heading"),
				description: z
					.string()
					.nullable()
					.describe("Optional timeline description"),
				items: z
					.array(
						z.object({
							title: z.string().describe("Timeline event title"),
							description: z.string().nullable().describe("Event details"),
							timestamp: z
								.string()
								.nullable()
								.describe("Date/time or relative timestamp"),
							status: z
								.enum([
									"completed",
									"current",
									"pending",
									"warning",
									"error",
									"info",
								])
								.nullable()
								.describe("Event status"),
							statusLabel: z
								.string()
								.nullable()
								.describe("Inline status label"),
							badge: z.string().nullable().describe("Optional badge text"),
							badgeVariant: richBadgeVariantSchema,
							meta: z
								.string()
								.nullable()
								.describe("Secondary timestamp or metadata"),
						}),
					)
					.describe("Timeline events"),
				density: z
					.enum(["compact", "comfortable"])
					.nullable()
					.describe("Spacing density"),
				showConnectors: z
					.boolean()
					.nullable()
					.describe("Show vertical connector lines"),
				variant: z
					.enum(["card", "plain"])
					.nullable()
					.describe("Visual container style"),
			}),
			description:
				"Vertical status timeline for workflows, orders, incidents, audits, and task progress.",
		},

		Carousel: {
			props: z.object({
				autoPlay: z.boolean().nullable().describe("Auto-advance slides"),
				interval: z.number().nullable().describe("Auto-play interval in ms"),
				showDots: z.boolean().nullable().describe("Show navigation dots"),
				showArrows: z.boolean().nullable().describe("Show navigation arrows"),
				loop: z.boolean().nullable().describe("Enable infinite looping"),
			}),
			// Slides are the default content, which json-render delivers as
			// `children`; the carousel has no separately-named region.
			slots: [],
			description:
				"Horizontal scrollable carousel. Children are individual slides (typically Cards).",
		},

		ProductCard: {
			props: z.object({
				title: z.string().describe("Product name"),
				image: z.string().nullable().describe("Product image URL"),
				price: z
					.string()
					.nullable()
					.describe("Formatted price (e.g., '$29.99')"),
				originalPrice: z
					.string()
					.nullable()
					.describe("Original price for strikethrough"),
				rating: z.number().nullable().describe("Rating value (0-5)"),
				ratingCount: z.number().nullable().describe("Number of ratings"),
				badge: z
					.string()
					.nullable()
					.describe("Product badge (e.g., 'Sale', 'New')"),
				badgeVariant: badgeVariantSchema,
				url: z.string().nullable().describe("Product URL"),
				ctaLabel: z.string().nullable().describe("Call-to-action button label"),
			}),
			description:
				"Ecommerce product card with image, price, rating, and CTA. Designed for carousel/grid layouts.",
		},

		StatGroup: {
			props: z.object({
				stats: z
					.array(
						z.object({
							label: z.string(),
							value: z.string(),
							change: z.string().nullable(),
							changeType: z
								.enum(["positive", "negative", "neutral"])
								.nullable(),
						}),
					)
					.describe("Array of stat items"),
				columns: responsiveColumnsSchema.nullable(),
			}),
			description:
				"Group of inline metric stats. Compact alternative to multiple MetricCards.",
		},

		ContentCard: {
			props: z.object({
				title: z.string().describe("Article/content title"),
				snippet: z.string().nullable().describe("Content snippet/excerpt"),
				thumbnail: z.string().nullable().describe("Thumbnail image URL"),
				category: z.string().nullable().describe("Content category"),
				author: z.string().nullable().describe("Author name"),
				date: z.string().nullable().describe("Publication date"),
				url: z.string().nullable().describe("Content URL"),
				score: z.number().nullable().describe("Relevance score (0-1)"),
			}),
			description:
				"Content/article card for content search results. Shows title, snippet, metadata, and relevance.",
		},

		ActionButton: {
			props: z.object({
				label: z.string().describe("Button label"),
				tone: z
					.enum([
						"default",
						"primary",
						"success",
						"warning",
						"destructive",
						"ghost",
					])
					.nullable()
					.describe("Visual tone"),
				disabled: z.boolean().nullable().describe("Disable the button"),
				fullWidth: z
					.boolean()
					.nullable()
					.describe("Stretch to container width"),
			}),
			description:
				"Standalone button whose behavior is its on.press action (open_url, follow_up, call_tool, ...). Presentation only; side effects stay in registered actions.",
		},

		EmptyState: {
			props: z.object({
				title: z.string().describe("Empty state heading"),
				description: z.string().nullable().describe("Helpful description"),
				icon: z.string().nullable().describe("Icon name"),
				actionLabel: z.string().nullable().describe("CTA button label"),
				action: z.string().nullable().describe("CTA action name"),
			}),
			description: "Placeholder for empty/no-data states with optional CTA",
		},

		AnswerBlock: {
			props: z.object({
				answer: z
					.string()
					.describe("AI-generated answer text (supports markdown)"),
				query: z.string().nullable().describe("Original query for context"),
				sources: z
					.array(
						z.object({
							title: z.string(),
							url: z.string(),
							snippet: z.string().nullable(),
						}),
					)
					.nullable()
					.describe("Source citations"),
			}),
			description:
				"AI answer block with markdown rendering and source citations. For content/knowledge search results.",
		},

		ComparisonLayout: {
			props: z.object({
				results: z
					.array(comparisonLayoutItemSchema)
					.nullable()
					.describe("Comparison results array"),
				items: z
					.array(comparisonLayoutItemSchema)
					.nullable()
					.describe("Alias for results; useful when tool output uses /items"),
				query: z
					.string()
					.nullable()
					.describe("Search query shown in the header"),
				batchMode: z
					.boolean()
					.nullable()
					.describe("Enable grouped multi-product comparison mode"),
				listingGroups: z
					.array(listingGroupSchema)
					.nullable()
					.describe("Grouped results for batch mode"),
				batchContext: z
					.string()
					.nullable()
					.describe("Subtitle/context for batch searches"),
				currency: z.string().nullable().describe("Currency code"),
				vertical: z
					.enum([
						"ecommerce",
						"real_estate",
						"automotive",
						"jobs",
						"travel",
						"crypto",
						"services",
						"marketplace",
					])
					.nullable()
					.describe("Vertical-specific comparison styling"),
				hideFilters: z.boolean().nullable().describe("Hide the filter bar"),
				strings: z
					.record(z.string(), z.unknown())
					.nullable()
					.describe("Localized UI strings override map"),
				sortBy: z
					.enum(["relevance", "price", "rating", "delivery"])
					.nullable()
					.describe("Initial sort option"),
				filters: comparisonFilterStateSchema
					.nullable()
					.describe("Initial filter state"),
				selectedIds: z
					.array(z.string())
					.nullable()
					.describe("Initially selected comparison item IDs"),
				allowFullscreen: z
					.boolean()
					.nullable()
					.describe("Allow fullscreen toggle"),
				className: z
					.string()
					.nullable()
					.describe("Optional extra container classes"),
				metadata: z
					.record(z.string(), z.unknown())
					.nullable()
					.describe("Extra metadata forwarded to the layout"),
				isLoading: z.boolean().nullable().describe("Render loading state"),
				error: z.string().nullable().describe("Optional inline error content"),
				errorTitle: z.string().nullable().describe("Custom error title"),
				errorMessage: z.string().nullable().describe("Custom error message"),
				emptyTitle: z.string().nullable().describe("Custom empty state title"),
				emptyMessage: z
					.string()
					.nullable()
					.describe("Custom empty state message"),
				comparePrompt: z
					.string()
					.nullable()
					.describe(
						"Optional follow-up prompt template with {query}, {count}, and {items} placeholders",
					),
				widgetState: comparisonWidgetStateSchema
					.nullable()
					.describe(
						"Persisted layout state; bind this with $bindState for host persistence",
					),
			}),
			description:
				"Full-featured price comparison experience with carousel, filters, compare tray, fullscreen mode, and product detail dialog. Best for Find/search results.",
		},

		ItemDetailDialog: {
			props: z.object({
				item: z
					.record(z.string(), z.unknown())
					.nullable()
					.describe(
						"The selected item object to display in the dialog. Bind to $state: '/selectedItem'.",
					),
			}),
			slots: [],
			description:
				"Modal dialog showing full details of a selected product/item. Wire on.close to clear the selectedItem state.",
		},
	},

	actions: {
		open_url: {
			params: z.object({
				url: z.string().describe("URL to open"),
			}),
			description:
				"Open a URL in a new tab. Prefer open_external for proper host integration.",
		},
		open_external: {
			params: z.object({
				url: z.string().describe("URL to open via host bridge"),
			}),
			description:
				"Open a URL via the host bridge (MCP Apps openLink) with UTM tracking. Preferred over open_url.",
		},
		follow_up: {
			params: z.object({
				query: z.string().describe("Follow-up query text"),
			}),
			description:
				"Send a follow-up message to the AI assistant via the host bridge.",
		},
		request_modal: {
			params: z.object({
				title: z.string().optional().describe("Modal title"),
				item: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Item data to display in the modal"),
				anchor: z
					.object({
						top: z.number().optional(),
						left: z.number().optional(),
						width: z.number().optional(),
						height: z.number().optional(),
					})
					.optional()
					.describe(
						"Position anchor for the modal relative to the triggering element",
					),
			}),
			description:
				"Request a modal overlay from the host to show item detail or custom content.",
		},
		request_display_mode: {
			params: z.object({
				mode: z
					.enum(["inline", "fullscreen", "pip"])
					.describe("Requested display mode"),
			}),
			description:
				"Request a display mode change from the host (inline, fullscreen, pip).",
		},
		call_tool: {
			params: z.object({
				tool: z.string().describe("MCP tool name to call via the host bridge"),
				arguments: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Arguments passed to the tool"),
			}),
			description:
				"Host-mediated MCP tool call. The host authorizes the named tool; outside an MCP Apps host this is a warned no-op.",
		},
		refine_search: {
			params: z.object({
				query: z.string().describe("New search query"),
				tool: z
					.string()
					.optional()
					.describe("MCP tool name to call (defaults to search_listings)"),
			}),
			description: "Trigger a new MCP tool call to refine search results.",
		},
		filter: {
			params: z.object({
				field: z.string().describe("Field to filter on"),
				value: z.string().describe("Filter value"),
				mode: z
					.enum(["includes", "eq"])
					.optional()
					.describe("Filter mode; defaults to substring match"),
				statePath: z
					.string()
					.optional()
					.describe("Target state array path to replace; defaults to /items"),
				sourceStatePath: z
					.string()
					.optional()
					.describe(
						"Source state array path to filter from; defaults to /allItems when present",
					),
				queryStatePath: z
					.string()
					.optional()
					.describe(
						"Optional state path to mirror the current filter query into",
					),
			}),
			description:
				"Apply a data filter and write filtered rows back into widget state",
		},
		sort: {
			params: z.object({
				field: z.string().describe("Field to sort by"),
				direction: z.enum(["asc", "desc"]).describe("Sort direction"),
				statePath: z
					.string()
					.optional()
					.describe("Target state array path to replace; defaults to /items"),
				sourceStatePath: z
					.string()
					.optional()
					.describe(
						"Source state array path to sort from; defaults to the target path",
					),
			}),
			description:
				"Sort data by field and write the reordered rows back into widget state",
		},
		selectItem: {
			params: z.object({
				index: z
					.number()
					.describe(
						"Index of the item in the source array (use { $index: true } inside repeat)",
					),
				sourcePath: z
					.string()
					.optional()
					.describe("State path to the source array; defaults to /items"),
				targetPath: z
					.string()
					.optional()
					.describe(
						"State path to write the selected item to; defaults to /selectedItem",
					),
			}),
			description:
				"Copy an item from a state array into a target state path by index. Use inside repeat elements with { $index: true } to select the current item.",
		},
	},
});

/**
 * JSON Schema for the full layout spec.
 * Used as outputSchema on MCP tools that return widget layouts.
 *
 * Note: strict mode ({ strict: true }) collapses the dynamic elements map,
 * so we use the standard schema which preserves full component type info.
 */
export function getTediJsonSchema(): Record<string, unknown> {
	return tedixCatalog.jsonSchema() as Record<string, unknown>;
}

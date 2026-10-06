/**
 * Tedix Component Registry for json-render
 *
 * Uses @json-render/shadcn component implementations for standard UI components
 * and custom implementations for Tedix-specific components.
 *
 * @module @tedix/mcp-ui/json-render/registry
 */

import { getByPath, setByPath } from "@json-render/core";
import { standardDirectives } from "@json-render/directives";
import { defineRegistry } from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";
import type { LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";
import {
	CarouselContent,
	CarouselDots,
	CarouselNext,
	CarouselPrevious,
	Carousel as EmblaCarousel,
} from "@tedix/widget-ui/carousel";
import {
	GeneratedChart,
	type GeneratedChartProps,
} from "@tedix/widget-ui/generated-chart";

// Import @tedix/widget-ui components (for custom components only)
import { Separator } from "@tedix/widget-ui/separator";
import {
	openSafeExternalUrl,
	safeImageSrc,
	safeLinkHref,
} from "@tedix/widget-ui/safe-url";
import { appendUtmParams, type UtmParams } from "../lib/utm";
import { tedixCatalog } from "./catalog";
import type { AnswerBlockSource } from "./components/AnswerBlock";
import { AnswerBlockComponent } from "./components/AnswerBlock";
import type { BarListItem } from "./components/BarList";
import { BarListComponent } from "./components/BarList";
import type { ComparisonLayoutComponentProps } from "./components/ComparisonLayout";
import { ComparisonLayoutComponent } from "./components/ComparisonLayout";
import { ContentCardComponent } from "./components/ContentCard";
import type { DataTableColumn } from "./components/DataTable";
import { DataTableComponent } from "./components/DataTable";
import { EmptyStateComponent } from "./components/EmptyState";
import { ItemDetailDialogComponent } from "./components/ItemDetailDialog";
import type { ActionButtonTone } from "./components/ActionButton";
import { ActionButtonComponent } from "./components/ActionButton";
import type { KeyValueItem } from "./components/KeyValuePanel";
import { KeyValuePanelComponent } from "./components/KeyValuePanel";
// Local custom components
import { MetricCardComponent } from "./components/MetricCard";
import { MetricTrendComponent } from "./components/MetricTrend";
import { ProductCardComponent } from "./components/ProductCard";
import { SectionHeaderComponent } from "./components/SectionHeader";
import type { StatGridItem } from "./components/StatGrid";
import { StatGridComponent } from "./components/StatGrid";
import type { StatItem } from "./components/StatGroup";
import { StatGroupComponent } from "./components/StatGroup";
import type { StatusTimelineItem } from "./components/StatusTimeline";
import { StatusTimelineComponent } from "./components/StatusTimeline";

// =============================================================================
// REGISTRY
// =============================================================================

// json-render types emit as void, but its dispatcher returns a rejecting promise.
// Catch at the UI boundary after the action observer records failure.
function emitWidgetEvent(emit: () => void): void {
	void Promise.resolve()
		.then(emit)
		.catch((error: unknown) => console.error("Widget action failed:", error));
}

export const tedixDirectives = standardDirectives;

export const { registry: tedixRegistry, handlers: tedixHandlers } =
	defineRegistry(tedixCatalog, {
		components: {
			// =====================================================================
			// from @json-render/shadcn (standard UI components)
			// =====================================================================

			// Layout
			Stack: shadcnComponents.Stack,
			Grid: shadcnComponents.Grid,
			Card: shadcnComponents.Card,
			Tabs: shadcnComponents.Tabs,
			Accordion: shadcnComponents.Accordion,
			Separator: shadcnComponents.Separator,

			// Typography & Media
			Heading: shadcnComponents.Heading,
			Text: shadcnComponents.Text,
			// `Image`/`Avatar`/`Link` are the three shadcn components whose spec
			// props land directly on a URL attribute, so each is wrapped rather
			// than passed through. The wrappers hand the underlying component a
			// value that already passed the allowlist — the sanitizer cannot live
			// inside @json-render/shadcn, which is a third-party package.
			Image: (ctx) => (
				<shadcnComponents.Image
					{...ctx}
					props={{ ...ctx.props, src: safeImageSrc(ctx.props.src) ?? null }}
				/>
			),
			Avatar: (ctx) => (
				<shadcnComponents.Avatar
					{...ctx}
					props={{ ...ctx.props, src: safeImageSrc(ctx.props.src) ?? null }}
				/>
			),
			Badge: shadcnComponents.Badge,

			// Form Controls
			Button: shadcnComponents.Button,
			// Fails closed to plain text, not to an empty `href`: `<a href="">`
			// re-navigates the widget to itself, which is a worse outcome than a
			// label that simply is not a link.
			Link: (ctx) => {
				const href = safeLinkHref(ctx.props.href);
				if (href === undefined) {
					return (
						<span className="text-muted-foreground">{ctx.props.label}</span>
					);
				}
				return (
					<shadcnComponents.Link {...ctx} props={{ ...ctx.props, href }} />
				);
			},
			Input: shadcnComponents.Input,
			Textarea: shadcnComponents.Textarea,
			Select: shadcnComponents.Select,
			Checkbox: shadcnComponents.Checkbox,
			Radio: shadcnComponents.Radio,
			Switch: shadcnComponents.Switch,
			Slider: shadcnComponents.Slider,
			Toggle: shadcnComponents.Toggle,
			ToggleGroup: shadcnComponents.ToggleGroup,

			// Feedback & Status
			Alert: shadcnComponents.Alert,
			Progress: shadcnComponents.Progress,
			Skeleton: shadcnComponents.Skeleton,
			Spinner: shadcnComponents.Spinner,

			// Navigation
			Pagination: shadcnComponents.Pagination,

			// Data
			Table: shadcnComponents.Table,

			// =====================================================================
			// CUSTOM LAYOUT (Tedix-specific)
			// =====================================================================

			Section: ({ props, children, slots }) => (
				<section className="space-y-4">
					{(props.title || props.description || slots?.header) && (
						<div className="flex items-start justify-between gap-4">
							{(props.title || props.description) && (
								<div className="space-y-1">
									{props.title && (
										<h2 className="font-semibold text-foreground text-xl">
											{props.title}
										</h2>
									)}
									{props.description && (
										<p className="text-muted-foreground text-sm">
											{props.description}
										</p>
									)}
								</div>
							)}
							{slots?.header && (
								<div className="flex shrink-0 items-center gap-2">
									{slots.header}
								</div>
							)}
						</div>
					)}
					{children}
					{slots?.footer && <div className="pt-2">{slots.footer}</div>}
				</section>
			),

			Divider: ({ props }) => {
				if (props.label) {
					return (
						<div className="relative my-4">
							<Separator />
							<span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-muted-foreground text-xs">
								{props.label}
							</span>
						</div>
					);
				}
				return <Separator className="my-4" />;
			},
			SectionHeader: ({ props, on }) => {
				const press = on("press");
				return (
					<SectionHeaderComponent
						title={props.title as string | null | undefined}
						description={props.description as string | null | undefined}
						eyebrow={props.eyebrow as string | null | undefined}
						meta={props.meta as string | null | undefined}
						badge={props.badge as string | null | undefined}
						badgeVariant={props.badgeVariant}
						actionLabel={props.actionLabel as string | null | undefined}
						align={
							props.align as "left" | "center" | "right" | null | undefined
						}
						density={
							props.density as "compact" | "comfortable" | null | undefined
						}
						divider={props.divider as boolean | null | undefined}
						onAction={() => emitWidgetEvent(press.emit)}
					/>
				);
			},

			// =====================================================================
			// DATA COMPONENTS (Custom)
			// =====================================================================

			MetricCard: ({ props }) => (
				<MetricCardComponent
					label={props.label}
					value={props.value}
					change={props.change}
					changeType={props.changeType}
					icon={props.icon}
					format={props.format}
				/>
			),
			MetricTrend: ({ props }) => (
				<MetricTrendComponent
					label={props.label as string}
					value={props.value as number | string}
					unit={props.unit as string | null | undefined}
					trend={props.trend as string | null | undefined}
					trendLabel={props.trendLabel as string | null | undefined}
					direction={
						props.direction as "up" | "down" | "flat" | null | undefined
					}
					description={props.description as string | null | undefined}
					badge={props.badge as string | null | undefined}
					badgeVariant={props.badgeVariant}
					tone={
						props.tone as
							| "default"
							| "success"
							| "warning"
							| "danger"
							| "info"
							| null
							| undefined
					}
					format={
						props.format as
							| "number"
							| "currency"
							| "percent"
							| "text"
							| null
							| undefined
					}
					currency={props.currency as string | null | undefined}
					variant={
						props.variant as "card" | "plain" | "inline" | null | undefined
					}
				/>
			),
			DataTable: ({ props }) => (
				<DataTableComponent
					columns={props.columns as DataTableColumn[]}
					data={props.data as Record<string, unknown>[]}
					pageSize={props.pageSize as number | null | undefined}
					striped={props.striped as boolean | null | undefined}
					compact={props.compact as boolean | null | undefined}
				/>
			),
			DataChart: ({ props }) => (
				<GeneratedChart {...(props as GeneratedChartProps)} />
			),
			Carousel: ({ props, children }) => {
				// Children are rendered directly (no CarouselItem wrapping).
				// When json-render's `repeat` is on this element, RepeatChildren returns
				// a Fragment that dissolves — each repeated child becomes a direct DOM
				// child of CarouselContent's container, letting Embla detect them as slides.
				// CSS [&>*] applies slide sizing to all direct children uniformly.
				return (
					<EmblaCarousel
						className="w-full overflow-hidden"
						opts={{
							align: "start",
							loop: !!props.loop,
							watchSlides: true,
							watchResize: true,
						}}
						showEdgeGradients={!!props.showArrows}
						enableWheelGestures
						autoPlay={!!props.autoPlay}
						autoPlayDelay={
							typeof props.interval === "number" ? props.interval : undefined
						}
					>
						<CarouselContent className="-ml-3 [&>*]:min-w-0 [&>*]:shrink-0 [&>*]:grow-0 [&>*]:basis-[280px] [&>*]:pl-3">
							{children}
						</CarouselContent>
						{props.showArrows !== false && <CarouselPrevious />}
						{props.showArrows !== false && <CarouselNext />}
						{props.showDots && <CarouselDots />}
					</EmblaCarousel>
				);
			},
			ProductCard: ({ props, on }) => {
				const press = on("press");
				return (
					<ProductCardComponent
						title={props.title}
						image={props.image}
						price={props.price}
						originalPrice={props.originalPrice}
						rating={props.rating}
						ratingCount={props.ratingCount}
						badge={props.badge}
						badgeVariant={props.badgeVariant}
						url={props.url}
						ctaLabel={props.ctaLabel}
						ctaShouldPreventDefault={press.shouldPreventDefault}
						onCtaClick={() => emitWidgetEvent(press.emit)}
					/>
				);
			},
			StatGroup: ({ props }) => (
				<StatGroupComponent
					stats={props.stats as StatItem[]}
					columns={
						props.columns as
							| {
									mobile: number;
									tablet?: number | null;
									desktop?: number | null;
							  }
							| null
							| undefined
					}
				/>
			),
			StatGrid: ({ props }) => (
				<StatGridComponent
					title={props.title as string | null | undefined}
					description={props.description as string | null | undefined}
					stats={props.stats as StatGridItem[]}
					columns={
						props.columns as
							| {
									mobile: number;
									tablet?: number | null;
									desktop?: number | null;
							  }
							| null
							| undefined
					}
					variant={
						props.variant as "cards" | "panel" | "minimal" | null | undefined
					}
					density={
						props.density as "compact" | "comfortable" | null | undefined
					}
				/>
			),
			KeyValuePanel: ({ props }) => (
				<KeyValuePanelComponent
					title={props.title as string | null | undefined}
					description={props.description as string | null | undefined}
					items={props.items as KeyValueItem[]}
					columns={props.columns as 1 | 2 | 3 | null | undefined}
					density={
						props.density as "compact" | "comfortable" | null | undefined
					}
					variant={props.variant as "card" | "plain" | null | undefined}
				/>
			),
			BarList: ({ props }) => (
				<BarListComponent
					title={props.title as string | null | undefined}
					description={props.description as string | null | undefined}
					items={props.items as BarListItem[]}
					maxValue={props.maxValue as number | null | undefined}
					format={
						props.format as "number" | "currency" | "percent" | null | undefined
					}
					currency={props.currency as string | null | undefined}
					showValues={props.showValues as boolean | null | undefined}
					showPercent={props.showPercent as boolean | null | undefined}
					sort={props.sort as "asc" | "desc" | "none" | null | undefined}
					limit={props.limit as number | null | undefined}
					variant={props.variant as "card" | "plain" | null | undefined}
				/>
			),
			StatusTimeline: ({ props }) => (
				<StatusTimelineComponent
					title={props.title as string | null | undefined}
					description={props.description as string | null | undefined}
					items={props.items as StatusTimelineItem[]}
					density={
						props.density as "compact" | "comfortable" | null | undefined
					}
					showConnectors={props.showConnectors as boolean | null | undefined}
					variant={props.variant as "card" | "plain" | null | undefined}
				/>
			),
			ContentCard: ({ props, on }) => {
				const press = on("press");
				return (
					<ContentCardComponent
						title={props.title}
						snippet={props.snippet}
						thumbnail={props.thumbnail}
						category={props.category}
						author={props.author}
						date={props.date}
						url={props.url}
						score={props.score}
						shouldPreventDefault={press.shouldPreventDefault}
						onClick={() => emitWidgetEvent(press.emit)}
					/>
				);
			},
			ActionButton: ({ props, on }) => (
				<ActionButtonComponent
					label={props.label as string | null | undefined}
					tone={props.tone as ActionButtonTone | null | undefined}
					disabled={props.disabled as boolean | null | undefined}
					fullWidth={props.fullWidth as boolean | null | undefined}
					onPress={() => emitWidgetEvent(on("press").emit)}
				/>
			),
			EmptyState: ({ props, on }) => (
				<EmptyStateComponent
					title={props.title}
					description={props.description}
					icon={props.icon}
					actionLabel={props.actionLabel}
					action={props.action}
					onAction={() => emitWidgetEvent(on("press").emit)}
				/>
			),
			AnswerBlock: ({ props }) => (
				<AnswerBlockComponent
					answer={props.answer as string}
					query={props.query as string | null | undefined}
					sources={props.sources as AnswerBlockSource[] | null | undefined}
				/>
			),
			ItemDetailDialog: ({ props, on }) => {
				const close = on("close");
				return (
					<ItemDetailDialogComponent
						item={props.item as LayoutItem | null}
						onClose={() => emitWidgetEvent(close.emit)}
					/>
				);
			},
			ComparisonLayout: ({ props, bindings, emit, on }) => {
				// Spec syntax to wire widget state persistence:
				//   { "$bindState": "widgetState" }
				// This binds the widgetState prop to the store path "widgetState" for
				// cross-session persistence via the host view-state bridge.
				const p = props as ComparisonLayoutComponentProps;
				return (
					<ComparisonLayoutComponent
						results={p.results}
						items={p.items}
						query={p.query}
						batchMode={p.batchMode}
						listingGroups={p.listingGroups}
						batchContext={p.batchContext}
						currency={p.currency}
						vertical={p.vertical}
						hideFilters={p.hideFilters}
						strings={p.strings}
						sortBy={p.sortBy}
						filters={p.filters}
						selectedIds={p.selectedIds}
						allowFullscreen={p.allowFullscreen}
						className={p.className}
						metadata={p.metadata}
						isLoading={p.isLoading}
						error={p.error}
						errorTitle={p.errorTitle}
						errorMessage={p.errorMessage}
						emptyTitle={p.emptyTitle}
						emptyMessage={p.emptyMessage}
						comparePrompt={p.comparePrompt}
						widgetState={p.widgetState}
						widgetStateBinding={bindings?.widgetState}
						emit={emit}
						on={on}
					/>
				);
			},
		},

		actions: {
			// `params.url` on both of these is a raw string out of the layout spec,
			// i.e. fully model-controlled, and `window.open("javascript:…")`
			// executes against the opener's origin. Both go through the scheme
			// allowlist; `openSafeExternalUrl` no-ops and warns on a rejected value
			// rather than opening a blank tab.
			open_url: async (params, _setState, state) => {
				const href = safeLinkHref(params?.url);
				if (href === undefined) {
					openSafeExternalUrl(params?.url);
					return;
				}
				const utmParams = (state as Record<string, unknown>)?._utmParams as
					| UtmParams
					| undefined;
				openSafeExternalUrl(appendUtmParams(href, utmParams));
			},
			open_external: async (params, _setState, _state) => {
				// Placeholder — overridden at runtime by TedixRenderer with MCP Apps hook
				openSafeExternalUrl(params?.url);
			},
			call_tool: async (_params) => {
				// Placeholder — overridden at runtime by TedixRenderer, which routes
				// through the MCP Apps host bridge. The name and
				// arguments come from the layout spec, and the HOST decides whether
				// that tool exists and is permitted — this action grants nothing.
			},
			follow_up: async (_params, _ctx) => {
				// Runtime override required: TedixRenderer injects the real sendFollowUpMessage
				// handler before mount. This fallback is never reached in production.
			},
			request_modal: async (_params) => {
				// Placeholder — overridden at runtime by TedixRenderer with MCP Apps hook
			},
			request_display_mode: async (_params) => {
				// Placeholder — overridden at runtime by TedixRenderer with MCP Apps hook
			},
			refine_search: async (_params) => {
				// Placeholder — overridden at runtime by TedixRenderer with MCP Apps hook
			},
			filter: async (params, setState, state) => {
				const targetPath =
					typeof params?.statePath === "string" ? params.statePath : "/items";
				const sourcePath =
					typeof params?.sourceStatePath === "string"
						? params.sourceStatePath
						: getByPath(state, "/allItems") !== undefined
							? "/allItems"
							: targetPath;
				const source = getByPath(state, sourcePath);
				if (!Array.isArray(source)) return;
				const rawValue =
					typeof params?.value === "string" ? params.value.trim() : "";
				const mode = params?.mode === "eq" ? "eq" : "includes";
				const nextRows =
					rawValue.length === 0
						? source
						: source.filter((row) => {
								if (!row || typeof row !== "object") return false;
								const fieldValue =
									typeof params?.field === "string" && params.field.length > 0
										? getByPath(
												row,
												`/${params.field.replace(/^\/+/, "").replace(/\./g, "/")}`,
											)
										: row;
								const haystack = String(fieldValue ?? "").toLowerCase();
								const needle = rawValue.toLowerCase();
								return mode === "eq"
									? haystack === needle
									: haystack.includes(needle);
							});
				setState((prev) => {
					const next = structuredClone((prev ?? {}) as Record<string, unknown>);
					setByPath(next, targetPath, nextRows);
					if (typeof params?.queryStatePath === "string") {
						setByPath(next, params.queryStatePath, rawValue);
					}
					return next;
				});
			},
			selectItem: async (params, setState, state) => {
				const index = typeof params?.index === "number" ? params.index : -1;
				if (index < 0) return;
				const sourcePath =
					typeof params?.sourcePath === "string" ? params.sourcePath : "/items";
				const targetPath =
					typeof params?.targetPath === "string"
						? params.targetPath
						: "/selectedItem";
				const source = getByPath(state, sourcePath);
				if (!Array.isArray(source) || index >= source.length) return;
				const item = source[index];
				setState((prev) => {
					const next = structuredClone((prev ?? {}) as Record<string, unknown>);
					setByPath(next, targetPath, item);
					return next;
				});
			},
			sort: async (params, setState, state) => {
				const targetPath =
					typeof params?.statePath === "string" ? params.statePath : "/items";
				const sourcePath =
					typeof params?.sourceStatePath === "string"
						? params.sourceStatePath
						: targetPath;
				const source = getByPath(state, sourcePath);
				if (!Array.isArray(source) || typeof params?.field !== "string") return;
				const direction = params?.direction === "desc" ? "desc" : "asc";
				const fieldPath = `/${params.field.replace(/^\/+/, "").replace(/\./g, "/")}`;
				const nextRows = [...source].sort((left, right) => {
					const leftValue = getByPath(left, fieldPath);
					const rightValue = getByPath(right, fieldPath);
					const comparison = String(leftValue ?? "").localeCompare(
						String(rightValue ?? ""),
						undefined,
						{ numeric: true, sensitivity: "base" },
					);
					return direction === "asc" ? comparison : -comparison;
				});
				setState((prev) => {
					const next = structuredClone((prev ?? {}) as Record<string, unknown>);
					setByPath(next, targetPath, nextRows);
					return next;
				});
			},
		},
	});

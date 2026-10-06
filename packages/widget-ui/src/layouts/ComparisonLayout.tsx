"use client";

// Stable default references to prevent infinite re-renders
// (inline defaults like `= []` or `= {}` create new references each render)
const EMPTY_SELECTED_IDS: string[] = [];
const EMPTY_FILTERS: {
	freeShipping?: boolean;
	inStock?: boolean;
	topRated?: boolean;
} = {};

/**
 * ComparisonLayout - Multi-source price comparison experience (Layer 3)
 *
 * A full-featured price comparison UX for price aggregation platforms.
 * Provides complete shopping flows with filtering, sorting, price alerts,
 * and external redirects with legal disclaimers.
 *
 * **Layer**: Layout (Layer 3) - Brand-level, config-driven
 * **Purpose**: Price aggregation and multi-merchant comparison sites
 *
 * **Features:**
 * - Horizontal carousel in inline mode, grid in fullscreen mode
 * - Multi-source search results with responsive layouts
 * - Price comparison with "Best Price" highlighting
 * - Filter chips (Free Shipping, In Stock, Top Rated)
 * - Sort options (Price, Rating, Delivery)
 * - Price alert modal
 * - External redirect with disclaimer (legal compliance)
 * - Comparison table for side-by-side analysis
 * - Price trend indicators (up/down)
 *
 * **Use Cases:**
 * - Google Shopping (merchant listings)
 * - Kayak (travel comparison)
 * - Skyscanner (flight search)
 * - Check24 (insurance/services)
 * - Trivago (hotel comparison)
 * - Expedia (hotel booking)
 *
 * **When to Use:**
 * - Building a price aggregation widget
 * - Need multi-merchant comparison with external links
 * - Require legal disclaimers for external redirects
 * - Need filtering/sorting/price alerts
 *
 * **NOT for:**
 * - Simple 2-4 item comparison (use CompareLayout)
 * - Generic intent-based comparison (use CompareLayout)
 *
 * @see CompareLayout - Simple side-by-side comparison (Intent Layer - Layer 3)
 *
 * @example
 * ```tsx
 * <ComparisonLayout
 *   results={products}
 *   query="iPhone 15 Pro"
 *   sortBy="price"
 *   onSortChange={(sort) => handleSort(sort)}
 *   filters={{ freeShipping: true, inStock: true }}
 *   onFilterChange={(filters) => handleFilters(filters)}
 *   onSetPriceAlert={(id, price) => handleAlert(id, price)}
 *   onExternalRedirect={(item) => handleRedirect(item)}
 * />
 * ```
 */

import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import {
	AlertTriangle,
	Bell,
	CheckCircle,
	ChevronDown,
	Maximize2,
	Minimize2,
	Search,
	Sparkles,
	Star,
} from "lucide-react";
import * as React from "react";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import {
	Carousel,
	CarouselContent,
	CarouselItem,
	CarouselNext,
	CarouselPrevious,
} from "../components/carousel";
import { PriceCard } from "../components/comparison/price-card";
import { ProductDetailDialog } from "../components/comparison/product-detail-dialog";
import { FullscreenGallery } from "../components/fullscreen-gallery";
import { Input } from "../components/input";
import { LayoutEmpty } from "../components/layout-primitives/layout-empty";
import { LayoutError } from "../components/layout-primitives/layout-error";
import { formatPrice } from "../lib/price-utils";
import { cn } from "../lib/utils";
import type {
	LayoutItemSchemaType as LayoutItem,
	LayoutItemOfferSchemaType as LayoutItemOffer,
} from "@tedix/api-contract/schemas/layout";
import {
	filterAndSortItems,
	getBestPrice,
	type ComparisonFilters,
	type ComparisonSort,
} from "./comparison/items";
import {
	getVerticalPriceCardProps,
	type ComparisonVertical,
} from "./comparison/vertical";
export type { ComparisonVertical } from "./comparison/vertical";

// =============================================================================
// Animation Constants
// =============================================================================

/** Spring transition for smooth LayoutGroup animations (filter/sort reordering) */
const LAYOUT_SPRING_TRANSITION = {
	type: "spring" as const,
	stiffness: 260,
	damping: 26,
};

// =============================================================================
// Types
// =============================================================================

/**
 * Product group for batch/multi-product search results.
 * Each group contains results for a single product query in the batch.
 */
export interface ListingGroup<T extends LayoutItem = LayoutItem> {
	/** The product query (e.g., "iPhone 16 Pro") */
	query: string;
	/** Results for this product */
	items: T[];
	/** Total results found for this product */
	totalResults: number;
	/** Error message if search failed for this product */
	error?: string;
}

/**
 * Persistable widget state for ComparisonLayout.
 * Use with the widget owner's view-state hook to persist state across conversations.
 *
 * @example
 * ```tsx
 * const [widgetState, setWidgetState] = useWidgetState<ComparisonWidgetState>();
 *
 * <ComparisonLayout
 *   widgetState={widgetState}
 *   onWidgetStateChange={setWidgetState}
 *   ...
 * />
 * ```
 */
export interface ComparisonWidgetState {
	/** IDs of items selected for comparison */
	selectedIds?: string[];
	/** Current sort option */
	sortBy?: ComparisonSort;
	/** Active filters */
	filters?: ComparisonFilters;
	/** Current view */
	view?: "results" | "compare" | "alert";
}

/**
 * Configurable UI strings for ComparisonLayout
 * Enables per-brand localization without code changes
 */
export interface ComparisonStrings {
	/** Filter label: "Free Shipping" / "Versandkostenfrei" */
	freeShipping?: string;
	/** Filter label: "In Stock" / "Auf Lager" */
	inStock?: string;
	/** Filter label: "Top Rated" / "Top bewertet" */
	topRated?: string;
	/** Clear filters: "Clear all" / "Alle löschen" */
	clearAll?: string;
	/** Compare button: "Compare Now" / "Jetzt vergleichen" */
	compareNow?: string;
	/** Clear selection: "Clear" / "Löschen" */
	clear?: string;
	/** Back button: "Back to Results" / "Zurück zu Ergebnissen" */
	backToResults?: string;
	/** Best price badge: "Best Price" / "Bester Preis" */
	bestPrice?: string;
	/** Selection text: "{count} items selected" / "{count} Artikel ausgewählt" */
	selectedForComparison?: string;
	/** Comparing header: "Comparing {count} Items" / "{count} Artikel vergleichen" */
	comparingItems?: string;
	/** AI comparison CTA: "Ask AI host to Compare" / "AI host vergleichen lassen" */
	askAIToCompare?: string;
	/** Empty comparison: "No items selected for comparison" */
	noItemsSelected?: string;
}

export interface ComparisonLayoutProps<T extends LayoutItem> {
	// Data
	/** Array of search results with merchant/source info (used in single-query mode) */
	results: T[];

	/** Search query that produced these results */
	query?: string;

	// Batch Mode (multi-product search)
	/**
	 * Whether this is a batch/multi-product search.
	 * When true, listingGroups should be provided instead of results.
	 */
	batchMode?: boolean;

	/**
	 * Grouped results by product query (only present in batch mode).
	 * Each group contains results for a single product query.
	 */
	listingGroups?: ListingGroup<T>[];

	/** User-provided context for the batch search (displayed as subtitle) */
	batchContext?: string;

	/** Currency code (default: EUR) */
	currency?: string;

	/** Locale for number/currency formatting (e.g., "de-DE", "en-US"). Defaults to "en-US". */
	locale?: string;

	/** Vertical type - controls which filters are shown */
	vertical?: ComparisonVertical;

	/** Hide filter bar entirely */
	hideFilters?: boolean;

	/**
	 * Configurable UI strings for localization
	 * Pass from brand's widgetConfig.strings via useWidgetStrings() hook
	 */
	strings?: ComparisonStrings;

	// Sorting
	/** Current sort option - "relevance" preserves backend semantic ranking */
	sortBy?: ComparisonSort;

	/** Callback when sort changes */
	onSortChange?: (sort: ComparisonSort) => void;

	// Filtering
	/** Active filters */
	filters?: ComparisonFilters;

	/** Callback when filters change */
	onFilterChange?: (filters: ComparisonFilters) => void;

	// Actions
	/** Callback when user sets a price alert */
	onSetPriceAlert?: (itemId: string, targetPrice: number) => void;

	/** Callback when user clicks external redirect (includes offer when clicking specific merchant) */
	onExternalRedirect?: (item: T, offer?: LayoutItemOffer) => void;

	/** Callback when user requests item details (host modal) */
	onRequestDetail?: (item: T) => void;

	// Selection (for comparison table)
	/** IDs of selected items for comparison */
	selectedIds?: string[];

	/** Callback when selection changes */
	onSelectionChange?: (ids: string[]) => void;

	// Render slots
	/** Custom result card renderer */
	renderResultCard?: (result: T) => React.ReactNode;

	/** Custom comparison table renderer */
	renderCompareTable?: (items: T[]) => React.ReactNode;

	/** Custom price alert renderer */
	renderPriceAlert?: (item: T) => React.ReactNode;

	// Layout options
	/** Enable fullscreen toggle */
	allowFullscreen?: boolean;

	/** Custom className for container */
	className?: string;

	/** Additional metadata */
	metadata?: Record<string, unknown>;

	// State
	/** Loading state - renders skeleton when true */
	isLoading?: boolean;

	/** Error state - renders error view with retry option */
	error?: React.ReactNode;

	/** Empty state - renders empty view when true and no data */
	isEmpty?: boolean;

	/** Callback when retry button is clicked */
	onRetry?: () => void;

	/** Custom error title */
	errorTitle?: string;

	/** Custom error message */
	errorMessage?: string;

	/** Custom empty state title */
	emptyTitle?: string;

	/** Custom empty state message */
	emptyMessage?: string;

	/**
	 * Per-item CTA text generator - overrides default CTA
	 * Use this for multi-source searches where each item has different source
	 */
	getItemCtaText?: (item: T) => string;

	/**
	 * Display mode from Apps SDK.
	 * - 'inline': Lightweight card in conversation
	 * - 'fullscreen': Immersive experience
	 *
	 * Per OpenAI guidelines: "Do not include your logo as part of the response.
	 * AI host will always append your logo and app name before the widget."
	 *
	 * Widget layer should pass this from host display-mode hook.
	 */
	displayMode?: "inline" | "fullscreen";

	/**
	 * Callback when display mode should change.
	 * Widget layer should pass setDisplayMode from host display-mode hook.
	 */
	onDisplayModeChange?: (mode: "inline" | "fullscreen") => void;

	/** Callback when user submits a new search query from within the widget */
	onRefineSearch?: (query: string) => void;

	/** Whether a search refinement is currently loading */
	isRefining?: boolean;

	/**
	 * Callback when user requests AI-powered comparison of selected items.
	 * Widget layer should use its MCP Apps message handler to
	 * send a comparison request to AI host with the selected items.
	 *
	 * @example
	 * ```tsx
	 * const sendFollowUp = useSendFollowUpMessage();
	 *
	 * <ComparisonLayout
	 *   onRequestAIComparison={(items) => {
	 *     const titles = items.map(i => i.title).join(", ");
	 *     sendFollowUp(`Compare these products: ${titles}`);
	 *   }}
	 * />
	 * ```
	 */
	onRequestAIComparison?: (items: T[]) => void;

	// Widget State Persistence
	/**
	 * Persisted widget state from parent.
	 * When provided, initializes internal state from this object.
	 * Use with the widget owner's view-state hook.
	 *
	 * @example
	 * ```tsx
	 * const [widgetState, setWidgetState] = useWidgetState<ComparisonWidgetState>();
	 *
	 * <ComparisonLayout
	 *   widgetState={widgetState}
	 *   onWidgetStateChange={setWidgetState}
	 * />
	 * ```
	 */
	widgetState?: ComparisonWidgetState;

	/**
	 * Callback to persist state changes.
	 * Called whenever internal state changes (selectedIds, sortBy, filters, view).
	 * Use with the widget owner's view-state hook.
	 */
	onWidgetStateChange?: (state: ComparisonWidgetState) => void;
}

type ComparisonView = "results" | "compare" | "alert";

// =============================================================================
// Batch Mode Sub-Components
// =============================================================================

interface BatchModeMultiRowProps<T extends LayoutItem> {
	groups: ListingGroup<T>[];
	renderResultCard?: (result: T) => React.ReactNode;
	/** Render function that receives item, compact flag, and per-group best price */
	renderDefaultPriceCard: (
		result: T,
		compact: boolean,
		groupBestPrice: number | null,
	) => React.ReactNode;
	/** Maximum groups to show initially (default: 4). Additional groups show via "Show more" */
	maxVisibleGroups?: number;
	/** Text for "Show more" button */
	showMoreText?: string;
}

/**
 * Multi-row stacked carousels for batch mode (Netflix-style).
 * Shows all listing groups simultaneously - one carousel per row.
 * Follows Apps SDK guidelines: no tabs, no deep navigation within cards.
 *
 * Each row has its own "Best Price" calculation (per-group, not global).
 */
function BatchModeMultiRow<T extends LayoutItem>({
	groups,
	renderResultCard,
	renderDefaultPriceCard,
	maxVisibleGroups = 4,
	showMoreText = "Show more groups",
}: BatchModeMultiRowProps<T>) {
	const [showAll, setShowAll] = React.useState(false);

	// Show all groups if <= maxVisibleGroups, or if user clicked "Show more"
	const visibleGroups =
		showAll || groups.length <= maxVisibleGroups
			? groups
			: groups.slice(0, maxVisibleGroups);

	const hasMoreGroups = groups.length > maxVisibleGroups && !showAll;

	// Compute best price per group (memoized)
	const groupBestPrices = React.useMemo(() => {
		return groups.map((group) => {
			const prices = group.items
				.filter((item) => item.price?.amount != null)
				.map((item) => item.price!.amount);
			return prices.length > 0 ? Math.min(...prices) : null;
		});
	}, [groups]);

	return (
		<div className="space-y-6">
			{visibleGroups.map((group, groupIndex) => {
				const groupBestPrice = groupBestPrices[groupIndex] ?? null;

				return (
					<div key={group.query} className="space-y-2">
						{/* Row header: listing query + count */}
						<div className="flex items-center gap-2">
							<h3 className="font-medium text-foreground text-sm">
								{group.query}
							</h3>
							<Badge variant="secondary" size="sm" pill>
								{group.items.length}
							</Badge>
							{group.error && (
								<AlertTriangle className="h-3.5 w-3.5 text-destructive" />
							)}
						</div>

						{/* Row content */}
						{group.error ? (
							<div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
								<p className="text-muted-foreground text-xs">{group.error}</p>
							</div>
						) : group.items.length === 0 ? (
							<div className="rounded-lg border border-border bg-muted/20 p-3 text-center">
								<p className="text-muted-foreground text-xs">
									No results found
								</p>
							</div>
						) : (
							<Carousel
								opts={{
									align: "start",
									loop: false,
								}}
								className="@container w-full"
								gap="0.75rem"
							>
								<CarouselContent>
									<LayoutGroup id={`multirow-carousel-${groupIndex}`}>
										{group.items.map((result) => (
											<CarouselItem
												key={result.id}
												className="@[480px]:basis-1/3 @[768px]:basis-1/4 basis-1/2"
											>
												<motion.div
													layout
													// Prefix with groupIndex to avoid collision when same item appears in multiple groups
													layoutId={`multirow-g${groupIndex}-item-${result.id}`}
													transition={LAYOUT_SPRING_TRANSITION}
												>
													{renderResultCard
														? renderResultCard(result)
														: renderDefaultPriceCard(
																result,
																true,
																groupBestPrice,
															)}
												</motion.div>
											</CarouselItem>
										))}
									</LayoutGroup>
								</CarouselContent>
								<CarouselPrevious className="-left-3 hidden sm:flex" />
								<CarouselNext className="-right-3 hidden sm:flex" />
							</Carousel>
						)}
					</div>
				);
			})}

			{/* Show more button for >maxVisibleGroups */}
			{hasMoreGroups && (
				<div className="flex justify-center pt-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => setShowAll(true)}
						className="gap-1"
					>
						<ChevronDown className="h-4 w-4" />
						{showMoreText} ({groups.length - maxVisibleGroups} more)
					</Button>
				</div>
			)}
		</div>
	);
}

// =============================================================================
// Component
// =============================================================================

export function ComparisonLayout<T extends LayoutItem>({
	results,
	query,
	batchMode = false,
	listingGroups,
	batchContext,
	currency = "EUR",
	locale = "en-US",
	vertical = "ecommerce",
	strings,
	sortBy = "relevance",
	filters = EMPTY_FILTERS,
	onSetPriceAlert,
	onExternalRedirect,
	onRequestDetail,
	selectedIds = EMPTY_SELECTED_IDS,
	onSelectionChange,
	renderResultCard,
	renderCompareTable,
	renderPriceAlert,
	allowFullscreen = true,
	className,
	isLoading = false,
	error,
	isEmpty = false,
	onRetry,
	errorTitle,
	errorMessage,
	emptyTitle,
	emptyMessage,
	getItemCtaText,
	displayMode,
	onDisplayModeChange,
	onRefineSearch,
	isRefining = false,
	onRequestAIComparison,
	widgetState,
	onWidgetStateChange,
}: ComparisonLayoutProps<T>) {
	// =============================================================================
	// RESOLVED STRINGS (with defaults)
	// =============================================================================
	const resolvedStrings = React.useMemo(
		() => ({
			freeShipping: strings?.freeShipping ?? "Free Shipping",
			inStock: strings?.inStock ?? "In Stock",
			topRated: strings?.topRated ?? "Top Rated",
			clearAll: strings?.clearAll ?? "Clear all",
			compareNow: strings?.compareNow ?? "Compare Now",
			clear: strings?.clear ?? "Clear",
			backToResults: strings?.backToResults ?? "Back to Results",
			bestPrice: strings?.bestPrice ?? "Best Price",
			selectedForComparison:
				strings?.selectedForComparison ?? "{count} items selected",
			comparingItems: strings?.comparingItems ?? "Comparing {count} Items",
			askAIToCompare: strings?.askAIToCompare ?? "Ask AI host to Compare",
			noItemsSelected:
				strings?.noItemsSelected ?? "No items selected for comparison",
		}),
		[strings],
	);
	// =============================================================================
	// ALL HOOKS MUST BE CALLED BEFORE ANY EARLY RETURNS (Rules of Hooks)
	// =============================================================================

	// View state - initialize from widgetState if provided
	const [view, setView] = React.useState<ComparisonView>(
		widgetState?.view ?? "results",
	);
	const [internalFullscreen, setInternalFullscreen] = React.useState(false);
	const [selectedForCompare, setSelectedForCompare] = React.useState<string[]>(
		widgetState?.selectedIds ?? selectedIds,
	);
	const [priceAlertItem, setPriceAlertItem] = React.useState<T | null>(null);
	const [targetPrice, setTargetPrice] = React.useState<string>("");
	const [detailItem, setDetailItem] = React.useState<T | null>(null);

	// Notify parent of state changes for persistence (useWidgetState integration)
	// Skip initial mount to avoid infinite re-render loop in ChatGPT's iframe
	// where setWidgetState → host notification → re-render → effect fires again.
	const isInitialMount = React.useRef(true);
	const prevStateRef = React.useRef<string>("");
	React.useEffect(() => {
		if (isInitialMount.current) {
			isInitialMount.current = false;
			prevStateRef.current = JSON.stringify({
				selectedIds: selectedForCompare,
				sortBy,
				filters,
				view,
			});
			return;
		}
		if (!onWidgetStateChange) return;
		const nextState = {
			selectedIds: selectedForCompare,
			sortBy,
			filters,
			view,
		};
		const serialized = JSON.stringify(nextState);
		if (serialized === prevStateRef.current) return;
		prevStateRef.current = serialized;
		onWidgetStateChange(nextState);
	}, [selectedForCompare, sortBy, filters, view, onWidgetStateChange]);

	// Check if we have AI host/MCP Apps display mode control
	// Widget layer passes this from host display-mode hook
	const hasHostDisplayMode = displayMode !== undefined;

	// Compute fullscreen state from:
	// 1. displayMode prop from widget layer (AI host environment via MCP Apps)
	// 2. Internal state (fallback for non-AI host environments)
	const isInFullscreen =
		displayMode === "fullscreen" || (!hasHostDisplayMode && internalFullscreen);

	// Handle fullscreen toggle
	const handleFullscreenToggle = React.useCallback(() => {
		if (onDisplayModeChange) {
			// Request display mode change via callback (connected to MCP Apps in widget layer)
			const newMode = isInFullscreen ? "inline" : "fullscreen";
			onDisplayModeChange(newMode);
		} else {
			// Fallback for non-AI host environments
			setInternalFullscreen((prev) => !prev);
		}
	}, [isInFullscreen, onDisplayModeChange]);

	// Sync external selection state
	React.useEffect(() => {
		setSelectedForCompare(selectedIds);
	}, [selectedIds]);

	// =============================================================================
	// Batch Mode Processing
	// =============================================================================

	// Determine which items to use based on batch mode
	// In batch mode, we may show all items or current group's items depending on view
	const effectiveResults = React.useMemo(() => {
		if (!batchMode || !listingGroups?.length) {
			return results;
		}
		// Flatten all items from listing groups as the effective results
		return listingGroups.flatMap((group) => group.items);
	}, [batchMode, listingGroups, results]);

	// Items for the current view (all items in batch mode, results otherwise)
	// Multi-row batch mode shows all groups at once, so currentItems = all items
	const currentItems = React.useMemo(() => {
		if (batchMode && listingGroups?.length) {
			return listingGroups.flatMap((group) => group.items) as T[];
		}
		return results;
	}, [batchMode, listingGroups, results]);

	// Find best price (across current view items)
	const bestPrice = React.useMemo(
		() => getBestPrice(currentItems),
		[currentItems],
	);

	// Helper to filter and sort items
	// Filter and sort results (single query mode or active group)
	const processedResults = React.useMemo(
		() => filterAndSortItems(currentItems, filters, sortBy),
		[currentItems, filters, sortBy],
	);

	// Process all groups for batch mode display
	const processedGroups = React.useMemo(() => {
		if (!batchMode || !listingGroups?.length) return [];
		return listingGroups.map((group) => ({
			...group,
			items: filterAndSortItems(group.items as T[], filters, sortBy),
		}));
	}, [batchMode, listingGroups, filters, sortBy]);

	// Total results count (for header display)
	const totalResultsCount = React.useMemo(() => {
		if (batchMode && listingGroups?.length) {
			return listingGroups.reduce((sum, g) => sum + g.items.length, 0);
		}
		return results.length;
	}, [batchMode, listingGroups, results]);

	const selectedItems = React.useMemo(
		() => effectiveResults.filter((r) => selectedForCompare.includes(r.id)),
		[effectiveResults, selectedForCompare],
	);

	const handleItemDetail = React.useCallback(
		(item: T) => {
			if (onRequestDetail) {
				onRequestDetail(item);
				return;
			}
			setDetailItem(item);
		},
		[onRequestDetail],
	);

	// Helper to render PriceCard consistently in both inline and fullscreen modes
	// Only difference: compact=true for inline carousel, compact=false for fullscreen grid
	// For batch mode multi-row, groupBestPrice is provided for per-group "Best Price" badge
	const renderDefaultPriceCard = React.useCallback(
		(result: T, compact: boolean, groupBestPrice?: number | null) => {
			// Use per-group best price if provided (batch mode), otherwise global best price
			const effectiveBestPrice = groupBestPrice ?? bestPrice;
			return (
				<PriceCard
					result={result}
					isBestPrice={result.price?.amount === effectiveBestPrice}
					currency={currency}
					compact={compact}
					isSelected={selectedForCompare.includes(result.id)}
					onItemClick={() => handleItemDetail(result)}
					onSelect={() => handleSelectForCompare(result.id)}
					onExternalClick={
						onExternalRedirect ? () => handleExternalClick(result) : undefined
					}
					{...getVerticalPriceCardProps(vertical)}
					ctaText={getItemCtaText?.(result)}
				/>
			);
		},
		[
			bestPrice,
			currency,
			handleItemDetail,
			selectedForCompare,
			vertical,
			getItemCtaText,
			onExternalRedirect,
		],
	);

	// Build data-llm context for AI host model awareness (MCP Apps pattern)
	const getDataLlmContext = (): string => {
		const v = vertical || "comparison";
		const queryContext = query ? ` for '${query}'` : "";

		if (isLoading) return `Loading ${v} results${queryContext}`;
		if (totalResultsCount === 0) return `No ${v} results found${queryContext}`;

		const parts: string[] = [];

		// Batch mode context
		if (batchMode && listingGroups?.length) {
			const groupCount = listingGroups.length;
			const queries = listingGroups.map((g) => g.query).join(", ");
			parts.push(
				`Comparing ${groupCount} products: ${queries} (${totalResultsCount} total results)`,
			);
			if (batchContext) {
				parts.push(`Context: ${batchContext}`);
			}
			// Multi-row shows all groups at once, no "active" group
		} else {
			// Basic result count and query
			parts.push(`Viewing ${totalResultsCount} ${v} results${queryContext}`);
		}

		// Best price item info
		if (bestPrice !== null) {
			const bestPriceItem = currentItems.find(
				(r) => r.price?.amount === bestPrice,
			);
			if (bestPriceItem) {
				const priceStr = formatPrice(
					bestPrice,
					currency as Parameters<typeof formatPrice>[1],
					locale,
				);
				const sellerStr = bestPriceItem.seller?.name
					? ` at ${bestPriceItem.seller.name}`
					: "";
				parts.push(`Best price: ${priceStr}${sellerStr}`);
			}
		}

		// Total merchant count (sum of all offerCounts)
		const totalMerchants = effectiveResults.reduce(
			(sum, r) => sum + (r.offerCount || 0),
			0,
		);
		if (totalMerchants > 0) {
			parts.push(
				`${totalMerchants} total merchant${totalMerchants > 1 ? "s" : ""}`,
			);
		}

		// Selection count
		if (selectedForCompare.length > 0) {
			parts.push(
				`${selectedForCompare.length} item${selectedForCompare.length > 1 ? "s" : ""} selected for comparison`,
			);
		}

		// Active view and compare details
		if (view === "compare" && selectedItems.length > 0) {
			const titles = selectedItems.map((item) => item.title).join(", ");
			parts.push(`Currently viewing comparison table with: ${titles}`);
		} else if (view === "alert" && priceAlertItem) {
			parts.push(`Setting price alert for: ${priceAlertItem.title}`);
		} else {
			// Results view - include mode
			const mode = isInFullscreen ? "fullscreen grid" : "carousel";
			parts.push(`Currently in ${mode} view`);
		}

		// Active filters
		const activeFilters = [
			filters.freeShipping && "free shipping",
			filters.inStock && "in stock",
			filters.topRated && "top rated",
		].filter(Boolean);
		if (activeFilters.length > 0) {
			parts.push(`Filters: ${activeFilters.join(", ")}`);
		}

		return `${parts.join(". ")}.`;
	};

	// =============================================================================
	// EARLY RETURNS (after all hooks)
	// =============================================================================

	// Loading state - always show carousel-style skeleton for visual consistency
	// The carousel skeleton matches the initial view users expect to see.
	// Note: We use the same skeleton regardless of displayMode because:
	// 1. The AI host may set fullscreen before data loads, but users expect carousel
	// 2. LayoutSkeleton variant="search" shows sidebar+list which looks wrong for carousel
	if (isLoading) {
		// Always use carousel-matching skeleton (same as Astro SSR fallback)
		return (
			<div className={cn("bg-background", className)}>
				{/* Compact header skeleton */}
				<div className="flex items-center justify-between px-4 py-3">
					<div className="flex items-center gap-2">
						<div className="h-5 w-32 animate-pulse rounded bg-muted" />
						<div className="h-4 w-16 animate-pulse rounded bg-muted" />
					</div>
					<div className="h-8 w-8 animate-pulse rounded bg-muted" />
				</div>
				{/* Carousel skeleton - horizontal single row */}
				<div className="flex gap-4 overflow-hidden px-4 pt-2">
					{[0, 1, 2, 3].map((i) => (
						<div
							key={i}
							className={cn(
								"flex-shrink-0 overflow-hidden rounded-lg border bg-card",
								"w-[45%] sm:w-[30%] lg:w-[23%]",
								i >= 2 && "hidden sm:block",
								i >= 3 && "hidden lg:block",
							)}
						>
							<div className="aspect-[4/3] animate-pulse bg-muted" />
							<div className="space-y-2 p-3">
								<div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
								<div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
								<div className="h-5 w-1/3 animate-pulse rounded bg-muted" />
							</div>
						</div>
					))}
				</div>
			</div>
		);
	}

	// Show error state
	if (error) {
		return (
			<LayoutError
				error={errorMessage ?? error}
				title={errorTitle}
				onRetry={onRetry}
				className={className}
			/>
		);
	}

	// Show empty state (check both single and batch mode)
	if (isEmpty || totalResultsCount === 0) {
		return (
			<LayoutEmpty
				icon={Search}
				title={emptyTitle || "No results found"}
				description={
					emptyMessage || "Try adjusting your search or filter criteria"
				}
				className={className}
			/>
		);
	}

	const handleSelectForCompare = (id: string) => {
		const newSelection = selectedForCompare.includes(id)
			? selectedForCompare.filter((sid) => sid !== id)
			: [...selectedForCompare, id].slice(0, 4); // Max 4 items

		setSelectedForCompare(newSelection);
		if (onSelectionChange) {
			onSelectionChange(newSelection);
		}
	};

	const handleSetAlert = () => {
		if (priceAlertItem && targetPrice && onSetPriceAlert) {
			onSetPriceAlert(priceAlertItem.id, Number.parseFloat(targetPrice));
			setPriceAlertItem(null);
			setTargetPrice("");
			setView("results");
		}
	};

	const handleExternalClick = (item: T, offer?: LayoutItemOffer) => {
		const hasExternalTarget = Boolean(offer?.url || item.url);
		if (!hasExternalTarget) return;
		// OpenAI handles external link confirmation, no need for our own flow
		if (onExternalRedirect) {
			onExternalRedirect(item, offer);
		}
	};

	return (
		<div
			data-llm={getDataLlmContext()}
			className={cn(
				"bg-background transition-all",
				// Fullscreen: fill viewport; Inline: auto-fit content (no fixed height)
				// Apps SDK guideline: "cards should auto-fit content"
				isInFullscreen ? "min-h-screen" : "w-full",
				className,
			)}
		>
			{/* Compact Header - single row with result count */}
			<div className="flex items-center justify-between gap-2 px-4 py-3">
				{/* Left: Brand name or result count */}
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex items-center gap-2">
						<span className="font-medium text-foreground text-sm">
							{totalResultsCount} result
							{totalResultsCount !== 1 ? "s" : ""}
						</span>
					</div>
					{batchMode && batchContext && (
						<span className="truncate text-muted-foreground text-xs">
							{batchContext}
						</span>
					)}
				</div>

				{/* Center: Inline search refinement */}
				{onRefineSearch && (
					<form
						className="flex flex-1 items-center gap-1.5"
						onSubmit={(e) => {
							e.preventDefault();
							const input = e.currentTarget.querySelector("input");
							if (input?.value.trim()) {
								onRefineSearch(input.value.trim());
							}
						}}
					>
						<input
							type="text"
							defaultValue={query ?? ""}
							placeholder="Refine search…"
							className="min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 py-1 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
							disabled={isRefining}
						/>
						<Button
							type="submit"
							size="sm"
							disabled={isRefining}
							className="shrink-0 gap-1"
						>
							{isRefining ? (
								<span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
							) : (
								<Search className="h-3.5 w-3.5" />
							)}
						</Button>
					</form>
				)}

				{/* Right: Fullscreen toggle */}
				<div className="flex shrink-0 items-center gap-2">
					{allowFullscreen && (
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={handleFullscreenToggle}
							aria-label={
								isInFullscreen ? "Exit fullscreen" : "Enter fullscreen"
							}
						>
							{isInFullscreen ? (
								<Minimize2 className="h-4 w-4" />
							) : (
								<Maximize2 className="h-4 w-4" />
							)}
						</Button>
					)}
				</div>
			</div>

			{/* Compare Bar (if items selected) */}
			{selectedForCompare.length > 0 && (
				<div className="border-border border-b bg-primary/10 px-4 py-2.5">
					<div className="mx-auto flex max-w-7xl items-center justify-between">
						<p className="font-medium text-sm">
							{resolvedStrings.selectedForComparison.replace(
								"{count}",
								String(selectedForCompare.length),
							)}
						</p>
						<div className="flex gap-2">
							<Button size="sm" onClick={() => setView("compare")}>
								{resolvedStrings.compareNow}
							</Button>
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									setSelectedForCompare([]);
									if (onSelectionChange) {
										onSelectionChange([]);
									}
								}}
							>
								{resolvedStrings.clear}
							</Button>
						</div>
					</div>
				</div>
			)}

			{/* Content Area */}
			{/* Apps SDK guideline: "No nested scrolling" in inline mode */}
			{/* Fullscreen can scroll since it's an immersive takeover */}
			<div
				className={cn(
					isInFullscreen && "h-[calc(100vh-140px)] overflow-y-auto",
				)}
			>
				<div className="mx-auto max-w-7xl p-4 sm:p-6">
					<AnimatePresence mode="wait">
						{/* Results View */}
						{view === "results" && (
							<motion.div
								key="results"
								initial={{ opacity: 0, x: -20 }}
								animate={{ opacity: 1, x: 0 }}
								exit={{ opacity: 0, x: 20 }}
							>
								{/* Batch Mode: Multi-row stacked carousels (Apps SDK compliant) */}
								{batchMode && processedGroups.length > 0 ? (
									<BatchModeMultiRow
										groups={processedGroups}
										renderResultCard={renderResultCard}
										renderDefaultPriceCard={renderDefaultPriceCard}
									/>
								) : processedResults.length === 0 ? (
									<LayoutEmpty
										icon={Search}
										title="No results found"
										description="Try adjusting your search or filter criteria"
									/>
								) : isInFullscreen ? (
									// FullscreenGallery for immersive browsing
									<FullscreenGallery
										items={processedResults}
										title={query ? `Results for "${query}"` : "Search Results"}
										onClose={handleFullscreenToggle}
										renderItem={(result) =>
											renderResultCard
												? renderResultCard(result)
												: renderDefaultPriceCard(result, false)
										}
									/>
								) : (
									// Carousel for inline mode with fullscreen button
									<div className="relative">
										<Carousel
											opts={{
												align: "start",
												loop: false,
											}}
											className="@container w-full"
											gap="1.25rem"
											onRequestFullscreen={
												allowFullscreen ? handleFullscreenToggle : undefined
											}
											showFullscreenButton={allowFullscreen}
										>
											<CarouselContent>
												<LayoutGroup id="comparison-carousel">
													{processedResults.map((result) => (
														<CarouselItem
															key={result.id}
															className="@[480px]:basis-1/3 @[768px]:basis-1/4 basis-1/2"
														>
															<motion.div
																layout
																layoutId={`carousel-item-${result.id}`}
																transition={LAYOUT_SPRING_TRANSITION}
															>
																{renderResultCard
																	? renderResultCard(result)
																	: renderDefaultPriceCard(result, true)}
															</motion.div>
														</CarouselItem>
													))}
												</LayoutGroup>
											</CarouselContent>
											<CarouselPrevious className="-left-4 hidden sm:flex" />
											<CarouselNext className="-right-4 hidden sm:flex" />
										</Carousel>
									</div>
								)}
							</motion.div>
						)}

						{/* Compare View */}
						{view === "compare" && (
							<motion.div
								key="compare"
								initial={{ opacity: 0, x: -20 }}
								animate={{ opacity: 1, x: 0 }}
								exit={{ opacity: 0, x: 20 }}
								className="space-y-4"
							>
								<div className="mb-4 flex items-center justify-between">
									<h2 className="font-bold text-xl">
										{resolvedStrings.comparingItems.replace(
											"{count}",
											String(selectedItems.length),
										)}
									</h2>
									<Button
										variant="outline"
										size="sm"
										onClick={() => setView("results")}
									>
										{resolvedStrings.backToResults}
									</Button>
								</div>

								{renderCompareTable ? (
									renderCompareTable(selectedItems)
								) : (
									<DefaultCompareTable
										items={selectedItems}
										currency={currency}
										locale={locale}
										noItemsSelectedText={resolvedStrings.noItemsSelected}
									/>
								)}

								{/* AI Comparison CTA - triggers AI host analysis */}
								{onRequestAIComparison && selectedItems.length > 0 && (
									<div className="mt-6 flex justify-center border-border border-t pt-6">
										<Button
											size="lg"
											onClick={() => onRequestAIComparison(selectedItems)}
											className="gap-2"
										>
											<Sparkles className="h-4 w-4" />
											{resolvedStrings.askAIToCompare}
										</Button>
									</div>
								)}
							</motion.div>
						)}

						{/* Price Alert View */}
						{view === "alert" && priceAlertItem && (
							<motion.div
								key="alert"
								initial={{ opacity: 0, scale: 0.95 }}
								animate={{ opacity: 1, scale: 1 }}
								exit={{ opacity: 0, scale: 0.95 }}
								className="mx-auto mt-12 max-w-md"
							>
								<div className="space-y-4 rounded-xl border border-border bg-card p-6">
									<div className="flex items-center gap-3">
										<div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
											<Bell className="h-6 w-6 text-primary" />
										</div>
										<div>
											<h3 className="font-semibold text-lg">Set Price Alert</h3>
											<p className="text-muted-foreground text-sm">
												Get notified when price drops
											</p>
										</div>
									</div>

									<div className="rounded-lg bg-muted p-3">
										<p className="font-medium text-sm">
											{priceAlertItem.title}
										</p>
										<p className="mt-1 text-muted-foreground text-xs">
											Current:{" "}
											{formatPrice(
												priceAlertItem.price?.amount,
												currency,
												locale,
											)}
										</p>
									</div>

									{renderPriceAlert ? (
										renderPriceAlert(priceAlertItem)
									) : (
										<>
											<div>
												<label className="mb-2 block font-medium text-sm">
													Target Price
												</label>
												<Input
													type="number"
													value={targetPrice}
													onChange={(e) => setTargetPrice(e.target.value)}
													placeholder="Enter target price"
												/>
											</div>

											<div className="flex gap-2">
												<Button
													block
													onClick={handleSetAlert}
													disabled={!targetPrice}
												>
													Set Alert
												</Button>
												<Button
													variant="outline"
													onClick={() => {
														setPriceAlertItem(null);
														setTargetPrice("");
														setView("results");
													}}
												>
													Cancel
												</Button>
											</div>
										</>
									)}
								</div>
							</motion.div>
						)}
					</AnimatePresence>
				</div>
			</div>

			{/* Product Detail Dialog - opens when clicking carousel item */}
			{!onRequestDetail && (
				<ProductDetailDialog
					item={detailItem}
					open={detailItem !== null}
					onClose={() => setDetailItem(null)}
					currency={currency}
					onExternalClick={
						onExternalRedirect
							? (item, offer) => {
									// Close dialog and trigger external redirect
									setDetailItem(null);
									onExternalRedirect(item as T, offer);
								}
							: undefined
					}
				/>
			)}

			{/* Floating Compare Bar for fullscreen mode */}
			{/* Rendered with z-[101] to appear above FullscreenGallery (z-[100]) */}
			{/* Hidden when already in compare view */}
			{isInFullscreen &&
				selectedForCompare.length > 0 &&
				view !== "compare" && (
					<div className="fixed right-0 bottom-0 left-0 z-[101] border-border border-t bg-background/95 px-4 py-3 backdrop-blur-sm">
						<div className="mx-auto flex max-w-7xl items-center justify-between">
							<p className="font-medium text-sm">
								{resolvedStrings.selectedForComparison.replace(
									"{count}",
									String(selectedForCompare.length),
								)}
							</p>
							<div className="flex gap-2">
								<Button size="sm" onClick={() => setView("compare")}>
									{resolvedStrings.compareNow}
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => {
										setSelectedForCompare([]);
										if (onSelectionChange) {
											onSelectionChange([]);
										}
									}}
								>
									{resolvedStrings.clear}
								</Button>
							</div>
						</div>
					</div>
				)}
		</div>
	);
}

ComparisonLayout.displayName = "ComparisonLayout";

// =============================================================================
// Default Renderers (Fallbacks)
// =============================================================================

interface DefaultCompareTableProps<T extends LayoutItem> {
	items: T[];
	currency: string;
	locale: string;
	/** Empty state text (defaults to "No items selected for comparison") */
	noItemsSelectedText?: string;
}

function DefaultCompareTable<T extends LayoutItem>({
	items,
	currency,
	locale,
	noItemsSelectedText = "No items selected for comparison",
}: DefaultCompareTableProps<T>) {
	if (items.length === 0) {
		return (
			<div className="py-12 text-center">
				<p className="text-muted-foreground">{noItemsSelectedText}</p>
			</div>
		);
	}

	const bestPrice = Math.min(...items.map((item) => item.price?.amount || 0));

	// Helper to get shipping display
	const getShippingDisplay = (item: T) => {
		// Structured field from upstream shopping MCP providers.
		if (item.shipping?.free || item.shipping?.cost === 0) {
			return <span className="font-medium text-success">Free</span>;
		}
		if (item.shipping?.cost != null) {
			return (
				<span>
					{currency}
					{item.shipping.cost.toFixed(2)}
				</span>
			);
		}
		return <span className="text-muted-foreground">—</span>;
	};

	// Helper to get delivery display
	const getDeliveryDisplay = (item: T) => {
		// Structured field from upstream shopping MCP providers.
		if (item.shipping?.minDays && item.shipping?.maxDays) {
			return item.shipping.minDays === item.shipping.maxDays
				? `${item.shipping.minDays} days`
				: `${item.shipping.minDays}-${item.shipping.maxDays} days`;
		}
		if (item.shipping?.maxDays) return `≤${item.shipping.maxDays} days`;
		if (item.shipping?.minDays) return `${item.shipping.minDays}+ days`;
		return "—";
	};

	// Helper to get stock display
	const getStockDisplay = (item: T) => {
		// Structured field from upstream shopping MCP providers.
		if (item.stock?.status) {
			switch (item.stock.status) {
				case "in_stock":
					return <CheckCircle className="mx-auto h-4 w-4 text-success" />;
				case "limited":
					return <span className="text-warning">Limited Stock</span>;
				case "out_of_stock":
					return <span className="text-destructive">Out of Stock</span>;
				default:
					return <span className="text-muted-foreground">—</span>;
			}
		}
		return <span className="text-muted-foreground">—</span>;
	};

	// Helper to get savings display
	const getSavingsDisplay = (item: T) => {
		if (item.savings?.percentage) {
			return (
				<span className="font-medium text-destructive">
					-{Math.round(item.savings.percentage)}%
				</span>
			);
		}
		if (item.savings?.amount) {
			return (
				<span className="font-medium text-destructive">
					-{currency}
					{item.savings.amount.toFixed(0)}
				</span>
			);
		}
		return <span className="text-muted-foreground">—</span>;
	};

	return (
		<div className="overflow-x-auto">
			<table className="w-full border-collapse">
				<thead>
					<tr className="border-border border-b">
						<th className="p-3 text-left font-semibold text-sm">Item</th>
						<LayoutGroup id="compare-table-header">
							{items.map((item) => (
								<motion.th
									key={item.id}
									layout
									layoutId={`compare-header-${item.id}`}
									transition={LAYOUT_SPRING_TRANSITION}
									className="p-3 text-center"
								>
									<div className="mx-auto mb-2 h-20 w-20 overflow-hidden rounded-lg bg-muted">
										{item.image && (
											<img
												src={item.image}
												alt={item.title}
												className="h-full w-full object-cover"
											/>
										)}
									</div>
									<p className="line-clamp-2 font-medium text-xs">
										{item.title}
									</p>
								</motion.th>
							))}
						</LayoutGroup>
					</tr>
				</thead>
				<LayoutGroup id="compare-table-body">
					<tbody>
						<tr className="border-border border-b">
							<td className="p-3 font-medium text-sm">Price</td>
							{items.map((item) => (
								<motion.td
									key={item.id}
									layout
									layoutId={`compare-price-${item.id}`}
									transition={LAYOUT_SPRING_TRANSITION}
									className={cn(
										"p-3 text-center font-bold",
										item.price?.amount === bestPrice && "text-success",
									)}
								>
									{formatPrice(item.price?.amount, currency, locale)}
									{item.price?.amount === bestPrice && (
										<div className="mt-1 font-normal text-success/80 text-xs">
											Best Price
										</div>
									)}
								</motion.td>
							))}
						</tr>
						<tr className="border-border border-b">
							<td className="p-3 font-medium text-sm">Savings</td>
							{items.map((item) => (
								<motion.td
									key={item.id}
									layout
									layoutId={`compare-savings-${item.id}`}
									transition={LAYOUT_SPRING_TRANSITION}
									className="p-3 text-center text-sm"
								>
									{getSavingsDisplay(item)}
								</motion.td>
							))}
						</tr>
						<tr className="border-border border-b">
							<td className="p-3 font-medium text-sm">Seller</td>
							{items.map((item) => (
								<motion.td
									key={item.id}
									layout
									layoutId={`compare-seller-${item.id}`}
									transition={LAYOUT_SPRING_TRANSITION}
									className="p-3 text-center text-sm"
								>
									{/* Prioritize best offer's merchant name over legacy seller field */}
									{item.offers?.[0]?.merchantName || item.seller?.name || "N/A"}
								</motion.td>
							))}
						</tr>
						<tr className="border-border border-b">
							<td className="p-3 font-medium text-sm">Rating</td>
							{items.map((item) => (
								<motion.td
									key={item.id}
									layout
									layoutId={`compare-rating-${item.id}`}
									transition={LAYOUT_SPRING_TRANSITION}
									className="p-3 text-center text-sm"
								>
									{item.rating ? (
										<div className="flex items-center justify-center gap-1">
											<Star className="h-3 w-3 fill-caution text-caution" />
											{item.rating.value.toFixed(1)}
										</div>
									) : (
										"N/A"
									)}
								</motion.td>
							))}
						</tr>
						<tr className="border-border border-b">
							<td className="p-3 font-medium text-sm">Shipping</td>
							{items.map((item) => (
								<motion.td
									key={item.id}
									layout
									layoutId={`compare-shipping-${item.id}`}
									transition={LAYOUT_SPRING_TRANSITION}
									className="p-3 text-center text-sm"
								>
									{getShippingDisplay(item)}
								</motion.td>
							))}
						</tr>
						<tr className="border-border border-b">
							<td className="p-3 font-medium text-sm">Delivery</td>
							{items.map((item) => (
								<motion.td
									key={item.id}
									layout
									layoutId={`compare-delivery-${item.id}`}
									transition={LAYOUT_SPRING_TRANSITION}
									className="p-3 text-center text-sm"
								>
									{getDeliveryDisplay(item)}
								</motion.td>
							))}
						</tr>
						<tr className="border-border border-b">
							<td className="p-3 font-medium text-sm">Stock</td>
							{items.map((item) => (
								<motion.td
									key={item.id}
									layout
									layoutId={`compare-stock-${item.id}`}
									transition={LAYOUT_SPRING_TRANSITION}
									className="p-3 text-center text-sm"
								>
									{getStockDisplay(item)}
								</motion.td>
							))}
						</tr>
						<tr className="border-border border-b">
							<td className="p-3 font-medium text-sm">Offers</td>
							{items.map((item) => (
								<motion.td
									key={item.id}
									layout
									layoutId={`compare-offers-${item.id}`}
									transition={LAYOUT_SPRING_TRANSITION}
									className="p-3 text-center text-sm"
								>
									{item.offerCount && item.offerCount > 0
										? `${item.offerCount} merchant${item.offerCount > 1 ? "s" : ""}`
										: "—"}
								</motion.td>
							))}
						</tr>
						{/* Features/Specs row - shows product specifications for comparison */}
						{items.some(
							(item) => item.features && item.features.length > 0,
						) && (
							<tr className="border-border border-b">
								<td className="p-3 align-top font-medium text-sm">Features</td>
								{items.map((item) => (
									<motion.td
										key={item.id}
										layout
										layoutId={`compare-features-${item.id}`}
										transition={LAYOUT_SPRING_TRANSITION}
										className="p-3 text-left text-xs"
									>
										{item.features && item.features.length > 0 ? (
											<div className="space-y-1">
												{item.features.slice(0, 5).map((feature) => (
													<div
														key={feature.label}
														className="flex items-start gap-1"
													>
														<span className="text-muted-foreground">
															{feature.label}:
														</span>
														<span className="font-medium">{feature.value}</span>
													</div>
												))}
												{item.features.length > 5 && (
													<span className="text-muted-foreground">
														+{item.features.length - 5} more
													</span>
												)}
											</div>
										) : (
											<span className="text-muted-foreground">—</span>
										)}
									</motion.td>
								))}
							</tr>
						)}
					</tbody>
				</LayoutGroup>
			</table>
		</div>
	);
}

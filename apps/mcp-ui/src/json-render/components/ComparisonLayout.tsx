import type { EventHandle } from "@json-render/react";
import { useBoundProp, useStateValue, useStateStore } from "@json-render/react";
import type { LayoutItemOfferSchemaType as LayoutItemOffer } from "@tedix/api-contract/schemas/layout";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@tedix/widget-ui/dialog";
import {
	type ComparisonVertical,
	type ComparisonWidgetState,
	type LayoutItem,
	type ListingGroup,
	ComparisonLayout as TedixComparisonLayout,
} from "@tedix/widget-ui/layouts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	useWidgetDisplayMode,
	useWidgetOpenExternal,
	useWidgetModal,
	useWidgetSendFollowUp,
	useWidgetSetOpenInAppUrl,
	useWidgetUser,
} from "../../lib/widget-host-hooks";
import type { UtmParams } from "../../lib/utm";
import { ItemDetailContent } from "../components/ItemDetailContent";

export interface ComparisonLayoutComponentProps {
	results?: LayoutItem[] | null;
	items?: LayoutItem[] | null;
	query?: string | null;
	batchMode?: boolean | null;
	listingGroups?: ListingGroup<LayoutItem>[] | null;
	batchContext?: string | null;
	currency?: string | null;
	vertical?: ComparisonVertical | null;
	hideFilters?: boolean | null;
	strings?: Record<string, unknown> | null;
	sortBy?: ComparisonWidgetState["sortBy"];
	filters?: ComparisonWidgetState["filters"];
	selectedIds?: string[] | null;
	allowFullscreen?: boolean | null;
	className?: string | null;
	metadata?: Record<string, unknown> | null;
	isLoading?: boolean | null;
	error?: string | null;
	errorTitle?: string | null;
	errorMessage?: string | null;
	emptyTitle?: string | null;
	emptyMessage?: string | null;
	comparePrompt?: string | null;
	widgetState?: ComparisonWidgetState | null;
	widgetStateBinding?: string;
	/** json-render event emitter (shorthand) */
	emit?: (event: string) => void;
	/** json-render event handle getter */
	on?: (event: string) => EventHandle;
}

function buildComparePrompt(
	template: string | null | undefined,
	query: string | null | undefined,
	items: LayoutItem[],
): string {
	const titles = items.map((item) => item.title).filter(Boolean);
	const fallback = query
		? `Compare these results for ${query}: ${titles.join(", ")}`
		: `Compare these results: ${titles.join(", ")}`;

	if (!template) return fallback;

	return template
		.replaceAll("{query}", query ?? "")
		.replaceAll("{count}", String(items.length))
		.replaceAll("{items}", titles.join(", "));
}

export function ComparisonLayoutComponent({
	results,
	items,
	query,
	batchMode,
	listingGroups,
	batchContext,
	currency,
	vertical,
	hideFilters,
	strings,
	sortBy,
	filters,
	selectedIds,
	allowFullscreen,
	className,
	metadata,
	isLoading,
	error,
	errorTitle,
	errorMessage,
	emptyTitle,
	emptyMessage,
	comparePrompt,
	widgetState,
	widgetStateBinding,
	emit,
	on,
}: ComparisonLayoutComponentProps) {
	const { set: setState } = useStateStore();
	const utmParams = useStateValue<UtmParams>("/_utmParams");
	const openExternal = useWidgetOpenExternal(utmParams);
	const sendFollowUp = useWidgetSendFollowUp();
	const [displayMode, requestDisplayMode] = useWidgetDisplayMode();
	const { locale } = useWidgetUser();
	const setOpenInAppUrl = useWidgetSetOpenInAppUrl();

	const detailTemplate = useStateValue<string>("/_detailTemplate");
	const modal = useWidgetModal();

	const [detailItem, setDetailItem] = useState<LayoutItem | null>(null);

	// Check which events are bound in the spec (enables fallback behavior)
	const externalRedirectEvent = on?.("externalRedirect");
	const requestComparisonEvent = on?.("requestComparison");
	const requestDetailEvent = on?.("requestDetail");
	const displayModeChangeEvent = on?.("displayModeChange");

	const [boundWidgetState, setBoundWidgetState] =
		useBoundProp<ComparisonWidgetState | null>(
			widgetState ?? null,
			widgetStateBinding,
		);
	const [localWidgetState, setLocalWidgetState] =
		useState<ComparisonWidgetState>(widgetState ?? {});

	useEffect(() => {
		if (boundWidgetState) {
			setLocalWidgetState(boundWidgetState);
		}
	}, [boundWidgetState]);

	const handleWidgetStateChange = useCallback(
		(next: ComparisonWidgetState) => {
			setLocalWidgetState(next);
			setBoundWidgetState(next);
		},
		[setBoundWidgetState],
	);

	// -- Callbacks: use json-render events when bound, fallback to direct hooks --

	const handleExternalRedirect = useCallback(
		(item: LayoutItem, offer?: LayoutItemOffer) => {
			const href = offer?.url ?? item.url;
			if (!href) return;
			if (externalRedirectEvent?.bound && emit) {
				setState("/_event/externalRedirect", { url: href, item, offer });
				emit("externalRedirect");
				return;
			}
			openExternal(href);
		},
		[externalRedirectEvent?.bound, emit, setState, openExternal],
	);

	const handleRequestAIComparison = useCallback(
		(selectedItems: LayoutItem[]) => {
			const prompt = buildComparePrompt(comparePrompt, query, selectedItems);
			if (!prompt.trim()) return;
			if (requestComparisonEvent?.bound && emit) {
				setState("/_event/requestComparison", {
					query: prompt,
					items: selectedItems,
				});
				emit("requestComparison");
				return;
			}
			void sendFollowUp(prompt).catch((error) =>
				console.error("Widget follow-up failed:", error),
			);
		},
		[
			requestComparisonEvent?.bound,
			emit,
			setState,
			comparePrompt,
			query,
			sendFollowUp,
		],
	);

	const handleRequestDetail = useCallback(
		(item: LayoutItem) => {
			if (requestDetailEvent?.bound && emit) {
				setState("/_event/requestDetail", { item });
				emit("requestDetail");
				return;
			}
			if (detailTemplate && modal.open) {
				void Promise.resolve()
					.then(() =>
						modal.open!({
							template: detailTemplate,
							params: { _detailItem: item },
							title: item.title ?? "Details",
						}),
					)
					.catch(() => setDetailItem(item));
			} else {
				setDetailItem(item);
			}
		},
		[requestDetailEvent?.bound, emit, setState, detailTemplate, modal],
	);

	const handleDisplayModeChange = useCallback(
		(mode: string) => {
			if (displayModeChangeEvent?.bound && emit) {
				setState("/_event/displayModeChange", { mode });
				emit("displayModeChange");
				return;
			}
			void requestDisplayMode(mode).catch((error) =>
				console.error("Widget display-mode request failed:", error),
			);
		},
		[displayModeChangeEvent?.bound, emit, setState, requestDisplayMode],
	);

	const effectiveResults = results ?? items ?? [];
	const effectiveWidgetState = boundWidgetState ?? localWidgetState;
	const comparisonDisplayMode =
		displayMode === "fullscreen" || displayMode === "modal"
			? "fullscreen"
			: "inline";

	// Surface "Open in App" URL in ChatGPT when results are available
	const openInAppUrlSet = useRef(false);
	useEffect(() => {
		if (effectiveResults.length > 0 && !openInAppUrlSet.current) {
			openInAppUrlSet.current = true;
			const firstUrl = effectiveResults[0]?.url;
			if (firstUrl) {
				setOpenInAppUrl(firstUrl);
			}
		}
	}, [effectiveResults, setOpenInAppUrl]);

	return (
		<>
			<TedixComparisonLayout
				results={effectiveResults}
				query={query ?? undefined}
				batchMode={batchMode ?? undefined}
				listingGroups={listingGroups ?? undefined}
				batchContext={batchContext ?? undefined}
				currency={currency ?? undefined}
				locale={locale}
				vertical={vertical ?? undefined}
				hideFilters={hideFilters ?? undefined}
				strings={strings as never}
				sortBy={sortBy}
				filters={filters}
				selectedIds={selectedIds ?? undefined}
				allowFullscreen={allowFullscreen ?? undefined}
				className={className ?? undefined}
				metadata={metadata ?? undefined}
				isLoading={isLoading ?? undefined}
				error={error ?? undefined}
				errorTitle={errorTitle ?? undefined}
				errorMessage={errorMessage ?? undefined}
				emptyTitle={emptyTitle ?? undefined}
				emptyMessage={emptyMessage ?? undefined}
				onRequestDetail={handleRequestDetail}
				displayMode={comparisonDisplayMode}
				onDisplayModeChange={handleDisplayModeChange}
				onWidgetStateChange={handleWidgetStateChange}
				widgetState={effectiveWidgetState}
				onExternalRedirect={handleExternalRedirect}
				onRequestAIComparison={handleRequestAIComparison}
			/>

			<Dialog
				open={!!detailItem}
				onOpenChange={(open) => {
					if (!open) setDetailItem(null);
				}}
			>
				<DialogContent size="lg" mobileBottomSheet>
					<DialogHeader>
						<DialogTitle>{detailItem?.title ?? "Details"}</DialogTitle>
					</DialogHeader>
					{detailItem && <ItemDetailContent item={detailItem} />}
				</DialogContent>
			</Dialog>
		</>
	);
}

/**
 * Item Detail Widget — standalone React component for host modal detail views.
 *
 * Data flow:
 * 1. Inline widget calls requestModal({ template, params: { _detailItem } })
 * 2. Host opens this page as a modal iframe with params available via view context
 * 3. This component reads _detailItem from useRequestModal().params
 * 4. Falls back to widgetState._detailItem for restored modal state
 */

import { WidgetWrapper } from "../../components/WidgetWrapper";
import {
	useWidgetModal,
	useWidgetViewState,
} from "../../lib/widget-host-hooks";
import { ItemDetailContent } from "./ItemDetailContent";

function ItemDetailWidgetInner() {
	const { params: modalParams } = useWidgetModal();
	const [widgetState] = useWidgetViewState<Record<string, unknown>>({});
	const item =
		(modalParams?._detailItem as Record<string, unknown>) ??
		(widgetState?._detailItem as Record<string, unknown>);

	if (!item) {
		return (
			<div className="mx-auto max-w-2xl p-8 text-center text-muted-foreground">
				<div className="space-y-3">
					<div className="h-48 animate-pulse rounded-lg bg-muted" />
					<div className="mx-auto h-6 w-2/3 animate-pulse rounded bg-muted" />
					<div className="mx-auto h-4 w-1/2 animate-pulse rounded bg-muted" />
				</div>
			</div>
		);
	}

	return (
		<div className="mx-auto max-w-2xl bg-background p-4 font-sans text-foreground">
			<ItemDetailContent item={item} />
		</div>
	);
}

export function ItemDetailWidget() {
	return (
		<WidgetWrapper>
			<ItemDetailWidgetInner />
		</WidgetWrapper>
	);
}

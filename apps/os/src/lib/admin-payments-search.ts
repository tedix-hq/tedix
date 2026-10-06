import type { SearchSchemaInput } from "@tanstack/react-router";

/**
 * URL state for /admin/payments. The ledger filters, the spend window, and
 * the open receipt live in the search string — shareable, back/forward-
 * correct, prefetchable — never in component state. Invalid values degrade to
 * the default view instead of blocking the navigation.
 *
 * Hand-guarded rather than zod, like `audit-search.ts`: this module is
 * reachable from the route config in the shared entry chunk, and every field
 * here is a literal set or a bounded string.
 *
 * The contract-input builders live beside the schema so the route loader and
 * the mounted surface construct byte-identical inputs — a generated query key
 * encodes the complete input, so any drift would make the loader warm an
 * entry the page never reads.
 */

/** The bounded ledger read. */
export const PAYMENT_EVENTS_LIMIT = 100;
/** Spend summary rows per window. */
export const PAYMENT_SUMMARY_LIMIT = 50;
/** Budget policies are a short administrative list. */
export const PAYMENT_POLICIES_LIMIT = 100;

export const PAYMENT_WINDOW_HOURS = [24, 168, 720, 2160] as const;
export type PaymentWindowHours = (typeof PAYMENT_WINDOW_HOURS)[number];

export const PAYMENT_STATUS_FILTERS = [
	"all",
	"required",
	"settled",
	"rejected",
] as const;
export type PaymentStatusFilter = (typeof PAYMENT_STATUS_FILTERS)[number];

export type AdminPaymentsSearch = {
	hours: PaymentWindowHours;
	status: PaymentStatusFilter;
	app?: string;
	tool?: string;
	tedi?: string;
	/** The receipt sheet's open state; only settled events carry one. */
	receipt?: string;
};

/** Free-text filters mirror the contract's own 200-char input bounds. */
function textParam(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" && value.length <= 200
		? value
		: undefined;
}

export function validateAdminPaymentsSearch(
	search: Partial<AdminPaymentsSearch> & SearchSchemaInput,
): AdminPaymentsSearch {
	const raw = search as Record<string, unknown>;
	const hours = PAYMENT_WINDOW_HOURS.find((value) => value === raw.hours) ?? 24;
	const status =
		PAYMENT_STATUS_FILTERS.find((value) => value === raw.status) ?? "all";
	const app = textParam(raw.app);
	const tool = textParam(raw.tool);
	const tedi = textParam(raw.tedi);
	const receipt = textParam(raw.receipt);
	return {
		hours,
		status,
		...(app !== undefined ? { app } : {}),
		...(tool !== undefined ? { tool } : {}),
		...(tedi !== undefined ? { tedi } : {}),
		...(receipt !== undefined ? { receipt } : {}),
	};
}

const UUID_PARAM =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The contract's `tediId` is `z.uuid()`; a free-typed non-UUID would 400
 * server-side, so it is dropped from the request (the page still shows what
 * was typed and says the value is not a tedi id).
 */
export function paymentsTediFilter(search: {
	tedi?: string;
}): string | undefined {
	const tedi = search.tedi?.trim();
	return tedi && UUID_PARAM.test(tedi) ? tedi : undefined;
}

function sharedFilters(search: AdminPaymentsSearch): {
	appSlug?: string;
	toolId?: string;
	tediId?: string;
} {
	const appSlug = search.app?.trim();
	const toolId = search.tool?.trim();
	const tediId = paymentsTediFilter(search);
	return {
		...(appSlug ? { appSlug } : {}),
		...(toolId ? { toolId } : {}),
		...(tediId ? { tediId } : {}),
	};
}

export function paymentsEventsInput(search: AdminPaymentsSearch): {
	limit: number;
	status?: Exclude<PaymentStatusFilter, "all">;
	appSlug?: string;
	toolId?: string;
	tediId?: string;
} {
	return {
		limit: PAYMENT_EVENTS_LIMIT,
		...(search.status === "all" ? {} : { status: search.status }),
		...sharedFilters(search),
	};
}

export function paymentsSummaryInput(search: AdminPaymentsSearch): {
	lastHours: number;
	limit: number;
	appSlug?: string;
	toolId?: string;
	tediId?: string;
} {
	return {
		lastHours: search.hours,
		limit: PAYMENT_SUMMARY_LIMIT,
		...sharedFilters(search),
	};
}

export function paymentsPoliciesInput(search: AdminPaymentsSearch): {
	limit: number;
	appSlug?: string;
	toolId?: string;
	tediId?: string;
} {
	return {
		limit: PAYMENT_POLICIES_LIMIT,
		...sharedFilters(search),
	};
}

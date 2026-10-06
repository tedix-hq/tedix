import {
	fetchNamedTenantConnectionToken,
	fetchPersonalConnectionToken,
} from "@tedix/auth/connections";
import {
	getConnectionInstance,
	listConnectionInstances,
} from "@tedix/db/queries/connection-instances";
import { listConnectionProviders } from "@tedix/db/queries/connection-providers";
import { getOrganizationDescopeTenantId } from "@tedix/db/queries/organizations";
import type { BaseContext } from "../../rpc/orpc";
import { googleCalendarAdapter } from "./google";
import { microsoftCalendarAdapter } from "./microsoft";
import type { AdapterKind, CalendarRoute } from "./types";
type Selection = Pick<
	CalendarRoute,
	"adapter" | "providerId" | "connectionScope" | "connectionInstanceId"
>;
export function calendarOwnerUser(context: BaseContext): string {
	if (context.authType !== "user" || !context.user?.sub)
		throw new Error(
			"Interactive calendar operation requires the signed-in account owner",
		);
	return context.user.sub;
}
/** Classification belongs to the canonical provider registry, never an editable account label. */
export async function supportedCalendarAccounts(
	context: BaseContext,
	organizationId: string,
	scope: "tenant" | "user",
) {
	const owner =
		scope === "user"
			? { userId: calendarOwnerUser(context) }
			: { organizationId };
	const providers = await listConnectionProviders(context.db);
	const classify = (providerId: string): AdapterKind | null => {
		const p = providers.find(
			(p) =>
				p.descopeAppId === providerId ||
				p.descopeAppAliases?.includes(providerId),
		);
		return p?.id === "google-calendar"
			? "google"
			: p?.id === "microsoft-graph-calendar-tedix"
				? "microsoft"
				: null;
	};
	return (await listConnectionInstances(context.db, owner)).flatMap(
		(instance) => {
			const adapter = classify(instance.providerId);
			return adapter && instance.tokenIds.length
				? [
						{
							adapter,
							providerId: instance.providerId,
							connectionScope: scope,
							connectionInstanceId: instance.id,
							instanceLabel: instance.label,
							accountSubject: instance.tokenSub,
						},
					]
				: [];
		},
	);
}
export async function resolveCalendarAdapter(
	context: BaseContext,
	organizationId: string,
	selection: Selection,
	execution = false,
) {
	if (execution && selection.connectionScope === "user")
		throw new Error(
			"Personal calendar background execution requires an explicit revocable delegation",
		);
	if (!selection.connectionInstanceId)
		throw new Error("Exact named account is required");
	const accounts = await supportedCalendarAccounts(
		context,
		organizationId,
		selection.connectionScope,
	);
	const account = accounts.find(
		(a) =>
			a.connectionInstanceId === selection.connectionInstanceId &&
			a.providerId === selection.providerId &&
			a.adapter === selection.adapter,
	);
	if (!account)
		throw new Error(
			"Calendar account is unavailable or adapter does not match the canonical provider",
		);
	const owner =
		selection.connectionScope === "user"
			? { userId: calendarOwnerUser(context) }
			: { organizationId };
	const instance = await getConnectionInstance(
		context.db,
		owner,
		selection.connectionInstanceId,
		selection.providerId,
	);
	if (!instance?.tokenIds.length || !instance.tokenSub)
		throw new Error("Account identity has not been verified");
	const externalIdentifier = `tedix_${instance.id}`;
	const token =
		selection.connectionScope === "user"
			? await fetchPersonalConnectionToken(context.env, {
					appId: selection.providerId,
					userId: calendarOwnerUser(context),
					externalIdentifier,
				})
			: await fetchNamedTenantConnectionToken(context.env, {
					appId: selection.providerId,
					tenantId:
						(await getOrganizationDescopeTenantId(
							context.db,
							organizationId,
						)) ?? "",
					externalIdentifier,
				});
	if (
		!token ||
		!token.id ||
		!instance.tokenIds.includes(token.id) ||
		token.tokenSub !== instance.tokenSub
	)
		throw new Error(
			"Named calendar credential identity changed or is unavailable",
		);
	const scopes = token.scopes ?? [];
	const canWrite =
		selection.adapter === "google"
			? scopes.some((s) =>
					[
						"https://www.googleapis.com/auth/calendar",
						"https://www.googleapis.com/auth/calendar.events",
					].includes(s),
				)
			: scopes.some((s) => /(^|\/)Calendars\.ReadWrite$/i.test(s));
	const underlying =
		selection.adapter === "google"
			? googleCalendarAdapter(token.accessToken)
			: microsoftCalendarAdapter(token.accessToken);
	return {
		account,
		adapter: {
			...underlying,
			async listCalendars() {
				return (await underlying.listCalendars()).map((c) => ({
					...c,
					canWrite: c.canWrite && canWrite,
				}));
			},
			async snapshot(
				route: CalendarRoute,
				window: { start: string; end: string },
			) {
				const snapshot = await underlying.snapshot(route, window);
				return {
					...snapshot,
					calendar: {
						...snapshot.calendar,
						canWrite: snapshot.calendar.canWrite && canWrite,
					},
				};
			},
			async create(
				route: CalendarRoute,
				action: Parameters<typeof underlying.create>[1],
			) {
				if (!canWrite) throw new Error("Calendar credential lacks write scope");
				return underlying.create(route, action);
			},
			async update(
				route: CalendarRoute,
				action: Parameters<typeof underlying.update>[1],
			) {
				if (!canWrite) throw new Error("Calendar credential lacks write scope");
				return underlying.update(route, action);
			},
			async remove(
				route: CalendarRoute,
				action: Parameters<typeof underlying.remove>[1],
			) {
				if (!canWrite) throw new Error("Calendar credential lacks write scope");
				return underlying.remove(route, action);
			},
		},
	};
}

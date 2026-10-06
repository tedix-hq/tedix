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
import { createError, ErrorCodes, type BaseContext } from "../../rpc/orpc";
import { googleCalendarAdapter } from "./google";
import { microsoftCalendarAdapter } from "./microsoft";
import type {
	AdapterKind,
	CalendarRoute,
	CalendarAdapter,
	Configuration,
} from "./types";
type Selection = Partial<
	Pick<CalendarRoute, "workspaceResourceId" | "delegationId" | "calendarId">
> &
	Pick<
		CalendarRoute,
		"adapter" | "providerId" | "connectionScope" | "connectionInstanceId"
	>;
export function calendarOwnerUser(context: BaseContext): string {
	if (context.authType !== "user" || context.tediId || !context.user?.sub)
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
	authority?: Pick<
		Configuration,
		"workspaceId" | "tediId" | "skillId" | "skillRevision" | "ownerUserId"
	>,
) {
	if (
		execution &&
		selection.connectionScope === "user" &&
		context.authType !== "user"
	) {
		if (
			!authority ||
			!selection.delegationId ||
			!selection.workspaceResourceId ||
			!selection.calendarId
		)
			throw new Error(
				"Personal calendar background execution requires an explicit revocable delegation",
			);
		const {
			authorizePersonalResourceDelegation,
			validatePersonalDelegationToken,
		} = await import("../personal-resource-delegation-authority");
		const toolId = context.headers.get("X-Tedix-Mcp-Tool-Id");
		if (!toolId)
			throw new Error(
				"Personal calendar execution requires trusted workflow tool provenance",
			);
		const providers = await listConnectionProviders(context.db);
		const definition = providers.find(
			(p) =>
				p.descopeAppId === selection.providerId ||
				p.descopeAppAliases?.includes(selection.providerId),
		);
		if (
			definition?.id !==
			(selection.adapter === "google"
				? "google-calendar"
				: "microsoft-graph-calendar-tedix")
		)
			throw new Error("Calendar adapter differs from the canonical provider");
		const requiredScopes =
			selection.adapter === "google"
				? [
						"https://www.googleapis.com/auth/calendar.events",
						"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
					]
				: ["Calendars.ReadWrite"];
		const fresh = async (operation: string) => {
			const use = {
				delegationId: selection.delegationId!,
				tediId: authority.tediId,
				skillId: authority.skillId,
				skillRevision: authority.skillRevision,
				workspaceId: authority.workspaceId,
				resourceId: selection.workspaceResourceId!,
				providerId: selection.providerId,
				connectionInstanceId: selection.connectionInstanceId,
				operation,
				toolId,
				providerResourceId: selection.calendarId!,
				requiredScopes,
			};
			const grant = await authorizePersonalResourceDelegation(context, use);
			if (grant.ownerUserId !== authority.ownerUserId)
				throw new Error(
					"Personal delegation owner differs from the configuration owner",
				);
			const token = await fetchPersonalConnectionToken(context.env, {
				appId: selection.providerId,
				userId: grant.ownerUserId,
				externalIdentifier: `tedix_${grant.connectionInstanceId}`,
				scopes: grant.delegation.requiredScopes,
			});
			if (!token)
				throw new Error("Exact delegated calendar credential is unavailable");
			validatePersonalDelegationToken(
				grant.delegation,
				token,
				grant.approvedTokenIds,
				token.id,
			);
			const current = await authorizePersonalResourceDelegation(context, use);
			if (current.ownerUserId !== authority.ownerUserId)
				throw new Error(
					"Personal delegation owner changed during credential lookup",
				);
			validatePersonalDelegationToken(
				current.delegation,
				token,
				current.approvedTokenIds,
				token.id,
			);
			return token;
		};
		const initial = await fresh("read");
		const adapterFor = async (operation: string) => {
			const token = await fresh(operation);
			const authorize = async () => (await fresh(operation)).accessToken;
			return selection.adapter === "google"
				? googleCalendarAdapter(token.accessToken, authorize)
				: microsoftCalendarAdapter(token.accessToken, authorize);
		};
		const assertRoute = (r: CalendarRoute) => {
			if (
				r.providerId !== selection.providerId ||
				r.connectionInstanceId !== selection.connectionInstanceId ||
				r.calendarId !== selection.calendarId ||
				r.workspaceResourceId !== selection.workspaceResourceId ||
				r.connectionScope !== "user" ||
				r.adapter !== selection.adapter
			)
				throw new Error(
					"Calendar operation differs from the delegated resource",
				);
		};
		const useAdapter = async (operation: string, r: CalendarRoute) => {
			assertRoute(r);
			return adapterFor(operation);
		};
		const adapter: CalendarAdapter = {
			kind: selection.adapter,
			conditionalWrites: true,
			removalMode: selection.adapter === "microsoft" ? "release" : "delete",
			listCalendars: async () => {
				throw new Error(
					"Background calendar inventory is not a selected resource operation",
				);
			},
			snapshot: async (r, w) => (await useAdapter("read", r)).snapshot(r, w),
			get: async (r, id) => (await useAdapter("read", r)).get(r, id),
			findOwned: async (r, m, w) =>
				(await useAdapter("read", r)).findOwned(r, m, w),
			create: async (r, a) => (await useAdapter("create", r)).create(r, a),
			update: async (r, a) => (await useAdapter("update", r)).update(r, a),
			remove: async (r, a) => (await useAdapter("delete", r)).remove(r, a),
		};
		return {
			account: {
				adapter: selection.adapter,
				providerId: selection.providerId,
				connectionScope: selection.connectionScope,
				connectionInstanceId: selection.connectionInstanceId,
				instanceLabel: "",
				accountSubject: initial.tokenSub ?? null,
			},
			adapter,
		};
	}
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
		throw createError(
			ErrorCodes.CONFLICT,
			"This calendar account needs identity verification before its calendars can be read. Open Connections to verify this account.",
		);
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

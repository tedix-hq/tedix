import { buildBrokerStartPath } from "@/shared/session-status";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
	CliLoginPermissions,
	defaultCliLoginScopes,
} from "@/account/cli-login-permissions";
import { Checkbox } from "@/components/kumo/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Card } from "@/components/kumo/card";
import { CodeInline } from "@/components/kumo/code";
import { Empty } from "@/components/kumo/empty";
import { Link } from "@/components/kumo/link";
import { Input } from "@/components/kumo/input";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { OrganizationOnboardingForm } from "@/account/organization-launcher-page";
import { cliWorkspacesDirectoryQueryOptions } from "@/account/query-options";
import { osApi } from "@/lib/api";
import {
	buildCliLoginBrokerTarget,
	buildCliLoginReturnTarget,
} from "@/account/cli-login-return";
import { useOsOnboardingState } from "@/account/use-os-onboarding-state";
import { useOsIdentity } from "@/lib/use-os-identity";
import { IdentityJourneyFrame } from "@/account/identity-journey";
import { IDENTITY_JOURNEY_COPY } from "@/shared/identity-journey-copy";

/**
 * `os.tedix.dev/cli/login` — the standalone "authorize the CLI" page that
 * finishes a `tedix login`. It renders OUTSIDE the OS shell (no nav/chrome): a
 * `tedix login` is a focused, one-purpose auth handshake, the way GitHub,
 * Vercel, and Supabase render CLI/device authorization on a dedicated page
 * rather than inside the product app.
 *
 * The CLI opens this behind Descope auth (the SPA's session boundary handles
 * sign-in) with `?port=<loopback>&state=<uuid>`, the operator picks one of their
 * organizations, and we hand the choice back to the CLI's local callback at
 * `127.0.0.1:<port>/workspace`. The gateway URL itself is resolved CLI-side from
 * the slug via the public `cli-workspace` endpoint, so this page only needs to
 * return a validated slug.
 */
export function CliLoginPage() {
	const identity = useOsIdentity();
	const {
		port,
		requestedOrganization,
		selectedOrganization,
		selectedTenant,
		batchSelections,
		returnScopes,
		state,
	} = useMemo(() => {
		const params = new URLSearchParams(window.location.search);
		return {
			port: params.get("port"),
			requestedOrganization: params.get("organization")?.trim().toLowerCase(),
			selectedOrganization: params
				.get("selected_organization")
				?.trim()
				.toLowerCase(),
			selectedTenant: params.get("selected_tenant")?.trim(),
			batchSelections: params
				.getAll("batch_org")
				.map((organization, index) => ({
					organization,
					tenant: params.getAll("batch_tenant")[index] ?? "",
				})),
			returnScopes: params.getAll("scope"),
			state: params.get("state"),
		};
	}, []);
	const logoutHref = useMemo(
		() =>
			buildBrokerStartPath("/cli/session-broker", {
				operation: "logout",
				redirectTo: `${window.location.pathname}${window.location.search}`,
			}),
		[],
	);

	const [redirectingSlug, setRedirectingSlug] = useState<string | null>(null);
	const [step, setStep] = useState<"permissions" | "organizations">(
		"permissions",
	);
	const [scopes, setScopes] = useState(defaultCliLoginScopes);
	const [selectedSlugs, setSelectedSlugs] = useState<string[]>([]);
	const [organizationSearch, setOrganizationSearch] = useState("");
	const [error, setError] = useState<string | null>(null);
	const hasCallback = Boolean(port && state);
	const onboarding = useOsOnboardingState({ enabled: hasCallback });
	const [requestedOrganizationHandled, setRequestedOrganizationHandled] =
		useState(false);

	const organizations = useQuery({
		...cliWorkspacesDirectoryQueryOptions(),
		// Do not expose a placeholder personal organization to the CLI. A fresh
		// account first completes the same central OS onboarding as the launcher.
		enabled: hasCallback && onboarding.isReady,
	});
	const items = useMemo(
		() => organizations.data?.data ?? [],
		[organizations.data],
	);

	useEffect(() => {
		if (
			!requestedOrganization ||
			requestedOrganizationHandled ||
			!organizations.isSuccess
		) {
			return;
		}
		setRequestedOrganizationHandled(true);
		if (selectedOrganization && selectedTenant) {
			const selected = items.find(
				(workspace) =>
					workspace.org.slug === selectedOrganization &&
					workspace.org.descopeTenantId === selectedTenant &&
					workspace.org.provisionComplete,
			);
			const selections =
				batchSelections.length > 0
					? batchSelections
					: [{ organization: selectedOrganization, tenant: selectedTenant }];
			const allSelectedAreMembers = selections.every((choice) =>
				items.some(
					(workspace) =>
						workspace.org.slug === choice.organization &&
						workspace.org.descopeTenantId === choice.tenant &&
						workspace.org.provisionComplete,
				),
			);
			const target =
				selected && allSelectedAreMembers
					? buildCliLoginReturnTarget({
							port,
							state,
							organization: selectedOrganization,
							tenant: selectedTenant,
							selections,
							...(returnScopes.length ? { scopes: returnScopes } : {}),
						})
					: null;
			if (!target) {
				setError(
					"The selected organization is no longer available to this account.",
				);
				return;
			}
			setRedirectingSlug(selectedOrganization);
			window.location.replace(target);
			return;
		}
		const requested = items.find(
			(workspace) =>
				workspace.org.slug === requestedOrganization &&
				workspace.org.provisionComplete &&
				workspace.org.descopeTenantId,
		);
		if (!requested?.org.descopeTenantId) {
			setError(
				`Organization "${requestedOrganization}" is not available to this account.`,
			);
			return;
		}
		const target = buildCliLoginBrokerTarget({
			port,
			state,
			organization: requested.org.slug,
			tenant: requested.org.descopeTenantId,
		});
		if (!target) {
			setError(
				"This sign-in link is malformed or expired. Re-run `tedix login` in your terminal.",
			);
			return;
		}
		setRedirectingSlug(requested.org.slug);
		window.location.replace(target);
	}, [
		items,
		batchSelections,
		organizations.isSuccess,
		port,
		requestedOrganization,
		requestedOrganizationHandled,
		returnScopes,
		selectedOrganization,
		selectedTenant,
		state,
	]);

	// Opened without the CLI's callback params (e.g. someone browsed here): this
	// page cannot complete a login on its own, so guide them back to the CLI.
	if (!port || !state) {
		return (
			<IdentityJourneyFrame
				kind="cli"
				eyebrow="TEDIX CLI"
				title="Finish this from your terminal"
				description="This page completes a Tedix CLI login and needs a state-bound request from your terminal."
			>
				<Text role="control" tone="secondary" className="mt-4">
					Run <CodeInline>tedix login</CodeInline> in your terminal. It will
					reopen this page with everything needed to continue safely.
				</Text>
			</IdentityJourneyFrame>
		);
	}

	function choose(slug: string, tenant: string) {
		const target = buildCliLoginBrokerTarget({
			port,
			state,
			organization: slug,
			tenant,
		});
		if (!target) {
			setError(
				"This sign-in link is malformed or expired. Re-run `tedix login` in your terminal.",
			);
			return;
		}
		setRedirectingSlug(slug);
		// Select the membership-validated tenant through the central refresh owner
		// before returning to the CLI. The callback revalidates the selection
		// against this directory before the loopback handoff.
		window.location.replace(target);
	}

	function chooseSelected() {
		const selections = selectedSlugs.flatMap((slug) => {
			const org = items.find((item) => item.org.slug === slug)?.org;
			return org?.provisionComplete && org.descopeTenantId
				? [{ organization: org.slug, tenant: org.descopeTenantId }]
				: [];
		});
		const first = selections[0];
		if (
			!first ||
			selections.length !== selectedSlugs.length ||
			scopes.length === 0
		)
			return;
		const target = buildCliLoginBrokerTarget({
			port,
			state,
			...first,
			selections,
			scopes,
		});
		if (!target) {
			setError(
				"This sign-in link is malformed or expired. Re-run `tedix login` in your terminal.",
			);
			return;
		}
		setRedirectingSlug(first.organization);
		window.location.replace(target);
	}

	if (onboarding.isLoading) {
		return (
			<IdentityJourneyFrame
				kind="cli"
				eyebrow="TEDIX CLI"
				title="Preparing your workspace"
				description="Tedix Identity is checking your account and organization memberships."
				loading
			>
				<ListSkeleton />
			</IdentityJourneyFrame>
		);
	}

	if (onboarding.error) {
		return (
			<IdentityJourneyFrame
				kind="cli"
				eyebrow="TEDIX CLI"
				title="Could not prepare your workspace"
				description="Tedix Identity could not finish the account setup required by this CLI request."
			>
				<Alert variant="destructive">
					<AlertTitle>Workspace setup failed</AlertTitle>
					<AlertDescription>
						{onboarding.error instanceof Error
							? onboarding.error.message
							: "Refresh to retry the first-run setup."}
					</AlertDescription>
				</Alert>
			</IdentityJourneyFrame>
		);
	}

	if (onboarding.onboardingOwner) {
		return (
			<OrganizationOnboardingForm
				email={identity.email}
				organization={{
					id: onboarding.onboardingOwner.organizationId,
					name: onboarding.onboardingOwner.organizationName,
					slug: onboarding.onboardingOwner.organizationSlug,
				}}
				localEvaluation={false}
				completionTarget="cli"
				onComplete={async (organization) => {
					try {
						const workspace = await osApi.directory.resolveWorkspace({
							organizationId: organization.id,
						});
						const tenant = workspace?.org.descopeTenantId;
						if (!tenant) throw new Error("missing tenant binding");
						choose(organization.slug, tenant);
					} catch {
						setError("Your workspace is not ready for CLI authorization yet.");
					}
				}}
			/>
		);
	}

	const redirecting = redirectingSlug !== null;
	const selectingMultiple = !requestedOrganization;
	const selectableItems = items.filter(
		(item) => item.org.provisionComplete && item.org.descopeTenantId,
	);
	const visibleItems =
		selectingMultiple && organizationSearch.trim()
			? items.filter((item) =>
					`${item.org.name} ${item.org.slug}`
						.toLowerCase()
						.includes(organizationSearch.trim().toLowerCase()),
				)
			: items;

	return (
		<IdentityJourneyFrame
			kind="cli"
			eyebrow="TEDIX CLI"
			title={
				selectingMultiple && step === "permissions"
					? "Choose CLI permissions"
					: "Choose organizations"
			}
			description={
				selectingMultiple
					? "Review the access the CLI will request, then choose the organizations that may grant it."
					: IDENTITY_JOURNEY_COPY.workspaceSelection.description
			}
		>
			{identity.email ? (
				<Surface className="mt-3.5 px-3 py-2.5">
					<Text role="control" tone="secondary">
						Signed in as{" "}
						<Text as="span" role="control" weight="semibold">
							{identity.email}
						</Text>
						{" · "}
						<Link href={logoutHref}>Use a different account</Link>
					</Text>
				</Surface>
			) : null}

			{error ? (
				<Alert variant="destructive">
					<AlertTitle>Sign-in failed</AlertTitle>
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			{organizations.isError ? (
				<Alert variant="destructive">
					<AlertTitle>Could not load your organizations</AlertTitle>
					<AlertDescription>
						Refresh to try again, or re-run <CodeInline>tedix login</CodeInline>
						.
					</AlertDescription>
				</Alert>
			) : null}

			{selectingMultiple && step === "permissions" ? (
				<div className="mt-5 grid gap-4">
					<CliLoginPermissions
						value={scopes}
						onChange={setScopes}
						disabled={redirecting}
					/>
					<Button
						disabled={scopes.length === 0 || redirecting}
						onClick={() => setStep("organizations")}
					>
						Choose organizations
					</Button>
				</div>
			) : organizations.isLoading ? (
				<ListSkeleton />
			) : items.length === 0 && !organizations.isError ? (
				<Empty
					appearance="quiet"
					className="mt-5"
					description="Your account is not a member of any Tedix organization yet."
					title="No organizations"
				/>
			) : (
				<div className="mt-5 grid gap-3">
					{selectingMultiple ? (
						<div className="grid gap-2">
							<Input
								type="search"
								aria-label="Search organizations"
								placeholder="Search organizations…"
								value={organizationSearch}
								onChange={(event) => setOrganizationSearch(event.target.value)}
							/>
							<Button
								variant="ghost"
								disabled={redirecting || selectableItems.length === 0}
								onClick={() =>
									setSelectedSlugs(
										selectedSlugs.length === selectableItems.length
											? []
											: selectableItems.map((item) => item.org.slug),
									)
								}
							>
								{selectedSlugs.length === selectableItems.length
									? "Deselect all"
									: "Select all current organizations"}
							</Button>
						</div>
					) : null}
					<Card
						className="max-h-96 gap-0 divide-y divide-kumo-hairline overflow-y-auto p-0"
						render={<ul />}
					>
						{visibleItems.map((workspace) => {
							const org = workspace.org;
							const isRedirecting = redirectingSlug === org.slug;
							return (
								<li key={org.organizationId}>
									{selectingMultiple ? (
										<div className="px-3.5 py-3">
											<Checkbox
												checked={selectedSlugs.includes(org.slug)}
												disabled={
													redirecting ||
													!org.provisionComplete ||
													!org.descopeTenantId
												}
												onCheckedChange={(checked) =>
													setSelectedSlugs((current) =>
														checked
															? [...current, org.slug]
															: current.filter((slug) => slug !== org.slug),
													)
												}
												label={
													<span className="flex items-center gap-3">
														<span
															className="grid size-7 shrink-0 place-items-center rounded-md bg-kumo-brand font-bold text-kumo-inverse type-tedix-control"
															aria-hidden="true"
														>
															{org.name.charAt(0).toUpperCase()}
														</span>
														<Text as="span" role="body" weight="medium">
															{org.name}
														</Text>
													</span>
												}
											/>
										</div>
									) : (
										<Button
											className="w-full justify-start gap-3 rounded-none px-3.5 py-3 font-normal!"
											disabled={redirecting || !org.provisionComplete}
											multiline
											onClick={() => {
												if (org.descopeTenantId)
													choose(org.slug, org.descopeTenantId);
											}}
											variant="ghost"
										>
											<span
												className="grid size-7 shrink-0 place-items-center rounded-md bg-kumo-brand font-bold text-kumo-inverse type-tedix-control"
												aria-hidden="true"
											>
												{org.name.charAt(0).toUpperCase()}
											</span>
											<Text
												as="span"
												role="body"
												weight="medium"
												truncate
												className="flex-1 text-left"
											>
												{org.name}
											</Text>
											<Text
												as="span"
												role="label"
												tone="secondary"
												weight="semibold"
												className="shrink-0"
											>
												{isRedirecting
													? IDENTITY_JOURNEY_COPY.workspaceSelection
															.preparingLabel
													: org.provisionComplete
														? IDENTITY_JOURNEY_COPY.workspaceSelection
																.continueLabel
														: "Provisioning"}
											</Text>
										</Button>
									)}
								</li>
							);
						})}
					</Card>
				</div>
			)}
			{selectingMultiple && step === "organizations" ? (
				<div className="mt-4 flex justify-between gap-2">
					<Button
						variant="outline"
						onClick={() => setStep("permissions")}
						disabled={redirecting}
					>
						Edit permissions
					</Button>
					<Button
						onClick={chooseSelected}
						disabled={redirecting || selectedSlugs.length === 0}
					>
						Review access for {selectedSlugs.length}{" "}
						{selectedSlugs.length === 1 ? "organization" : "organizations"}
					</Button>
				</div>
			) : null}

			<Text role="label" tone="secondary" className="mt-5">
				{IDENTITY_JOURNEY_COPY.workspaceSelection.footnote}
			</Text>
		</IdentityJourneyFrame>
	);
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	PrepareTenantToolPolicyInputSchema,
	TenantToolPolicySetSchema,
	TenantToolPolicyBoundDescriptorSchema,
	type MachinePolicyInventory,
} from "@tedix/api-contract/schemas/tenant-tool-policy";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { osApi } from "@/lib/api";
import { appListQueryOptions, osQuery } from "@/lib/os-query-options";

type FieldChoice = {
	enabled: boolean;
	required: boolean;
	anyNonBlank: boolean;
};
type FieldChoices = Record<string, FieldChoice>;
const defaultFieldChoice = {
	enabled: true,
	required: true,
	anyNonBlank: false,
};
const fieldKey = (path: string[]) => JSON.stringify(path);

function reviewedSubjectIdentity(value: unknown): string | null {
	const parsed = TenantToolPolicyBoundDescriptorSchema.safeParse(value);
	if (!parsed.success || !("kind" in parsed.data)) return null;
	const descriptor = parsed.data;
	if (descriptor.kind === "profile")
		return JSON.stringify(["user", descriptor.actorUserId]);
	const subject = descriptor.subject;
	return subject.scope === "principal"
		? JSON.stringify([
				"machine-principal",
				subject.principalId,
				subject.mcpServerId,
			])
		: JSON.stringify([
				"machine-session",
				subject.principalId,
				subject.mcpServerId,
				subject.sessionId,
				subject.clientRecordId,
			]);
}

export function buildExampleRule(
	value: unknown,
	choices: FieldChoices,
	path: string[] = [],
): unknown {
	if (Array.isArray(value)) {
		if (value.length === 0)
			throw new Error(
				"Add an example array item so its allowed fields can be reviewed.",
			);
		const variants = value.map((item, index) =>
			buildExampleRule(item, choices, [...path, `[${index}]`]),
		);
		return {
			type: "array",
			items: variants.length === 1 ? variants[0] : { anyOf: variants },
			minItems: value.length,
			maxItems: value.length,
		};
	}
	if (value && typeof value === "object") {
		const properties: Record<string, unknown> = Object.create(null),
			required: string[] = [];
		for (const [name, child] of Object.entries(value)) {
			const childPath = [...path, name],
				choice = choices[fieldKey(childPath)] ?? defaultFieldChoice;
			if (!choice.enabled) continue;
			properties[name] = buildExampleRule(child, choices, childPath);
			if (choice.required) required.push(name);
		}
		return {
			type: "object",
			properties,
			required,
			additionalProperties: false,
		};
	}
	if (typeof value === "string")
		return (choices[fieldKey(path)] ?? defaultFieldChoice).anyNonBlank
			? { type: "string", nonBlank: true }
			: { type: "string", const: value };
	if (typeof value === "number" || typeof value === "boolean")
		return { type: typeof value, const: value };
	if (value === null) return { type: "null", const: null };
	throw new Error("The example contains an unsupported value.");
}

export function ExampleRuleFields({
	value,
	choices,
	onChange,
	path = [],
}: {
	value: unknown;
	choices: FieldChoices;
	onChange: (next: FieldChoices) => void;
	path?: string[];
}) {
	if (Array.isArray(value))
		return (
			<>
				{value.map((item, index) => (
					<div key={index}>
						<Text as="p" role="label">
							Array item {index + 1} of {value.length}
						</Text>
						<ExampleRuleFields
							value={item}
							choices={choices}
							onChange={onChange}
							path={[...path, `[${index}]`]}
						/>
					</div>
				))}
			</>
		);
	if (!value || typeof value !== "object") return null;
	return (
		<>
			{Object.entries(value).map(([name, child]) => {
				const childPath = [...path, name],
					key = fieldKey(childPath),
					choice = choices[key] ?? defaultFieldChoice;
				const update = (patch: Partial<FieldChoice>) =>
					onChange({ ...choices, [key]: { ...choice, ...patch } });
				return (
					<fieldset key={key}>
						<legend>{childPath.join(".")}</legend>
						<label>
							<input
								type="checkbox"
								checked={choice.enabled}
								onChange={(event) => update({ enabled: event.target.checked })}
							/>{" "}
							Allow this field
						</label>
						{choice.enabled ? (
							<>
								<label>
									<input
										type="checkbox"
										checked={choice.required}
										onChange={(event) =>
											update({ required: event.target.checked })
										}
									/>{" "}
									Required
								</label>
								{typeof child === "string" ? (
									<label>
										<input
											type="checkbox"
											checked={choice.anyNonBlank}
											onChange={(event) =>
												update({ anyNonBlank: event.target.checked })
											}
										/>{" "}
										Allow any non-blank text
									</label>
								) : null}
								<Text as="p" role="label">
									Example: {JSON.stringify(child)}
								</Text>
								<ExampleRuleFields
									value={child}
									choices={choices}
									onChange={onChange}
									path={childPath}
								/>
							</>
						) : null}
					</fieldset>
				);
			})}
		</>
	);
}

export function MachineInventoryPicker({
	items,
	loading,
	error,
	value,
	onChange,
	onRefresh,
}: {
	items: MachinePolicyInventory["items"];
	loading: boolean;
	error: boolean;
	value: string;
	onChange: (value: string) => void;
	onRefresh: () => void;
}) {
	return (
		<>
			<label htmlFor="native-machine-session">Active machine session</label>
			{loading ? (
				<Text as="p" role="label">
					Loading active machines…
				</Text>
			) : null}
			{error ? (
				<Text as="p" role="label" tone="error">
					Could not load machine sessions. Refresh and try again.
				</Text>
			) : null}
			{!loading && !error && items.length === 0 ? (
				<Text as="p" role="label">
					No active machine sessions found among the 100 most recent
					registrations.
				</Text>
			) : null}
			<select
				id="native-machine-session"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				disabled={loading || error}
			>
				<option value="">Choose a machine session</option>
				{items.map((item) => {
					const key = JSON.stringify([
						item.principalId,
						item.sessionId,
						item.clientRecordId,
						item.mcpServerId,
					]);
					return (
						<option key={key} value={key}>
							{item.principalName} · session {item.sessionId} · client{" "}
							{item.clientRecordId}
						</option>
					);
				})}
			</select>
			<Button variant="ghost" size="sm" onClick={onRefresh}>
				Refresh machine sessions
			</Button>
		</>
	);
}

/** Owner-authored tool rules are reviewed against a gateway-prepared identity. */
export function TenantToolPolicies({ canChange }: { canChange: boolean }) {
	const client = useQueryClient();
	const policies = useQuery(
		osQuery.mcpGovernance.listTenantToolPolicies.queryOptions(),
	);
	const deletedPolicies = useQuery(
		osQuery.mcpGovernance.listDeletedTenantPolicyFences.queryOptions(),
	);
	const apps = useQuery(appListQueryOptions(100));
	const profiles = useQuery(
		osQuery.mcpGovernance.listProviderIdentityProfiles.queryOptions(),
	);
	const machineProofs = useQuery(
		osQuery.mcpGovernance.listMachineProviderProbes.queryOptions(),
	);
	const machineInventory = useQuery(
		osQuery.mcpGovernance.listMachinePolicyInventory.queryOptions(),
	);
	const [nativeRule, setNativeRule] = useState(false);
	const [nativeSelection, setNativeSelection] = useState("");
	const selectedMachine = machineInventory.data?.items.find(
		(item) =>
			JSON.stringify([
				item.principalId,
				item.sessionId,
				item.clientRecordId,
				item.mcpServerId,
			]) === nativeSelection,
	);
	const [profileId, setProfileId] = useState("");
	const [machineProofId, setMachineProofId] = useState("");
	const [machineScope, setMachineScope] = useState<"session" | "principal">(
		"session",
	);
	const [machineConfirmationId, setMachineConfirmationId] = useState("");
	const [rootAppId, setRootAppId] = useState("");
	const toolPreview = useQuery({
		...osQuery.mcpServer.previewToolScopes.queryOptions({
			input: { appId: rootAppId },
		}),
		enabled: rootAppId.length > 0,
	});
	const [mountedToolId, setMountedToolId] = useState("");
	const [exampleArgs, setExampleArgs] = useState("{}");
	const [editingRevisionId, setEditingRevisionId] = useState("");
	const [regrantRevoked, setRegrantRevoked] = useState(false);
	const [recoverDeleted, setRecoverDeleted] = useState(false);
	const [recoverUnknown, setRecoverUnknown] = useState(false);
	const [unknownSubjectRevision, setUnknownSubjectRevision] = useState("");
	const [editingSubject, setEditingSubject] = useState<string | null>(null);
	const [fieldChoices, setFieldChoices] = useState<FieldChoices>({});
	let example: unknown;
	let rulePreview: unknown;
	let rulePreviewError = "";
	try {
		example = JSON.parse(exampleArgs);
		if (!example || typeof example !== "object" || Array.isArray(example))
			throw new Error("Enter an example object.");
		rulePreview = buildExampleRule(example, fieldChoices);
	} catch (error) {
		rulePreviewError =
			error instanceof Error ? error.message : "Enter valid example arguments.";
	}
	const [advanced, setAdvanced] = useState(false);
	const [schema, setSchema] = useState(
		'{"evaluatorVersion":1,"defaultDisposition":"ask","rules":[{"id":"rule-1","predicate":{"version":1,"schema":{"type":"object","properties":{},"additionalProperties":false}},"effect":{"disposition":"ask","riskTier":"bounded_write","blastRadius":"single_resource"}}]}',
	);
	const [disposition, setDisposition] = useState<"allow" | "ask" | "deny">(
		"ask",
	);
	const [error, setError] = useState("");
	const prepare = useMutation({
		onMutate: () => setUnknownSubjectRevision(""),
		mutationFn: async () => {
			const input = PrepareTenantToolPolicyInputSchema.parse({
				rootAppId,
				mountedToolId,
				exampleArgs: JSON.parse(exampleArgs),
			});
			if (nativeRule) {
				if (!selectedMachine)
					throw new Error("Choose an active machine session.");
				return osApi.mcpGovernance.prepareNativeRpcPolicy({
					...input,
					principalId: selectedMachine.principalId,
					sessionId: selectedMachine.sessionId,
					clientRecordId: selectedMachine.clientRecordId,
				});
			}
			if (machineProofId)
				return osApi.mcpGovernance.prepareMachineTenantToolPolicy({
					profileId,
					resultReceiptId: machineProofId,
					subjectScope: machineScope,
					exampleArgs: input.exampleArgs,
				});
			if (!profileId) throw new Error("Choose a reviewed account profile.");
			const proof = await osApi.mcpGovernance.probeProviderIdentityProfile({
				profileId,
				exampleArgs: input.exampleArgs,
			});
			const prepared = await osApi.mcpGovernance.prepareHybridTenantToolPolicy({
				profileId,
				resultReceiptId: proof.resultReceiptId,
				exampleArgs: input.exampleArgs,
			});
			return { ...prepared, credentialSummary: proof.credentialSummary };
		},
	});
	const preparedMachine =
		prepare.data &&
		"kind" in prepare.data.descriptor &&
		prepare.data.descriptor.kind === "machine"
			? prepare.data.descriptor
			: null;
	const preparedMount = prepare.data
		? "kind" in prepare.data.descriptor
			? prepare.data.descriptor.mount
			: prepare.data.descriptor
		: null;
	const matchingSubjectRevisions =
		recoverUnknown && preparedMount && prepare.data
			? (() => {
					const key = reviewedSubjectIdentity(prepare.data!.descriptor);
					if (!key) return [];
					const rules = (policies.data?.items ?? []).flatMap((rule) => {
						const mount =
							rule.mountDescriptor && "kind" in rule.mountDescriptor
								? rule.mountDescriptor.mount
								: rule.mountDescriptor;
						return reviewedSubjectIdentity(rule.mountDescriptor) === key &&
							mount?.rootAppId === preparedMount.rootAppId &&
							mount?.mountedToolId === preparedMount.mountedToolId
							? [
									{
										id: rule.id,
										mode: rule.revokedAt ? ("revoked" as const) : null,
										label: `${rule.revokedAt ? "Revoked" : "Active"} revision ${rule.id} (${rule.createdAt})`,
									},
								]
							: [];
					});
					const deleted = (deletedPolicies.data?.items ?? [])
						.filter(
							(item) =>
								item.subjectKey === key &&
								item.rootAppId === preparedMount.rootAppId &&
								item.mountedToolId === preparedMount.mountedToolId,
						)
						.map((item) => ({
							id: item.revisionId,
							mode: "deleted" as const,
							label: `Deleted revision ${item.revisionId}`,
						}));
					return [...rules, ...deleted];
				})()
			: [];
	const selectedSubjectRevision = matchingSubjectRevisions.find(
		(rule) => rule.id === unknownSubjectRevision,
	);

	const refresh = () =>
		Promise.all([
			client.invalidateQueries({
				queryKey: osQuery.mcpGovernance.listTenantToolPolicies.key({
					type: "query",
				}),
			}),
			client.invalidateQueries({
				queryKey: osQuery.mcpGovernance.listDeletedTenantPolicyFences.key({
					type: "query",
				}),
			}),
		]);
	const create = useMutation({
		mutationFn: (
			input: Parameters<typeof osApi.mcpGovernance.createTenantToolPolicy>[0],
		) => osApi.mcpGovernance.createTenantToolPolicy(input),
		onSuccess: async () => {
			prepare.reset();
			setEditingRevisionId("");
			setRegrantRevoked(false);
			setRecoverDeleted(false);
			setRecoverUnknown(false);
			setUnknownSubjectRevision("");
			setEditingSubject(null);
			await refresh();
		},
	});
	const revoke = useMutation({
		mutationFn: (id: string) =>
			osApi.mcpGovernance.revokeTenantToolPolicy({ id }),
		onSuccess: refresh,
	});
	const save = () => {
		setError("");
		let valueToCheck: unknown;
		try {
			valueToCheck = advanced
				? JSON.parse(schema)
				: {
						evaluatorVersion: 1,
						defaultDisposition: "ask",
						rules: [
							{
								id: "rule-1",
								predicate: {
									version: 1,
									schema: rulePreviewError
										? (() => {
												throw new Error(rulePreviewError);
											})()
										: rulePreview,
								},
								effect: {
									disposition,
									riskTier: "bounded_write",
									blastRadius: "single_resource",
								},
							},
						],
					};
		} catch (error) {
			setError(
				error instanceof Error ? error.message : "Enter valid rule JSON.",
			);
			return;
		}
		const parsed = TenantToolPolicySetSchema.safeParse(valueToCheck);
		if (!parsed.success) {
			setError("Enter a supported condition and value.");
			return;
		}
		if (!prepare.data) return;
		if (editingSubject) {
			const descriptor = prepare.data.descriptor;
			const subject = !("kind" in descriptor)
				? JSON.stringify(["legacy"])
				: descriptor.kind === "profile"
					? JSON.stringify([descriptor.kind, descriptor.actorUserId])
					: JSON.stringify([descriptor.kind, descriptor.subject]);
			if (subject !== editingSubject) {
				setError(
					"Review the same account or machine subject as the revision being replaced.",
				);
				return;
			}
		}
		if (
			recoverUnknown &&
			matchingSubjectRevisions.length > 0 &&
			!unknownSubjectRevision
		) {
			setError(
				"Choose the current revision for this subject before recovering the old fence.",
			);
			return;
		}
		if (
			"kind" in prepare.data.descriptor &&
			prepare.data.descriptor.kind === "machine" &&
			(!machineConfirmationId || machineConfirmationId === machineProofId)
		) {
			setError("Choose a second fresh verification from the same machine.");
			return;
		}
		create.mutate({
			preparationId: prepare.data.preparationId,
			expectedDescriptorDigest: prepare.data.descriptorDigest,
			...(editingRevisionId && !recoverUnknown
				? { expectedRevisionId: editingRevisionId }
				: {}),
			...(editingRevisionId && recoverUnknown
				? { recoverUnknownRevisionId: editingRevisionId }
				: {}),
			...(recoverUnknown && selectedSubjectRevision
				? {
						expectedRevisionId: selectedSubjectRevision.id,
						...(selectedSubjectRevision.mode
							? { subjectRecoveryMode: selectedSubjectRevision.mode }
							: {}),
					}
				: {}),
			...(regrantRevoked ? { regrantRevoked: true } : {}),
			...(recoverDeleted ? { recoverDeleted: true } : {}),
			exampleArgs: PrepareTenantToolPolicyInputSchema.parse({
				rootAppId,
				mountedToolId,
				exampleArgs: JSON.parse(exampleArgs),
			}).exampleArgs,
			...("kind" in prepare.data.descriptor &&
			prepare.data.descriptor.kind === "machine"
				? { machineConfirmationReceiptId: machineConfirmationId }
				: {}),
			policySet: parsed.data,
		});
	};
	return (
		<section
			className="grid gap-3 border-t border-kumo-hairline px-4 py-3"
			aria-label="Tool policy rules"
		>
			<h3 className="m-0 font-semibold">Tool policy rules</h3>
			<Text as="p" role="label" tone="secondary">
				A saved rule can apply to matching calls from the reviewed user or
				machine. Permissions and other safeguards still apply. Rules are scoped
				to a particular app, tool and connection; changes may require a new
				review. Each reviewed user or machine has its own rule revision;
				revoking one does not reactivate an older revision.
			</Text>
			{policies.isError ? (
				<Text as="p" role="label" tone="error">
					Could not load tool rules.
				</Text>
			) : null}
			<ul className="m-0 grid list-none gap-2 p-0">
				{(policies.data?.items ?? []).map((rule) => {
					const mount =
						rule.mountDescriptor && "kind" in rule.mountDescriptor
							? rule.mountDescriptor.mount
							: rule.mountDescriptor;
					return (
						<li
							key={rule.id}
							className="grid gap-1 border-b border-kumo-hairline pb-2"
						>
							<span>
								{mount?.mountedToolId ?? rule.toolRowId} ·{" "}
								{rule.revokedAt ? "Revoked" : "Stored revision"}
							</span>
							<Text as="span" role="label" tone="secondary">
								{mount && "providerId" in mount
									? mount.providerId
									: "Internal RPC"}{" "}
								·{" "}
								{rule.policySet
									? `${rule.policySet.rules.length} rule(s)`
									: "Legacy rule"}
								{rule.mountDescriptor &&
								"kind" in rule.mountDescriptor &&
								rule.mountDescriptor.kind === "profile"
									? ` · User ${rule.mountDescriptor.actorUserId}`
									: ""}
								{rule.mountDescriptor &&
								"kind" in rule.mountDescriptor &&
								(rule.mountDescriptor.kind === "machine" ||
									rule.mountDescriptor.kind === "native_rpc")
									? ` · Machine ${rule.mountDescriptor.subject.principalId}${rule.mountDescriptor.subject.scope === "session" ? " · Exact session" : " · All verified sessions"}`
									: ""}
							</Text>
							<details>
								<summary>View conditions and connection</summary>
								<Text as="p" role="label" tone="secondary">
									Operation:{" "}
									{mount &&
										("upstreamOperation" in mount
											? mount.upstreamOperation
											: mount.endpoint)}
									. Connection:{" "}
									{mount && "connectionInstanceId" in mount
										? (mount.connectionInstanceId ?? "verified account")
										: "Internal RPC"}
									.
								</Text>
								<pre className="whitespace-pre-wrap break-words">
									{JSON.stringify(rule.policySet ?? rule.predicate, null, 2)}
								</pre>
							</details>
							{canChange &&
							rule.policySet &&
							mount &&
							(rule.revokedAt ||
								(rule.mountDescriptor && "kind" in rule.mountDescriptor)) ? (
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										const descriptor = rule.mountDescriptor;
										setRegrantRevoked(!!rule.revokedAt);
										setRecoverDeleted(false);
										setRecoverUnknown(
											!!rule.revokedAt &&
												(!descriptor || !("kind" in descriptor)),
										);
										setEditingSubject(
											!descriptor || !("kind" in descriptor)
												? JSON.stringify(["legacy"])
												: descriptor.kind === "profile"
													? JSON.stringify([
															descriptor.kind,
															descriptor.actorUserId,
														])
													: JSON.stringify([
															descriptor.kind,
															descriptor.subject,
														]),
										);
										setEditingRevisionId(rule.id);
										setRootAppId(mount.rootAppId);
										setMountedToolId(mount.mountedToolId);
										setExampleArgs("{}");
										setFieldChoices({});
										setSchema(JSON.stringify(rule.policySet, null, 2));
										setAdvanced(true);
										setNativeRule(
											!!descriptor &&
												"kind" in descriptor &&
												descriptor.kind === "native_rpc",
										);
										setProfileId(
											descriptor &&
												"kind" in descriptor &&
												(descriptor.kind === "profile" ||
													descriptor.kind === "machine")
												? descriptor.profileId
												: "",
										);
										setMachineProofId("");
										setMachineConfirmationId("");
										setNativeSelection("");
										setError("");
										prepare.reset();
									}}
								>
									{rule.revokedAt
										? "Review new rule after revocation"
										: "Edit revision"}
								</Button>
							) : null}
							{canChange && !rule.revokedAt ? (
								<Button
									variant="ghost"
									size="sm"
									disabled={revoke.isPending}
									onClick={() => revoke.mutate(rule.id)}
								>
									Revoke rule
								</Button>
							) : null}
						</li>
					);
				})}
			</ul>
			{deletedPolicies.isError ? (
				<Text as="p" role="label" tone="error">
					Could not load deleted rule fences.
				</Text>
			) : null}
			{(deletedPolicies.data?.items ?? []).map((fence) => (
				<div key={fence.revisionId}>
					<Text as="p" role="label">
						Deleted rule for {fence.mountedToolId} (app {fence.rootAppId}); no
						old approval is active.{" "}
						{fence.subjectKey === null
							? "The prior subject is unknown; this review retires the old fence and creates a new subject-bound rule."
							: ""}
					</Text>
					{canChange ? (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setEditingRevisionId(fence.revisionId);
								setRecoverDeleted(true);
								setRecoverUnknown(fence.subjectKey === null);
								setUnknownSubjectRevision("");
								setRegrantRevoked(false);
								setEditingSubject(null);
								setRootAppId(fence.rootAppId);
								setMountedToolId(fence.mountedToolId);
								setExampleArgs("{}");
								setFieldChoices({});
								setAdvanced(false);
								setNativeRule(false);
								setProfileId("");
								setMachineProofId("");
								setMachineConfirmationId("");
								setNativeSelection("");
								setError("");
								prepare.reset();
							}}
						>
							Review a new rule for this tool
						</Button>
					) : null}
				</div>
			))}
			{canChange ? (
				<>
					{editingRevisionId ? (
						<div>
							<Text as="p" role="label">
								{recoverDeleted
									? `Creating a new rule after deleted revision ${editingRevisionId}. Choose the current account or machine, enter example arguments and complete a fresh review. The deleted rule is not restored.`
									: regrantRevoked
										? `Creating a new rule after revoked revision ${editingRevisionId}. Enter current example arguments and review the tool again. The revoked rule stays revoked; saving requires it to remain the latest revision.`
										: `Editing revision ${editingRevisionId}. Enter current example arguments and review the tool again. Saving creates a replacement only if this revision is still current and not revoked.`}
							</Text>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									setEditingRevisionId("");
									setRegrantRevoked(false);
									setRecoverDeleted(false);
									setRecoverUnknown(false);
									setUnknownSubjectRevision("");
									setEditingSubject(null);
									prepare.reset();
								}}
							>
								Cancel edit
							</Button>
						</div>
					) : null}
					<label>App</label>
					<Select
						value={rootAppId}
						onValueChange={(next) => {
							setRootAppId(next ?? "");
							setProfileId("");
							setMachineProofId("");
							prepare.reset();
						}}
					>
						<SelectTrigger aria-label="App">
							<SelectValue placeholder="Choose an app" />
						</SelectTrigger>
						<SelectContent>
							{(apps.data?.data ?? []).map((app) => (
								<SelectItem key={app.id} value={app.id}>
									{app.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<label htmlFor="policy-mounted-tool">
						Tool name as shown in the app
					</label>
					<Input
						id="policy-mounted-tool"
						aria-label="Tool name as shown in the app"
						list="policy-tool-suggestions"
						value={mountedToolId}
						onChange={(event) => {
							setMountedToolId(event.target.value);
							setProfileId("");
							setMachineProofId("");
							prepare.reset();
						}}
					/>
					<datalist id="policy-tool-suggestions">
						{Object.keys(toolPreview.data?.toolScopes ?? {}).map((name) => (
							<option key={name} value={name} />
						))}
					</datalist>
					<label htmlFor="policy-example">Example tool arguments</label>
					<Textarea
						id="policy-example"
						value={exampleArgs}
						onChange={(event) => {
							setExampleArgs(event.target.value);
							setFieldChoices({});
							prepare.reset();
						}}
						rows={3}
					/>
					<Text as="p" role="label" tone="secondary">
						These arguments verify that the selected connection can reach the
						intended resource.
					</Text>
					<label>
						<input
							type="checkbox"
							checked={nativeRule}
							onChange={(event) => {
								setNativeRule(event.target.checked);
								prepare.reset();
							}}
						/>{" "}
						Review an internal RPC for a machine
					</label>
					{nativeRule ? (
						<>
							<Text as="p" role="label" tone="secondary">
								Choose an active machine session. This rule covers future
								verified sessions for that principal; each call still needs its
								own permissions. No external account profile is used.
							</Text>
							<MachineInventoryPicker
								items={machineInventory.data?.items ?? []}
								loading={machineInventory.isLoading}
								error={machineInventory.isError}
								value={nativeSelection}
								onChange={(next) => {
									setNativeSelection(next);
									prepare.reset();
								}}
								onRefresh={() => void machineInventory.refetch()}
							/>
						</>
					) : null}
					{!nativeRule ? (
						<>
							<label>Reviewed account profile</label>
							{profiles.isError ? (
								<Text as="p" role="label" tone="error">
									Could not load reviewed account profiles. Try again before
									choosing one.
								</Text>
							) : null}
							<Select
								value={profileId || "none"}
								onValueChange={(next) => {
									const selected = next === "none" ? "" : (next ?? "");
									setProfileId(selected);
									setMachineProofId("");
									const profile = profiles.data?.items.find(
										(item) => item.id === selected,
									);
									if (profile) {
										setRootAppId(profile.mount.rootAppId);
										setMountedToolId(profile.mount.mountedToolId);
									}
									prepare.reset();
								}}
							>
								<SelectTrigger aria-label="Reviewed account profile">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="none">
										Choose an account profile
									</SelectItem>
									{(profiles.data?.items ?? [])
										.filter((item) => !item.revokedAt)
										.map((item) => (
											<SelectItem key={item.id} value={item.id}>
												{item.mount.providerId}: {item.mount.mountedToolId}
											</SelectItem>
										))}
								</SelectContent>
							</Select>
							<label>Machine verification (optional)</label>
							{machineProofs.isError ? (
								<Text as="p" role="label" tone="error">
									Could not load machine verifications.
								</Text>
							) : null}
						</>
					) : null}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => void machineProofs.refetch()}
					>
						Refresh machine verifications
					</Button>
					<Select
						value={machineProofId || "none"}
						onValueChange={(next) => {
							const selected = next === "none" ? "" : (next ?? "");
							setMachineProofId(selected);
							setMachineConfirmationId("");
							const proof = machineProofs.data?.items.find(
								(item) => item.id === selected,
							);
							const profile = profiles.data?.items.find(
								(item) => item.id === proof?.profileId,
							);
							if (profile) {
								setProfileId(profile.id);
								setRootAppId(profile.mount.rootAppId);
								setMountedToolId(profile.mount.mountedToolId);
							}
							prepare.reset();
						}}
					>
						<SelectTrigger aria-label="Machine verification">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="none">Use my account</SelectItem>
							{(machineProofs.data?.items ?? []).map((item) => (
								<SelectItem key={item.id} value={item.id}>
									Machine {item.principalId}, session {item.sessionId}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{machineProofId ? (
						<>
							<Select
								value={machineScope}
								onValueChange={(next) => {
									if (next === "session" || next === "principal")
										setMachineScope(next);
									prepare.reset();
								}}
							>
								<SelectTrigger aria-label="Machine rule scope">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="session">
										Only this session and client
									</SelectItem>
									<SelectItem value="principal">
										Future verified sessions for this machine
									</SelectItem>
								</SelectContent>
							</Select>
							<Text as="p" role="label" tone="secondary">
								{machineScope === "principal"
									? "This authorizes future verified sessions and clients of this machine in this organization; each call still checks the current session, access and account."
									: "This authorizes only the verified machine session and client; a new session needs a new rule."}{" "}
								The machine must run a second verification for the same profile
								and arguments before you save.
							</Text>
						</>
					) : null}
					<Button
						size="sm"
						disabled={
							!rootAppId ||
							!mountedToolId.trim() ||
							(!nativeRule && !profileId) ||
							prepare.isPending
						}
						onClick={() => prepare.mutate()}
					>
						{!nativeRule && profileId
							? "Verify account and review tool"
							: "Review tool"}
					</Button>
					{prepare.data ? (
						<div className="grid gap-2">
							{recoverUnknown && matchingSubjectRevisions.length > 0 ? (
								<>
									<label>Current rule for the reviewed subject</label>
									<Select
										value={unknownSubjectRevision || "none"}
										onValueChange={(value) =>
											setUnknownSubjectRevision(
												value === "none" ? "" : (value ?? ""),
											)
										}
									>
										<SelectTrigger aria-label="Current rule for the reviewed subject">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="none">
												Choose the current revision
											</SelectItem>
											{matchingSubjectRevisions.map((rule) => (
												<SelectItem key={rule.id} value={rule.id}>
													{rule.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Text as="p" role="label" tone="secondary">
										Choose the latest revision and review whether it is active,
										revoked or deleted. Saving succeeds only if that status is
										still current.
									</Text>
								</>
							) : null}
							{preparedMachine ? (
								<>
									<label>Second machine verification</label>
									<Select
										value={machineConfirmationId || "none"}
										onValueChange={(next) =>
											setMachineConfirmationId(
												next === "none" ? "" : (next ?? ""),
											)
										}
									>
										<SelectTrigger aria-label="Second machine verification">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="none">
												Choose a fresh verification
											</SelectItem>
											{(machineProofs.data?.items ?? [])
												.filter(
													(item) =>
														item.id !== machineProofId &&
														item.profileId === profileId &&
														item.principalId ===
															preparedMachine.subject.principalId &&
														(preparedMachine.subject.scope === "principal" ||
															(item.sessionId ===
																preparedMachine.subject.sessionId &&
																item.clientRecordId ===
																	preparedMachine.subject.clientRecordId)),
												)
												.map((item) => (
													<SelectItem key={item.id} value={item.id}>
														Machine {item.principalId}, session {item.sessionId}
													</SelectItem>
												))}
										</SelectContent>
									</Select>
								</>
							) : null}
							<Text as="p" role="label" tone="secondary">
								Review: {preparedMount?.mountedToolId},{" "}
								{preparedMount && "providerId" in preparedMount
									? `provider ${preparedMount.providerId}, operation ${preparedMount.upstreamOperation}, connection ${preparedMount.connectionInstanceId ?? "verified account"}`
									: `internal operation ${preparedMount?.endpoint}`}
								.
							</Text>
							{prepare.data.descriptor &&
							"kind" in prepare.data.descriptor &&
							prepare.data.descriptor.kind === "profile" ? (
								<Text as="p" role="label" tone="secondary">
									{"credentialSummary" in prepare.data &&
									prepare.data.credentialSummary
										? prepare.data.credentialSummary.scope === "user"
											? "The verified connection is your personal connection."
											: "The verified connection belongs to the organization."
										: "The connection scope could not be displayed."}{" "}
									{"credentialSummary" in prepare.data &&
									prepare.data.credentialSummary?.connectionInstanceId
										? `Connection ID: ${prepare.data.credentialSummary.connectionInstanceId}.`
										: ""}{" "}
									The workspace name is not shown; verify the target workspace
									and resource before saving.
								</Text>
							) : null}
							{prepare.data.descriptor &&
							"kind" in prepare.data.descriptor &&
							prepare.data.descriptor.kind === "native_rpc" ? (
								<Text as="p" role="label" tone="secondary">
									Machine principal:{" "}
									{prepare.data.descriptor.subject.principalId}. Future verified
									sessions for this machine can use this rule when their own
									permissions allow.
								</Text>
							) : null}
							<label className="flex items-center gap-2">
								<Switch checked={advanced} onCheckedChange={setAdvanced} />{" "}
								Advanced rule set
							</label>
							{advanced ? (
								<>
									<label htmlFor="policy-schema">Ordered rules</label>
									<Textarea
										id="policy-schema"
										value={schema}
										onChange={(event) => setSchema(event.target.value)}
										rows={6}
									/>
								</>
							) : (
								<>
									<Text as="p" role="label" tone="secondary">
										Choose allowed and required fields from the example. Values
										match exactly unless you allow non-blank text. Arrays have
										the example's length and item choices. Unlisted fields are
										rejected at every level.
									</Text>
									{rulePreviewError ? (
										<Text as="p" role="label" tone="error">
											{rulePreviewError}
										</Text>
									) : (
										<>
											<ExampleRuleFields
												value={example}
												choices={fieldChoices}
												onChange={setFieldChoices}
											/>
											<details>
												<summary>Review rule conditions</summary>
												<pre className="whitespace-pre-wrap break-words">
													{JSON.stringify(rulePreview, null, 2)}
												</pre>
											</details>
										</>
									)}
								</>
							)}
							{!advanced ? (
								<Select
									value={disposition}
									onValueChange={(next) => {
										if (next === "allow" || next === "ask" || next === "deny")
											setDisposition(next);
									}}
								>
									<SelectTrigger aria-label="When this rule matches">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="allow">Allow automatically</SelectItem>
										<SelectItem value="ask">Ask a person</SelectItem>
										<SelectItem value="deny">Deny</SelectItem>
									</SelectContent>
								</Select>
							) : null}
							<Text as="p" role="label" tone="secondary">
								A matching deny wins. Otherwise the first matching rule applies;
								unmatched calls ask a person.
							</Text>
							<Button size="sm" onClick={save} disabled={create.isPending}>
								Save rule
							</Button>
						</div>
					) : null}
					{error || prepare.error || create.error || revoke.error ? (
						<Text as="p" role="label" tone="error">
							{error ||
								(prepare.error ?? create.error ?? revoke.error)?.message}
						</Text>
					) : null}
				</>
			) : null}
		</section>
	);
}

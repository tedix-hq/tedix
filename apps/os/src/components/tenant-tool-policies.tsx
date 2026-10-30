import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	PrepareTenantToolPolicyInputSchema,
	TenantToolPolicySetSchema,
	TenantToolPolicyBoundDescriptorSchema,
	type MachinePolicyInventory,
} from "@tedix/api-contract/schemas/tenant-tool-policy";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import { Checkbox } from "@/components/kumo/checkbox";
import { CodeBlock } from "@/components/kumo/code";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/kumo/sheet";
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
import { useMediaQuery } from "@/lib/use-media-query";

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
						<Checkbox
							label="Allow this field"
							checked={choice.enabled}
							onCheckedChange={(checked) => update({ enabled: checked })}
						/>
						{choice.enabled ? (
							<>
								<Checkbox
									label="Required"
									checked={choice.required}
									onCheckedChange={(checked) => update({ required: checked })}
								/>
								{typeof child === "string" ? (
									<Checkbox
										label="Allow any non-blank text"
										checked={choice.anyNonBlank}
										onCheckedChange={(checked) =>
											update({ anyNonBlank: checked })
										}
									/>
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
	const choices = items.map((item) => ({
		value: JSON.stringify([
			item.principalId,
			item.sessionId,
			item.clientRecordId,
			item.mcpServerId,
		]),
		label: `${item.principalName} · session ${item.sessionId} · client ${item.clientRecordId}`,
	}));
	return (
		<>
			<Label htmlFor="native-machine-session">Active machine session</Label>
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
			<Select
				value={value}
				items={choices}
				onValueChange={(next) => onChange(next ?? "")}
				disabled={loading || error}
			>
				<SelectTrigger id="native-machine-session" className="w-full min-w-0">
					<SelectValue placeholder="Choose a machine session" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="">Choose a machine session</SelectItem>
					{choices.map((choice) => (
						<SelectItem key={choice.value} value={choice.value}>
							{choice.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Button variant="ghost" size="sm" onClick={onRefresh}>
				Refresh machine sessions
			</Button>
		</>
	);
}

/** Owner-authored tool rules are reviewed against a gateway-prepared identity. */
export function TenantToolPolicies({ canChange }: { canChange: boolean }) {
	const client = useQueryClient();
	const [editorOpen, setEditorOpen] = useState(false);
	const mobile = useMediaQuery("(max-width: 639px)");
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
	const [exampleFields, setExampleFields] = useState<
		Array<{ name: string; value: string }>
	>([]);
	const [exampleJson, setExampleJson] = useState(false);
	const [exampleModeError, setExampleModeError] = useState("");
	const exampleFieldsValid =
		exampleFields.every((field) => field.name.trim().length > 0) &&
		new Set(exampleFields.map((field) => field.name)).size ===
			exampleFields.length;
	const updateExampleFields = (
		fields: Array<{ name: string; value: string }>,
	) => {
		setExampleFields(fields);
		if (
			fields.every((field) => field.name.trim().length > 0) &&
			new Set(fields.map((field) => field.name)).size === fields.length
		)
			setExampleArgs(
				JSON.stringify(
					Object.fromEntries(fields.map((field) => [field.name, field.value])),
				),
			);
		setFieldChoices({});
		prepare.reset();
	};
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
			setEditorOpen(false);
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
			aria-label="Rules for connected apps"
		>
			<h3 className="m-0 font-semibold">Rules for connected apps</h3>
			<Text as="p" role="label" tone="secondary">
				Rules apply to matching requests from the reviewed person or agent, for
				one app, action and connection. Permissions and other safeguards still
				apply.
			</Text>
			{(policies.data?.items.length ?? 0) > 0 ? (
				<Text as="p" role="label" tone="secondary">
					This list includes older records. A saved record may have been
					replaced; its current status is not shown here.
				</Text>
			) : null}
			{policies.isError ? (
				<Text as="p" role="label" tone="error">
					Could not load tool rules.
				</Text>
			) : policies.data && policies.data.items.length === 0 ? (
				<Text as="p" role="label" tone="secondary">
					No rules for connected apps yet.
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
								{rule.revokedAt
									? "Revoked record"
									: "Saved record · current status unknown"}
							</span>
							<Text as="span" role="label" tone="secondary">
								{mount && "providerId" in mount
									? mount.providerId
									: "Internal action"}{" "}
								·{" "}
								{rule.policySet
									? `${rule.policySet.rules.length} rule(s)`
									: "Legacy rule"}
								{rule.mountDescriptor &&
								"kind" in rule.mountDescriptor &&
								rule.mountDescriptor.kind === "profile"
									? " · Person"
									: ""}
								{rule.mountDescriptor &&
								"kind" in rule.mountDescriptor &&
								(rule.mountDescriptor.kind === "machine" ||
									rule.mountDescriptor.kind === "native_rpc")
									? ` · Agent${rule.mountDescriptor.subject.scope === "session" ? " · This session" : " · Verified sessions"}`
									: ""}
							</Text>
							<Collapsible>
								<CollapsibleDefaultTrigger>
									View conditions and connection
								</CollapsibleDefaultTrigger>
								<CollapsibleDefaultContent>
									<Text as="p" role="label" tone="secondary">
										Rule ID: {rule.id}. Reviewed identity:{" "}
										{rule.mountDescriptor && "kind" in rule.mountDescriptor
											? rule.mountDescriptor.kind === "profile"
												? rule.mountDescriptor.actorUserId
												: rule.mountDescriptor.subject.principalId
											: "Unknown"}
										.
									</Text>
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
									<CodeBlock
										code={JSON.stringify(
											rule.policySet ?? rule.predicate,
											null,
											2,
										)}
										lang="json"
									/>
								</CollapsibleDefaultContent>
							</Collapsible>
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
										setExampleFields([]);
										setExampleJson(false);
										setExampleModeError("");
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
										setEditorOpen(true);
									}}
								>
									{rule.revokedAt
										? "Review new rule after revocation"
										: "Edit rule"}
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
					Could not load deleted rules.
				</Text>
			) : null}
			{(deletedPolicies.data?.items ?? []).map((fence) => (
				<div key={fence.revisionId}>
					<Text as="p" role="label">
						Deleted rule for {fence.mountedToolId}; no old approval is active.{" "}
						{fence.subjectKey === null
							? "The prior person or agent is unknown. A fresh review is needed to create a new rule."
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
								setExampleFields([]);
								setExampleJson(false);
								setExampleModeError("");
								setFieldChoices({});
								setAdvanced(false);
								setNativeRule(false);
								setProfileId("");
								setMachineProofId("");
								setMachineConfirmationId("");
								setNativeSelection("");
								setError("");
								prepare.reset();
								setEditorOpen(true);
							}}
						>
							Review a new rule for this tool
						</Button>
					) : null}
				</div>
			))}
			{revoke.error ? (
				<Text as="p" role="label" tone="error">
					{revoke.error.message}
				</Text>
			) : null}
			{canChange ? (
				<>
					<Button
						size="sm"
						onClick={() => {
							setEditingRevisionId("");
							setRegrantRevoked(false);
							setRecoverDeleted(false);
							setRecoverUnknown(false);
							setUnknownSubjectRevision("");
							setEditingSubject(null);
							setRootAppId("");
							setMountedToolId("");
							setExampleArgs("{}");
							setExampleFields([]);
							setExampleJson(false);
							setExampleModeError("");
							setFieldChoices({});
							setAdvanced(false);
							setDisposition("ask");
							setNativeRule(false);
							setProfileId("");
							setMachineProofId("");
							setMachineConfirmationId("");
							setNativeSelection("");
							setError("");
							prepare.reset();
							setEditorOpen(true);
						}}
					>
						Add rule
					</Button>
					<Sheet open={editorOpen} onOpenChange={setEditorOpen}>
						<SheetContent
							side={mobile ? "bottom" : "right"}
							size="xl"
							className={mobile ? "max-h-[85dvh] rounded-t-xl" : "sm:w-full"}
						>
							<SheetHeader>
								<SheetTitle>
									{editingRevisionId ? "Review rule" : "Add a rule"}
								</SheetTitle>
								<SheetDescription>
									Choose the action and account, then review exactly which calls
									the rule covers.
								</SheetDescription>
							</SheetHeader>
							<div className="grid gap-3 px-4 pb-6 sm:px-6">
								{editingRevisionId ? (
									<div>
										<Text as="p" role="label">
											{recoverDeleted
												? "Choose the current account or agent, enter an example request and review it again. The deleted rule is not restored."
												: regrantRevoked
													? "Enter an example request and review the action again. The revoked rule stays revoked; saving requires it to remain the latest rule."
													: "Enter an example request and review the action again. Saving replaces the rule only if it is still current and not revoked."}
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
										<SelectValue placeholder="Choose an app">
											{rootAppId
												? (apps.data?.data.find((app) => app.id === rootAppId)
														?.name ?? "Selected app unavailable")
												: null}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										{(apps.data?.data ?? []).map((app) => (
											<SelectItem key={app.id} value={app.id}>
												{app.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<label htmlFor="policy-mounted-tool">Action</label>
								<Input
									id="policy-mounted-tool"
									aria-label="Action"
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
									{Object.keys(toolPreview.data?.toolScopes ?? {}).map(
										(name) => (
											<option key={name} value={name} />
										),
									)}
								</datalist>
								<Text as="p" weight="semibold">
									Example request
								</Text>
								{exampleJson ? (
									<>
										<label htmlFor="policy-example">Request JSON</label>
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
									</>
								) : (
									<div className="grid gap-2">
										{exampleFields.map((field, index) => (
											<div
												key={index}
												className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
											>
												<Input
													aria-label={`Field ${index + 1} name`}
													placeholder="Field name"
													value={field.name}
													onChange={(event) =>
														updateExampleFields(
															exampleFields.map((item, i) =>
																i === index
																	? { ...item, name: event.target.value }
																	: item,
															),
														)
													}
												/>
												<Input
													aria-label={`Field ${index + 1} value`}
													placeholder="Example text value"
													value={field.value}
													onChange={(event) =>
														updateExampleFields(
															exampleFields.map((item, i) =>
																i === index
																	? { ...item, value: event.target.value }
																	: item,
															),
														)
													}
												/>
												<Button
													variant="ghost"
													size="sm"
													onClick={() =>
														updateExampleFields(
															exampleFields.filter((_, i) => i !== index),
														)
													}
												>
													Remove field
												</Button>
											</div>
										))}
										<Button
											variant="ghost"
											size="sm"
											onClick={() =>
												updateExampleFields([
													...exampleFields,
													{ name: "", value: "" },
												])
											}
										>
											Add field
										</Button>
										{!exampleFieldsValid ? (
											<Text as="p" role="label" tone="error">
												Give each field a different, non-empty name.
											</Text>
										) : null}
									</div>
								)}
								<Checkbox
									label="Enter request as JSON"
									checked={exampleJson}
									onCheckedChange={(checked) => {
										if (checked === true) {
											if (!exampleFieldsValid) {
												setExampleModeError(
													"Complete or remove the unfinished fields first.",
												);
												return;
											}
											setExampleJson(true);
											setExampleModeError("");
											return;
										}
										try {
											const parsed: unknown = JSON.parse(exampleArgs);
											if (
												!parsed ||
												typeof parsed !== "object" ||
												Array.isArray(parsed) ||
												Object.values(parsed).some(
													(value) => typeof value !== "string",
												)
											)
												throw new Error();
											setExampleFields(
												Object.entries(parsed).map(([name, value]) => ({
													name,
													value: value as string,
												})),
											);
											setExampleModeError("");
											setExampleJson(false);
										} catch {
											setExampleModeError(
												"This request contains non-text or nested values. Keep using JSON to preserve them.",
											);
										}
									}}
								/>
								{exampleModeError ? (
									<Text as="p" role="label" tone="error">
										{exampleModeError}
									</Text>
								) : null}
								<Text as="p" role="label" tone="secondary">
									Add field names and text values from the action. Use JSON for
									numbers, lists, or nested values.
								</Text>
								<Text as="p" role="label" tone="secondary">
									This example checks whether the selected connection can reach
									the intended resource. It also helps define which requests
									match.
								</Text>
								{!nativeRule ? (
									<>
										<label>Account check</label>
										{profiles.isError ? (
											<Text as="p" role="label" tone="error">
												Could not load account checks. Try again before choosing
												one.
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
											<SelectTrigger aria-label="Account check">
												<SelectValue>
													{profileId
														? (() => {
																const profile = profiles.data?.items.find(
																	(item) =>
																		item.id === profileId && !item.revokedAt,
																);
																return profile
																	? `${profile.mount.providerId}: ${profile.mount.mountedToolId}`
																	: "Selected account check unavailable";
															})()
														: "Choose an account check"}
												</SelectValue>
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="none">
													Choose an account check
												</SelectItem>
												{(profiles.data?.items ?? [])
													.filter((item) => !item.revokedAt)
													.map((item) => (
														<SelectItem key={item.id} value={item.id}>
															{item.mount.providerId}:{" "}
															{item.mount.mountedToolId}
														</SelectItem>
													))}
											</SelectContent>
										</Select>
										{!profiles.isLoading &&
										!profiles.isError &&
										!(profiles.data?.items ?? []).some(
											(item) => !item.revokedAt,
										) ? (
											<Text as="p" role="label" tone="secondary">
												No account check is available. Close this panel and
												choose Add account check in Account checks first.
											</Text>
										) : null}
										{machineProofs.isError ? (
											<Text as="p" role="label" tone="error">
												Could not load machine verifications.
											</Text>
										) : null}
									</>
								) : null}
								<Collapsible defaultOpen={nativeRule || !!machineProofId}>
									<CollapsibleDefaultTrigger>
										For agent accounts
									</CollapsibleDefaultTrigger>
									<CollapsibleDefaultContent className="grid gap-3">
										<Checkbox
											label="Review an internal action for an agent"
											checked={nativeRule}
											onCheckedChange={(checked) => {
												setNativeRule(checked === true);
												prepare.reset();
											}}
										/>
										{nativeRule ? (
											<>
												<Text as="p" role="label" tone="secondary">
													Choose an active machine session. This rule covers
													future verified sessions for that principal; each call
													still needs its own permissions. No external account
													profile is used.
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
										<label>Machine verification (optional)</label>
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
													The machine must run a second verification for the
													same profile and arguments before you save.
												</Text>
											</>
										) : null}
									</CollapsibleDefaultContent>
								</Collapsible>
								<Button
									size="sm"
									disabled={
										!rootAppId ||
										!mountedToolId.trim() ||
										(!exampleJson && !exampleFieldsValid) ||
										!!rulePreviewError ||
										(!nativeRule && !profileId) ||
										prepare.isPending
									}
									onClick={() => prepare.mutate()}
								>
									{!nativeRule && profileId
										? "Verify account and review action"
										: "Review action"}
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
													Choose the latest revision and review whether it is
													active, revoked or deleted. Saving succeeds only if
													that status is still current.
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
																	(preparedMachine.subject.scope ===
																		"principal" ||
																		(item.sessionId ===
																			preparedMachine.subject.sessionId &&
																			item.clientRecordId ===
																				preparedMachine.subject
																					.clientRecordId)),
															)
															.map((item) => (
																<SelectItem key={item.id} value={item.id}>
																	Machine {item.principalId}, session{" "}
																	{item.sessionId}
																</SelectItem>
															))}
													</SelectContent>
												</Select>
											</>
										) : null}
										<Text as="p" weight="semibold">
											Review the action and account
										</Text>
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
												The workspace name is not shown; verify the target
												workspace and resource before saving.
											</Text>
										) : null}
										{prepare.data.descriptor &&
										"kind" in prepare.data.descriptor &&
										prepare.data.descriptor.kind === "native_rpc" ? (
											<Text as="p" role="label" tone="secondary">
												Machine principal:{" "}
												{prepare.data.descriptor.subject.principalId}. Future
												verified sessions for this machine can use this rule
												when their own permissions allow.
											</Text>
										) : null}
										<label className="flex items-center gap-2">
											<Switch
												checked={advanced}
												onCheckedChange={setAdvanced}
											/>{" "}
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
													Choose allowed and required fields from the example.
													Values match exactly unless you allow non-blank text.
													Arrays have the example's length and item choices.
													Unlisted fields are rejected at every level.
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
														<Collapsible>
															<CollapsibleDefaultTrigger>
																Review rule conditions
															</CollapsibleDefaultTrigger>
															<CollapsibleDefaultContent>
																<CodeBlock
																	code={JSON.stringify(rulePreview, null, 2)}
																	lang="json"
																/>
															</CollapsibleDefaultContent>
														</Collapsible>
													</>
												)}
											</>
										)}
										{!advanced ? (
											<Select
												value={disposition}
												onValueChange={(next) => {
													if (
														next === "allow" ||
														next === "ask" ||
														next === "deny"
													)
														setDisposition(next);
												}}
											>
												<SelectTrigger aria-label="When this rule matches">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="allow">
														Allow automatically
													</SelectItem>
													<SelectItem value="ask">Ask a person</SelectItem>
													<SelectItem value="deny">Deny</SelectItem>
												</SelectContent>
											</Select>
										) : null}
										<Text as="p" role="label" tone="secondary">
											When several rules match, deny takes priority, then ask,
											then allow. Calls with no match ask a person. Other
											safeguards still apply.
										</Text>
										<Button
											size="sm"
											onClick={save}
											disabled={create.isPending}
										>
											Save rule
										</Button>
									</div>
								) : null}
								{error || prepare.error || create.error ? (
									<Text as="p" role="label" tone="error">
										{error || (prepare.error ?? create.error)?.message}
									</Text>
								) : null}
							</div>
						</SheetContent>
					</Sheet>
				</>
			) : null}
		</section>
	);
}

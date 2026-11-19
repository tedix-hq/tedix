import {
	DotsThree,
	Globe,
	Info,
	LinkSimple,
	Lock,
	PencilSimple,
	Plugs,
	Prohibit,
	UsersThree,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	OsShareInvitee,
	OsShareLink,
} from "@tedix/api-contract/contracts/os-shares";
import type {
	OsAffectedCollaborator,
	OsCollaborator,
	OsCollaboratorLink,
	OsCollaboratorRole,
	OsCollaboratorTarget,
	OsInviteSuggestion,
} from "@tedix/api-contract/schemas/os-collaborators";
import {
	type ClipboardEvent,
	type FormEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	LoadError,
	Alert,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import { Avatar, AvatarFallback } from "@/components/kumo/avatar";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Checkbox } from "@/components/kumo/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { Input } from "@/components/kumo/input";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
import {
	FreshLink,
	LinkCopyStatus,
	PermanentUrl,
	SHARE_DIALOG_CLASS,
	ShareLinksPanel,
	shareStatus,
	useLinkCopy,
	workspaceGuestLimitsText,
} from "@/components/share-controls";
import {
	INVITE_SUGGESTIONS_ID,
	InviteChips,
	InviteSuggestionList,
	suggestionOptionId,
	useInviteSuggestions,
	withoutInviteSearchTerm,
} from "@/components/workspace-invite-people";
import { osApi } from "@/lib/api";
import {
	canvasGadgetDetailQueryOptions,
	osQueryKeys,
	operationalContextQueryOptions,
	osSharesQueryOptions,
	outputDetailQueryOptions,
	shareInviteesQueryOptions,
	workspaceCollaboratorsQueryOptions,
	workspacePresenceQueryOptions,
} from "@/lib/os-query-options";
import { relativeTime } from "@/lib/time";
import { sourceLabel } from "@/lib/workspace-sources";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

export const ROLE_LABEL: Record<OsCollaboratorRole, string> = {
	use: "Can use",
	build: "Can build",
};

const ROLE_VERB: Record<OsCollaboratorRole, string> = {
	use: "use",
	build: "build",
};

export function workspaceShareUrl(
	origin: string,
	workspaceId: string,
	key: string,
): string {
	return `${origin}/shared/workspace/${encodeURIComponent(workspaceId)}#share=${encodeURIComponent(key)}`;
}

/** The address an invited person opens after signing in; it carries no key. */
export function workspaceAddress(origin: string, workspaceId: string): string {
	return `${origin}/shared/workspace/${encodeURIComponent(workspaceId)}`;
}

/** The addresses typed or pasted into the invite field, each one once. */
export function parseInviteEmails(text: string): string[] {
	const seen = new Set<string>();
	const emails: string[] = [];
	for (const part of text.split(/[\s,;]+/)) {
		const key = part.toLowerCase();
		if (!part || seen.has(key)) continue;
		seen.add(key);
		emails.push(part);
	}
	return emails;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why one address could not be added, naming that address. */
export function inviteFailureText(email: string, error: unknown): string {
	const message = error instanceof Error ? error.message.trim() : "";
	if (!message) return `Couldn't add ${email}.`;
	return message.includes("that email")
		? message.replace("that email", email)
		: `${email}: ${message}`;
}

/** "Ana", "Ana and Ben", "Ana, Ben, and Cy". */
function nameList(names: readonly string[]): string {
	return new Intl.ListFormat("en", {
		style: "long",
		type: "conjunction",
	}).format(names);
}

type InviteResult = {
	added: OsCollaborator[];
	failed: { email: string; message: string }[];
};

const HIGHLIGHT_MS = 3000;
/** A row that was just added stands out, then settles. */
const ROW_CLASS =
	"-mx-2 rounded-md px-2 transition-colors duration-700 motion-reduce:transition-none";

function personLabel(person: { name: string | null; email: string | null }) {
	return person.name ?? person.email ?? "Someone";
}

function initials(label: string): string {
	const parts = label
		.replace(/@.*$/, "")
		.split(/[\s._-]+/)
		.filter(Boolean);
	const letters = parts.slice(0, 2).map((part) => part[0] ?? "");
	return letters.join("").toUpperCase() || "?";
}

/** One sentence per consequence, so the confirm says exactly who changes. */
export function removalConsequences(
	affected: readonly OsAffectedCollaborator[],
	target: OsCollaboratorTarget,
): { removed: OsAffectedCollaborator[]; downgraded: OsAffectedCollaborator[] } {
	const others = affected.filter(
		(person) => target.kind !== "user" || person.userId !== target.userId,
	);
	return {
		removed: others.filter((person) => person.newRole === null),
		downgraded: others.filter((person) => person.newRole !== null),
	};
}

function errorText(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

/** After a role change, name anyone else whose access fell with it. */
function knockOnText(
	affected: readonly OsAffectedCollaborator[],
	changedUserId?: string,
): string | null {
	const others = affected.filter((person) => person.userId !== changedUserId);
	if (others.length === 0) return null;
	return `${others
		.map(
			(person) =>
				`${personLabel(person)} ${
					person.newRole
						? `now ${ROLE_LABEL[person.newRole].toLowerCase()}`
						: "lost access"
				}`,
		)
		.join("; ")}.`;
}

type PendingRemoval = {
	target: OsCollaboratorTarget;
	label: string;
	affected: OsAffectedCollaborator[];
	keep: Set<string>;
};

/** The app or file open in the workspace when Share is pressed. */
export type WorkspaceShareItem = {
	type: "gadget" | "output";
	id: string;
	/** Opens the app's Review tab, where review rounds are sent. */
	onOpenReview?: () => void;
};

type Scope = "workspace" | "item";

/** Marks the Copy link button beside General access as the one just used. */
const OWN_LINK = "own";

/**
 * What General access can be set to. Workspace links need a Tedix sign-in
 * and join people at a role; the public link needs no account and shows the
 * apps only.
 */
type AccessChoice = "restricted" | "link:use" | "link:build" | "public";

/**
 * What General access says while no link is on. Everyone in the organization
 * already builds in an organization workspace, so "only people invited"
 * would contradict the list of people above it.
 */
export function restrictedAccessLabel(
	visibility: "org" | "private" | undefined,
	organization: string,
): string {
	return visibility === "org"
		? `Everyone in ${organization}, and people invited`
		: "Only people invited";
}

type ConnectedSource = {
	id: string;
	name: string | null;
	providerId: string;
	personal: boolean;
	files: number;
	apps: number;
};

/** The muted line under a connected source: whose account, and what uses it. */
export function connectedSourceDetail(source: ConnectedSource): string {
	const uses = [
		source.files > 0
			? `${source.files} ${source.files === 1 ? "file" : "files"}`
			: null,
		source.apps > 0
			? `${source.apps} ${source.apps === 1 ? "app" : "apps"}`
			: null,
	].filter(Boolean);
	return [
		sourceLabel(source.providerId),
		source.personal
			? "one person's own account"
			: "shared organization account",
		uses.length > 0 ? `used by ${uses.join(" and ")}` : null,
	]
		.filter(Boolean)
		.join(" · ");
}

/**
 * The connected data this workspace's files and apps draw on, shown before
 * anyone is invited so the person sharing knows what comes with it.
 */
function ConnectedData(props: { sources: readonly ConnectedSource[] }) {
	if (props.sources.length === 0) return null;
	return (
		<section
			className="grid gap-1 border-kumo-line border-t pt-4"
			aria-label="Connected data in this workspace"
			data-connected-data
		>
			<SectionHeading
				learnMore={{
					label: "About connected data",
					text: "Tedix checks this each time someone opens a file. A file made from a shared organization account opens for people in your organization while that account stays connected. A file made from one person's own account opens for that person only.",
				}}
			>
				Connected data in this workspace
			</SectionHeading>
			<Text role="label" tone="secondary" className="m-0">
				Files and apps here draw on these. People in your organization you
				invite can see files made from a shared organization account. Files made
				from one person's own account open for that person only.
			</Text>
			<ul className="m-0 grid list-none p-0">
				{props.sources.map((source) => (
					<PersonRow
						key={source.id}
						name={source.name ?? "A source no longer in this workspace"}
						detail={connectedSourceDetail(source)}
						icon={<Plugs size={12} />}
						trailing={null}
					/>
				))}
			</ul>
		</section>
	);
}

/** A short "Learn more" beside a heading, instead of a paragraph under it. */
function LearnMore(props: { label: string; children: string }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button variant="ghost" size="icon-xs" aria-label={props.label} />
				}
			>
				<Info size={14} />
			</TooltipTrigger>
			<TooltipContent>{props.children}</TooltipContent>
		</Tooltip>
	);
}

function SectionHeading(props: {
	children: string;
	learnMore?: { label: string; text: string };
}) {
	return (
		<div className="flex min-h-6 items-center gap-1">
			<Text as="h3" role="label" tone="strong" className="m-0">
				{props.children}
			</Text>
			{props.learnMore ? (
				<LearnMore label={props.learnMore.label}>
					{props.learnMore.text}
				</LearnMore>
			) : null}
		</div>
	);
}

export function WorkspaceShareDialog(props: {
	workspaceId: string;
	workspaceName: string;
	/** Private workspaces cannot have a no-sign-in link. */
	visibility?: "org" | "private";
	item?: WorkspaceShareItem;
	/** What the dialog opens on: the item when its own Share was pressed. */
	initialScope?: Scope;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const item = props.item;
	const [scope, setScope] = useState<Scope>(
		props.initialScope === "item" && item ? "item" : "workspace",
	);
	const gadget = useQuery({
		...canvasGadgetDetailQueryOptions(props.workspaceId, item?.id ?? ""),
		enabled: props.open && item?.type === "gadget",
	});
	const output = useQuery({
		...outputDetailQueryOptions(item?.id ?? ""),
		enabled: props.open && item?.type === "output",
	});
	const itemNoun = item?.type === "gadget" ? "app" : "file";
	const itemName =
		item?.type === "gadget"
			? gadget.data?.gadget.name
			: output.data?.output.title;
	const title =
		scope === "item" && item
			? itemName
				? `Share “${itemName}”`
				: `Share this ${itemNoun}`
			: `Share “${props.workspaceName}”`;

	return (
		<TooltipProvider>
			<Dialog open={props.open} onOpenChange={props.onOpenChange}>
				<DialogContent className={SHARE_DIALOG_CLASS} data-share-dialog>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>
							Invite people or share a link.
						</DialogDescription>
					</DialogHeader>
					{item ? (
						<SegmentedControl
							ariaLabel="What to share"
							fill
							value={scope}
							onValueChange={setScope}
							options={[
								{ value: "workspace", label: "This workspace" },
								{ value: "item", label: `This ${itemNoun}` },
							]}
						/>
					) : null}
					{scope === "item" && item ? (
						<ItemLinks
							workspaceId={props.workspaceId}
							visibility={props.visibility}
							item={item}
							onOpenReview={
								item.onOpenReview
									? () => {
											props.onOpenChange(false);
											item.onOpenReview?.();
										}
									: undefined
							}
						/>
					) : (
						<WorkspaceAccess
							workspaceId={props.workspaceId}
							visibility={props.visibility}
						/>
					)}
				</DialogContent>
			</Dialog>
		</TooltipProvider>
	);
}

/** Links to the open app or file alone, inside the same dialog. */
function ItemLinks(props: {
	workspaceId: string;
	visibility?: "org" | "private";
	item: WorkspaceShareItem;
	onOpenReview?: () => void;
}) {
	const { item } = props;
	const gadget = useQuery({
		...canvasGadgetDetailQueryOptions(props.workspaceId, item.id),
		enabled: item.type === "gadget",
	});
	const output = useQuery({
		...outputDetailQueryOptions(item.id),
		enabled: item.type === "output",
	});
	return (
		<div className="grid gap-4" data-share-open-item>
			<Text role="label" tone="secondary" className="m-0">
				A link to this {item.type === "gadget" ? "app" : "file"} alone, without
				the rest of the workspace.
			</Text>
			{item.type === "gadget" && gadget.data ? (
				<ShareLinksPanel
					resourceType="gadget"
					resourceId={gadget.data.gadget.id}
					currentRevisionId={gadget.data.currentRevision?.id}
					onOpenReview={props.onOpenReview}
				/>
			) : item.type === "output" && output.data ? (
				<ShareLinksPanel
					outputId={item.id}
					currentRevisionId={output.data.currentRevision.id}
				/>
			) : (
				<Text role="label" tone="secondary" className="m-0">
					Loading…
				</Text>
			)}
			<ItemAccess
				workspaceId={props.workspaceId}
				visibility={props.visibility}
				item={item}
			/>
		</div>
	);
}

const THROUGH_WORKSPACE = "Through the workspace";
const THROUGH_LINK = "Through this link";

export type ItemAccessRow = {
	key: string;
	name: string;
	detail?: string;
	group?: "organization" | "anyone";
	/** How this person or group reaches the file or app. */
	through: string;
};

/**
 * Everyone who can open one file or app, each with how they reach it:
 * through the workspace it is in, through its own link, or both. A link that
 * is off, stopped or expired reaches nobody.
 */
export function itemAccessRows(input: {
	itemType: WorkspaceShareItem["type"];
	visibility?: "org" | "private";
	organization: string;
	sharing?: {
		ownerName: string | null;
		collaborators: readonly OsCollaborator[];
	};
	link?: Pick<OsShareLink, "access" | "role"> | null;
	invitees?: readonly OsShareInvitee[];
}): ItemAccessRow[] {
	const rows: ItemAccessRow[] = [];
	if (input.sharing?.ownerName)
		rows.push({
			key: "owner",
			name: input.sharing.ownerName,
			detail: "Owner",
			through: THROUGH_WORKSPACE,
		});
	if (input.visibility === "org")
		rows.push({
			key: "organization",
			name: `Everyone in ${input.organization}`,
			group: "organization",
			through: THROUGH_WORKSPACE,
		});
	// A person who may only use the workspace's apps does not open its files.
	const members = (input.sharing?.collaborators ?? []).filter(
		(person) => input.itemType === "gadget" || person.role === "build",
	);
	const invitees =
		input.link?.access === "invited" ? (input.invitees ?? []) : [];
	const invited = (person: OsCollaborator) =>
		invitees.some(
			(invitee) =>
				(invitee.userId !== null && invitee.userId === person.userId) ||
				(invitee.email !== null &&
					person.email !== null &&
					invitee.email.toLowerCase() === person.email.toLowerCase()),
		);
	for (const person of members)
		rows.push({
			key: `member:${person.userId}`,
			name: personLabel(person),
			detail: ROLE_LABEL[person.role],
			through: invited(person)
				? `${THROUGH_WORKSPACE} and this link`
				: THROUGH_WORKSPACE,
		});
	if (!input.link) return rows;
	if (input.link.access === "anyone_with_link")
		rows.push({
			key: "anyone",
			name: "Anyone with the link",
			group: "anyone",
			through: THROUGH_LINK,
		});
	else if (input.link.access === "organization") {
		if (input.visibility !== "org")
			rows.push({
				key: "link-organization",
				name: `People in ${input.organization}`,
				group: "organization",
				through: THROUGH_LINK,
			});
	} else
		for (const invitee of invitees) {
			if (
				members.some(
					(person) =>
						(invitee.userId !== null && invitee.userId === person.userId) ||
						(invitee.email !== null &&
							person.email !== null &&
							invitee.email.toLowerCase() === person.email.toLowerCase()),
				)
			)
				continue;
			rows.push({
				key: `invitee:${invitee.id}`,
				name: invitee.name ?? invitee.email ?? "Someone",
				detail: invitee.name && invitee.email ? invitee.email : undefined,
				through: THROUGH_LINK,
			});
		}
	return rows;
}

/** The list under an item's link: who can open it, and how. */
function ItemAccess(props: {
	workspaceId: string;
	visibility?: "org" | "private";
	item: WorkspaceShareItem;
}) {
	const { item } = props;
	const organization =
		useOsOperationalContext().data?.organization.name ?? "your organization";
	const sharing = useQuery(
		workspaceCollaboratorsQueryOptions(props.workspaceId),
	);
	const shares = useQuery(
		osSharesQueryOptions({ resourceType: item.type, resourceId: item.id }),
	);
	// Only a link that opens right now gives anyone access.
	const link =
		(shares.data?.items ?? []).find(
			(share) => shareStatus(share) === "active",
		) ?? null;
	const invitees = useQuery({
		...shareInviteesQueryOptions(link?.id ?? ""),
		enabled: link?.access === "invited",
	});
	const noun = item.type === "gadget" ? "app" : "file";
	const rows = itemAccessRows({
		itemType: item.type,
		visibility: props.visibility,
		organization,
		sharing: sharing.data,
		link,
		invitees: invitees.data?.items,
	});
	if (!shares.isSuccess) return null;
	return (
		<section
			className="grid gap-1 border-kumo-line border-t pt-4"
			aria-label="Who has access"
			data-item-access
		>
			<SectionHeading
				learnMore={{
					label: "About access",
					text: `People in the workspace open this ${noun} there. Its own link lets others open this ${noun} alone: they never see the workspace's other files, its chat or its members.`,
				}}
			>
				Who has access
			</SectionHeading>
			<ul className="m-0 grid list-none p-0">
				{rows.map((row) => (
					<PersonRow
						key={row.key}
						name={row.name}
						detail={row.detail}
						icon={
							row.group === "organization" ? (
								<UsersThree size={12} />
							) : row.group === "anyone" ? (
								<Globe size={12} />
							) : undefined
						}
						trailing={
							<Text as="span" role="label" tone="secondary">
								{row.through}
							</Text>
						}
					/>
				))}
			</ul>
			{link ? null : (
				<Text role="label" tone="secondary" className="m-0">
					Nobody outside the workspace can open this {noun}.
				</Text>
			)}
		</section>
	);
}

function WorkspaceAccess(props: {
	workspaceId: string;
	visibility?: "org" | "private";
}) {
	const { workspaceId } = props;
	const queryClient = useQueryClient();
	const sharing = useQuery(workspaceCollaboratorsQueryOptions(workspaceId));
	const [email, setEmail] = useState("");
	/** People chosen from the suggestions, shown as chips until invited. */
	const [picked, setPicked] = useState<OsInviteSuggestion[]>([]);
	const [inviteRole, setInviteRole] = useState<OsCollaboratorRole>("use");
	const [freshUrl, setFreshUrl] = useState<string | null>(null);
	const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
	const linkCopy = useLinkCopy();
	const [invited, setInvited] = useState<InviteResult | null>(null);
	/** The role of a named link being set up; null while that form is closed. */
	const [stagedRole, setStagedRole] = useState<OsCollaboratorRole | null>(null);
	const [linkName, setLinkName] = useState("");
	const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (highlightTimer.current) clearTimeout(highlightTimer.current);
		},
		[],
	);
	const highlight = (ids: string[]) => {
		if (highlightTimer.current) clearTimeout(highlightTimer.current);
		setHighlighted(new Set(ids));
		highlightTimer.current = setTimeout(
			() => setHighlighted(new Set()),
			HIGHLIGHT_MS,
		);
	};
	const presence = useQuery(workspacePresenceQueryOptions(workspaceId));
	const you = presence.data;
	const [pending, setPending] = useState<PendingRemoval | null>(null);
	const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
	const [knockOn, setKnockOn] = useState<string | null>(null);
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: osQueryKeys.collaborators() });
	const origin = typeof window === "undefined" ? "" : window.location.origin;

	// Chosen people first, then whatever was typed or pasted, each address once.
	const inviteEmails = parseInviteEmails(
		[...picked.map((person) => person.email), email].join(" "),
	);
	// One call per address, so one unknown address never blocks the others.
	const invite = useMutation({
		mutationFn: async (emails: string[]): Promise<InviteResult> => {
			const result: InviteResult = { added: [], failed: [] };
			for (const address of emails) {
				if (!EMAIL_SHAPE.test(address)) {
					result.failed.push({
						email: address,
						message: `${address} doesn't look like an email address.`,
					});
					continue;
				}
				try {
					const { collaborator } = await osApi.osCollaborators.add({
						workspaceId,
						email: address,
						role: inviteRole,
					});
					result.added.push(collaborator);
				} catch (error) {
					result.failed.push({
						email: address,
						message: inviteFailureText(address, error),
					});
				}
			}
			return result;
		},
		onMutate: () => setInvited(null),
		onSuccess: (result) => {
			setInvited(result);
			// What failed stays to be corrected: a chosen person as their chip, a
			// typed address in the field.
			const failed = new Set(
				result.failed.map((failure) => failure.email.toLowerCase()),
			);
			const keptChips = picked.filter((person) =>
				failed.has(person.email.toLowerCase()),
			);
			const chipEmails = new Set(
				keptChips.map((person) => person.email.toLowerCase()),
			);
			setPicked(keptChips);
			setEmail(
				result.failed
					.map((failure) => failure.email)
					.filter((address) => !chipEmails.has(address.toLowerCase()))
					.join(", "),
			);
			if (result.added.length > 0) {
				highlight(result.added.map((person) => person.userId));
				void refresh();
			}
		},
	});
	// Without a name this is the person's own link for the workspace: the
	// server hands back the same link every time, so nobody piles up links.
	const createLink = useMutation({
		mutationFn: async (input: { role: OsCollaboratorRole; label: string }) => {
			// A sign-in link replaces the no-sign-in one; invited people keep theirs.
			if (activePublic.length > 0) await publicToggle.mutateAsync(false);
			return osApi.osCollaborators.createLink({
				workspaceId,
				role: input.role,
				...(input.label.trim() ? { label: input.label.trim() } : {}),
			});
		},
		onSuccess: (result) => {
			setStagedRole(null);
			setLinkName("");
			setFreshUrl(workspaceShareUrl(origin, workspaceId, result.key));
			highlight([result.link.id]);
			void refresh();
		},
	});
	const setRole = useMutation({
		mutationFn: (input: { userId: string; role: OsCollaboratorRole }) =>
			osApi.osCollaborators.setRole({ workspaceId, ...input }),
		onSuccess: (result, input) =>
			setKnockOn(knockOnText(result.affected, input.userId)),
		onSettled: () => void refresh(),
	});
	const updateLink = useMutation({
		mutationFn: (input: {
			linkId: string;
			label: string;
			role: OsCollaboratorRole;
		}) =>
			osApi.osCollaborators.updateLink({
				workspaceId,
				linkId: input.linkId,
				role: input.role,
				label: input.label.trim() || null,
			}),
		onSuccess: (result) => {
			setEditingLinkId(null);
			setKnockOn(knockOnText(result.affected));
		},
		onSettled: () => void refresh(),
	});
	const copyLink = useMutation({
		mutationFn: async (linkId: string) => {
			const { key } = await osApi.osCollaborators.copyLink({
				workspaceId,
				linkId,
			});
			return { linkId, url: workspaceShareUrl(origin, workspaceId, key) };
		},
		onSuccess: async ({ linkId, url }) => {
			setCopiedLinkId(linkId);
			// When the browser refuses, the address is shown to copy by hand.
			if (!(await linkCopy.copy(url))) setFreshUrl(url);
		},
	});
	const copyOwnLink = useMutation({
		mutationFn: (role: OsCollaboratorRole) =>
			osApi.osCollaborators.createLink({ workspaceId, role }),
		onSuccess: async ({ link, key }) => {
			setCopiedLinkId(OWN_LINK);
			highlight([link.id]);
			void refresh();
			const url = workspaceShareUrl(origin, workspaceId, key);
			// When the browser refuses, the address is shown to copy by hand.
			if (!(await linkCopy.copy(url))) setFreshUrl(url);
		},
	});
	const preview = useMutation({
		mutationFn: async (input: {
			target: OsCollaboratorTarget;
			label: string;
		}) => {
			const { affected } = await osApi.osCollaborators.previewRemove({
				workspaceId,
				target: input.target,
			});
			return { ...input, affected };
		},
		onSuccess: (result) => setPending({ ...result, keep: new Set() }),
	});
	const remove = useMutation({
		mutationFn: (removal: PendingRemoval) =>
			osApi.osCollaborators.remove({
				workspaceId,
				target: removal.target,
				keepUserIds: [...removal.keep],
			}),
		onSuccess: () => {
			setPending(null);
			void refresh();
		},
	});

	// The no-sign-in link: anyone holding it can view the workspace's
	// documents, sheets, slides and apps, read-only, without a Tedix account.
	// Turning it off revokes every active public link.
	const publicQuery = osSharesQueryOptions({
		resourceType: "workspace",
		resourceId: workspaceId,
	});
	const publicShares = useQuery(publicQuery);
	const activePublic = (publicShares.data?.items ?? []).filter(
		(share) => shareStatus(share) === "active",
	);
	// The no-sign-in link has a permanent address, shown whenever it is on.
	const publicUrl = activePublic[0]?.url ?? null;
	// What that link leaves out: files with connected data, apps that need sign-in.
	const publicLimits = publicShares.data?.guestLimits
		? workspaceGuestLimitsText(publicShares.data.guestLimits)
		: null;
	const publicToggle = useMutation({
		mutationFn: async (on: boolean) => {
			if (on) {
				await osApi.osShares.shares.create({
					resourceType: "workspace",
					resourceId: workspaceId,
					role: "use",
					access: "anyone_with_link",
					revisionMode: "living",
				});
				return;
			}
			for (const share of activePublic)
				await osApi.osShares.shares.revoke({ shareId: share.id });
		},
		onSuccess: () => {
			setFreshUrl(null);
			void queryClient.invalidateQueries({ queryKey: publicQuery.queryKey });
		},
	});

	const submitInvite = (event: FormEvent) => {
		event.preventDefault();
		if (inviteEmails.length > 0) invite.mutate(inviteEmails);
	};
	// A single-line field drops line breaks, so a pasted column of addresses
	// would run together; keep them apart.
	const pasteEmails = (event: ClipboardEvent<HTMLInputElement>) => {
		const text = event.clipboardData.getData("text");
		if (!/[\r\n]/.test(text)) return;
		event.preventDefault();
		const field = event.currentTarget;
		const start = field.selectionStart ?? email.length;
		const end = field.selectionEnd ?? email.length;
		setEmail(
			email.slice(0, start) +
				parseInviteEmails(text).join(", ") +
				email.slice(end),
		);
	};
	const data = sharing.data;
	// Never suggest someone already chosen or already in the workspace.
	const suggestions = useInviteSuggestions(
		email,
		new Set([
			...picked.map((person) => person.userId),
			...(data?.collaborators ?? []).map((person) => person.userId),
		]),
	);
	const pickSuggestion = (person: OsInviteSuggestion) => {
		setPicked((current) => [...current, person]);
		setEmail(withoutInviteSearchTerm(email));
	};
	const canGrantBuild = data?.role === "build";
	const canManage = data?.role === "build";
	const links = data?.links ?? [];
	const newestLink = links[0] ?? null;
	const isPrivate = props.visibility === "private";
	// Only an organization workspace names the organization.
	const organization =
		useQuery({
			...operationalContextQueryOptions(),
			enabled: props.visibility === "org",
		}).data?.organization.name ?? "your organization";
	const access: AccessChoice =
		activePublic.length > 0
			? "public"
			: newestLink
				? `link:${newestLink.role}`
				: "restricted";
	const accessLabel: Record<AccessChoice, string> = {
		restricted: restrictedAccessLabel(props.visibility, organization),
		"link:use": "Anyone with the link can use",
		"link:build": "Anyone with the link can build",
		public: "Anyone with the link can view, no sign-in",
	};
	const busy =
		createLink.isPending ||
		publicToggle.isPending ||
		preview.isPending ||
		remove.isPending ||
		setRole.isPending ||
		updateLink.isPending;
	const chooseAccess = (choice: AccessChoice) => {
		setStagedRole(null);
		setLinkName("");
		if (choice === access) return;
		if (choice === "restricted") {
			if (activePublic.length > 0) publicToggle.mutate(false);
			else if (newestLink)
				preview.mutate({
					target: { kind: "link", linkId: newestLink.id },
					label: newestLink.label ?? "this link",
				});
			return;
		}
		if (choice === "public") {
			publicToggle.mutate(true);
			return;
		}
		setFreshUrl(null);
		createLink.mutate({
			role: choice === "link:build" ? "build" : "use",
			label: "",
		});
	};
	const roleOptions: OsCollaboratorRole[] = canGrantBuild
		? ["use", "build"]
		: ["use"];

	return (
		<>
			{sharing.isError ? (
				<LoadError
					title="Can't load sharing"
					error={sharing.error}
					onRetry={() => {
						void sharing.refetch();
					}}
					retrying={sharing.isFetching}
				/>
			) : null}

			<form className="grid gap-2" onSubmit={submitInvite}>
				<SectionHeading
					learnMore={{
						label: "About invites",
						text: "They sign in with their own Tedix account and use their own AI model and connected accounts, never yours. Tedix tells them in the browser if they turned notifications on, and the workspace shows as new under their Shared with you list. No email is sent, so you may still want to send them the link.",
					}}
				>
					Add people
				</SectionHeading>
				<InviteChips
					people={picked}
					disabled={invite.isPending}
					onRemove={(person) =>
						setPicked((current) =>
							current.filter((entry) => entry.userId !== person.userId),
						)
					}
				/>
				<div className="flex flex-col gap-2 sm:flex-row">
					<Input
						aria-label="Names or email addresses"
						type="text"
						role="combobox"
						aria-autocomplete="list"
						aria-expanded={suggestions.people.length > 0}
						aria-controls={INVITE_SUGGESTIONS_ID}
						aria-activedescendant={
							suggestions.active
								? suggestionOptionId(suggestions.active)
								: undefined
						}
						autoComplete="off"
						autoCapitalize="off"
						spellCheck={false}
						placeholder="Names or email addresses, separated by commas"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						onKeyDown={(event) => {
							const person = suggestions.onKeyDown(event);
							if (person) pickSuggestion(person);
						}}
						onPaste={pasteEmails}
						className="min-w-0 flex-1"
						data-invite-emails
					/>
					<div className="flex gap-2">
						<RoleSelect
							ariaLabel="Role for the invited person"
							value={inviteRole}
							options={roleOptions}
							onChange={setInviteRole}
						/>
						<Button
							type="submit"
							className="max-sm:flex-1 max-sm:justify-center"
							loading={invite.isPending}
							disabled={inviteEmails.length === 0 || invite.isPending}
						>
							{inviteEmails.length > 1
								? `Invite ${inviteEmails.length} people`
								: "Invite"}
						</Button>
					</div>
				</div>
				<InviteSuggestionList
					people={suggestions.people}
					active={suggestions.active}
					onPick={pickSuggestion}
				/>
				<div className="grid gap-2" aria-live="polite">
					{suggestions.noMatch ? (
						<Text
							role="label"
							tone="secondary"
							className="m-0"
							data-invite-no-match
						>
							No one in your organization matches. Type their full email address
							instead.
						</Text>
					) : null}
					{invited?.failed.length ? (
						<ul className="m-0 grid list-none gap-1 p-0" data-invite-failures>
							{invited.failed.map((failure) => (
								<Text
									as="li"
									key={failure.email}
									role="label"
									tone="error"
									className="m-0"
								>
									{failure.message}
								</Text>
							))}
						</ul>
					) : null}
					{invited?.added.length ? (
						<div data-invited-link>
							<FreshLink
								title={`Added ${nameList(invited.added.map(personLabel))}. Tedix tells them; you can also send this link`}
								url={workspaceAddress(origin, workspaceId)}
							/>
						</div>
					) : null}
				</div>
			</form>

			<section className="grid gap-1" aria-label="People with access">
				<SectionHeading>People with access</SectionHeading>
				<ul className="m-0 grid list-none p-0">
					<PersonRow
						name={data?.ownerName ?? "Owner"}
						you={
							Boolean(data?.isOwner && you) &&
							you?.displayName === data?.ownerName
						}
						trailing={<Badge variant="secondary">Owner</Badge>}
					/>
					{props.visibility === "org" ? (
						<EveryoneRow organization={organization} />
					) : null}
					{data?.collaborators.map((person) => (
						<PersonRow
							key={person.userId}
							name={personLabel(person)}
							you={person.userId === you?.userId}
							highlighted={highlighted.has(person.userId)}
							detail={[
								person.name && person.email ? person.email : null,
								person.addedBy.length
									? `added by ${person.addedBy.join(", ")}`
									: null,
							]
								.filter(Boolean)
								.join(" · ")}
							data-collaborator={person.userId}
							trailing={
								<>
									{person.canChangeRole ? (
										<RoleSelect
											ariaLabel={`Role for ${personLabel(person)}`}
											value={person.role}
											options={roleOptions}
											disabled={busy}
											onChange={(role) =>
												role !== person.role &&
												setRole.mutate({ userId: person.userId, role })
											}
										/>
									) : (
										<Text as="span" role="label" tone="secondary">
											{ROLE_LABEL[person.role]}
										</Text>
									)}
									{person.canRemove ? (
										<DropdownMenu>
											<DropdownMenuTrigger
												render={
													<Button
														size="icon-sm"
														variant="ghost"
														aria-label={`Options for ${personLabel(person)}`}
														disabled={busy}
													/>
												}
											>
												<DotsThree size={16} weight="bold" />
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												<DropdownMenuItem
													variant="destructive"
													onClick={() =>
														preview.mutate({
															target: { kind: "user", userId: person.userId },
															label: personLabel(person),
														})
													}
												>
													<Prohibit size={14} /> Remove {personLabel(person)}
												</DropdownMenuItem>
											</DropdownMenuContent>
										</DropdownMenu>
									) : null}
								</>
							}
						/>
					))}
				</ul>
				{setRole.isError ? (
					<Text role="label" tone="error" className="m-0" aria-live="polite">
						{errorText(setRole.error, "Couldn't change that role.")}
					</Text>
				) : knockOn ? (
					<Text
						role="label"
						tone="secondary"
						className="m-0"
						aria-live="polite"
						data-role-knock-on
					>
						{knockOn}
					</Text>
				) : null}
			</section>

			<ConnectedData sources={publicShares.data?.connectedData ?? []} />

			{pending ? (
				<RemovalConfirm
					pending={pending}
					busy={remove.isPending}
					error={remove.isError ? errorText(remove.error, "") : null}
					onToggleKeep={(userId) =>
						setPending((current) => {
							if (!current) return current;
							const keep = new Set(current.keep);
							if (keep.has(userId)) keep.delete(userId);
							else keep.add(userId);
							return { ...current, keep };
						})
					}
					onCancel={() => setPending(null)}
					onConfirm={() => remove.mutate(pending)}
				/>
			) : null}
			{preview.isError ? (
				<Text role="label" tone="error" className="m-0">
					{errorText(preview.error, "Couldn't check who would be affected.")}
				</Text>
			) : null}

			<section
				className="grid gap-2 border-kumo-line border-t pt-4"
				aria-label="General access"
				data-general-access
			>
				<SectionHeading
					learnMore={{
						label: "About links",
						text: "A link with sign-in adds people at that role once they open it. The no-sign-in link shows the documents, sheets, slides and apps, read-only, never how they are built. Copy link gives you your own link for this workspace every time, with a fresh address; addresses you copied before keep working. A named link is a separate one for a group you may want to turn off on its own.",
					}}
				>
					General access
				</SectionHeading>
				<div className="flex flex-wrap items-center gap-2">
					{access !== "restricted" ? (
						<Globe size={16} className="shrink-0 text-kumo-subtle" />
					) : props.visibility === "org" ? (
						<UsersThree size={16} className="shrink-0 text-kumo-subtle" />
					) : (
						<Lock size={16} className="shrink-0 text-kumo-subtle" />
					)}
					<Select
						value={access}
						onValueChange={(value) => chooseAccess(value as AccessChoice)}
					>
						<SelectTrigger
							aria-label="General access"
							className="min-w-0 flex-1"
							disabled={busy || !data || !canManage}
						>
							<SelectValue>{accessLabel[access]}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="restricted">
								{accessLabel.restricted}
							</SelectItem>
							{roleOptions.map((role) => (
								<SelectItem key={role} value={`link:${role}`}>
									Anyone with the link can {ROLE_VERB[role]}
								</SelectItem>
							))}
							{isPrivate ? null : (
								<SelectItem value="public">{accessLabel.public}</SelectItem>
							)}
						</SelectContent>
					</Select>
					{newestLink && !freshUrl && !stagedRole && access !== "public" ? (
						<Button
							variant="secondary"
							size="sm"
							loading={copyOwnLink.isPending}
							disabled={copyOwnLink.isPending}
							onClick={() => copyOwnLink.mutate(newestLink.role)}
						>
							<LinkSimple size={14} />{" "}
							{copiedLinkId === OWN_LINK && linkCopy.state === "copied"
								? "Copied"
								: "Copy link"}
						</Button>
					) : null}
				</div>
				{props.visibility === "org" ? (
					<Text
						as="p"
						role="label"
						tone="secondary"
						className="m-0"
						data-organization-access
					>
						Everyone in {organization} can build here without a link. Links and
						invites are for people outside {organization}.
					</Text>
				) : null}
				{stagedRole ? (
					<form
						className="grid gap-2 rounded-md border border-kumo-line p-3"
						data-new-link
						onSubmit={(event) => {
							event.preventDefault();
							createLink.mutate({ role: stagedRole, label: linkName });
						}}
					>
						<Text as="span" role="label" tone="strong" className="m-0">
							Name this link
						</Text>
						<div className="flex flex-col gap-2 sm:flex-row">
							<Input
								aria-label="Name this link"
								autoFocus
								maxLength={120}
								placeholder="For example: Reviewers"
								value={linkName}
								onChange={(event) => setLinkName(event.target.value)}
								className="min-w-0 flex-1"
							/>
							{roleOptions.length > 1 ? (
								<RoleSelect
									ariaLabel="Role for people with this link"
									value={stagedRole}
									options={roleOptions}
									onChange={setStagedRole}
								/>
							) : null}
						</div>
						<Text role="label" tone="secondary" className="m-0">
							A named link is separate from your own link, so you can turn it
							off later without affecting anyone else.
						</Text>
						<div className="flex flex-wrap gap-2">
							<Button
								type="submit"
								size="sm"
								loading={createLink.isPending}
								disabled={!linkName.trim()}
							>
								<LinkSimple size={14} /> Create link
							</Button>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								disabled={createLink.isPending}
								onClick={() => {
									setStagedRole(null);
									setLinkName("");
								}}
							>
								Cancel
							</Button>
						</div>
					</form>
				) : data && canManage ? (
					<div>
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							data-add-named-link
							onClick={() => {
								createLink.reset();
								setFreshUrl(null);
								setStagedRole(newestLink?.role ?? "use");
							}}
						>
							<LinkSimple size={14} /> New named link
						</Button>
					</div>
				) : null}
				<LinkCopyStatus state={linkCopy.state} showCopied />
				{freshUrl ? (
					<div data-fresh-link>
						<FreshLink
							url={freshUrl}
							note="Anyone who opens it and signs in joins at this role. Copy link in the list below makes a fresh address for it later."
							onDismiss={() => setFreshUrl(null)}
						/>
					</div>
				) : null}
				{access === "public" && publicUrl ? (
					<div data-public-url>
						<PermanentUrl url={publicUrl} />
					</div>
				) : null}
				{access === "public" && publicLimits ? (
					<Text
						as="p"
						role="label"
						tone="secondary"
						className="m-0"
						data-guest-limits
					>
						{publicLimits}
					</Text>
				) : null}
				{links.length > 0 ? (
					<ul className="m-0 grid list-none p-0" data-share-link-list>
						{links.map((link) => (
							<li
								key={link.id}
								className={`grid gap-2 ${ROW_CLASS}${highlighted.has(link.id) ? " bg-kumo-tint" : ""}`}
								data-share-link={link.id}
								data-highlighted={highlighted.has(link.id) || undefined}
							>
								<div className="flex min-h-10 items-center gap-2">
									<LinkSimple size={14} className="shrink-0 text-kumo-subtle" />
									<span className="grid min-w-0 flex-1">
										<Text as="span" role="body" className="truncate">
											{link.label ??
												(link.createdBy.userId === you?.userId
													? "Your link"
													: "Link with sign-in")}
										</Text>
										<Text
											as="span"
											role="label"
											tone="secondary"
											className="truncate"
										>
											{[
												ROLE_LABEL[link.role],
												`made by ${personLabel(link.createdBy)}`,
												relativeTime(link.createdAt),
											]
												.filter(Boolean)
												.join(" · ")}
										</Text>
									</span>
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													size="icon-sm"
													variant="ghost"
													aria-label={`Options for ${link.label ?? "link"}`}
													disabled={busy || copyLink.isPending}
												/>
											}
										>
											<DotsThree size={16} weight="bold" />
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem
												onClick={() => copyLink.mutate(link.id)}
											>
												<LinkSimple size={14} /> Copy link
											</DropdownMenuItem>
											{link.canEdit ? (
												<DropdownMenuItem
													onClick={() => {
														updateLink.reset();
														setEditingLinkId(link.id);
													}}
												>
													<PencilSimple size={14} /> Edit settings
												</DropdownMenuItem>
											) : null}
											{link.canRevoke ? (
												<DropdownMenuItem
													variant="destructive"
													onClick={() =>
														preview.mutate({
															target: { kind: "link", linkId: link.id },
															label: link.label ?? "this link",
														})
													}
												>
													<Prohibit size={14} /> Turn off
												</DropdownMenuItem>
											) : null}
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
								{editingLinkId === link.id ? (
									<LinkSettingsForm
										link={link}
										roleOptions={roleOptions}
										pending={updateLink.isPending}
										error={
											updateLink.isError
												? errorText(updateLink.error, "Couldn't save the link.")
												: null
										}
										onSave={(settings) =>
											updateLink.mutate({ linkId: link.id, ...settings })
										}
										onCancel={() => setEditingLinkId(null)}
									/>
								) : null}
							</li>
						))}
					</ul>
				) : null}
				{copyOwnLink.isError ? (
					<Text role="label" tone="error" className="m-0" aria-live="polite">
						{errorText(copyOwnLink.error, "Couldn't get the link. Try again.")}
					</Text>
				) : createLink.isError || publicToggle.isError ? (
					<Text role="label" tone="error" className="m-0" aria-live="polite">
						{errorText(
							createLink.error ?? publicToggle.error,
							"Couldn't change the link.",
						)}
					</Text>
				) : copyLink.isError ? (
					<Text role="label" tone="error" className="m-0" aria-live="polite">
						{errorText(copyLink.error, "Couldn't get the link. Try again.")}
					</Text>
				) : null}
			</section>
		</>
	);
}

/**
 * A link's label and role, changed in place. The link keeps working and its
 * URL is never shown again.
 */
function LinkSettingsForm(props: {
	link: OsCollaboratorLink;
	roleOptions: OsCollaboratorRole[];
	pending: boolean;
	error: string | null;
	onSave: (settings: { label: string; role: OsCollaboratorRole }) => void;
	onCancel: () => void;
}) {
	const [label, setLabel] = useState(props.link.label ?? "");
	const [role, setRole] = useState<OsCollaboratorRole>(props.link.role);
	const options = props.roleOptions.includes(props.link.role)
		? props.roleOptions
		: [...props.roleOptions, props.link.role];
	return (
		<form
			className="grid gap-2 rounded-md border border-kumo-line p-3"
			data-link-settings
			onSubmit={(event) => {
				event.preventDefault();
				props.onSave({ label, role });
			}}
		>
			<div className="flex flex-col gap-2 sm:flex-row">
				<Input
					aria-label="Link name"
					placeholder="Link with sign-in"
					maxLength={120}
					value={label}
					onChange={(event) => setLabel(event.target.value)}
					className="min-w-0 flex-1"
				/>
				<RoleSelect
					ariaLabel="Role for people with this link"
					value={role}
					options={options}
					onChange={setRole}
				/>
			</div>
			<Text role="label" tone="secondary" className="m-0">
				The link stays the same. Everyone who joined through it moves to the new
				role.
			</Text>
			{props.error ? (
				<Text role="label" tone="error" className="m-0" aria-live="polite">
					{props.error}
				</Text>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button type="submit" size="sm" loading={props.pending}>
					Save
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					onClick={props.onCancel}
				>
					Cancel
				</Button>
			</div>
		</form>
	);
}

function RoleSelect(props: {
	ariaLabel: string;
	value: OsCollaboratorRole;
	options: OsCollaboratorRole[];
	onChange: (role: OsCollaboratorRole) => void;
	disabled?: boolean;
}) {
	return (
		<Select
			value={props.value}
			onValueChange={(value) => props.onChange(value as OsCollaboratorRole)}
		>
			<SelectTrigger
				aria-label={props.ariaLabel}
				className="shrink-0"
				disabled={props.disabled}
			>
				<SelectValue>{ROLE_LABEL[props.value]}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{props.options.map((role) => (
					<SelectItem key={role} value={role}>
						{ROLE_LABEL[role]}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function PersonRow(props: {
	name: string;
	detail?: string;
	icon?: ReactNode;
	trailing: ReactNode;
	/** This row is the person looking at the dialog. */
	you?: boolean;
	/** Just added: stands out for a moment. */
	highlighted?: boolean;
	"data-collaborator"?: string;
}) {
	return (
		<li
			className={`flex min-h-11 items-center gap-3 ${ROW_CLASS}${props.highlighted ? " bg-kumo-tint" : ""}`}
			data-collaborator={props["data-collaborator"]}
			data-highlighted={props.highlighted || undefined}
		>
			<Avatar size="sm">
				<AvatarFallback>{props.icon ?? initials(props.name)}</AvatarFallback>
			</Avatar>
			<span className="grid min-w-0 flex-1">
				<Text as="span" role="body" className="truncate">
					{props.name}
					{props.you ? " (you)" : ""}
				</Text>
				{props.detail ? (
					<Text as="span" role="label" tone="secondary" className="truncate">
						{props.detail}
					</Text>
				) : null}
			</span>
			<span className="flex shrink-0 items-center gap-1">{props.trailing}</span>
		</li>
	);
}

/** An organization workspace is open to every member, at build level. */
function EveryoneRow(props: { organization: string }) {
	return (
		<PersonRow
			name={`Everyone in ${props.organization}`}
			icon={<UsersThree size={12} />}
			trailing={
				<Text as="span" role="label" tone="secondary">
					{ROLE_LABEL.build}
				</Text>
			}
		/>
	);
}

function RemovalConfirm(props: {
	pending: PendingRemoval;
	busy: boolean;
	error: string | null;
	onToggleKeep: (userId: string) => void;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const { pending } = props;
	const { removed, downgraded } = removalConsequences(
		pending.affected,
		pending.target,
	);
	const isLink = pending.target.kind === "link";
	return (
		<Alert variant="warning" data-removal-confirm>
			<AlertTitle>
				{isLink ? `Turn off ${pending.label}?` : `Remove ${pending.label}?`}
			</AlertTitle>
			<AlertDescription className="grid gap-3">
				<p className="m-0">
					{isLink
						? "The link stops working. People who joined only through it lose access."
						: "They lose the access you gave them."}
				</p>
				{removed.length > 0 ? (
					<p className="m-0">
						This also removes{" "}
						{removed.map((person) => personLabel(person)).join(", ")}.
					</p>
				) : null}
				{downgraded.length > 0 ? (
					<p className="m-0">
						{downgraded
							.map(
								(person) =>
									`${personLabel(person)} drops to ${ROLE_LABEL[person.newRole ?? "use"].toLowerCase()}`,
							)
							.join("; ")}
						.
					</p>
				) : null}
				{removed.length + downgraded.length > 0 ? (
					<div className="grid gap-1">
						{[...removed, ...downgraded].map((person) => (
							<Checkbox
								key={person.userId}
								checked={pending.keep.has(person.userId)}
								onCheckedChange={() => props.onToggleKeep(person.userId)}
								label={`Keep ${personLabel(person)} at ${ROLE_LABEL[person.oldRole].toLowerCase()}`}
							/>
						))}
					</div>
				) : null}
				{props.error ? (
					<Text role="label" tone="error" className="m-0">
						{props.error}
					</Text>
				) : null}
				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						variant="destructive"
						loading={props.busy}
						onClick={props.onConfirm}
					>
						{isLink ? "Turn off link" : "Remove"}
					</Button>
					<Button size="sm" variant="ghost" onClick={props.onCancel}>
						Cancel
					</Button>
				</div>
			</AlertDescription>
		</Alert>
	);
}

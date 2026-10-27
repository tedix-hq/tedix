import {
	type WorkstationProfileId,
	type WorkstationAdapter,
	getWorkstationProfile,
} from "@tedix/api-contract/schemas/workstation";
import {
	WORKSTATION_DIR,
	WORKSTATION_HOME,
	WORKSTATION_REPOS_DIR,
} from "../../../workstation/paths";
import { WORKSTATION_EGRESS_GUARD_VERSION } from "../../../workstation/egress-guard";

export const WORKSTATION_HEADER = "X-Tedix-Workstation";
export const WORKSTATION_CONVERSATION_HEADER =
	"X-Tedix-Workstation-Conversation-Id";
export const WORKSTATION_RUN_HEADER = "X-Tedix-Workstation-Run-Id";

export const ACTIVE_WORKSTATION_PROFILE_ID =
	"general" satisfies WorkstationProfileId;

export const ACTIVE_WORKSTATION_SESSION_ADAPTER =
	"sandbox-workstation" satisfies WorkstationAdapter;

export const ACTIVE_WORKSTATION_PROFILE = getWorkstationProfile(
	ACTIVE_WORKSTATION_PROFILE_ID,
);

export const ACTIVE_WORKSTATION_BINDING = {
	adapterKind: "cloudflare-sandbox-workstation",
	bodyAdapter: "tedix-sandbox-workstation",
	profile: ACTIVE_WORKSTATION_PROFILE,
	sessionAdapter: ACTIVE_WORKSTATION_SESSION_ADAPTER,
} as const;

if (
	!ACTIVE_WORKSTATION_BINDING.profile.defaultAdapters.includes(
		ACTIVE_WORKSTATION_BINDING.sessionAdapter,
	)
) {
	throw new Error(
		`Workstation profile ${ACTIVE_WORKSTATION_BINDING.profile.id} does not allow adapter ${ACTIVE_WORKSTATION_BINDING.sessionAdapter}`,
	);
}

export const WORKSTATION_JOBS_DIR = `${WORKSTATION_DIR}/jobs`;

export const WORKSTATION_OPERATION_LOCKS_DIR = `${WORKSTATION_DIR}/locks/operations`;

export const WORKSTATION_SESSION_LOCKS_DIR = `${WORKSTATION_DIR}/locks/sessions`;

export const WORKSTATION_BOOTSTRAP_INSTALL_PROCESS_ID = "bootstrap-install";

export const WORKSTATION_BOOTSTRAP_INSTALL_STUCK_MS = 30 * 60 * 1000;

// Wall-clock ceiling for an AUTO-started bootstrap install. Kept below
// WORKSTATION_BOOTSTRAP_INSTALL_STUCK_MS (30m) so a job that overruns records
// `timed_out_at` and surfaces as "timed_out" (operator restart) rather than
// "stuck". A cold full-monorepo install downloads thousands of tarballs through
// the per-host egress proxy. Immutable public package tarballs are edge-cached
// by that broker, and retries retain the package cache before one final clean
// fallback. Only applies to the self-bootstrap path (scheduleBootstrapInstall).
export const WORKSTATION_BOOTSTRAP_INSTALL_TIMEOUT_MS = 25 * 60 * 1000;

// Cooldown after a bootstrap-install LAUNCH failure (Computer exec rejected before
// the wrapped command ran, so no job dir/sentinel exists). Throttles the
// self-bootstrap retry so a persistently-failing launch is not re-fired on every
// readiness poll. See scheduleBootstrapInstall.
export const WORKSTATION_BOOTSTRAP_INSTALL_LAUNCH_BACKOFF_MS = 2 * 60 * 1000;

export const WORKSTATION_BOOTSTRAP_CACHE_RESTORED_AT_PATH = `${WORKSTATION_DIR}/cache/restored_at`;

export const WORKSTATION_BOOTSTRAP_PACKAGE_CACHE_DIR = `${WORKSTATION_DIR}/cache/package-managers`;

export const WORKSTATION_BOOTSTRAP_DEPENDENCY_MARKER =
	"node_modules/.tedix-dependency-fingerprint";

export const WORKSTATION_BOOTSTRAP_CACHE_RECORD_VERSION = 3;

export const WORKSTATION_BOOTSTRAP_CACHE_PROFILE_VERSION = `${ACTIVE_WORKSTATION_BINDING.adapterKind}:${WORKSTATION_EGRESS_GUARD_VERSION}:dependency-cache-v6`;

export const WORKSTATION_BOOTSTRAP_CACHE_MAX_RECORDS = 4;

// Sandbox directory snapshots traverse the full dependency tree inside the DO.
// A live 3,116-package Tedix install exceeded the DO memory limit and replaced
// the Computer generation immediately after readiness. Existing cache records
// remain readable, but writes stay disabled until backup is streamed outside
// the DO rather than materialized through Sandbox.
export const WORKSTATION_BOOTSTRAP_CACHE_BACKUP_ENABLED = false;

export const WORKSTATION_OPERATION_LOCK_TIMEOUT_SECONDS = 600;

export const WORKSTATION_OPERATION_LOCK_STALE_SECONDS = 30 * 60;

export const DEFAULT_PROCESS_TAIL_BYTES = 64_000;

export const MAX_PROCESS_TAIL_BYTES = 256_000;

// Native reviewer reads are deliberately bounded to 200k characters. Publish
// that same bounded tail inline so a terminal log artifact is actually
// inspectable through artifact:// instead of merely pointing at private R2.
export const MAX_REVIEWER_OPENABLE_LOG_BYTES = 200_000;

// Must match the TEDI_STORAGE binding's real bucket (cloudflare.config.ts): the
// artifact-serve streamer resolves r2://<bucket>/ refs by name. Older rows
// carry the legacy "tedi-storage" ref, which artifact-serve aliases.
export const WORKSTATION_PROCESS_ARTIFACT_BUCKET_REF = "tedix-tedi-production";

export const WORKSTATION_PATHS = new Set([
	"/api/admin/workstation/repository/inspect",
	"/api/admin/workstation/wake",
	"/api/admin/workstation/provision",
	"/api/admin/workstation/exec",
	"/api/admin/workstation/files",
	"/api/admin/workstation/dev-server",
	"/api/admin/workstation/process/start",
	"/api/admin/workstation/process/status",
	"/api/admin/workstation/process/wait",
	"/api/admin/workstation/process/cancel",
	"/api/admin/workstation/join",
	"/api/admin/workstation/release",
	"/api/admin/workstation/status",
]);

export const CHECKOUT_CLOSING_MARKER = `${WORKSTATION_DIR}/locks/checkout.closing`;

export const WORKSTATION_EGRESS_GUARD_MARKER = `${WORKSTATION_HOME}/.tedix-egress-guard-${WORKSTATION_EGRESS_GUARD_VERSION}`;

// The marker-write exec forces a cold Computer host to boot. Computer owns a
// 180s connection budget including one native restart, so the edge must remain
// alive beyond that complete recovery window rather than abandon valid work.
export const WORKSTATION_EGRESS_GUARD_BOOT_TIMEOUT_MS = 195_000;

export const REPO_SYNC_OPTIONS = {
	markerFile: ".git/tedix-workstation-repo.json",
	repoStrategy: ACTIVE_WORKSTATION_PROFILE.repoStrategy,
	reposRoot: WORKSTATION_REPOS_DIR,
	workdirSource: "derived",
} as const;

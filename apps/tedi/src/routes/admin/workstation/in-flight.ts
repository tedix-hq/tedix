export const repoSyncInFlight = new Map<string, Promise<void>>();

/**
 * In-flight background bootstrap-install launches per workstation id. Guards the
 * same-isolate launch window so concurrent readiness probes don't each fire a
 * Computer execution for the install (the OS `package_install` lock + the
 * `installRunning` probe guard cross-isolate / post-launch). See
 * {@link scheduleBootstrapInstall}.
 */
export const bootstrapInstallInFlight = new Map<string, Promise<void>>();

/**
 * Last bootstrap-install LAUNCH failure time per workstation id. A failed Computer exec
 * writes no job dir, so the readiness probe keeps reporting installStatus
 * "missing"; this timestamp throttles the auto-start retry to once per
 * {@link WORKSTATION_BOOTSTRAP_INSTALL_LAUNCH_BACKOFF_MS}. Cleared on a successful
 * launch. See {@link scheduleBootstrapInstall}.
 */
export const bootstrapInstallLaunchFailedAt = new Map<string, number>();

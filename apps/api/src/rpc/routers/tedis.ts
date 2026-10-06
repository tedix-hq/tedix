import {
	inspectRuntimeCutoverProcedure,
	operateRuntimeCutoverProcedure,
} from "./tedis/cutover-inventory";
import { inspectRuntimeRecoveryProcedure } from "./tedis/recovery-diagnostic";
import {
	runTediDurableCode,
	listTediCodeExecutions,
	getTediCodeExecution,
	approveTediCodeExecution,
	rejectTediCodeExecution,
	rollbackTediCodeExecution,
	recoverTediCodeExecution,
} from "./tedis/durable-code";
/** Tedis router composition. Capability handlers live in ./tedis/. */
import { resolveEmbeddedHostDelegationProcedure } from "./tedis/embedded-host-delegation";
import {
	identifyEmbeddedProviderContact,
	listWidgetContacts,
	getWidgetContact,
} from "./tedis/embedded-contacts";
import {
	configureProviderOnboarding,
	getProviderOnboardingStatus,
	activateProviderCustomer,
} from "./tedis/provider-onboarding";

import {
	listWidgetAccessConfigurations,
	updateWidgetAccessConfiguration,
	previewWidgetAccess,
	authorizeEmbeddedWidgetAccess,
} from "./tedis/widget-access";
import { tedisOs } from "./tedis/helpers";

import {
	approvePairingProcedure,
	listPairingRequestsProcedure,
	testChannelTokenProcedure,
	updateChannelConfigProcedure,
	validateChannelTokenProcedure,
} from "./tedis/channels";
import {
	cleanupSnapshots,
	getModelPolicy,
	getRuntimeProjection,
	ingestRuntimeProjection,
	listRuntimeMetaBySlugs,
	syncConfig,
} from "./tedis/config";
import { initiateAppConnectionProcedure } from "./tedis/connections";
// Import all procedures from split modules
import {
	createTediProcedure,
	decommissionTediProcedure,
	deleteTediProcedure,
	getLogsProcedure,
	getTedi,
	inspectAgentMemoryProcedure,
	listTedis,
	rebindProcedure,
	repairTediProcedure,
	rotateAccessKeyProcedure,
	updateTediGovernanceProcedure,
	updateTediProcedure,
} from "./tedis/crud";
import {
	approveDeviceProcedure,
	listDevices,
	revokeDeviceProcedure,
} from "./tedis/devices";
import {
	addCustomDomainProcedure,
	listCustomDomains,
	removeCustomDomainProcedure,
} from "./tedis/domains";
import {
	authorizeOsPortableCallProcedure,
	createEmbeddedSessionProcedure,
	listPeersProcedure,
	sendMessageProcedure,
} from "./tedis/gateway";
import {
	attachEmbeddedConversationCapabilityProcedure,
	attachEmbeddedConversationArtifactPinProcedure,
	detachEmbeddedConversationArtifactPinProcedure,
	detachEmbeddedConversationCapabilityProcedure,
	listEmbeddedConversationArtifactPinsProcedure,
	listEmbeddedConversationCapabilitiesProcedure,
} from "./tedis/embedded-conversation-capabilities";
import { listOperationsSummariesProcedure } from "./tedis/operations-summary";
import { portableSnapshotPageProcedure } from "./tedis/portable-snapshot";
import { portableGitReadAccessProcedure } from "./tedis/portable-export-access";
import { portableImportBeginProcedure } from "./tedis/portable-import-access";
import { inspectRuntimeOutboxProcedure } from "./tedis/outbox-diagnostic";
import {
	createEmbeddedProviderSessionProcedure,
	getEmbeddedProviderAvailabilityProcedure,
	getProviderInstallationProcedure,
	listPortableWebMcpConfigurationsProcedure,
	publishPortableWebMcpProfileProcedure,
	provisionProviderInstallationProcedure,
	setProviderInstallationPausedProcedure,
	validatePortableWebMcpProfileProcedure,
} from "./tedis/provider-installations";
import {
	auditBackupsProcedure,
	authorizeCodingSessionProcedure,
	deleteStorageFileProcedure,
	getChannelStatus,
	getDreamsProcedure,
	getStatus,
	getStorageFileProcedure,
	getStorageStatusProcedure,
	listStorageFilesProcedure,
	resetSandboxProcedure,
	restart,
	revokeCodingSessionProcedure,
	syncStorage,
	triggerCronSyncProcedure,
	wake,
	writeStorageFileProcedure,
} from "./tedis/runtime";
import { listSchedulesProcedure } from "./tedis/schedules";
import {
	deleteSessionProcedure,
	deleteSessionsProcedure,
	listSessionStatesProcedure,
	updateSessionStateProcedure,
} from "./tedis/sessions";

// =============================================================================
// CONTRACT ROUTER
// =============================================================================

export const tedisContractRouter = tedisOs.router({
	runTediDurableCode,
	listTediCodeExecutions,
	getTediCodeExecution,
	approveTediCodeExecution,
	rejectTediCodeExecution,
	rollbackTediCodeExecution,
	recoverTediCodeExecution,
	identifyEmbeddedProviderContact,
	listWidgetContacts,
	getWidgetContact,
	configureProviderOnboarding,
	getProviderOnboardingStatus,
	activateProviderCustomer,
	list: listTedis,
	listOperationsSummaries: listOperationsSummariesProcedure,
	portableSnapshotPage: portableSnapshotPageProcedure,
	portableGitReadAccess: portableGitReadAccessProcedure,
	portableImportBegin: portableImportBeginProcedure,
	auditBackups: auditBackupsProcedure,
	get: getTedi,
	listRuntimeMetaBySlugs,
	create: createTediProcedure,
	update: updateTediProcedure,
	delete: deleteTediProcedure,
	getLogs: getLogsProcedure,
	listCustomDomains,
	addCustomDomain: addCustomDomainProcedure,
	removeCustomDomain: removeCustomDomainProcedure,
	getStatus,
	listSchedules: listSchedulesProcedure,
	inspectRuntimeOutbox: inspectRuntimeOutboxProcedure,
	inspectRuntimeCutover: inspectRuntimeCutoverProcedure,
	operateRuntimeCutover: operateRuntimeCutoverProcedure,
	inspectRuntimeRecovery: inspectRuntimeRecoveryProcedure,
	inspectAgentMemory: inspectAgentMemoryProcedure,
	wake,
	getChannelStatus,
	restart,
	resetSandbox: resetSandboxProcedure,
	syncStorage,
	triggerCronSync: triggerCronSyncProcedure,
	getStorageStatus: getStorageStatusProcedure,
	listStorageFiles: listStorageFilesProcedure,
	getStorageFile: getStorageFileProcedure,
	writeStorageFile: writeStorageFileProcedure,
	deleteStorageFile: deleteStorageFileProcedure,
	getDreams: getDreamsProcedure,
	listSessionStates: listSessionStatesProcedure,
	updateSessionState: updateSessionStateProcedure,
	deleteSession: deleteSessionProcedure,
	deleteSessions: deleteSessionsProcedure,
	listPeers: listPeersProcedure,
	rotateAccessKey: rotateAccessKeyProcedure,
	syncConfig,
	getModelPolicy,
	getRuntimeProjection,
	ingestRuntimeProjection,
	cleanupSnapshots,
	testChannelToken: testChannelTokenProcedure,
	validateChannelToken: validateChannelTokenProcedure,
	listPairingRequests: listPairingRequestsProcedure,
	approvePairing: approvePairingProcedure,
	updateChannelConfig: updateChannelConfigProcedure,
	listDevices,
	approveDevice: approveDeviceProcedure,
	revokeDevice: revokeDeviceProcedure,
	initiateAppConnection: initiateAppConnectionProcedure,
	sendMessage: sendMessageProcedure,
	createEmbeddedSession: createEmbeddedSessionProcedure,
	authorizeOsPortableCall: authorizeOsPortableCallProcedure,
	listEmbeddedConversationCapabilities:
		listEmbeddedConversationCapabilitiesProcedure,
	attachEmbeddedConversationCapability:
		attachEmbeddedConversationCapabilityProcedure,
	detachEmbeddedConversationCapability:
		detachEmbeddedConversationCapabilityProcedure,
	listEmbeddedConversationArtifactPins:
		listEmbeddedConversationArtifactPinsProcedure,
	attachEmbeddedConversationArtifactPin:
		attachEmbeddedConversationArtifactPinProcedure,
	detachEmbeddedConversationArtifactPin:
		detachEmbeddedConversationArtifactPinProcedure,
	listWidgetAccessConfigurations,
	updateWidgetAccessConfiguration,
	previewWidgetAccess,
	authorizeEmbeddedWidgetAccess,
	createEmbeddedProviderSession: createEmbeddedProviderSessionProcedure,
	resolveEmbeddedHostDelegation: resolveEmbeddedHostDelegationProcedure,
	getEmbeddedProviderAvailability: getEmbeddedProviderAvailabilityProcedure,
	provisionProviderInstallation: provisionProviderInstallationProcedure,
	getProviderInstallation: getProviderInstallationProcedure,
	setProviderInstallationPaused: setProviderInstallationPausedProcedure,
	validatePortableWebMcpProfile: validatePortableWebMcpProfileProcedure,
	listPortableWebMcpConfigurations: listPortableWebMcpConfigurationsProcedure,
	publishPortableWebMcpProfile: publishPortableWebMcpProfileProcedure,
	repair: repairTediProcedure,
	updateGovernance: updateTediGovernanceProcedure,
	rebind: rebindProcedure,
	decommission: decommissionTediProcedure,
	authorizeCodingSession: authorizeCodingSessionProcedure,
	revokeCodingSession: revokeCodingSessionProcedure,
});

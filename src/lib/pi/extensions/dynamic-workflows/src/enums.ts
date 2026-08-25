/** Classifies a workflow capability by its runtime and documentation role. */
export const CapabilityClassification = {
  RUNTIME_GLOBAL: "runtime-global",
  WORKFLOW_TOOL_INPUT: "workflow-tool-input",
  SCRIPT_CONTRACT: "script-contract",
  COMPATIBILITY_BEHAVIOR: "compatibility-behavior",
  INTERNAL_SUBSTRATE: "internal-substrate",
  DYNAMIC_REFERENCE: "dynamic-reference",
} as const;
export type CapabilityClassification = (typeof CapabilityClassification)[keyof typeof CapabilityClassification];

/** Declares whether workflow authors should use a capability. */
export const CapabilitySupport = {
  SUPPORTED: "supported",
  COMPATIBILITY: "compatibility",
  INTERNAL: "internal",
} as const;
export type CapabilitySupport = (typeof CapabilitySupport)[keyof typeof CapabilitySupport];

/** Identifies the model-visible surface responsible for discovery. */
export const DiscoveryPlacement = {
  COMPACT_GUIDANCE: "compact-guidance",
  WORKFLOW_AUTHORING_SKILL: "workflow-authoring-skill",
  NONE: "none",
} as const;
export type DiscoveryPlacement = (typeof DiscoveryPlacement)[keyof typeof DiscoveryPlacement];

/** Names the subsystem that owns a capability's behavior. */
export const CapabilityOrigin = {
  PROJECT: "project",
  TOOL_ADAPTER: "tool-adapter",
  VM_REALM: "vm-realm",
  LIVE_CONFIGURATION: "live-configuration",
} as const;
export type CapabilityOrigin = (typeof CapabilityOrigin)[keyof typeof CapabilityOrigin];

/** Severity carried by capability-alignment diagnostics. */
export const DiagnosticSeverity = {
  ERROR: "error",
  WARNING: "warning",
  INFORMATION: "information",
} as const;
export type DiagnosticSeverity = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

/** Optional model-comprehension scenario groups. */
export const ComprehensionSuite = {
  QUICK: "quick",
  FULL: "full",
  COVERAGE: "coverage",
} as const;
export type ComprehensionSuite = (typeof ComprehensionSuite)[keyof typeof ComprehensionSuite];

/** Authoring operation exercised by a comprehension scenario. */
export const ComprehensionTaskKind = {
  WRITE: "write",
  EDIT: "edit",
  REVIEW: "review",
  DEBUG: "debug",
} as const;
export type ComprehensionTaskKind = (typeof ComprehensionTaskKind)[keyof typeof ComprehensionTaskKind];

/** Whether authoring guidance may be optimized against behavioral evidence or must remain frozen. */
export const WorkflowAuthoringProtection = {
  BEHAVIORALLY_COVERED: "behaviorally-covered",
  GUIDANCE_FROZEN: "guidance-frozen",
} as const;
export type WorkflowAuthoringProtection = (typeof WorkflowAuthoringProtection)[keyof typeof WorkflowAuthoringProtection];

/** Machine-readable release-gate failure and warning domains. */
export const WorkflowReleaseDiagnosticCode = {
  INCOMPATIBLE_VERSION: "INCOMPATIBLE_VERSION",
  MISSING_BEHAVIOR_EVIDENCE: "MISSING_BEHAVIOR_EVIDENCE",
  UNRESOLVED_BEHAVIOR_EVIDENCE: "UNRESOLVED_BEHAVIOR_EVIDENCE",
  BROKEN_CONTRACT_REFERENCE: "BROKEN_CONTRACT_REFERENCE",
  MISSING_PACKAGE_RESOURCE: "MISSING_PACKAGE_RESOURCE",
  BROKEN_PACKAGE_LINK: "BROKEN_PACKAGE_LINK",
  STALE_GENERATED_SURFACE: "STALE_GENERATED_SURFACE",
  TOOL_INPUT_MISMATCH: "TOOL_INPUT_MISMATCH",
  RUNTIME_CONSTRAINT_DISAGREEMENT: "RUNTIME_CONSTRAINT_DISAGREEMENT",
  NON_CONTRACTUAL_PROSE_DRIFT: "NON_CONTRACTUAL_PROSE_DRIFT",
  MISSING_AUTHORING_COVERAGE: "MISSING_AUTHORING_COVERAGE",
  UNPROTECTED_AUTHORING_GUIDANCE: "UNPROTECTED_AUTHORING_GUIDANCE",
  PROTECTED_GUIDANCE_DRIFT: "PROTECTED_GUIDANCE_DRIFT",
  UNKNOWN_COMPREHENSION_SCENARIO: "UNKNOWN_COMPREHENSION_SCENARIO",
} as const;
export type WorkflowReleaseDiagnosticCode = (typeof WorkflowReleaseDiagnosticCode)[keyof typeof WorkflowReleaseDiagnosticCode];

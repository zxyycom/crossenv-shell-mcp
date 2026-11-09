type FailureKind = "missing" | "drift" | "blocked";

// One closed set owns the meaning consumed by both execution and Info.
const failureKinds = {
  managed_block_invalid: "blocked",
  ssh_config_invalid: "blocked",
  dynamic_ssh_config_unsupported: "blocked",
  ssh_alias_conflict: "blocked",
  ssh_alias_not_configured: "missing",
  managed_block_drift: "drift",
  ssh_directory_not_regular: "blocked",
  ssh_directory_resolution_failed: "blocked",
  local_config_changed_during_apply: "blocked",
  public_identity_still_referenced: "blocked",
  client_config_postcheck_failed: "blocked",
  client_config_filesystem_failed: "blocked",
  client_config_program_failed: "blocked",
  ssh_process_timeout: "blocked",
  local_file_not_regular: "blocked",
  local_file_unreadable: "blocked",
  public_identity_invalid: "blocked",
  public_identity_not_configured: "missing",
  public_identity_drift: "drift",
  ssh_agent_unavailable: "blocked",
  agent_identity_not_configured: "missing",
  agent_identity_ambiguous: "drift",
  agent_identity_drift: "drift",
  host_pin_not_configured: "missing",
  host_pin_probe_unavailable: "blocked",
  host_pin_drift: "drift",
  effective_config_invalid: "blocked",
  effective_config_drift: "drift",
  ssh_client_unavailable: "blocked",
  ssh_execution_timeout: "blocked",
  ssh_execution_interrupted: "blocked",
  ssh_session_cleanup_failed: "blocked",
} as const satisfies Record<string, FailureKind>;

export type SshTargetFailureReason = keyof typeof failureKinds;

/** A malformed machine response is a hard failure, never an unavailable environment fact. */
export class SshTargetProtocolError extends Error {}

export class SshTargetBoundaryError extends Error {
  readonly kind: FailureKind;
  readonly reason: SshTargetFailureReason;

  constructor(reason: SshTargetFailureReason, message: string) {
    super(message);
    this.reason = reason;
    this.kind = failureKinds[reason];
  }
}

export function blocked(reason: SshTargetFailureReason, message: string): never {
  throw new SshTargetBoundaryError(reason, message);
}

/** Keep only an OS/runtime error code; never copy command output, paths or arbitrary messages. */
export function systemErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return undefined;
  if (error instanceof TypeError || error instanceof RangeError) return undefined;
  return /^E(?!RR_)[A-Z0-9_]{1,39}$/.test(error.code) ? error.code : undefined;
}

export function rethrowUnexpected(error: unknown): void {
  if (error instanceof SshTargetBoundaryError || systemErrorCode(error) === undefined) throw error;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    private readonly retryableOverride?: boolean,
    /** Parsed error body from the server, e.g. the current copy on an expense conflict. */
    public readonly details?: unknown,
  ) {
    super(message);
  }

  /** Only authentication/network/server failures should block a queued operation. */
  get isRetryable() {
    if (this.retryableOverride !== undefined) return this.retryableOverride;
    return this.status === 401 || this.status === 408 || this.status === 429 || this.status >= 500;
  }

  /** The server rejected the request for good; retrying won't help. */
  get isPermanent() {
    if (this.isRetryable) return false;
    return this.status >= 400 && this.status < 500;
  }

  /** The expense was changed or deleted by someone else since this edit started. */
  get isExpenseConflict() {
    return this.status === 409 && (this.code === "expense_conflict" || this.code === "expense_deleted");
  }

  get code(): string | undefined {
    const code = (this.details as { code?: unknown } | undefined)?.code;
    return typeof code === "string" ? code : undefined;
  }

  /** The server's current copy of the conflicting expense; null once it was deleted. */
  get currentExpense(): unknown {
    return (this.details as { current?: unknown } | undefined)?.current ?? null;
  }
}

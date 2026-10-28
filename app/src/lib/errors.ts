export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    private readonly retryableOverride?: boolean,
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
    return [400, 403, 404, 409, 410, 422].includes(this.status);
  }
}

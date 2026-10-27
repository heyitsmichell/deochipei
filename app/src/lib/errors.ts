export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }

  /** Retryable when the user needs to sign in again, the server is busy, or the network is flaky. */
  get isRetryable() {
    return this.status === 401 || this.status === 403 || this.status === 408 || this.status === 429 || this.status >= 500;
  }

  /** The server rejected the request for good; retrying won't help. */
  get isPermanent() {
    if (this.isRetryable) return false;
    return [400, 404, 409, 410, 422].includes(this.status);
  }
}

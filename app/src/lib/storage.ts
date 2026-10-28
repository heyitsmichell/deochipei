/** The slice of AsyncStorage the app's services need; lets tests pass an in-memory map. */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem?(key: string): Promise<void>;
}

export class MemoryStorage implements KeyValueStorage {
  private readonly data = new Map<string, string>();

  async getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  async setItem(key: string, value: string) {
    this.data.set(key, value);
  }

  async removeItem(key: string) {
    this.data.delete(key);
  }
}

/**
 * Keeps one storage key in step with a value that changes often. Saving is a
 * full JSON.stringify, and changes tend to come in bursts (a change, then the
 * server's reply), so everything changed before a write starts, or while one
 * is running, goes out together in the next single write.
 */
export class CoalescedWriter {
  private saving?: Promise<void>;
  private unsaved = false;
  private failed = false;
  private lastError: unknown;

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly key: string,
    private readonly current: () => unknown,
    private readonly onError?: (error: unknown) => void,
    private readonly onSaved?: () => void,
  ) {}

  /** Marks the value changed; it's written shortly. */
  save() {
    this.unsaved = true;
    this.failed = false;
    if (!this.saving) {
      const run = this.writeUntilSaved().catch((error) => {
        this.unsaved = true;
        this.failed = true;
        this.lastError = error;
        this.onError?.(error);
        throw error;
      });
      let wrapped: Promise<void>;
      wrapped = run.finally(() => {
        if (this.saving === wrapped) this.saving = undefined;
        if (this.unsaved && !this.failed) this.save();
      });
      wrapped.catch(() => {});
      this.saving = wrapped;
    }
  }

  /** Resolves once every change so far has been written. */
  saved = () => this.saving ?? (this.failed ? Promise.reject(this.lastError) : Promise.resolve());

  private async writeUntilSaved() {
    await Promise.resolve(); // Let the rest of this change land first.
    while (this.unsaved) {
      this.unsaved = false;
      await this.storage.setItem(this.key, JSON.stringify(this.current()));
      this.lastError = undefined;
      this.onSaved?.();
    }
  }
}

import { randomUUID } from "node:crypto";

export interface DotBrowserBinding {
  readonly roomId: string;
  readonly pageUrl: string;
  readonly generation: number;
}
export type DotBrowserAvailability = "disabled" | "disconnected" | "qualifying" | "ready";
export interface DotBrowserLease {
  readonly epoch: string;
  readonly generation: number;
}

/** In-memory admission only, after transport authentication by the caller.
 * It neither authenticates an extension nor replaces the durable input journal.
 * No browser launch, login, dispatch, replay or uncertainty resolution occurs.
 */
export class DotBrowserConnectionGate {
  private readonly binding: DotBrowserBinding;
  private enabled = false;
  private epoch: string | null = null;
  private qualified = false;
  private deadline = 0;
  private lastTime = -1;

  constructor(binding: DotBrowserBinding, private readonly freshnessMs = 15_000) {
    const url = new URL(binding.pageUrl);
    if (!/^[a-f0-9]{32}$/u.test(binding.roomId) || !Number.isSafeInteger(binding.generation) || binding.generation < 1 ||
        url.origin !== "https://chatgpt.com" || url.username || url.password || url.search || url.hash ||
        !/^\/dots\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(url.pathname) || url.href !== binding.pageUrl ||
        !Number.isSafeInteger(freshnessMs) || freshnessMs < 1 || freshnessMs > 60_000)
      throw new TypeError("Invalid browser connection binding");
    this.binding = { ...binding };
  }

  setEnabled(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid connection state");
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.invalidate();
  }
  isBoundTo(roomId: string, generation: number): boolean {
    return this.binding.roomId === roomId && this.binding.generation === generation;
  }

  /** One authenticated port at a time; duplicate connects cannot steal a lease. */
  connect(now: number): DotBrowserLease | null {
    this.observeTime(now);
    if (!this.enabled || this.epoch !== null) return null;
    this.epoch = randomUUID();
    this.deadline = now + this.freshnessMs;
    return { epoch: this.epoch, generation: this.binding.generation };
  }

  /** Caller must derive room/page qualification from the selected live tab.
   * A heartbeat alone is insufficient; each renewal rechecks the room.
   */
  qualify(lease: DotBrowserLease, observation: { roomId: string; pageUrl: string; qualified: boolean }, now: number): boolean {
    this.observeTime(now);
    if (!this.matches(lease)) return false;
    if (observation.qualified !== true || observation.roomId !== this.binding.roomId || observation.pageUrl !== this.binding.pageUrl) {
      this.invalidate();
      return false;
    }
    this.qualified = true;
    this.deadline = now + this.freshnessMs;
    return true;
  }

  disconnect(lease: DotBrowserLease): void {
    if (this.matches(lease)) this.invalidate();
  }

  /** Check immediately before the synchronous durable dispatch fence, and again
   * after any awaited preparation. It cannot retract a previously issued send.
   */
  canDispatch(lease: DotBrowserLease, now: number): boolean {
    this.observeTime(now);
    return this.enabled && this.qualified && this.matches(lease);
  }

  availability(now: number): DotBrowserAvailability {
    this.observeTime(now);
    return !this.enabled ? "disabled" : this.epoch === null ? "disconnected" : this.qualified ? "ready" : "qualifying";
  }

  private matches(lease: DotBrowserLease): boolean {
    return this.epoch !== null && lease.epoch === this.epoch && lease.generation === this.binding.generation;
  }
  private observeTime(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - this.freshnessMs) {
      this.invalidate();
      throw new TypeError("Invalid connection clock");
    }
    if (now < this.lastTime) {
      this.invalidate();
      throw new Error("Browser connection clock moved backwards");
    }
    this.lastTime = now;
    // Freshness admits dispatch; it is not the lifetime of the authenticated port.
    // Keep its epoch until an explicit disconnect, scope rejection or bad clock.
    if (this.epoch !== null && now >= this.deadline) this.qualified = false;
  }
  private invalidate(): void {
    this.epoch = null;
    this.qualified = false;
    this.deadline = 0;
  }
}

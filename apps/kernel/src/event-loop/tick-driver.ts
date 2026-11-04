import type { Simulation } from '../simulation/simulation.js';

/**
 * Background tick driver (M1.2-A).
 *
 * `Simulation.Resume` used to flip a scheduler flag and nothing else: the console showed
 * a running simulation while the runtime never advanced on its own, so the only way to
 * move time forward was to click Step forever (`RT-1`/`RT-2` in the M1.1 audit). This
 * driver is the missing engine behind Resume - the kernel keeps ticking while it is
 * running, and stops the moment it is paused.
 *
 * Deliberate properties:
 *
 * - **No overlap.** The next tick is only scheduled after the previous one settled, and
 *   `Simulation.tick()` itself serialises callers, so a background tick can never race
 *   `POST /api/tick` or the control plane's `Step`.
 * - **No busy loop.** A tick that did work schedules the next one on a short delay; an
 *   idle tick backs off to a slow keep-alive, so the clock still advances on its own
 *   without burning CPU. A paused simulation is never ticked, so pause produces no
 *   clock noise either.
 * - **Responsive to human input.** `kick()` drops whatever wait is pending and ticks as
 *   soon as the current one is done, so an operator command takes effect immediately
 *   instead of waiting out an idle interval.
 */
export interface TickDriverOptions {
  /** Delay after a tick that did work (default 100ms). */
  readonly activeIntervalMs?: number;
  /** Delay after an idle tick (default 1000ms). */
  readonly idleIntervalMs?: number;
  /** Delay while the simulation is paused (default 1000ms). */
  readonly pausedIntervalMs?: number;
  /** Called when `simulation.tick()` rejects; the driver keeps running. */
  readonly onTickError?: (error: unknown) => void;
}

export interface TickDriver {
  /** Number of ticks this driver has issued since it started. */
  readonly ticks: number;
  /** Ask for the next tick as soon as the in-flight one (if any) is done. */
  kick(): void;
  stop(): void;
}

const DEFAULT_ACTIVE_INTERVAL_MS = 100;
const DEFAULT_IDLE_INTERVAL_MS = 1000;
const DEFAULT_PAUSED_INTERVAL_MS = 1000;

export function startTickDriver(
  simulation: Simulation,
  options: TickDriverOptions = {},
): TickDriver {
  const activeIntervalMs = options.activeIntervalMs ?? DEFAULT_ACTIVE_INTERVAL_MS;
  const idleIntervalMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;
  const pausedIntervalMs = options.pausedIntervalMs ?? DEFAULT_PAUSED_INTERVAL_MS;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let pendingKick = false;
  let ticks = 0;

  function schedule(delay: number): void {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delay);
  }

  async function run(): Promise<void> {
    if (stopped || inFlight) return;
    if (simulation.scheduler.paused) {
      schedule(pausedIntervalMs);
      return;
    }
    inFlight = true;
    let delay: number;
    try {
      const result = await simulation.tick();
      ticks += 1;
      delay =
        result.status === 'paused'
          ? pausedIntervalMs
          : result.status === 'idle'
            ? idleIntervalMs
            : activeIntervalMs;
    } catch (error) {
      options.onTickError?.(error);
      delay = idleIntervalMs;
    } finally {
      inFlight = false;
    }
    if (pendingKick) {
      pendingKick = false;
      schedule(0);
      return;
    }
    schedule(delay);
  }

  schedule(activeIntervalMs);

  return {
    get ticks(): number {
      return ticks;
    },
    kick(): void {
      if (stopped) return;
      if (inFlight) {
        pendingKick = true;
        return;
      }
      if (simulation.scheduler.paused) return;
      schedule(0);
    },
    stop(): void {
      stopped = true;
      pendingKick = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

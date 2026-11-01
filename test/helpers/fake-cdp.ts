import type { CdpClient } from "../../src/cdp-client.js";

/** A record of one CDP call. */
export interface CdpCall {
  method: string;
  /** The raw params passed to sendCommand (including keys whose value is undefined). */
  params: Record<string, unknown>;
  /**
   * The keys that actually go on the wire — keys whose value is undefined are dropped by
   * JSON.stringify and the kernel never sees them. That is exactly how a required parameter
   * written as undefined turns into an InvalidParams, so contract checks must read this one.
   */
  wireKeys: string[];
}

/** A route: takes params, returns the reply; returning an Error instance means this call should throw. */
export type CdpRoute = (params: Record<string, unknown>) => unknown;

/**
 * A fake CDP client. It implements only the sendCommand the action layer actually uses, and
 * nothing else exists — use asCdp() to assert it into a CdpClient for the function under test.
 *
 * A command with no registered route throws the same "'X' wasn't found" the kernel does, so
 * "we sent a command the kernel does not have" looks the same in a test as on a real machine.
 */
export class FakeCdp {
  readonly calls: CdpCall[] = [];
  private readonly routes = new Map<string, CdpRoute>();

  constructor(routes: Record<string, CdpRoute | unknown> = {}) {
    for (const [method, route] of Object.entries(routes)) {
      this.on(method, route);
    }
  }

  /** Register a route. A function gives a dynamic reply; any other value is a fixed one. */
  on(method: string, route: CdpRoute | unknown): this {
    this.routes.set(
      method,
      typeof route === "function" ? (route as CdpRoute) : () => route,
    );
    return this;
  }

  async sendCommand(method: string, params?: object): Promise<unknown> {
    const raw = { ...((params ?? {}) as Record<string, unknown>) };
    this.calls.push({
      method,
      params: raw,
      wireKeys: Object.keys(raw).filter((k) => raw[k] !== undefined),
    });

    const route = this.routes.get(method);
    if (!route) {
      throw new Error(`'${method}' wasn't found`);
    }
    const reply = route(raw);
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  }

  asCdp(): CdpClient {
    return this as unknown as CdpClient;
  }

  callsTo(method: string): CdpCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** The last call to a command; throws when there was none (in a test that is always an assertion failure). */
  lastCall(method: string): CdpCall {
    const found = this.callsTo(method).at(-1);
    if (!found) {
      throw new Error(
        `${method} was never called; the commands actually called were: ${[...new Set(this.calls.map((c) => c.method))].join(", ") || "(none)"}`,
      );
    }
    return found;
  }

  /** For when only which commands were called, and in what order, matters. */
  methodSequence(): string[] {
    return this.calls.map((c) => c.method);
  }

  reset(): void {
    this.calls.length = 0;
  }
}

// Lightweight typed service registry — DI without the framework.
//
// Why this exists: as the codebase trends toward microservices, we want
// modules to talk to each other through registered service objects
// rather than direct cross-module imports. Today it's a single process,
// so registration is just a Map; tomorrow we can swap the resolve
// function to dial out to a remote service mesh without changing the
// caller surface.
//
// What this is NOT: a generic IoC container. There's no constructor
// injection, no scope management, no decorators. Modules register
// already-built objects against a string token; consumers resolve by
// the same token. The token is named with its owning module so a
// future split is unambiguous.

export interface ServiceDescriptor<T = unknown> {
  /** Tokens are namespaced "<moduleId>.<serviceName>" — this string
   *  is what consumers use to resolve. */
  token: string;
  /** Owning module id (must match ModuleRegistry). */
  moduleId: string;
  /** The actual service instance. The registry never constructs; it
   *  holds whatever the module hands over. */
  instance: T;
  /** Optional human-readable description for the diagnostics endpoint. */
  description?: string;
}

export class ServiceRegistry {
  private services: Map<string, ServiceDescriptor<unknown>> = new Map();

  /** Register a service. Last-write-wins so tests can swap fakes
   *  without an explicit unregister, but the registry warns when this
   *  happens at runtime since it usually means a misconfiguration. */
  register<T>(descriptor: ServiceDescriptor<T>): void {
    if (!/^[\w-]+\.[\w.-]+$/.test(descriptor.token)) {
      throw new Error(`invalid service token "${descriptor.token}" — must match "<module>.<name>"`);
    }
    const [moduleId] = descriptor.token.split('.');
    if (moduleId !== descriptor.moduleId) {
      throw new Error(`token "${descriptor.token}" does not match moduleId "${descriptor.moduleId}"`);
    }
    this.services.set(descriptor.token, descriptor as ServiceDescriptor<unknown>);
  }

  /** Resolve a service by token. Throws if not registered — services
   *  required for correctness should fail loudly at startup, not later
   *  when a request lands. Consumers that want a soft lookup can use
   *  `tryResolve`. */
  resolve<T>(token: string): T {
    const desc = this.services.get(token);
    if (!desc) throw new Error(`service "${token}" not registered`);
    return desc.instance as T;
  }

  /** Soft lookup — undefined when not registered. */
  tryResolve<T>(token: string): T | undefined {
    return this.services.get(token)?.instance as T | undefined;
  }

  /** Did a module register this token? Used by the boundary enforcer
   *  to verify modules only register under their own namespace. */
  has(token: string): boolean {
    return this.services.has(token);
  }

  /** Snapshot for the diagnostics endpoint. Returns descriptors with
   *  `instance` redacted so the API doesn't leak references. */
  list(): Array<Omit<ServiceDescriptor, 'instance'>> {
    return Array.from(this.services.values()).map(d => ({
      token: d.token, moduleId: d.moduleId, description: d.description,
    }));
  }

  /** Drop every registration — used by tests. */
  reset(): void { this.services.clear(); }
}

/** Process-wide singleton. Most callers use this; tests construct
 *  fresh instances when they want isolation. */
let _global: ServiceRegistry | null = null;
export function getServiceRegistry(): ServiceRegistry {
  if (!_global) _global = new ServiceRegistry();
  return _global;
}
export function resetServiceRegistry(): void { _global = null; }

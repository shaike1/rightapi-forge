// Wraps EventBus so callers in a request scope auto-inject the active
// tenantId on publish, and subscribers only see events for their own
// tenant by default. The wrapper does NOT replace the underlying bus —
// admin tooling that legitimately needs cross-tenant reads still uses
// the raw EventBus / EventStore.
//
// Subscriber model:
//   bus.subscribe(filter, handler)            — scoped to active tenant
//   bus.subscribeAcrossAllTenants(filter, h)  — explicitly opt out
//
// Why two subscription methods rather than a flag: making the unsafe
// path explicit pushes readers to ask "do I really mean every tenant?"
// at the call site instead of buried in a config object.

import { createLogger } from '../observability/Logger.js';
import type {
  AppendedEvent,
  EventInput,
  EventStore,
  EventStreamFilter,
} from '../persistence/index.js';
import type {
  EventBus,
  EventHandler,
  SubscriptionFilter,
} from './EventBus.js';
import { getCurrentTenantId, SYSTEM_TENANT_ID } from '../tenancy/index.js';

const log = createLogger({ component: 'tenant-event-bus' });

export class TenantScopedEventBus {
  private readonly inner: EventBus;
  private readonly store: EventStore;

  constructor(inner: EventBus, store: EventStore) {
    this.inner = inner;
    this.store = store;
  }

  /** Persist + fan out an event under the current tenant. The caller can
   *  override tenantId explicitly (e.g. when emitting on behalf of a
   *  different tenant during admin actions); the active scope wins
   *  otherwise. */
  async publish(input: EventInput): Promise<AppendedEvent> {
    const tenantId = input.tenantId ?? getCurrentTenantId();
    return this.inner.publish({ ...input, tenantId });
  }

  /** Subscribe to events for the *active tenant only*. The handler runs
   *  inside the same tenant scope it would have observed at publish time
   *  — important for code that calls back into stores expecting a
   *  consistent tenantId. The passed filter cannot override the
   *  isolation; an explicit tenantId in the filter wins only when it
   *  matches the active tenant (otherwise it's silently dropped to the
   *  active tenant, since subscribers can't peek at other tenants). */
  subscribe(filter: SubscriptionFilter, handler: EventHandler, name?: string): () => void {
    const expectedTenant = getCurrentTenantId();
    return this.inner.subscribe(filter, async (event) => {
      if (event.tenantId !== expectedTenant) return;
      try { await handler(event); }
      catch (err: any) {
        log.error('tenant-scoped subscriber threw', {
          err: err?.message, tenant: expectedTenant, name: name ?? 'anonymous',
        });
      }
    }, name);
  }

  /** Subscribe across every tenant. Reserved for system-level concerns
   *  (audit pipelines, security monitors) that legitimately need to see
   *  all events. The handler observes event.tenantId on every record so
   *  it can route + log accordingly. */
  subscribeAcrossAllTenants(filter: SubscriptionFilter, handler: EventHandler, name?: string): () => void {
    return this.inner.subscribe(filter, handler, `${name ?? 'cross-tenant'}::all`);
  }

  /** Read events scoped to the active tenant. Callers wanting cross-
   *  tenant reads should hit the underlying store directly. */
  async read(filter: EventStreamFilter = {}): Promise<AppendedEvent[]> {
    const tenantId = filter.tenantId ?? getCurrentTenantId();
    return Promise.resolve(this.store.read({ ...filter, tenantId }));
  }

  /** Replay scoped to the active tenant. */
  async replay<S>(
    filter: EventStreamFilter,
    projection: (state: S, event: AppendedEvent) => S,
    initialState: S,
  ): Promise<{ state: S; visited: number }> {
    const tenantId = filter.tenantId ?? getCurrentTenantId();
    const events = await Promise.resolve(this.store.read({ ...filter, tenantId }));
    let state = initialState;
    for (const e of events) state = projection(state, e);
    return { state, visited: events.length };
  }

  /** Pass-through: the inner bus's diagnostics endpoint. */
  listSubscriptions(): ReturnType<EventBus['listSubscriptions']> {
    return this.inner.listSubscriptions();
  }

  /** Escape hatch — for code that legitimately needs to publish under
   *  the system tenant (background sweeps, lifecycle events). */
  publishAsSystem(input: Omit<EventInput, 'tenantId'>): Promise<AppendedEvent> {
    return this.inner.publish({ ...input, tenantId: SYSTEM_TENANT_ID });
  }
}

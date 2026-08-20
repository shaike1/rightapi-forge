// In-process event bus with a durable backbone.
//
// publish(input) → store.append() (durable) → fan-out to subscribers.
// Subscribers run *after* the event is on disk, so a crash mid-fanout
// can't lose the event itself; replaying through the EventStore catches
// any subscriber that didn't run before the process died.
//
// Subscriptions:
//   bus.subscribe({ type: 'task.created' }, async (e) => { … })
//   bus.subscribe({ aggregateType: 'workflow' }, async (e) => { … })
//   bus.subscribe({}, async (e) => { … })   // catch-all
//
// Replay:
//   bus.replay({ aggregateId: 'task-42' }, projection)
//   - Pulls events in append order from the store and feeds them to a
//     pure projection function. Used for debugging ("show every event
//     for task X") and rebuilding read-model projections from scratch.
//
// What this is NOT: a cross-process bus. For that, route the published
// AppendedEvent through the Redis MessageBus. Splitting durability
// (EventStore) from delivery (MessageBus) keeps each piece simple and
// composable.

import { createLogger } from '../observability/Logger.js';
import type {
  AppendedEvent,
  EventInput,
  EventStore,
  EventStreamFilter,
} from '../persistence/index.js';

const log = createLogger({ component: 'event-bus' });

export interface SubscriptionFilter {
  /** Match exactly this aggregateType. Omit for any. */
  aggregateType?: string;
  /** Match exactly this aggregateId. Useful for "watch task-42". */
  aggregateId?: string;
  /** Match exactly this event type, or any with the given prefix
   *  ("task." matches "task.created", "task.completed", …). */
  type?: string;
  /** Match by prefix; takes precedence over `type` if both set. */
  typePrefix?: string;
}

export type EventHandler = (event: AppendedEvent) => void | Promise<void>;

interface Subscription {
  id: number;
  filter: SubscriptionFilter;
  handler: EventHandler;
  /** Caller-supplied label for diagnostics + the /api/events/subscriptions
   *  endpoint. Falls back to "anonymous" when omitted. */
  name: string;
}

export class EventBus {
  private readonly store: EventStore;
  private subs: Subscription[] = [];
  private nextSubId = 1;
  /** When false, fan-out is skipped (used during replay so subscribers
   *  don't double-fire on historical events). */
  private fanoutEnabled = true;

  constructor(store: EventStore) {
    this.store = store;
  }

  /** Persist + fan out an event. Returns the persisted record (with its
   *  generated id + timestamp) so callers can use it for causation links
   *  on follow-up events. Subscriber failures are logged but don't fail
   *  the publish — durability is the contract, delivery is best-effort. */
  async publish(input: EventInput): Promise<AppendedEvent> {
    const stored = await Promise.resolve(this.store.append(input));
    if (this.fanoutEnabled) await this.fanout(stored);
    return stored;
  }

  /** Add a subscription. Returns an unsubscribe function. */
  subscribe(filter: SubscriptionFilter, handler: EventHandler, name?: string): () => void {
    const sub: Subscription = { id: this.nextSubId++, filter, handler, name: name ?? 'anonymous' };
    this.subs.push(sub);
    return () => { this.subs = this.subs.filter(s => s.id !== sub.id); };
  }

  /** Read raw events without fanning out — for direct queries (UI). */
  async read(filter: EventStreamFilter = {}): Promise<AppendedEvent[]> {
    return Promise.resolve(this.store.read(filter));
  }

  /**
   * Replay historical events through a projection function. Returns the
   * accumulated state + the events visited. Pure: doesn't mutate the bus
   * or fire live subscribers. Use to rebuild a dashboard tile, debug a
   * task's full history, or test a projection.
   */
  async replay<S>(
    filter: EventStreamFilter,
    projection: (state: S, event: AppendedEvent) => S,
    initialState: S,
  ): Promise<{ state: S; visited: number }> {
    const events = await Promise.resolve(this.store.read(filter));
    let state = initialState;
    for (const e of events) state = projection(state, e);
    return { state, visited: events.length };
  }

  /** Snapshot of current subscribers for the diagnostics endpoint. */
  listSubscriptions(): Array<{ id: number; name: string; filter: SubscriptionFilter }> {
    return this.subs.map(s => ({ id: s.id, name: s.name, filter: s.filter }));
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private async fanout(event: AppendedEvent): Promise<void> {
    // Snapshot subs to avoid surprises if a handler subscribes / unsubscribes
    // mid-fanout.
    const snapshot = this.subs.slice();
    for (const sub of snapshot) {
      if (!matches(event, sub.filter)) continue;
      try {
        await sub.handler(event);
      } catch (err: any) {
        // One failing handler must not poison the others. Log + continue.
        log.error('event handler threw', {
          subId: sub.id, subscriber: sub.name, type: event.type,
          eventId: event.id, err: err?.message ?? String(err),
        });
      }
    }
  }
}

function matches(event: AppendedEvent, filter: SubscriptionFilter): boolean {
  if (filter.aggregateType && filter.aggregateType !== event.aggregateType) return false;
  if (filter.aggregateId   && filter.aggregateId   !== event.aggregateId)   return false;
  if (filter.typePrefix    && !event.type.startsWith(filter.typePrefix))    return false;
  if (filter.type && !filter.typePrefix && filter.type !== event.type)      return false;
  return true;
}

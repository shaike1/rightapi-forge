// Typed envelope format for inter-module communication.
//
// Why bother formalising this in a single-process codebase: every
// inter-module message that gets sent today as a plain function call
// is a future RPC payload after a microservices split. Wrapping it in
// an envelope now means:
//   - Type-checked sender/receiver pairs.
//   - Built-in correlation/causation IDs so audit trails stitch up
//     across modules without each call site re-inventing them.
//   - One place to add cross-cutting fields (tenant, traceparent)
//     when they appear, instead of editing every signature.
//
// Modules that need bidirectional communication import the envelope
// types from here, route messages through ServiceRegistry-resolved
// services, and never reach into another module's internals
// directly. The ModuleBoundaryEnforcer flags any deviation.

import { randomUUID } from 'crypto';
import { getCurrentTenantId } from '../tenancy/index.js';

/** A typed envelope wrapping an inter-module message.
 *
 *  T is the payload shape. Two messages with different T values are
 *  distinct types and the compiler enforces that at the call site
 *  (e.g. you can't pass a "task.created" payload to a handler that
 *  expects "skill.executed").
 */
export interface InternalMessage<T = unknown> {
  /** Stable id assigned at construction; appears in logs + the event
   *  log when the message is also persisted. */
  id: string;
  /** ISO timestamp the envelope was created. */
  createdAt: string;
  /** Module the message was sent from. */
  sender: string;
  /** Module / service token the message is addressed to. Format:
   *  "<module>.<service>" — same shape as ServiceRegistry tokens. */
  recipient: string;
  /** Dotted message-type identifier. Conventionally
   *  "<noun>.<verb>" — e.g. "task.created". The enforcer validates
   *  the shape but not the contents. */
  type: string;
  /** Active tenant scope. Auto-populated from getCurrentTenantId()
   *  unless overridden. */
  tenantId: string;
  /** When this message was caused by another, the upstream id. Lets
   *  audit trails reconstruct chains across modules. */
  causationId?: string;
  /** Stable id shared by every message belonging to one logical flow
   *  (request, task, workflow run). Carries through the chain. */
  correlationId?: string;
  /** The typed payload. */
  payload: T;
}

export interface CreateOptions {
  sender: string;
  recipient: string;
  type: string;
  causationId?: string;
  correlationId?: string;
  tenantId?: string;
}

/** Build an envelope. Validates the recipient + type shape so
 *  malformed messages fail loudly at the source rather than at the
 *  handler. */
export function envelope<T>(opts: CreateOptions, payload: T): InternalMessage<T> {
  if (!/^[\w-]+\.[\w.-]+$/.test(opts.recipient)) {
    throw new Error(`invalid recipient "${opts.recipient}" — must be "<module>.<service>"`);
  }
  if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(opts.type)) {
    throw new Error(`invalid message type "${opts.type}" — must be dotted lowercase`);
  }
  return {
    id: `msg-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    sender: opts.sender,
    recipient: opts.recipient,
    type: opts.type,
    tenantId: opts.tenantId ?? getCurrentTenantId(),
    causationId: opts.causationId,
    correlationId: opts.correlationId,
    payload,
  };
}

/** Helper for the second message in a chain — copies correlation +
 *  inherits the upstream id as causation. */
export function reply<T>(parent: InternalMessage<unknown>, opts: Omit<CreateOptions, 'correlationId' | 'causationId'>, payload: T): InternalMessage<T> {
  return envelope(
    {
      ...opts,
      correlationId: parent.correlationId ?? parent.id,
      causationId: parent.id,
    },
    payload,
  );
}

/** Validates an envelope at a boundary. Receiving handlers can call
 *  this to confirm a payload arrived intact (e.g. when the bus
 *  serialised + deserialised the envelope). */
export function isInternalMessage(value: unknown): value is InternalMessage<unknown> {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return typeof m.id === 'string'
      && typeof m.createdAt === 'string'
      && typeof m.sender === 'string'
      && typeof m.recipient === 'string'
      && typeof m.type === 'string'
      && typeof m.tenantId === 'string'
      && 'payload' in m;
}

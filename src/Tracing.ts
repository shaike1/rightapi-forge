// Observability & Tracing System

export type TraceStatus = 'pending' | 'running' | 'success' | 'error';

export interface TraceSpan {
  id: string;
  name: string;
  status: TraceStatus;
  startTime: number;
  endTime?: number;
  duration?: number;
  metadata?: Record<string, any>;
  error?: string;
  children: TraceSpan[];
  parentId?: string;
}

export interface Trace {
  id: string;
  name: string;
  status: TraceStatus;
  startTime: number;
  endTime?: number;
  duration?: number;
  spans: TraceSpan[];
  metadata: Record<string, any>;
}

export class Tracer {
  private traces: Map<string, Trace> = new Map();
  private activeSpans: Map<string, TraceSpan[]> = new Map();

  // Start a new trace
  startTrace(name: string, metadata?: Record<string, any>): string {
    const traceId = 'trace-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    
    const trace: Trace = {
      id: traceId,
      name,
      status: 'running',
      startTime: Date.now(),
      spans: [],
      metadata: metadata || {}
    };

    this.traces.set(traceId, trace);
    this.activeSpans.set(traceId, []);

    return traceId;
  }

  // Start a span within a trace
  startSpan(traceId: string, name: string, parentId?: string): string {
    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error('Trace not found: ' + traceId);
    }

    const spanId = 'span-' + Date.now();
    const span: TraceSpan = {
      id: spanId,
      name,
      status: 'running',
      startTime: Date.now(),
      children: [],
      parentId
    };

    trace.spans.push(span);
    
    const activeSpans = this.activeSpans.get(traceId) || [];
    activeSpans.push(span);
    this.activeSpans.set(traceId, activeSpans);

    return spanId;
  }

  // End a span
  endSpan(traceId: string, spanId: string, error?: string): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;

    const span = trace.spans.find(s => s.id === spanId);
    if (!span) return;

    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.status = error ? 'error' : 'success';
    span.error = error;

    // Remove from active spans
    const activeSpans = this.activeSpans.get(traceId) || [];
    const idx = activeSpans.findIndex(s => s.id === spanId);
    if (idx >= 0) {
      activeSpans.splice(idx, 1);
    }
  }

  // End trace
  endTrace(traceId: string, error?: string): Trace | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) return undefined;

    trace.endTime = Date.now();
    trace.duration = trace.endTime - trace.startTime;
    trace.status = error ? 'error' : 'success';

    // Clean up active spans
    this.activeSpans.delete(traceId);

    return trace;
  }

  // Get trace
  getTrace(traceId: string): Trace | undefined {
    return this.traces.get(traceId);
  }

  // List recent traces
  listTraces(limit: number = 10): Trace[] {
    return Array.from(this.traces.values())
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, limit);
  }

  // Get active traces
  getActiveTraces(): Trace[] {
    return Array.from(this.traces.values())
      .filter(t => t.status === 'running');
  }

  // Get stats
  getStats(): {
    total: number;
    active: number;
    success: number;
    error: number;
    avgDuration: number;
  } {
    const traces = Array.from(this.traces.values());
    const success = traces.filter(t => t.status === 'success').length;
    const error = traces.filter(t => t.status === 'error').length;
    const durations = traces.filter(t => t.duration).map(t => t.duration!);
    const avgDuration = durations.length > 0 
      ? durations.reduce((a, b) => a + b, 0) / durations.length 
      : 0;

    return {
      total: traces.length,
      active: traces.filter(t => t.status === 'running').length,
      success,
      error,
      avgDuration: Math.round(avgDuration)
    };
  }
}

// Singleton instance
export const tracer = new Tracer();

// Decorator for automatic tracing
export function traced() {
  return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function(...args: any[]) {
      const traceId = tracer.startTrace(propertyKey);
      const spanId = tracer.startSpan(traceId, propertyKey);
      
      try {
        const result = await originalMethod.apply(this, args);
        tracer.endSpan(traceId, spanId);
        tracer.endTrace(traceId);
        return result;
      } catch (error: any) {
        tracer.endSpan(traceId, spanId, error.message);
        tracer.endTrace(traceId, error.message);
        throw error;
      }
    };
    
    return descriptor;
  };
}

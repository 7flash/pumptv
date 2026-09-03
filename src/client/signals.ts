export type SignalUpdater<T> = T | ((previous: T) => T);

export type SignalChange<T> = {
  previous: T;
  value: T;
};

export type Signal<T> = {
  get(): T;
  set(next: SignalUpdater<T>): boolean;
  subscribe(listener: (change: SignalChange<T>) => void): () => void;
};

export function createSignal<T>(initialValue: T): Signal<T> {
  let value = initialValue;
  const listeners = new Set<(change: SignalChange<T>) => void>();

  return {
    get() {
      return value;
    },

    set(next) {
      const resolved =
        typeof next === "function" ? (next as (previous: T) => T)(value) : next;
      if (Object.is(value, resolved)) return false;

      const previous = value;
      value = resolved;
      const change = { previous, value };
      for (const listener of listeners) listener(change);
      return true;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ReactiveStateChange<T extends object> = {
  key: keyof T;
  previous: T[keyof T];
  value: T[keyof T];
};

export function createReactiveState<T extends object>(initialState: T) {
  type Listener = (change: ReactiveStateChange<T>) => void;
  const listeners = new Set<Listener>();
  const signals = new Map<keyof T, Signal<T[keyof T]>>();

  for (const key of Reflect.ownKeys(initialState) as Array<keyof T>) {
    const signal = createSignal(initialState[key] as T[keyof T]);
    signal.subscribe(({ previous, value }) => {
      const change = { key, previous, value } as ReactiveStateChange<T>;
      for (const listener of listeners) listener(change);
    });
    signals.set(key, signal);
  }

  const state = new Proxy({} as T, {
    get(_target, property) {
      const signal = signals.get(property as keyof T);
      return signal ? signal.get() : undefined;
    },

    set(_target, property, value) {
      const signal = signals.get(property as keyof T);
      if (!signal)
        throw new Error(`Unknown reactive state key: ${String(property)}`);
      signal.set(value as T[keyof T]);
      return true;
    },

    ownKeys() {
      return [...signals.keys()] as Array<string | symbol>;
    },

    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true };
    },
  });

  return {
    state,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeKey<K extends keyof T>(
      key: K,
      listener: (change: SignalChange<T[K]>) => void,
    ) {
      const signal = signals.get(key) as Signal<T[K]> | undefined;
      if (!signal)
        throw new Error(`Unknown reactive state key: ${String(key)}`);
      return signal.subscribe(listener);
    },
  };
}

export function createInvalidationQueue(
  flush: (reasons: readonly string[]) => void,
  enqueue: (callback: () => void) => void = queueMicrotask,
) {
  let scheduled = false;
  const reasons = new Set<string>();

  function drain() {
    scheduled = false;
    if (!reasons.size) return;
    const pending = [...reasons];
    reasons.clear();
    flush(pending);
  }

  return {
    invalidate(reason = "state") {
      reasons.add(reason);
      if (scheduled) return;
      scheduled = true;
      enqueue(drain);
    },
    flushNow() {
      drain();
    },
    get pending() {
      return scheduled;
    },
  };
}

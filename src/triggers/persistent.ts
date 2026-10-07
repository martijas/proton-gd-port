// Persistent Item Setup (3641): mark item or timer ids so a death restart
// keeps their values, and optionally zero them. Leaving the level drops them.
//
// [gdp GJBaseGameLayer::activatePersistentItemTrigger :459244-459387;
//  GJEffectManager::toggleItemPersistent :479657-479680,
//  transferPersistentItems :479697-479725,
//  updateCountForItem mirrors into the persistent map :487423-487426]

/** What a death restart of this visit carries into the next attempt. */
export interface PersistentCarry {
  readonly items: ReadonlyMap<number, number>;
  readonly timers: ReadonlyMap<number, number>;
}

/** Keys on a Persistent Item Setup trigger. [customObjectSetup :301172-301192] */
export interface PersistentSpec {
  item: number;
  persistent: boolean;
  targetAll: boolean;
  reset: boolean;
  timer: boolean;
}

export function persistentSpecOf(props: Record<number, string | undefined>): PersistentSpec {
  const flag = (k: number): boolean => {
    const v = props[k];
    return v !== undefined && Number(v) !== 0;
  };
  return {
    item: Math.trunc(Number(props[80] ?? 0)) || 0,
    persistent: flag(491),
    targetAll: flag(492),
    reset: flag(493),
    timer: flag(494),
  };
}

/**
 * Applies one Persistent Item Setup fire. Mutates maps in place; caller forks.
 */
export function applyPersistentTrigger(
  spec: PersistentSpec,
  items: Map<number, number>,
  timers: Map<number, number>,
  persistentItems: Map<number, number>,
  persistentTimers: Map<number, number>,
  clampId: (id: number) => number,
): void {
  if (spec.timer) {
    if (spec.targetAll) {
      if (spec.reset) for (const id of persistentTimers.keys()) timers.set(id, 0);
      if (!spec.persistent) persistentTimers.clear();
    } else {
      const id = clampId(spec.item);
      if (spec.persistent) persistentTimers.set(id, timers.get(id) ?? 0);
      else persistentTimers.delete(id);
      if (spec.reset && (timers.has(id) || persistentTimers.has(id))) timers.set(id, 0);
    }
    for (const id of [...persistentTimers.keys()]) persistentTimers.set(id, timers.get(id) ?? 0);
    return;
  }
  if (spec.targetAll) {
    if (spec.reset) {
      for (const id of persistentItems.keys()) {
        items.delete(id);
        persistentItems.set(id, 0);
      }
    }
    if (!spec.persistent) persistentItems.clear();
    return;
  }
  const id = clampId(spec.item);
  if (spec.persistent) persistentItems.set(id, items.get(id) ?? 0);
  else persistentItems.delete(id);
  if (spec.reset) {
    items.delete(id);
    if (persistentItems.has(id)) persistentItems.set(id, 0);
  }
}

/** Puts persistent values into the live maps after a death restart. */
export function transferPersistent(
  items: Map<number, number>,
  timers: Map<number, number>,
  carry: PersistentCarry,
): void {
  for (const [id, n] of carry.items) {
    if (n === 0) items.delete(id);
    else items.set(id, n);
  }
  for (const [id, n] of carry.timers) timers.set(id, n);
}

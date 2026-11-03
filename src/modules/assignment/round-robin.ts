export type RoundRobinState = {
    orderedUserIds: string[];
    nextIndex: number;
};

/**
 * Drop people who are no longer eligible (out of office or idle past 20 minutes).
 * Keep the previous order. Append someone who just became eligible at the end,
 * so they wait for the next turn instead of jumping the line.
 */
export function syncQueueOrder(
    previousOrder: string[],
    eligibleIds: string[],
    previousNextIndex: number
): RoundRobinState {
    const eligibleSet = new Set(eligibleIds);
    const remaining = previousOrder.filter((id) => eligibleSet.has(id));
    const remainingSet = new Set(remaining);
    const newcomers = eligibleIds.filter((id) => !remainingSet.has(id));

    const previousNextId =
        previousOrder.length > 0
            ? previousOrder[previousNextIndex % previousOrder.length]
            : null;

    const orderedUserIds = [...remaining, ...newcomers];

    let nextIndex = 0;
    if (orderedUserIds.length === 0) {
        nextIndex = 0;
    } else if (previousNextId && remainingSet.has(previousNextId)) {
        nextIndex = orderedUserIds.indexOf(previousNextId);
    } else if (previousNextId && previousOrder.length) {
        let found = false;
        for (let i = 1; i <= previousOrder.length; i++) {
            const cand = previousOrder[(previousNextIndex + i) % previousOrder.length];
            if (remainingSet.has(cand)) {
                nextIndex = orderedUserIds.indexOf(cand);
                found = true;
                break;
            }
        }
        if (!found) nextIndex = 0;
    }

    return { orderedUserIds, nextIndex };
}

/**
 * One New (or Other) shipment. The pointer moves to the person after the one
 * who just received it, so the next shipment cannot land on the same broker
 * while anyone else in the circle is still eligible.
 */
export function takeNextInQueue(
    state: RoundRobinState,
    eligibleIds: string[],
    excludeIds: string[] = []
): { chosenId: string; state: RoundRobinState } | null {
    const synced = syncQueueOrder(state.orderedUserIds, eligibleIds, state.nextIndex);
    const order = synced.orderedUserIds;
    const n = order.length;
    if (!n) return null;
    const exclude = new Set(excludeIds);
    for (let i = 0; i < n; i++) {
        const idx = (synced.nextIndex + i) % n;
        const chosenId = order[idx];
        if (exclude.has(chosenId)) continue;
        return {
            chosenId,
            state: { orderedUserIds: order, nextIndex: (idx + 1) % n },
        };
    }
    return null;
}

/** Hand `count` shipments to whoever is eligible on every turn. */
export type QueuePlace = "next" | "waiting" | "received";

/** Live circle only: who receives the next shipment, who received the last turn, who is waiting. */
export function queuePlaces(
    order: string[],
    nextIndex: number,
    lastUserId: string | null
): Array<{ userId: string; position: number; place: QueuePlace }> {
    const n = order.length;
    if (!n) return [];
    const next = ((nextIndex % n) + n) % n;
    return order.map((userId, index) => {
        let place: QueuePlace = "waiting";
        if (index === next) place = "next";
        else if (lastUserId && userId === lastUserId) place = "received";
        return { userId, position: index + 1, place };
    });
}

export function assignInTurns(
    eligibleIds: string[],
    count: number,
    excludeIds: string[] = []
): string[] {
    let state: RoundRobinState = { orderedUserIds: [], nextIndex: 0 };
    const picks: string[] = [];
    for (let i = 0; i < count; i++) {
        const turn = takeNextInQueue(state, eligibleIds, excludeIds);
        if (!turn) break;
        picks.push(turn.chosenId);
        state = turn.state;
    }
    return picks;
}

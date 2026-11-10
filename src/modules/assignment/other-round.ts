/** Max times one broker may receive the same load as an Other (REASSIGNED) offer. */
export const OTHER_OFFERS_PER_PERSON = 2;

export function otherOfferCountFor(
    offerCounts: ReadonlyMap<string, number>,
    userId: string
): number {
    return offerCounts.get(userId) || 0;
}

/** Brokers still allowed another Other offer (under the 2-pass cap). */
export function brokersDueForOtherOffer(
    eligibleIds: string[],
    offerCounts: ReadonlyMap<string, number>
): string[] {
    return [...new Set(eligibleIds.filter(Boolean))].filter(
        (id) => otherOfferCountFor(offerCounts, id) < OTHER_OFFERS_PER_PERSON
    );
}

/**
 * Brokers who already hit the 2-pass Other cap for this shipment.
 * They must not receive it again (avoids a 3rd trip through Rio / anyone else).
 */
export function brokersAtOtherOfferCap(
    eligibleIds: string[],
    offerCounts: ReadonlyMap<string, number>
): string[] {
    return [...new Set(eligibleIds.filter(Boolean))].filter(
        (id) => otherOfferCountFor(offerCounts, id) >= OTHER_OFFERS_PER_PERSON
    );
}

/**
 * An Other shipment is finished when the current holder already had their
 * second offer and nobody still in the pool is due another offer.
 * New walk-ins may still receive it (up to twice), but people at the cap do not.
 */
export function otherRoundIsClosed(input: {
    eligibleIds: string[];
    offerCounts: ReadonlyMap<string, number>;
    holderId: string;
}): boolean {
    const eligible = [...new Set(input.eligibleIds.filter(Boolean))];
    if (!eligible.length || !input.holderId) return false;
    if (otherOfferCountFor(input.offerCounts, input.holderId) < OTHER_OFFERS_PER_PERSON) {
        return false;
    }
    return brokersDueForOtherOffer(eligible, input.offerCounts).length === 0;
}

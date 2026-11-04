/**
 * An Other shipment has been through everyone currently in the office twice
 * when each of them already has two passed offers and the person holding it
 * also has two. That holder closes the second round.
 */
export function otherRoundIsClosed(input: {
    eligibleIds: string[];
    offerCounts: ReadonlyMap<string, number>;
    holderId: string;
}): boolean {
    const eligible = [...new Set(input.eligibleIds.filter(Boolean))];
    if (!eligible.length || !input.holderId) return false;
    const countOf = (id: string) => input.offerCounts.get(id) || 0;
    if (countOf(input.holderId) < 2) return false;
    return eligible.every((id) => countOf(id) >= 2);
}

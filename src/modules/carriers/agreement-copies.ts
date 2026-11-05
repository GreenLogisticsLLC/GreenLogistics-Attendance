/** One signed Broker–Carrier Agreement is one file. Older copies of that same PDF are extras. */
export type AgreementCopy = {
    documentId: string;
    status: string;
    version: number;
    uploadedAt: Date | string;
};

export function pickAgreementToKeep<T extends AgreementCopy>(docs: T[]): T | null {
    if (!docs.length) return null;
    return [...docs].sort((a, b) => {
        const aCurrent = a.status === "CURRENT" ? 1 : 0;
        const bCurrent = b.status === "CURRENT" ? 1 : 0;
        if (aCurrent !== bCurrent) return bCurrent - aCurrent;
        if (a.version !== b.version) return b.version - a.version;
        return new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime();
    })[0];
}

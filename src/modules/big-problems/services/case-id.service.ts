import { prisma } from "../../../config/database.js";

/** Allocate next BP-YYYY-NNNN under a transaction-safe yearly counter. */
export async function allocateBigProblemCaseNumber(now = new Date()): Promise<string> {
    const year = now.getUTCFullYear();
    const counter = await prisma.$transaction(async (tx) => {
        const existing = await tx.bigProblemCaseCounter.findUnique({ where: { year } });
        if (!existing) {
            return tx.bigProblemCaseCounter.create({
                data: { year, lastSeq: 1 },
            });
        }
        return tx.bigProblemCaseCounter.update({
            where: { year },
            data: { lastSeq: existing.lastSeq + 1 },
        });
    });
    const seq = String(counter.lastSeq).padStart(4, "0");
    return `BP-${year}-${seq}`;
}

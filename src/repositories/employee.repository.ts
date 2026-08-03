import { prisma } from "../config/database.js";
import { normalizeCardToken } from "../utils/helpers.js";

/** Attendance list: Alen Young team first, then Gary Michael, then others. */
function teamOrder(department: string | null | undefined): number {
    const d = (department || "").trim().toLowerCase();
    if (d === "team alen young") return 1;
    if (d === "team gary michael") return 2;
    return 3;
}

function sortEmployeesByTeam<T extends { department?: string | null; lastName: string; firstName: string }>(
    rows: T[]
): T[] {
    return [...rows].sort((a, b) => {
        const td = teamOrder(a.department) - teamOrder(b.department);
        if (td !== 0) return td;
        const ln = a.lastName.localeCompare(b.lastName, undefined, { sensitivity: "base" });
        if (ln !== 0) return ln;
        return a.firstName.localeCompare(b.firstName, undefined, { sensitivity: "base" });
    });
}

export class EmployeeRepository {
    async findByCardNumber(cardNumber: string) {
        const normalized = normalizeCardToken(cardNumber);
        const employees = await prisma.employee.findMany({
            where: { status: "ACTIVE" },
            include: { shift: true },
        });
        return employees.find(
            (e) => normalizeCardToken(e.cardNumber) === normalized
        ) ?? null;
    }

    async findByExternalRef(externalRef: string) {
        return prisma.employee.findFirst({
            where: { externalRef, status: "ACTIVE" },
            include: { shift: true },
        });
    }

    async findByEmployeeNumber(employeeNumber: string) {
        return prisma.employee.findUnique({
            where: { employeeNumber },
            include: { shift: true },
        });
    }

    async findById(employeeId: string) {
        return prisma.employee.findUnique({
            where: { employeeId },
            include: { shift: true },
        });
    }

    async findAllActive() {
        const rows = await prisma.employee.findMany({
            where: { status: "ACTIVE" },
            include: { shift: true },
        });
        return sortEmployeesByTeam(rows);
    }

    async findAll() {
        const rows = await prisma.employee.findMany({
            include: { shift: true },
        });
        return sortEmployeesByTeam(rows);
    }

    async create(data: {
        employeeNumber: string;
        firstName: string;
        lastName: string;
        department?: string;
        position?: string;
        cardNumber: string;
        externalRef?: string;
        cardType?: number;
        shiftId: string;
    }) {
        return prisma.employee.create({
            data,
            include: { shift: true },
        });
    }

    async update(employeeId: string, data: Record<string, unknown>) {
        return prisma.employee.update({
            where: { employeeId },
            data,
            include: { shift: true },
        });
    }
}

export const employeeRepository = new EmployeeRepository();

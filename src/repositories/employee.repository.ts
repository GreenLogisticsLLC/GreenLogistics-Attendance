import { prisma } from "../config/database.js";
import { normalizeCardToken } from "../utils/helpers.js";

/**
 * Attendance Live Board order:
 * 1) Team Alen Young (Alen on row 1, then his brokers)
 * 2) Team Carl Anderson (Carl first, then his brokers)
 * 3) Team Gary Michael (legacy)
 * 4) everyone else
 */
function teamOrder(department: string | null | undefined): number {
    const d = (department || "").trim().toLowerCase();
    if (d.includes("alen") || d.includes("allen")) return 1;
    if (d.includes("carl")) return 2;
    if (d.includes("gary")) return 3;
    return 4;
}

/** Team lead sits first within their department (name matches "Team …"). */
function isDepartmentLead(emp: {
    department?: string | null;
    firstName: string;
    lastName: string;
    position?: string | null;
}): boolean {
    const pos = (emp.position || "").trim().toLowerCase();
    if (pos === "team lead" || pos === "teamlead" || pos.includes("team lead")) {
        return true;
    }
    const dept = (emp.department || "").trim().toLowerCase();
    if (!dept.startsWith("team ")) return false;
    const first = emp.firstName.trim().toLowerCase();
    const last = emp.lastName.trim().toLowerCase();
    if (!first || !last) return false;
    return dept.includes(first) && dept.includes(last);
}

export function sortEmployeesByTeam<
    T extends {
        department?: string | null;
        lastName: string;
        firstName: string;
        position?: string | null;
    },
>(rows: T[]): T[] {
    return [...rows].sort((a, b) => {
        const td = teamOrder(a.department) - teamOrder(b.department);
        if (td !== 0) return td;
        const leadA = isDepartmentLead(a) ? 0 : 1;
        const leadB = isDepartmentLead(b) ? 0 : 1;
        if (leadA !== leadB) return leadA - leadB;
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

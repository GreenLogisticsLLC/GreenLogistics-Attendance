import { prisma } from "../config/database.js";
import { normalizeCardToken } from "../utils/helpers.js";

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
        return prisma.employee.findMany({
            where: { status: "ACTIVE" },
            include: { shift: true },
            orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        });
    }

    async findAll() {
        return prisma.employee.findMany({
            include: { shift: true },
            orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        });
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

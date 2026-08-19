import { prisma } from "../../../config/database.js";
import { isDataScopedRole, isTeamScopedRole, Roles } from "../../../auth/roles.js";
import { allocateGreenOsShipmentId } from "../../shipment/shipment.id.js";
import { shipmentService } from "../../shipment/services/shipment.service.js";
import { domainEventEngine } from "../../shipment/services/domain-event.engine.js";

type Actor = { userId: string; role: string };

function str(v: unknown): string | null {
    if (v == null) return null;
    const s = String(v).trim();
    return s || null;
}

function num(v: unknown): number | null {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
}

function dateVal(v: unknown): Date | null {
    const s = str(v);
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

export class CustomerService {
    private async visibleCreatorIds(actor: Actor): Promise<string[] | null> {
        if (!isDataScopedRole(actor.role) && !isTeamScopedRole(actor.role)) return null;
        if (isDataScopedRole(actor.role)) return [actor.userId];
        const team = await prisma.user.findMany({
            where: { teamLeadId: actor.userId },
            select: { userId: true },
        });
        return [actor.userId, ...team.map((u) => u.userId)];
    }

    private async assertVisible(customerId: string, actor: Actor) {
        const row = await prisma.directCustomer.findUnique({ where: { customerId } });
        if (!row) {
            throw Object.assign(new Error("Customer not found"), { status: 404 });
        }
        const ids = await this.visibleCreatorIds(actor);
        if (ids && !ids.includes(row.createdByUserId)) {
            throw Object.assign(new Error("Customer not found"), { status: 404 });
        }
        return row;
    }

    async list(actor: Actor, q?: string) {
        const ids = await this.visibleCreatorIds(actor);
        const where: Record<string, unknown> = {};
        if (ids) where.createdByUserId = { in: ids };
        const query = str(q);
        if (query) {
            where.OR = [
                { companyName: { contains: query } },
                { contactName: { contains: query } },
                { email: { contains: query } },
                { phone: { contains: query } },
            ];
        }
        const rows = await prisma.directCustomer.findMany({
            where,
            orderBy: { updatedAt: "desc" },
            take: 300,
        });
        const counts = await prisma.shipmentLead.groupBy({
            by: ["directCustomerId"],
            where: {
                directCustomerId: { in: rows.map((r) => r.customerId) },
            },
            _count: { _all: true },
        });
        const countMap = new Map(
            counts
                .filter((c) => c.directCustomerId)
                .map((c) => [c.directCustomerId as string, c._count._all])
        );
        return rows.map((r) => ({
            ...r,
            loadCount: countMap.get(r.customerId) || 0,
        }));
    }

    async get(customerId: string, actor: Actor) {
        const row = await this.assertVisible(customerId, actor);
        const loads = await prisma.shipmentLead.findMany({
            where: { directCustomerId: customerId },
            orderBy: { createdAt: "desc" },
            take: 50,
            select: {
                shipmentLeadId: true,
                loadNumber: true,
                greenOsShipmentId: true,
                shipmentTitle: true,
                status: true,
                pickupCity: true,
                pickupState: true,
                deliveryCity: true,
                deliveryState: true,
                createdAt: true,
            },
        });
        return { ...row, loads };
    }

    async create(body: Record<string, unknown>, actor: Actor) {
        const companyName = str(body.companyName);
        if (!companyName) {
            throw Object.assign(new Error("Company name is required"), { status: 422 });
        }
        return prisma.directCustomer.create({
            data: {
                companyName,
                contactName: str(body.contactName),
                email: str(body.email),
                phone: str(body.phone),
                billingAddress: str(body.billingAddress),
                city: str(body.city),
                state: str(body.state),
                zip: str(body.zip),
                notes: str(body.notes),
                createdByUserId: actor.userId,
            },
        });
    }

    async update(customerId: string, body: Record<string, unknown>, actor: Actor) {
        await this.assertVisible(customerId, actor);
        const data: Record<string, unknown> = {};
        if (body.companyName !== undefined) {
            const name = str(body.companyName);
            if (!name) throw Object.assign(new Error("Company name is required"), { status: 422 });
            data.companyName = name;
        }
        for (const key of ["contactName", "email", "phone", "billingAddress", "city", "state", "zip", "notes"]) {
            if (body[key] !== undefined) data[key] = str(body[key]);
        }
        return prisma.directCustomer.update({ where: { customerId }, data });
    }

    /**
     * Create a new lot + Load Number from a Direct Customer (skips uShip).
     * Broker is assigned immediately; GL# is allocated after Accepted.
     */
    async createLoad(customerId: string, body: Record<string, unknown>, actor: Actor) {
        const customer = await this.assertVisible(customerId, actor);
        const pickupCity = str(body.pickupCity);
        const deliveryCity = str(body.deliveryCity);
        if (!pickupCity || !deliveryCity) {
            throw Object.assign(new Error("Pickup city and delivery city are required"), { status: 422 });
        }

        const customerName = str(body.customerName) || customer.companyName;
        const title =
            str(body.shipmentTitle) ||
            `${customerName} ${pickupCity} → ${deliveryCity}`;
        const pickupFrom = dateVal(body.pickupFrom) || dateVal(body.pickupDate);
        const deliveryFrom = dateVal(body.deliveryFrom) || dateVal(body.deliveryDate);
        const customerRate = num(body.customerRate);
        const greenOsShipmentId = await allocateGreenOsShipmentId();
        const now = new Date();
        const brokerId =
            actor.role === Roles.Broker ? actor.userId : str(body.assignedBrokerId) || actor.userId;

        const lead = await prisma.shipmentLead.create({
            data: {
                greenOsShipmentId,
                source: "direct_customer",
                shipmentTitle: title,
                customerName,
                customerEmail: str(body.customerEmail) || customer.email,
                customerPhone: str(body.customerPhone) || customer.phone,
                pickupCity,
                pickupState: str(body.pickupState),
                pickupZip: str(body.pickupZip),
                deliveryCity,
                deliveryState: str(body.deliveryState),
                deliveryZip: str(body.deliveryZip),
                pickupFrom,
                deliveryFrom,
                opsPickupAt: pickupFrom,
                opsDeliveryAt: deliveryFrom,
                miles: num(body.miles),
                equipment: str(body.equipment),
                commodity: str(body.commodity) || str(body.vehicle),
                weight: str(body.weight),
                pieces: num(body.pieces) != null ? Math.round(num(body.pieces) as number) : null,
                specialInstructions: str(body.specialInstructions),
                notes: str(body.notes),
                customerRate,
                price: customerRate,
                status: "ACCEPTED",
                acceptedAt: now,
                assignedBrokerId: brokerId,
                assignedAt: now,
                receivedAt: now,
                directCustomerId: customer.customerId,
                priority: "NORMAL",
            },
        });

        await shipmentService.markImported(lead.shipmentLeadId, {
            source: "direct_customer",
            customerId: customer.customerId,
            greenOsShipmentId,
        });
        await domainEventEngine.emit({
            shipmentLeadId: lead.shipmentLeadId,
            eventType: "CUSTOMER_ACCEPTED",
            title: "Direct Customer Load",
            message: `Direct lot from ${customerName}`,
            actorUserId: actor.userId,
            payload: { source: "direct_customer", customerId: customer.customerId },
            timelineStage: "CUSTOMER_ACCEPTED",
        });

        const loaded = await shipmentService.createLoadAfterAccepted({
            shipmentLeadId: lead.shipmentLeadId,
            actorUserId: actor.userId,
        });

        return {
            customer,
            shipmentLeadId: loaded.shipmentLeadId,
            loadNumber: loaded.loadNumber,
            greenOsShipmentId: loaded.greenOsShipmentId || greenOsShipmentId,
            status: loaded.status,
        };
    }
}

export const customerService = new CustomerService();

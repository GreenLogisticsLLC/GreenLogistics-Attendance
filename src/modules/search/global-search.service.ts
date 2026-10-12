import { prisma } from "../../config/database.js";
import { isDataScopedRole, isTeamScopedRole, Roles } from "../../auth/roles.js";
import { listTeamBrokerIds } from "../../auth/team-scope.js";
import { carrierService } from "../carriers/services/carrier.service.js";
import { customerService } from "../customers/services/customer.service.js";

export type GlobalSearchActor = { userId: string; role: string };

export type GlobalSearchItem = {
    type:
        | "SHIPMENT"
        | "LOAD"
        | "CARRIER"
        | "CUSTOMER"
        | "EMPLOYEE"
        | "USER"
        | "DOCUMENT"
        | "EMAIL";
    id: string;
    title: string;
    subtitle: string;
    snippet: string;
    matchedFields: string[];
    score: number;
    href: string | null;
    meta: Record<string, unknown>;
};

export type GlobalSearchGroup = {
    type: GlobalSearchItem["type"];
    label: string;
    count: number;
    items: GlobalSearchItem[];
};

const GROUP_LABELS: Record<GlobalSearchItem["type"], string> = {
    LOAD: "Loads",
    SHIPMENT: "Shipments",
    CARRIER: "Carriers",
    CUSTOMER: "Customers",
    EMPLOYEE: "Employees",
    USER: "People",
    DOCUMENT: "Documents",
    EMAIL: "Emails",
};

const GROUP_ORDER: GlobalSearchItem["type"][] = [
    "LOAD",
    "SHIPMENT",
    "CARRIER",
    "CUSTOMER",
    "EMPLOYEE",
    "USER",
    "DOCUMENT",
    "EMAIL",
];

function snippetOf(...parts: Array<string | null | undefined>): string {
    return parts.filter(Boolean).join(" · ").slice(0, 240);
}

function digitsOnly(s: string): string {
    return String(s || "").replace(/\D/g, "");
}

async function brokerScopeIds(actor: GlobalSearchActor): Promise<string[] | null> {
    if (isDataScopedRole(actor.role)) return [actor.userId];
    if (isTeamScopedRole(actor.role)) {
        const ids = await listTeamBrokerIds(actor.userId);
        return ids.length ? ids : ["__none__"];
    }
    return null;
}

function canSearchPeople(role: string): boolean {
    return (
        role === Roles.Administrator ||
        role === Roles.Owner ||
        role === Roles.Manager ||
        role === Roles.HR ||
        role === Roles.TeamLead
    );
}

function scoreMatch(q: string, value: string | null | undefined, field: string): number {
    if (!value) return 0;
    const v = String(value).toLowerCase();
    const needle = q.toLowerCase();
    if (!needle) return 0;
    if (v === needle) return field.includes("Number") || field.includes("Id") ? 100 : 90;
    if (v.startsWith(needle)) return 70;
    if (v.includes(needle)) return 50;
    const qd = digitsOnly(q);
    const vd = digitsOnly(value);
    if (qd && vd && (vd === qd || vd.includes(qd))) return 80;
    return 0;
}

function bestScore(
    q: string,
    fields: Array<[string | null | undefined, string]>
): { score: number; matched: string[] } {
    let score = 0;
    const matched: string[] = [];
    for (const [value, field] of fields) {
        const s = scoreMatch(q, value, field);
        if (s > 0) {
            matched.push(field);
            if (s > score) score = s;
        }
    }
    return { score, matched };
}

export class GlobalSearchService {
    async search(actor: GlobalSearchActor, rawQuery: string, limitPerGroup = 8) {
        const query = String(rawQuery || "").trim();
        if (!query) {
            return { query, total: 0, groups: [] as GlobalSearchGroup[] };
        }

        const take = Math.min(Math.max(limitPerGroup, 1), 15);
        const brokerIds = await brokerScopeIds(actor);

        const [loadsShipments, carriers, customers, people, documents, emails] =
            await Promise.all([
                this.searchShipmentsAndLoads(actor, query, brokerIds, take),
                this.searchCarriers(actor, query, take),
                this.searchCustomers(actor, query, take),
                canSearchPeople(actor.role)
                    ? this.searchPeople(actor, query, take)
                    : Promise.resolve({ employees: [], users: [] }),
                this.searchDocuments(actor, query, brokerIds, take),
                this.searchEmails(actor, query, brokerIds, take),
            ]);

        const items: GlobalSearchItem[] = [
            ...loadsShipments,
            ...carriers,
            ...customers,
            ...people.employees,
            ...people.users,
            ...documents,
            ...emails,
        ];

        items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

        const byType = new Map<GlobalSearchItem["type"], GlobalSearchItem[]>();
        for (const item of items) {
            const list = byType.get(item.type) || [];
            list.push(item);
            byType.set(item.type, list);
        }

        const groups: GlobalSearchGroup[] = GROUP_ORDER.filter((t) => byType.has(t)).map(
            (type) => {
                const groupItems = (byType.get(type) || []).slice(0, take);
                return {
                    type,
                    label: GROUP_LABELS[type],
                    count: groupItems.length,
                    items: groupItems,
                };
            }
        );

        return {
            query,
            total: groups.reduce((n, g) => n + g.count, 0),
            groups,
        };
    }

    private async searchShipmentsAndLoads(
        actor: GlobalSearchActor,
        query: string,
        brokerIds: string[] | null,
        take: number
    ): Promise<GlobalSearchItem[]> {
        const q = query.slice(0, 80);
        const qd = digitsOnly(q);
        const where: Record<string, unknown> = {};
        if (brokerIds) where.assignedBrokerId = { in: brokerIds };

        const or: Record<string, unknown>[] = [
            { loadNumber: { contains: q } },
            { greenOsShipmentId: { contains: q } },
            { externalShipmentId: { contains: q } },
            { referenceNumber: { contains: q } },
            { shipmentTitle: { contains: q } },
            { customerName: { contains: q } },
            { carrierName: { contains: q } },
            { carrierMc: { contains: q } },
            { carrierDot: { contains: q } },
            { commodity: { contains: q } },
            { pickupCity: { contains: q } },
            { pickupState: { contains: q } },
            { pickupZip: { contains: q } },
            { deliveryCity: { contains: q } },
            { deliveryState: { contains: q } },
            { deliveryZip: { contains: q } },
            { driverName: { contains: q } },
            { driverPhone: { contains: q } },
            { truckNumber: { contains: q } },
            { trailerNumber: { contains: q } },
            { status: { contains: q } },
            { invoiceNumber: { contains: q } },
        ];
        if (qd && qd !== q) {
            or.push(
                { loadNumber: { contains: qd } },
                { greenOsShipmentId: { contains: qd } },
                { carrierMc: { contains: qd } },
                { carrierDot: { contains: qd } },
                { pickupZip: { contains: qd } },
                { deliveryZip: { contains: qd } },
                { driverPhone: { contains: qd } },
                { truckNumber: { contains: qd } },
                { trailerNumber: { contains: qd } }
            );
        }
        where.OR = or;

        const rows = await prisma.shipmentLead.findMany({
            where,
            take: take * 3,
            orderBy: { updatedAt: "desc" },
            select: {
                shipmentLeadId: true,
                loadNumber: true,
                greenOsShipmentId: true,
                status: true,
                customerName: true,
                carrierName: true,
                carrierMc: true,
                carrierDot: true,
                pickupCity: true,
                pickupState: true,
                pickupZip: true,
                deliveryCity: true,
                deliveryState: true,
                deliveryZip: true,
                driverName: true,
                driverPhone: true,
                truckNumber: true,
                trailerNumber: true,
                shipmentTitle: true,
                commodity: true,
                invoiceNumber: true,
            },
        });

        return rows
            .map((row) => {
                const { score, matched } = bestScore(q, [
                    [row.loadNumber, "loadNumber"],
                    [row.greenOsShipmentId, "greenOsShipmentId"],
                    [row.customerName, "customerName"],
                    [row.carrierName, "carrierName"],
                    [row.carrierMc, "carrierMc"],
                    [row.carrierDot, "carrierDot"],
                    [row.pickupCity, "pickupCity"],
                    [row.pickupZip, "pickupZip"],
                    [row.deliveryCity, "deliveryCity"],
                    [row.deliveryZip, "deliveryZip"],
                    [row.driverName, "driverName"],
                    [row.driverPhone, "driverPhone"],
                    [row.truckNumber, "truckNumber"],
                    [row.trailerNumber, "trailerNumber"],
                    [row.shipmentTitle, "shipmentTitle"],
                    [row.commodity, "commodity"],
                    [row.status, "status"],
                    [row.invoiceNumber, "invoiceNumber"],
                ]);
                const isLoad = Boolean(row.loadNumber);
                const type: GlobalSearchItem["type"] = isLoad ? "LOAD" : "SHIPMENT";
                const title =
                    row.loadNumber ||
                    row.greenOsShipmentId ||
                    row.shipmentTitle ||
                    row.shipmentLeadId.slice(0, 8);
                const lane = snippetOf(
                    [row.pickupCity, row.pickupState, row.pickupZip].filter(Boolean).join(", "),
                    "→",
                    [row.deliveryCity, row.deliveryState, row.deliveryZip]
                        .filter(Boolean)
                        .join(", ")
                );
                return {
                    type,
                    id: row.shipmentLeadId,
                    title,
                    subtitle: row.status || "",
                    snippet: snippetOf(
                        row.customerName,
                        row.carrierName,
                        lane,
                        row.driverName && `Driver ${row.driverName}`,
                        row.truckNumber && `Truck ${row.truckNumber}`
                    ),
                    matchedFields: matched.length ? matched : ["keyword"],
                    score: score || 40,
                    href: isLoad
                        ? `#/dispatch/active-loads/${encodeURIComponent(row.shipmentLeadId)}`
                        : null,
                    meta: {
                        shipmentLeadId: row.shipmentLeadId,
                        loadNumber: row.loadNumber,
                        greenOsShipmentId: row.greenOsShipmentId,
                        hasLoad: isLoad,
                        status: row.status,
                    },
                } satisfies GlobalSearchItem;
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, take * 2);
    }

    private async searchCarriers(
        actor: GlobalSearchActor,
        query: string,
        take: number
    ): Promise<GlobalSearchItem[]> {
        const q = query.slice(0, 80);
        const qd = digitsOnly(q);
        const where: Record<string, unknown> = {};
        if (isDataScopedRole(actor.role)) where.assignedBrokerId = actor.userId;
        else if (isTeamScopedRole(actor.role)) {
            const ids = await listTeamBrokerIds(actor.userId);
            where.assignedBrokerId = { in: ids.length ? ids : ["__none__"] };
        }
        const or: Record<string, unknown>[] = [
            { legalName: { contains: q } },
            { dbaName: { contains: q } },
            { email: { contains: q } },
            { phone: { contains: q } },
            { mcNumber: { contains: q } },
            { dotNumber: { contains: q } },
            { contactName: { contains: q } },
            { city: { contains: q } },
            { state: { contains: q } },
            { zip: { contains: q } },
            { address: { contains: q } },
        ];
        if (qd && qd !== q) {
            or.push(
                { phone: { contains: qd } },
                { mcNumber: { contains: qd } },
                { dotNumber: { contains: qd } },
                { zip: { contains: qd } }
            );
        }
        where.OR = or;

        const listed = await prisma.carrier.findMany({
            where,
            take,
            orderBy: { updatedAt: "desc" },
            select: {
                carrierId: true,
                legalName: true,
                dbaName: true,
                mcNumber: true,
                dotNumber: true,
                email: true,
                phone: true,
                contactName: true,
                city: true,
                state: true,
                zip: true,
                status: true,
                onboardingStatus: true,
            },
        });

        return listed.map((row) => {
            const { score, matched } = bestScore(query, [
                [row.legalName, "legalName"],
                [row.dbaName, "dbaName"],
                [row.mcNumber, "mcNumber"],
                [row.dotNumber, "dotNumber"],
                [row.email, "email"],
                [row.phone, "phone"],
                [row.contactName, "contactName"],
                [row.city, "city"],
                [row.state, "state"],
                [row.zip, "zip"],
            ]);
            return {
                type: "CARRIER" as const,
                id: row.carrierId,
                title: row.legalName,
                subtitle: snippetOf(
                    row.mcNumber && `MC ${row.mcNumber}`,
                    row.dotNumber && `DOT ${row.dotNumber}`
                ),
                snippet: snippetOf(
                    row.dbaName && `DBA ${row.dbaName}`,
                    row.email,
                    row.phone,
                    [row.city, row.state, row.zip].filter(Boolean).join(", "),
                    row.onboardingStatus || row.status
                ),
                matchedFields: matched.length ? matched : ["keyword"],
                score: score || 45,
                href: `#/carriers/${encodeURIComponent(row.carrierId)}`,
                meta: {
                    carrierId: row.carrierId,
                    mcNumber: row.mcNumber,
                    dotNumber: row.dotNumber,
                    status: row.status,
                    onboardingStatus: row.onboardingStatus,
                },
            };
        });
    }

    private async searchCustomers(
        actor: GlobalSearchActor,
        query: string,
        take: number
    ): Promise<GlobalSearchItem[]> {
        try {
            const rows = await customerService.list(actor, query.slice(0, 80));
            return rows.slice(0, take).map((row) => {
                const { score, matched } = bestScore(query, [
                    [row.companyName, "companyName"],
                    [row.contactName, "contactName"],
                    [row.email, "email"],
                    [row.phone, "phone"],
                    [row.city, "city"],
                    [row.state, "state"],
                    [row.zip, "zip"],
                ]);
                return {
                    type: "CUSTOMER" as const,
                    id: row.customerId,
                    title: row.companyName,
                    subtitle: row.contactName || "",
                    snippet: snippetOf(
                        row.email,
                        row.phone,
                        [row.city, row.state, row.zip].filter(Boolean).join(", "),
                        row.loadCount != null ? `${row.loadCount} loads` : null
                    ),
                    matchedFields: matched.length ? matched : ["keyword"],
                    score: score || 45,
                    href: `#/customers/${encodeURIComponent(row.customerId)}`,
                    meta: { customerId: row.customerId, loadCount: row.loadCount },
                };
            });
        } catch {
            return [];
        }
    }

    private async searchPeople(
        actor: GlobalSearchActor,
        query: string,
        take: number
    ): Promise<{ employees: GlobalSearchItem[]; users: GlobalSearchItem[] }> {
        const q = query.slice(0, 80);
        const qd = digitsOnly(q);

        const empWhere: Record<string, unknown> = {
            OR: [
                { firstName: { contains: q } },
                { lastName: { contains: q } },
                { employeeNumber: { contains: q } },
                { cardNumber: { contains: q } },
                { department: { contains: q } },
                { position: { contains: q } },
            ],
        };
        if (qd && qd !== q) {
            (empWhere.OR as Record<string, unknown>[]).push(
                { employeeNumber: { contains: qd } },
                { cardNumber: { contains: qd } }
            );
        }

        const nameOr: Record<string, unknown>[] = [
            { firstName: { contains: q } },
            { lastName: { contains: q } },
            { email: { contains: q } },
            { username: { contains: q } },
            { role: { roleName: { contains: q } } },
        ];
        const userWhere: Record<string, unknown> = { OR: nameOr };

        // Team leads only see themselves + brokers on their team.
        if (actor.role === Roles.TeamLead) {
            const ids = await listTeamBrokerIds(actor.userId);
            userWhere.AND = [
                {
                    OR: [{ userId: actor.userId }, { userId: { in: ids } }, { teamLeadId: actor.userId }],
                },
                { OR: nameOr },
            ];
            delete userWhere.OR;
        }

        const [employees, users] = await Promise.all([
            prisma.employee.findMany({
                where: empWhere,
                take,
                orderBy: { updatedAt: "desc" },
                select: {
                    employeeId: true,
                    employeeNumber: true,
                    firstName: true,
                    lastName: true,
                    department: true,
                    position: true,
                    cardNumber: true,
                    status: true,
                },
            }),
            prisma.user.findMany({
                where: userWhere,
                take,
                orderBy: { updatedAt: "desc" },
                select: {
                    userId: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    username: true,
                    isActive: true,
                    role: { select: { roleName: true } },
                },
            }),
        ]);

        return {
            employees: employees.map((row) => {
                const name = `${row.firstName} ${row.lastName}`.trim();
                const { score, matched } = bestScore(q, [
                    [row.firstName, "firstName"],
                    [row.lastName, "lastName"],
                    [name, "name"],
                    [row.employeeNumber, "employeeNumber"],
                    [row.cardNumber, "cardNumber"],
                    [row.department, "department"],
                    [row.position, "position"],
                ]);
                return {
                    type: "EMPLOYEE" as const,
                    id: row.employeeId,
                    title: name || row.employeeNumber,
                    subtitle: snippetOf(row.position, row.department, row.status),
                    snippet: snippetOf(
                        `#${row.employeeNumber}`,
                        row.cardNumber && `Card ${row.cardNumber}`
                    ),
                    matchedFields: matched.length ? matched : ["keyword"],
                    score: score || 40,
                    href: "#/employees",
                    meta: {
                        employeeId: row.employeeId,
                        employeeNumber: row.employeeNumber,
                    },
                };
            }),
            users: users.map((row) => {
                const name = `${row.firstName || ""} ${row.lastName || ""}`.trim();
                const roleName = row.role?.roleName || "";
                const { score, matched } = bestScore(q, [
                    [row.firstName, "firstName"],
                    [row.lastName, "lastName"],
                    [name, "name"],
                    [row.email, "email"],
                    [row.username, "username"],
                    [roleName, "role"],
                ]);
                return {
                    type: "USER" as const,
                    id: row.userId,
                    title: name || row.email || row.username,
                    subtitle: roleName,
                    snippet: snippetOf(row.email, row.isActive ? "active" : "inactive"),
                    matchedFields: matched.length ? matched : ["keyword"],
                    score: score || 40,
                    href:
                        actor.role === Roles.Administrator ||
                        actor.role === Roles.Owner ||
                        actor.role === Roles.Manager ||
                        actor.role === Roles.HR
                            ? "#/administration/users"
                            : null,
                    meta: { userId: row.userId, email: row.email, role: roleName },
                };
            }),
        };
    }

    private async searchDocuments(
        actor: GlobalSearchActor,
        query: string,
        brokerIds: string[] | null,
        take: number
    ): Promise<GlobalSearchItem[]> {
        const q = query.slice(0, 80);
        const carrierWhere: Record<string, unknown> = {
            status: "CURRENT",
            OR: [
                { originalFilename: { contains: q } },
                { documentType: { contains: q } },
            ],
        };
        if (brokerIds) {
            carrierWhere.carrier = { assignedBrokerId: { in: brokerIds } };
        }

        const docs = await prisma.carrierDocument.findMany({
            where: carrierWhere,
            take,
            orderBy: { uploadedAt: "desc" },
            select: {
                documentId: true,
                carrierId: true,
                shipmentLeadId: true,
                documentType: true,
                originalFilename: true,
                status: true,
                carrier: { select: { legalName: true } },
            },
        });

        const out: GlobalSearchItem[] = [];
        for (const d of docs) {
            try {
                await carrierService.assertCarrierAccess(d.carrierId, actor);
            } catch {
                continue;
            }
            out.push({
                type: "DOCUMENT",
                id: d.documentId,
                title: `${d.documentType}: ${d.originalFilename}`,
                subtitle: d.carrier.legalName,
                snippet: snippetOf(d.status, d.documentType),
                matchedFields: ["filename", "documentType"],
                score: 45,
                href: `#/carriers/${encodeURIComponent(d.carrierId)}`,
                meta: {
                    carrierId: d.carrierId,
                    shipmentLeadId: d.shipmentLeadId || undefined,
                    documentType: d.documentType,
                },
            });
        }

        // Load documents by filename / type
        const loadDocWhere: Record<string, unknown> = {
            isCurrent: true,
            OR: [
                { fileName: { contains: q } },
                { title: { contains: q } },
                { docType: { contains: q } },
            ],
        };
        if (brokerIds) {
            loadDocWhere.shipmentLead = { assignedBrokerId: { in: brokerIds } };
        }
        const loadDocs = await prisma.loadDocument.findMany({
            where: loadDocWhere,
            take,
            orderBy: { createdAt: "desc" },
            select: {
                documentId: true,
                shipmentLeadId: true,
                docType: true,
                fileName: true,
                title: true,
                shipmentLead: { select: { loadNumber: true, greenOsShipmentId: true } },
            },
        });
        for (const d of loadDocs) {
            out.push({
                type: "DOCUMENT",
                id: d.documentId,
                title: `${d.docType}: ${d.fileName || d.title || d.documentId}`,
                subtitle:
                    d.shipmentLead.loadNumber ||
                    d.shipmentLead.greenOsShipmentId ||
                    "",
                snippet: snippetOf(d.docType),
                matchedFields: ["load_document"],
                score: 45,
                href: d.shipmentLead.loadNumber
                    ? `#/dispatch/active-loads/${encodeURIComponent(d.shipmentLeadId)}`
                    : null,
                meta: {
                    shipmentLeadId: d.shipmentLeadId,
                    documentType: d.docType,
                    hasLoad: Boolean(d.shipmentLead.loadNumber),
                },
            });
        }

        return out.slice(0, take);
    }

    private async searchEmails(
        actor: GlobalSearchActor,
        query: string,
        brokerIds: string[] | null,
        take: number
    ): Promise<GlobalSearchItem[]> {
        const q = query.slice(0, 80);
        const mailboxWhere: Record<string, unknown> = {
            OR: [
                { subject: { contains: q } },
                { snippet: { contains: q } },
                { fromAddress: { contains: q } },
                { bodyText: { contains: q } },
            ],
        };
        if (isDataScopedRole(actor.role)) {
            mailboxWhere.userId = actor.userId;
        } else if (brokerIds) {
            mailboxWhere.userId = { in: brokerIds };
        }

        const rows = await prisma.brokerMailboxMessage.findMany({
            where: mailboxWhere,
            take,
            orderBy: { receivedAt: "desc" },
            select: {
                messageId: true,
                shipmentLeadId: true,
                fromAddress: true,
                subject: true,
                snippet: true,
                receivedAt: true,
            },
        });

        return rows.map((m) => ({
            type: "EMAIL" as const,
            id: m.messageId,
            title: m.subject || "(no subject)",
            subtitle: m.fromAddress || "",
            snippet: snippetOf(
                m.snippet,
                m.receivedAt ? m.receivedAt.toISOString().slice(0, 10) : null
            ),
            matchedFields: ["subject", "snippet", "from"],
            score: 40,
            href: m.shipmentLeadId ? null : "#/email",
            meta: {
                shipmentLeadId: m.shipmentLeadId || undefined,
                fromAddress: m.fromAddress,
            },
        }));
    }
}

export const globalSearchService = new GlobalSearchService();

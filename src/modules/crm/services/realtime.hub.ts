/**
 * In-memory SSE hub — push events to connected GreenOS clients by userId.
 * One Node process (PM2 fork) is enough for Contabo v1.
 */

export type RealtimeEvent = {
    type: string;
    [key: string]: unknown;
};

type Client = {
    userId: string;
    role: string;
    res: import("express").Response;
};

const clients = new Set<Client>();

export function sseSubscribe(client: Client) {
    clients.add(client);
    client.res.on("close", () => {
        clients.delete(client);
    });
}

export function sseClientCount(): number {
    return clients.size;
}

/** Send to one user (all their tabs). */
export function sseEmitToUser(userId: string, event: RealtimeEvent) {
    if (!userId) return;
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const c of clients) {
        if (c.userId !== userId) continue;
        try {
            c.res.write(payload);
        } catch {
            clients.delete(c);
        }
    }
}

/** Send to every connected client with one of the roles. */
export function sseEmitToRoles(roles: string[], event: RealtimeEvent) {
    const set = new Set(roles);
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const c of clients) {
        if (!set.has(c.role)) continue;
        try {
            c.res.write(payload);
        } catch {
            clients.delete(c);
        }
    }
}

export function sseHeartbeat() {
    const payload = `: heartbeat ${Date.now()}\n\n`;
    for (const c of clients) {
        try {
            c.res.write(payload);
        } catch {
            clients.delete(c);
        }
    }
}

/** Keep nginx / proxies from closing idle SSE connections. */
let heartbeatTimer: NodeJS.Timeout | null = null;
export function startSseHeartbeat(intervalMs = 25_000) {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(sseHeartbeat, intervalMs);
}

import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { apiResponse } from "../../../utils/helpers.js";
import { teamScopeUserId } from "../../../auth/access.js";
import { isBrokerOnTeam } from "../../../auth/team-scope.js";
import { brokerShipmentStatsService } from "../services/broker-shipment-stats.service.js";

export async function crmBrokerShipmentStatsController(req: AuthRequest, res: Response) {
    const teamLeadId = teamScopeUserId(req);
    if (!teamLeadId) {
        return res.status(403).json(apiResponse(false, "Only a Team Lead can open broker shipment totals"));
    }
    const requested = String(req.query.brokerId || "").trim();
    if (requested) {
        const onTeam = await isBrokerOnTeam(teamLeadId, requested);
        if (!onTeam) {
            return res.status(403).json(apiResponse(false, "That broker is not on your team"));
        }
    }
    const data = await brokerShipmentStatsService.forTeamLead(teamLeadId);
    const rows = requested ? data.rows.filter((row) => row.brokerId === requested) : data.rows;
    return res.json(
        apiResponse(true, "Broker shipment totals", {
            brokers: data.brokers,
            rows,
        })
    );
}

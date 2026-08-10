import { Router } from "express";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import {
    carriersController,
    carrierOnboardingPublicController,
    carrierUpload,
} from "../controllers/carriers.controller.js";

const staff = ["Administrator", "Owner", "Manager", "Team Lead", "Broker", "Dispatcher"] as const;

/** Authenticated Green OS carrier APIs */
export const carriersRouter = Router();
carriersRouter.use(authMiddleware);
carriersRouter.get("/", requireRole(...staff), carriersController.list);
carriersRouter.get("/dashboard", requireRole(...staff), carriersController.dashboard);
carriersRouter.post("/", requireRole(...staff), carriersController.create);
carriersRouter.post(
    "/from-load/:shipmentLeadId/invite-agreement",
    requireRole(...staff),
    carriersController.inviteAgreementFromLoad
);
carriersRouter.post(
    "/from-load/:shipmentLeadId/invite-rc-bol",
    requireRole(...staff),
    carriersController.inviteRcBolFromLoad
);
carriersRouter.get("/:id", requireRole(...staff), carriersController.get);
carriersRouter.patch("/:id", requireRole(...staff), carriersController.patch);
carriersRouter.post("/:id/onboarding/invite", requireRole(...staff), carriersController.invite);
carriersRouter.post("/:id/onboarding/resend", requireRole(...staff), carriersController.resend);
carriersRouter.get("/:id/onboarding", requireRole(...staff), carriersController.get);
carriersRouter.post(
    "/:id/onboarding/request-changes",
    requireRole(...staff),
    carriersController.requestChanges
);
carriersRouter.post("/:id/onboarding/approve", requireRole(...staff), carriersController.approve);
carriersRouter.post("/:id/onboarding/reject", requireRole(...staff), carriersController.reject);
carriersRouter.get(
    "/:id/documents/:documentId/download",
    requireRole(...staff),
    carriersController.downloadDocument
);

/** Public carrier onboarding portal APIs (token = credential) */
export const carrierOnboardingPublicRouter = Router();
carrierOnboardingPublicRouter.get("/:token", carrierOnboardingPublicController.get);
carrierOnboardingPublicRouter.post("/:token/save", carrierOnboardingPublicController.save);
carrierOnboardingPublicRouter.post(
    "/:token/documents",
    carrierUpload.single("file"),
    carrierOnboardingPublicController.upload
);
carrierOnboardingPublicRouter.post(
    "/:token/sign-agreement",
    carrierOnboardingPublicController.signAgreement
);
carrierOnboardingPublicRouter.post("/:token/sign-rc", carrierOnboardingPublicController.signRc);
carrierOnboardingPublicRouter.post("/:token/submit", carrierOnboardingPublicController.submit);

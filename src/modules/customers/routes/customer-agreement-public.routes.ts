import { Router } from "express";
import { customerAgreementPublicController } from "../controllers/customer-agreement-public.controller.js";

export const customerAgreementPublicRouter = Router();
customerAgreementPublicRouter.get("/:token", customerAgreementPublicController.get);
customerAgreementPublicRouter.post("/:token/save", customerAgreementPublicController.save);
customerAgreementPublicRouter.post("/:token/sign", customerAgreementPublicController.sign);
customerAgreementPublicRouter.get(
    "/:token/signed-pdf",
    customerAgreementPublicController.downloadSigned
);

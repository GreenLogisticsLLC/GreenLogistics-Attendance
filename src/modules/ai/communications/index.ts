export * from "./types.js";
export * from "./context.service.js";
export * from "./format.js";
export * from "./communications.controller.js";

import { classifyResponse, detectDocumentTypesInText, extractCommitment } from "./classify.js";
import { classifyDirection } from "./direction.js";
import { computeWaitingState } from "./waiting.js";

export const _commTestUtils = {
    classifyResponse,
    extractCommitment,
    detectDocumentTypesInText,
    classifyDirection,
    computeWaitingState,
};

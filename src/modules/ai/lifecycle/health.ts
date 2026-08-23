import type { LifecycleHealth, LifecycleIssue } from "./types.js";

export function deriveLifecycleHealth(input: {
    blockers: LifecycleIssue[];
    warnings: LifecycleIssue[];
    incompleteSubsystems: string[];
    insufficientCoreData?: boolean;
}): LifecycleHealth {
    if (input.blockers.some((blocker) => blocker.critical)) return "BLOCKED";
    if (input.incompleteSubsystems.length || input.insufficientCoreData) return "INCOMPLETE";
    if (input.blockers.length || input.warnings.length) return "ATTENTION_REQUIRED";
    return "HEALTHY";
}

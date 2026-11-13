/** Broker mailbox markers that must not rematch forever. */
export const BROKER_GMAIL_TERMINAL_METHODS = [
    "SAVED_SEARCH_ALERT",
    "GMAIL_NOT_FOUND",
] as const;

export function isBrokerGmailTerminalMethod(method: string | null | undefined): boolean {
    return BROKER_GMAIL_TERMINAL_METHODS.includes(
        String(method || "") as (typeof BROKER_GMAIL_TERMINAL_METHODS)[number]
    );
}

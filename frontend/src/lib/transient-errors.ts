// Whether a provider error is worth one silent automatic retry — network
// blips, timeouts, rate limits, and 5xx-class server hiccups usually succeed
// on a second attempt, whereas auth/validation errors ("invalid API key",
// "model not found") never will and should surface immediately.
export function isTransientError(message: string): boolean {
    return /timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network error|HTTP 5\d\d|\(5\d\d\)|\b429\b|rate limit|overloaded|temporarily unavailable|try again/i.test(
        message
    );
}

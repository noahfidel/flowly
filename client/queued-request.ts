/**
 * The request a session-wide queued-messages banner may deny (DISPATCHER-SPEC §9.4; ruling, Noah 2026-11-16): only the
 * session's one pending request. With several, or none (a question or blocker report), it denies nothing, and the
 * queue goes out once every request has ended.
 */
export function bannerRequestId(requests: readonly { id: string }[]): string | undefined {
  return requests.length === 1 ? requests[0].id : undefined;
}

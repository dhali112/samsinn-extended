// ============================================================================
// Wiki errors — typed discriminated union surfaced by the filesystem
// adapter + registry. Tools translate these into "wiki unavailable"
// messages for agents instead of letting the turn crash.
//
// Post-prune (commit M): only filesystem-shaped errors remain. The HTTP-
// response mapper that handled GitHub's rate-limit headers went away with
// github-adapter; the kinds 'rate_limited' and 'unauthorized' are kept in
// the union for forward-compat (a future remote-mirror adapter would
// re-introduce them) but no production code path emits them now.
// ============================================================================

export type WikiErrorKind =
  | 'unavailable'        // filesystem read failed (EACCES, ENOTDIR, etc.)
  | 'not_found'          // ENOENT — file or wiki dir doesn't exist
  | 'rate_limited'       // reserved (no current emitter)
  | 'unauthorized'       // reserved (no current emitter)
  | 'parse_error'        // file contents weren't what we expected
  | 'unknown'

export interface WikiError extends Error {
  readonly kind: WikiErrorKind
  readonly status?: number
  readonly retryAfterMs?: number
  readonly wikiId?: string
}

export const createWikiError = (
  kind: WikiErrorKind,
  message: string,
  extra: { status?: number; retryAfterMs?: number; wikiId?: string; cause?: unknown } = {},
): WikiError => {
  const err = new Error(message) as WikiError & { kind: WikiErrorKind }
  ;(err as { kind: WikiErrorKind }).kind = kind
  if (extra.status !== undefined) (err as { status?: number }).status = extra.status
  if (extra.retryAfterMs !== undefined) (err as { retryAfterMs?: number }).retryAfterMs = extra.retryAfterMs
  if (extra.wikiId !== undefined) (err as { wikiId?: string }).wikiId = extra.wikiId
  if (extra.cause !== undefined) (err as { cause?: unknown }).cause = extra.cause
  return err
}

export const isWikiError = (err: unknown): err is WikiError =>
  err instanceof Error && typeof (err as { kind?: unknown }).kind === 'string'

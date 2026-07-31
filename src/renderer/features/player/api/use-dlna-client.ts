export type { DlnaClient, DlnaEventName, Unsubscribe } from './dlna-client';

/**
 * Convenience re-exports for DLNA client hooks.
 *
 * Importing from this single file is preferred over reaching into
 * `dlna-client-provider.tsx` directly — it keeps the public surface
 * narrow and lets callers avoid React import noise.
 */
export { useDlnaClient, useDlnaClientContext } from './dlna-client-provider';
export type { DlnaClientContextValue } from './dlna-client-provider';

import type { ExternalSummary, ItemType } from "../../shared/connectors";
import type { Fetch, StoredConnection } from "./http";

/** An item as one provider fetched it: the summary, and the raw data for Markdown and fingerprints. */
export type Fetched = {
  summary: ExternalSummary;
  /** Present when the full item was read (description, comments …). */
  full?: unknown;
};

export type ItemRef = { itemType: ItemType; key: string };

/** What the picker searches for (CONNECTORS-SPEC §4.3). */
export type SearchScope = {
  /** Repositories of the card's project on this connection's host (GitHub/GitLab). */
  repos: readonly string[];
  /** Search everything I take part in instead of the project's repositories. */
  all: boolean;
};

/**
 * One provider family (CONNECTORS-SPEC §4.2). Adapters only know how to talk
 * to their service; caching, backoff and refused tokens are the service's job.
 */
export interface ConnectorAdapter {
  /** The API's display name in messages. */
  readonly label: string;
  /**
   * Checks the token: the account name and (GitHub/GitLab) the username. A provider with
   * `noAddress` (Linear) also reports the workspace address, which becomes the connection's baseUrl.
   */
  verify(connection: StoredConnection, fetchImpl: Fetch): Promise<{ account: string; login: string; baseUrl?: string }>;
  /** Picker rows for a query (see shared classifyQuery). */
  search(connection: StoredConnection, fetchImpl: Fetch, query: string, scope: SearchScope): Promise<Fetched[]>;
  /** One item; `full` adds what Markdown and fingerprints need. */
  get(connection: StoredConnection, fetchImpl: Fetch, ref: ItemRef, full: boolean): Promise<Fetched>;
  /** Several items' summaries in as few requests as the API allows. Missing items are left out. */
  getMany(connection: StoredConnection, fetchImpl: Fetch, refs: readonly ItemRef[]): Promise<Fetched[]>;
  /** A Confluence /display/<space>/<title> link → page id. */
  lookup?(connection: StoredConnection, fetchImpl: Fetch, space: string, title: string): Promise<string>;
  /** What makes the content change for an agent; not status, assignee or labels (CONNECTORS-SPEC §3.2). */
  fingerprint(full: unknown): string;
  /** The item as Markdown for agents and the preview. */
  markdown(summary: ExternalSummary, full: unknown, limit: number): { markdown: string; truncated: boolean };
  /** Read limit in bytes. */
  readonly readBytes: number;
  /** false when a summary's `updated` does not move with all content (Confluence comments): fingerprints are then refetched. */
  readonly updatedCoversContent?: boolean;
}

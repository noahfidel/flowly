import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { CARD_UNAVAILABLE, type CardDetail, type ProjectCardIndex, type ProjectIdeas } from "../shared/card-detail";
import { createChangedReader, boardKey } from "./queries";

export const detailKey = (hostId: string, taskId: string, workspaceId: string) => ["flowly", "card-detail", hostId, 1, taskId, workspaceId] as const;
export const projectIndexKey = (hostId: string, projectId: string) => ["flowly", "project-card-index", hostId, 1, projectId] as const;
export const projectIdeasKey = (hostId: string, projectId: string) => ["flowly", "project-ideas", hostId, 1, projectId] as const;
export type DetailRead = (input: { taskId: string; workspaceId: string; etag?: string }) => Promise<{ etag: string; value?: CardDetail }>;
const readDetailChanged = createChangedReader(), readIndexChanged = createChangedReader(), readIdeasChanged = createChangedReader();
export function detailQueryOptions(client: QueryClient, hostId: string, taskId: string, workspaceId: string, read: DetailRead, pollOnly = false) {
  const key = detailKey(hostId, taskId, workspaceId);
  return { queryKey: key, queryFn: async () => {
    const value = await readDetailChanged(client, key, etag => read({ taskId, workspaceId, ...(etag ? { etag } : {}) }));
    if (value.task.id !== taskId || value.task.workspaceId !== workspaceId || value.project.id !== value.task.projectId) throw new Error(CARD_UNAVAILABLE);
    return value;
  }, staleTime: 0, retry: false as const, ...(pollOnly ? { notifyOnChangeProps: [] } : {}) };
}
export const detailUnavailable = (error: unknown) => error instanceof Error && error.message.includes(CARD_UNAVAILABLE);
export function useCardDetailQuery(hostId: string, taskId: string, workspaceId: string, enabled: boolean, interval?: number, pollOnly = false) {
  const client = useQueryClient(), read = useRpc(rpc.readCardDetailChanged);
  return useQuery({ ...detailQueryOptions(client, hostId, taskId, workspaceId, read, pollOnly), enabled: enabled && !!taskId && !!workspaceId, refetchInterval: interval, refetchOnMount: interval ? false : true });
}
export function useProjectIndexQuery(hostId: string, projectId: string, enabled: boolean) {
  const client = useQueryClient(), read = useRpc(rpc.readProjectCardIndexChanged), key = projectIndexKey(hostId, projectId);
  return useQuery({ queryKey: key, queryFn: () => readIndexChanged(client, key, etag => read({ projectId, ...(etag ? { etag } : {}) })), enabled: enabled && !!projectId, staleTime: 0, retry: false });
}
type IdeasRead = (input: { projectId: string; etag?: string }) => Promise<{ etag: string; value?: ProjectIdeas }>;
const ideasOptions = (client: QueryClient, read: IdeasRead, hostId: string, projectId: string, enabled: boolean) => {
  const key = projectIdeasKey(hostId, projectId);
  return { queryKey: key, queryFn: () => readIdeasChanged(client, key, etag => read({ projectId, ...(etag ? { etag } : {}) })), enabled: enabled && !!projectId, refetchInterval: enabled ? 3000 : undefined, staleTime: 0, retry: false as const };
};
export function useProjectIdeasQuery(hostId: string, projectId: string, enabled: boolean) {
  const client = useQueryClient(), read = useRpc(rpc.readProjectIdeasChanged);
  return useQuery(ideasOptions(client, read, hostId, projectId, enabled));
}
/**
 * Several projects' ideas, one etag read each, sharing `useProjectIdeasQuery`'s cache: an unfiltered group board's Ideas
 * page (BOARD-GROUPS-SPEC §4). Per project rather than one group read, so a change in one project re-downloads only that
 * project's ideas; an unchanged poll answers with the etag alone.
 */
export function useProjectsIdeasQuery(hostId: string, projectIds: readonly string[], enabled: boolean) {
  const client = useQueryClient(), read = useRpc(rpc.readProjectIdeasChanged);
  return useQueries({ queries: projectIds.map(projectId => ideasOptions(client, read, hostId, projectId, enabled)) });
}
/** Refresh the appropriate active display readers; disabled full observers do not fetch. */
export async function invalidateCardViews(client: QueryClient) {
  await Promise.all([boardKey, ["flowly", "card-detail"], ["flowly", "overview"], ["flowly", "project-card-index"], ["flowly", "project-ideas"]].map(queryKey => client.invalidateQueries({ queryKey })));
}
export type CardDetailState = { hostId: string; detail?: CardDetail; index?: ProjectCardIndex; error: unknown; indexError: unknown; pending: boolean; retry(): void; retryIndex(): void };
export const CardDetailContext = createContext<CardDetailState | null>(null);
export function useTaskDetail() {
  const value = useContext(CardDetailContext);
  if (!value) throw new Error("Card detail provider is missing.");
  return value;
}
/** One card's detail and its project's card index, in every layout; never adapted from the whole board (LOADING-R2-SPEC §2A). */
export function CardDetailProvider({ hostId, task, active, initialRead = true, children }: { hostId: string; task: { id: string; workspaceId: string; projectId: string }; active: boolean; initialRead?: boolean; children: ReactNode }) {
  const query = useCardDetailQuery(hostId, task.id, task.workspaceId, active && initialRead);
  const index = useProjectIndexQuery(hostId, task.projectId, active);
  const retry = useCallback(() => void query.refetch(), [query.refetch]);
  const retryIndex = useCallback(() => void index.refetch(), [index.refetch]);
  const detail = detailUnavailable(query.error) ? undefined : query.data;
  const value = useMemo<CardDetailState>(() => ({ hostId, detail, index: index.data, error: query.error, indexError: index.error, pending: query.isPending, retry, retryIndex }),
    [hostId, detail, index.data, query.error, index.error, query.isPending, retry, retryIndex]);
  return <CardDetailContext.Provider value={value}>{children}</CardDetailContext.Provider>;
}

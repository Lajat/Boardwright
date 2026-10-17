import type { Board, Workspace } from "@boardwright/shared-types";

export const SIDEBAR_SYNC_EVENT = "boardwright:sidebar-sync";

export type SidebarSyncDetail =
  | { type: "workspace-upserted"; workspace: Workspace }
  | { type: "workspace-deleted"; workspaceId: string }
  | { type: "board-upserted"; board: Board }
  | { type: "board-deleted"; board: Board };

export function publishSidebarSync(detail: SidebarSyncDetail) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<SidebarSyncDetail>(SIDEBAR_SYNC_EVENT, { detail }));
  }
}

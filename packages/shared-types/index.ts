/**
 * Shared domain types for fluxboard.
 *
 * Both `apps/web` (Next.js frontend) and `apps/api` (Express backend) import
 * from this package instead of each defining their own copy of these shapes.
 * This is the main reason fluxboard is a monorepo rather than two separate
 * repos: a `Card` on the backend and a `Card` on the frontend are always
 * guaranteed to match, because they're literally the same type definition.
 *
 * If you add a new field to a type here, TypeScript will flag every place
 * in both apps that now needs to handle it — that's the safety net this
 * package buys you.
 */

/** A registered user of fluxboard. */
export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  createdAt: string; // ISO 8601 timestamp
}

/** A team workspace that owns one or more boards. */
export interface Workspace {
  id: string;
  name: string;
  ownerId: string; // User.id of the workspace creator
  memberIds: string[]; // User.id[] of everyone with access
  createdAt: string;
  /** Lightweight profiles included by the workspace list endpoint for its member-avatar summary. */
  memberPreview?: WorkspaceMemberPreview[];
  /**
   * The CALLING user's own resolved permissions in this workspace —
   * populated by workspace list and detail endpoints. This lets a member
   * see their own access level without a separate endpoint and lets the
   * UI gate workspace-level actions consistently.
   */
  myPermissions?: WorkspacePermissions;
  /** True when the caller has access to one or more boards, but not the workspace membership itself. */
  isBoardGuest?: boolean;
}

export interface WorkspaceMemberPreview {
  id: string;
  displayName: string;
  avatarUrl?: string;
}

/** Card-level permissions — add/edit/delete lists, cards, and comments. Shared by workspace members and single-board guests alike, since a guest's access is card-level only. */
export interface CardPermissions {
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

/**
 * A workspace member's full permission set — workspace rename,
 * board-level (create/rename/delete boards), and card-level (see
 * CardPermissions). Workspace and board-level rights exist ONLY for
 * workspace members — a single-board guest (BoardGuest, below) never
 * has them, by design.
 *
 * Dependency rule enforced both in the permission-settings UI and on the
 * server (apps/api's updateMemberPermissions): Delete requires Add AND
 * Edit already granted, on each axis independently — you can't hand
 * someone delete rights without also giving them the lesser rights that
 * delete implies.
 */
export interface WorkspacePermissions extends CardPermissions {
  canEditWorkspace: boolean;
  canAddBoards: boolean;
  canEditBoards: boolean;
  canDeleteBoards: boolean;
  canAddCards: boolean;
  canEditCards: boolean;
  canDeleteCards: boolean;
}

/** @deprecated Use CardPermissions (card-level) or WorkspacePermissions (full). Kept only so any code that hasn't migrated yet still compiles. */
export type MemberPermissions = CardPermissions;

/**
 * A workspace member with enough profile info to render an avatar/name —
 * returned by GET /workspaces/:id/members, which enriches Workspace.memberIds
 * with the member profiles needed by the members UI.
 */
export interface WorkspaceMember {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  role: "owner" | "member";
  permissions: WorkspacePermissions;
}

/**
 * A single-board guest — someone with card-level access to exactly ONE
 * board, who is NOT a member of that board's workspace at all. Modeled
 * after Trello's guest concept: they see this one board and nothing else
 * about the workspace (not its name, not its other boards, not its
 * member list) — see Board.guestPermissions on the API side.
 */
export interface BoardGuest {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  permissions: CardPermissions;
}

/** A single Kanban board that lives inside a workspace. */
export interface Board {
  id: string;
  workspaceId: string;
  title: string;
  /** Ordered list of List.id — defines left-to-right column order on screen. */
  listOrder: string[];
  createdAt: string;
  /**
   * The calling user's own resolved card-level permissions on this
   * board — populated by GET /boards/:id for both workspace members and
   * single-board guests, same "see your own access" purpose as
   * Workspace.myPermissions above. Never includes board-level rights
   * even for a member, since this is specifically about what you can do
   * to the board's CONTENTS — check Workspace.myPermissions for whether
   * you can edit/delete the board itself.
   */
  myPermissions?: CardPermissions;
}

/** A column on a board (e.g. "To Do", "In Progress", "Done"). */
export interface List {
  id: string;
  boardId: string;
  title: string;
  /** Ordered list of Card.id — defines top-to-bottom card order in this column. */
  cardOrder: string[];
}

/** A single task card that lives inside exactly one List at a time. */
export interface Card {
  id: string;
  listId: string;
  title: string;
  description?: string;
  assigneeId?: string; // User.id, if assigned
  dueDate?: string; // ISO 8601 timestamp, if set
  labels?: string[]; // color keywords, e.g. ["green", "red"]
  priority?: Priority;
  taskId?: string; // human-readable board-scoped id, e.g. "BT-7"
  createdAt: string;
  updatedAt: string;
}

export type Priority = "low" | "medium" | "high";

/** Display metadata for each priority level, in severity order (lowest first) — one place both the card badge and the picker UI pull from, so they can never disagree on label text or color. */
export const PRIORITY_META: Record<Priority, { label: string }> = {
  low: { label: "Low" },
  medium: { label: "Medium" },
  high: { label: "High" },
};

/** Color keywords available for card labels, in display order. */
export const LABEL_COLORS = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

/** A comment left on a card, used for the activity/discussion trail. */
export interface Comment {
  id: string;
  cardId: string;
  authorId: string; // User.id
  body: string;
  createdAt: string;
  /** Denormalized at read-time by the API so the frontend doesn't need a
   *  separate lookup per comment — not stored on the Comment document itself. */
  authorName?: string;
  authorAvatarUrl?: string;
}

/**
 * Real-time event names shared between the Socket.io server (apps/api) and
 * client (apps/web). Keeping these as a const object — not just strings
 * scattered in each codebase — means a typo in an event name fails at
 * compile time instead of silently never firing at runtime.
 */
export const SocketEvents = {
  CARD_MOVED: "card:moved",
  CARD_CREATED: "card:created",
  CARD_UPDATED: "card:updated",
  CARD_DELETED: "card:deleted",
  LIST_CREATED: "list:created",
  LIST_UPDATED: "list:updated",
  LIST_DELETED: "list:deleted",
  LIST_REORDERED: "list:reordered",
  BOARD_CREATED: "board:created",
  BOARD_UPDATED: "board:updated",
  BOARD_DELETED: "board:deleted",
  WORKSPACE_UPDATED: "workspace:updated",
  WORKSPACE_DELETED: "workspace:deleted",
  MEMBER_ADDED: "workspace:member-added",
  MEMBER_REMOVED: "workspace:member-removed",
  MEMBER_PERMISSIONS_UPDATED: "workspace:member-permissions-updated",
  // Sent to the removed user's personal room so active clients can leave
  // the workspace immediately instead of waiting for a failed API request.
  ACCESS_REVOKED: "workspace:access-revoked",
  ACCESS_GRANTED: "workspace:access-granted",
  COMMENT_ADDED: "comment:added",
  NOTIFICATION_CREATED: "notification:created",
  NOTIFICATION_UPDATED: "notification:updated",
  BOARD_PRESENCE_UPDATED: "board:presence-updated",
} as const;

/** Active signed-in users currently viewing a board, deduplicated across tabs. */
export interface BoardPresencePayload {
  boardId: string;
  userIds: string[];
}

/** Payload shape for the `card:moved` real-time event. */
export interface CardMovedPayload {
  cardId: string;
  fromListId: string;
  toListId: string;
  newIndex: number; // position within the destination list's cardOrder
  movedBy: string; // User.id of who made the change
}

/** Payload for `workspace:member-added`, including the member's profile. */
export interface WorkspaceMembershipPayload {
  workspaceId: string;
  member: WorkspaceMember;
}

/** Payload for `workspace:member-removed`. */
export interface WorkspaceMemberRemovedPayload {
  workspaceId: string;
  userId: string;
}

/** Payload for `workspace:member-permissions-updated`. */
export interface MemberPermissionsUpdatedPayload {
  workspaceId: string;
  member: WorkspaceMember;
}

/** Payload for `workspace:access-revoked`, sent to the affected user. */
export interface AccessRevokedPayload {
  workspaceId: string;
  workspaceName: string;
  resourceType: "workspace" | "board";
  resourceId: string;
  resourceName: string;
}

/**
 * A persisted notification — stored so it's still there when a user next
 * logs in, not just an ephemeral toast that's missed if they were
 * offline at the time. `link` is where clicking the notification should
 * navigate to; `type` exists mainly for future icon/grouping purposes,
 * not for any logic that currently branches on it.
 */
export type NotificationType =
  | "workspace_invite"
  | "board_invite"
  | "workspace_removed"
  | "board_removed"
  | "invitation_response";

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  isRead: boolean;
  isResolved?: boolean;
  snoozedUntil?: string;
  createdAt: string;
}

export interface InvitePreview {
  token: string;
  scope: "workspace" | "board";
  workspaceName: string;
  boardName?: string;
  resourceLink: string;
  inviterName: string;
  status: "pending" | "snoozed" | "accepted" | "declined" | "closed" | "already_has_access";
  snoozedUntil?: string;
  isDirectInvite: boolean;
  permissions?: CardPermissions;
}

"use client";

import { useEffect, useMemo, useRef, useState, FormEvent } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useActiveWorkspace } from "@/context/ActiveWorkspaceContext";
import { useToast } from "@/components/ui/Toast";
import { apiFetch, ApiError } from "@/lib/apiClient";
import { publishSidebarSync } from "@/lib/sidebarSync";
import { detectWorkspacePreset, detectGuestPreset, workspaceRoleLabel } from "@/lib/permissionPresets";
import { getSocket } from "@/lib/socket";
import { EditableTitle } from "@/components/ui/EditableTitle";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { AvatarStack } from "@/components/ui/AvatarStack";
import { MembersModal } from "@/components/MembersModal";
import {
  ChevronLeftIcon,
  CrownIcon,
  LayoutIcon,
  PlusIcon,
  TrashIcon,
  SpinnerIcon,
  SearchIcon,
  GridIcon,
  ListIcon,
} from "@/components/ui/icons";
import type { Board, Workspace, WorkspaceMember, WorkspacePermissions } from "@boardwright/shared-types";
import {
  SocketEvents,
  type WorkspaceMembershipPayload,
  type MemberPermissionsUpdatedPayload,
  type AccessRevokedPayload,
} from "@boardwright/shared-types";

// A small rotating set of gradients for board tile headers — purely
// cosmetic, but it makes a grid of same-shaped tiles easy to tell apart
// at a glance, the same way physical Trello-style boards use cover colors.
const BOARD_GRADIENTS = [
  "from-brand-500 to-indigo-600",
  "from-teal-500 to-emerald-600",
  "from-orange-400 to-pink-500",
  "from-sky-500 to-blue-600",
  "from-fuchsia-500 to-purple-600",
];

export default function WorkspaceBoardsPage() {
  const { accessToken, isLoading: authLoading, user } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params.workspaceId;
  const { setActiveWorkspaceId } = useActiveWorkspace();

  // Tell the sidebar which workspace this page is "inside" so it
  // auto-expands and highlights the right one — see ActiveWorkspaceContext.
  useEffect(() => {
    setActiveWorkspaceId(workspaceId);
  }, [workspaceId, setActiveWorkspaceId]);

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [boards, setBoards] = useState<Board[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [isLoadingBoards, setIsLoadingBoards] = useState(true);
  const [newBoardTitle, setNewBoardTitle] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isSubmittingBoard, setIsSubmittingBoard] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<"name" | "created">(() => {
    if (typeof window === "undefined") return "name";
    const stored = window.localStorage.getItem(`boardwright:workspace-sort-order:${workspaceId}`);
    return stored === "created" ? "created" : "name";
  });
  const [viewMode, setViewMode] = useState<"grid" | "list">(() => {
    if (typeof window === "undefined") return "grid";
    const stored = window.localStorage.getItem(`boardwright:workspace-view-mode:${workspaceId}`);
    return stored === "list" ? "list" : "grid";
  });
  const createBoardInFlight = useRef(false);

  useEffect(() => {
    if (!workspaceId) return;
    window.localStorage.setItem(`boardwright:workspace-sort-order:${workspaceId}`, sortOrder);
    window.localStorage.setItem(`boardwright:workspace-view-mode:${workspaceId}`, viewMode);
  }, [sortOrder, viewMode, workspaceId]);
  const [deletingBoard, setDeletingBoard] = useState<Board | null>(null);
  const [isMembersModalOpen, setIsMembersModalOpen] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [isLoadingInviteLink, setIsLoadingInviteLink] = useState(false);
  // Computed early (rather than after the loading-state early return below)
  // because it's needed inside a useEffect further down, and hooks can't
  // follow a conditional return.
  const isOwner = workspace?.ownerId === user?.id;
  // Same reasoning as the board page's myPermissions — see the comment
  // there for why this defaults to full access while `members` is still
  // loading rather than flashing every button as disabled.
  const myPermissions: WorkspacePermissions = user
    ? workspace?.myPermissions ?? members.find((m) => m.id === user.id)?.permissions ?? {
        canAdd: true,
        canEdit: true,
        canDelete: true,
        canEditWorkspace: true,
        canAddBoards: true,
        canEditBoards: true,
        canDeleteBoards: true,
        canAddCards: true,
        canEditCards: true,
        canDeleteCards: true,
      }
    : {
        canAdd: false,
        canEdit: false,
        canDelete: false,
        canEditWorkspace: false,
        canAddBoards: false,
        canEditBoards: false,
        canDeleteBoards: false,
        canAddCards: false,
        canEditCards: false,
        canDeleteCards: false,
      };
  const visibleBoards = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return boards
      .filter((board) => board.title.toLocaleLowerCase().includes(query))
      .sort((a, b) =>
        sortOrder === "name"
          ? a.title.localeCompare(b.title)
          : b.createdAt.localeCompare(a.createdAt)
      );
  }, [boards, searchQuery, sortOrder]);

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace("/login");
    }
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!accessToken) return;

    Promise.all([
      apiFetch<Workspace>(`/workspaces/${workspaceId}`, { accessToken }),
      apiFetch<{ items: Board[] }>(`/workspaces/${workspaceId}/boards`, { accessToken }),
    ])
      .then(async ([ws, boardsRes]) => {
        setWorkspace(ws);
        setBoards(boardsRes.items);
        if (ws.isBoardGuest) {
          setMembers([]);
          return;
        }
        const membersRes = await apiFetch<{ items: WorkspaceMember[] }>(
          `/workspaces/${workspaceId}/members`,
          { accessToken }
        );
        setMembers(membersRes.items);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          showToast("You no longer have access to this workspace.", "error");
          router.replace("/workspaces");
          return;
        }
        showToast(err instanceof ApiError ? err.message : "Failed to load workspace", "error");
      })
      .finally(() => setIsLoadingBoards(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, workspaceId]);

  // Real-time sync for everything at the workspace level: boards being
  // created/renamed/deleted by someone else, members joining/leaving, and
  // the workspace itself being renamed or deleted out from under this
  // page. This is the piece that makes "multiple people looking at the
  // same workspace" actually behave like it — without it, every one of
  // these changes would only show up on this page's next manual refresh.
  useEffect(() => {
    if (!accessToken) return;
    const socket = getSocket();
    if (!workspace?.isBoardGuest) socket.emit("join-workspace", workspaceId);
    function rejoinOnReconnect() {
      if (!workspace?.isBoardGuest) socket.emit("join-workspace", workspaceId);
    }
    socket.on("connect", rejoinOnReconnect);

    function handleBoardCreated(board: Board) {
      if (board.workspaceId !== workspaceId) return;
      // Guards against double-adding in the tab that created it — see the
      // identical pattern (and full explanation) in the board page for
      // cards/lists: the socket event and this tab's own HTTP response
      // can arrive in either order.
      setBoards((prev) => (prev.some((b) => b.id === board.id) ? prev : [...prev, board]));
    }

    function handleBoardUpdated(board: Board) {
      if (board.workspaceId !== workspaceId) return;
      setBoards((prev) => prev.map((b) => (b.id === board.id ? board : b)));
    }

    function handleBoardDeleted(board: Board) {
      if (board.workspaceId !== workspaceId) return;
      setBoards((prev) => prev.filter((b) => b.id !== board.id));
    }

    function handleWorkspaceUpdated(updated: Workspace) {
      if (updated.id !== workspaceId) return;
      setWorkspace((current) =>
        current ? { ...updated, myPermissions: current.myPermissions } : updated
      );
    }

    function handleWorkspaceDeleted(deleted: Workspace) {
      if (deleted.id !== workspaceId) return;
      showToast(`"${deleted.name}" was deleted`, "error");
      router.replace("/workspaces");
    }

    function handleAccessRevoked(payload: AccessRevokedPayload) {
      if (payload.workspaceId !== workspaceId) return;
      if (payload.resourceType === "board") {
        void apiFetch<{ items: Board[] }>(`/workspaces/${workspaceId}/boards`, { accessToken })
          .then((result) => {
            setBoards(result.items);
            if (result.items.length === 0) {
              showToast(`You no longer have access to "${payload.resourceName}".`, "error");
              router.replace("/workspaces");
            }
          })
          .catch(() => {
            setBoards((previous) => previous.filter((board) => board.id !== payload.resourceId));
            showToast(`You no longer have access to "${payload.resourceName}".`, "error");
            router.replace("/workspaces");
          });
        return;
      }
      Promise.all([
        apiFetch<Workspace>(`/workspaces/${workspaceId}`, { accessToken }),
        apiFetch<{ items: Board[] }>(`/workspaces/${workspaceId}/boards`, { accessToken }),
      ])
        .then(([updatedWorkspace, accessibleBoards]) => {
          setWorkspace(updatedWorkspace);
          setBoards(accessibleBoards.items);
          if (updatedWorkspace.isBoardGuest) {
            setMembers([]);
            showToast(`Workspace access changed. You still have access to shared boards.`, "error");
          } else {
            router.replace("/workspaces");
          }
        })
        .catch(() => {
          showToast(`You no longer have access to "${payload.resourceName}".`, "error");
          router.replace("/workspaces");
        });
    }

    function handleAccessGranted(payload: { workspaceId: string; resourceType: "board" }) {
      if (payload.workspaceId !== workspaceId || payload.resourceType !== "board") return;
      apiFetch<{ items: Board[] }>(`/workspaces/${workspaceId}/boards`, { accessToken })
        .then((result) => setBoards(result.items))
        .catch((err) => showToast(err instanceof ApiError ? err.message : "Could not refresh shared boards.", "error"));
    }

    function handleMemberAdded({ workspaceId: wsId, member }: WorkspaceMembershipPayload) {
      if (wsId !== workspaceId) return;
      setMembers((prev) => (prev.some((m) => m.id === member.id) ? prev : [...prev, member]));
      if (member.id !== user?.id) showToast(`${member.displayName} joined the workspace`);
    }

    function handleMemberRemoved({ workspaceId: wsId, userId }: { workspaceId: string; userId: string }) {
      if (wsId !== workspaceId) return;
      setMembers((prev) => prev.filter((m) => m.id !== userId));
    }

    function handleMemberPermissionsUpdated({ workspaceId: wsId, member }: MemberPermissionsUpdatedPayload) {
      if (wsId !== workspaceId) return;
      setMembers((prev) => prev.map((m) => (m.id === member.id ? member : m)));
      if (member.id === user?.id) {
        setWorkspace((current) =>
          current ? { ...current, myPermissions: member.permissions } : current
        );
      }
    }

    socket.on(SocketEvents.BOARD_CREATED, handleBoardCreated);
    socket.on(SocketEvents.BOARD_UPDATED, handleBoardUpdated);
    socket.on(SocketEvents.BOARD_DELETED, handleBoardDeleted);
    socket.on(SocketEvents.WORKSPACE_UPDATED, handleWorkspaceUpdated);
    socket.on(SocketEvents.WORKSPACE_DELETED, handleWorkspaceDeleted);
    socket.on(SocketEvents.ACCESS_REVOKED, handleAccessRevoked);
    socket.on(SocketEvents.ACCESS_GRANTED, handleAccessGranted);
    socket.on(SocketEvents.MEMBER_ADDED, handleMemberAdded);
    socket.on(SocketEvents.MEMBER_REMOVED, handleMemberRemoved);
    socket.on(SocketEvents.MEMBER_PERMISSIONS_UPDATED, handleMemberPermissionsUpdated);

    return () => {
      if (!workspace?.isBoardGuest) socket.emit("leave-workspace", workspaceId);
      socket.off("connect", rejoinOnReconnect);
      socket.off(SocketEvents.BOARD_CREATED, handleBoardCreated);
      socket.off(SocketEvents.BOARD_UPDATED, handleBoardUpdated);
      socket.off(SocketEvents.BOARD_DELETED, handleBoardDeleted);
      socket.off(SocketEvents.WORKSPACE_UPDATED, handleWorkspaceUpdated);
      socket.off(SocketEvents.WORKSPACE_DELETED, handleWorkspaceDeleted);
      socket.off(SocketEvents.ACCESS_REVOKED, handleAccessRevoked);
      socket.off(SocketEvents.ACCESS_GRANTED, handleAccessGranted);
      socket.off(SocketEvents.MEMBER_ADDED, handleMemberAdded);
      socket.off(SocketEvents.MEMBER_REMOVED, handleMemberRemoved);
      socket.off(SocketEvents.MEMBER_PERMISSIONS_UPDATED, handleMemberPermissionsUpdated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, user?.id, accessToken, workspace?.isBoardGuest]);

  async function handleCreateBoard(e: FormEvent) {
    e.preventDefault();
    if (createBoardInFlight.current) return;
    if (!newBoardTitle.trim()) {
      setCreateError("Board title is required.");
      return;
    }

    createBoardInFlight.current = true;
    setIsSubmittingBoard(true);
    try {
      const created = await apiFetch<Board>(`/workspaces/${workspaceId}/boards`, {
        method: "POST",
        accessToken,
        body: { title: newBoardTitle },
      });
      setBoards((prev) => (prev.some((b) => b.id === created.id) ? prev : [...prev, created]));
      publishSidebarSync({ type: "board-upserted", board: created });
      setNewBoardTitle("");
      setIsCreating(false);
      setCreateError(null);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to create board", "error");
    } finally {
      createBoardInFlight.current = false;
      setIsSubmittingBoard(false);
    }
  }

  async function handleRenameWorkspace(name: string) {
    if (!workspaceId || !workspace) return;
    try {
      const updated = await apiFetch<Workspace>(`/workspaces/${workspaceId}`, {
        method: "PATCH",
        accessToken,
        body: { name },
      });
      setWorkspace(updated);
      publishSidebarSync({ type: "workspace-upserted", workspace: updated });
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to rename workspace", "error");
    }
  }

  function closeCreateDialog() {
    if (isSubmittingBoard) return;
    setIsCreating(false);
    setNewBoardTitle("");
    setCreateError(null);
  }

  async function handleRenameBoard(boardId: string, title: string) {
    try {
      const updated = await apiFetch<Board>(`/boards/${boardId}`, {
        method: "PATCH",
        accessToken,
        body: { title },
      });
      setBoards((prev) => prev.map((b) => (b.id === boardId ? updated : b)));
      publishSidebarSync({ type: "board-upserted", board: updated });
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to rename board", "error");
    }
  }

  async function handleDeleteBoard() {
    if (!deletingBoard) return;
    try {
      await apiFetch(`/boards/${deletingBoard.id}`, { method: "DELETE", accessToken });
      setBoards((prev) => prev.filter((b) => b.id !== deletingBoard.id));
      publishSidebarSync({ type: "board-deleted", board: deletingBoard });
      showToast("Board deleted");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to delete board", "error");
    } finally {
      setDeletingBoard(null);
    }
  }

  async function handleInviteMember(email: string) {
    await apiFetch<{ invitationSent: boolean }>(
      `/workspaces/${workspaceId}/members`,
      { method: "POST", accessToken, body: { email } }
    );
    showToast("Workspace invitation sent");
  }

  async function handleRemoveMember(member: WorkspaceMember) {
    try {
      await apiFetch(`/workspaces/${workspaceId}/members/${member.id}`, {
        method: "DELETE",
        accessToken,
      });
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
      showToast(`${member.displayName} was removed from the workspace`);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to remove member", "error");
    }
  }

  async function handleUpdateMemberPermissions(member: WorkspaceMember, updates: Partial<WorkspacePermissions>) {
    try {
      const res = await apiFetch<{ member: WorkspaceMember }>(
        `/workspaces/${workspaceId}/members/${member.id}/permissions`,
        { method: "PATCH", accessToken, body: updates }
      );
      setMembers((prev) => prev.map((m) => (m.id === res.member.id ? res.member : m)));
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to update permissions", "error");
    }
  }

  // Lazily fetch the invite link only once the owner actually opens the
  // members modal (not on page load) — it's a secondary action most
  // visits to this page never need, so there's no reason to spend a
  // request on it up front.
  useEffect(() => {
    if (!isMembersModalOpen || !isOwner || inviteToken || !accessToken) return;
    setIsLoadingInviteLink(true);
    apiFetch<{ token: string }>(`/workspaces/${workspaceId}/invite-link`, { accessToken })
      .then((res) => setInviteToken(res.token))
      .catch((err) => showToast(err instanceof ApiError ? err.message : "Failed to load invite link", "error"))
      .finally(() => setIsLoadingInviteLink(false));
  }, [isMembersModalOpen, isOwner, inviteToken, accessToken, workspaceId, showToast]);

  async function handleRegenerateInviteLink() {
    try {
      const res = await apiFetch<{ token: string }>(`/workspaces/${workspaceId}/invite-link/regenerate`, {
        method: "POST",
        accessToken,
      });
      setInviteToken(res.token);
      showToast("Invite link regenerated");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to regenerate invite link", "error");
    }
  }

  if (authLoading || isLoadingBoards) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <SpinnerIcon className="h-6 w-6 text-brand-500" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
        <Link
          href="/workspaces"
          className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600"
        >
          <ChevronLeftIcon className="h-4 w-4" /> All workspaces
        </Link>

        <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <EditableTitle
                as="h1"
                value={workspace?.name ?? "Workspace"}
                onSave={handleRenameWorkspace}
                disabled={!workspace?.myPermissions?.canEditWorkspace}
                className="text-xl font-bold text-slate-900 sm:text-2xl"
                inputClassName="w-full rounded-lg border border-brand-300 bg-white px-2 py-0.5 text-xl font-bold text-slate-900 outline-none ring-2 ring-brand-100 sm:text-2xl"
              />
              {isOwner ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
                  <CrownIcon aria-hidden="true" className="h-3.5 w-3.5" />
                  Owner
                </span>
              ) : (
                !workspace?.isBoardGuest &&
                workspace?.myPermissions && (
                  <span
                    title={`${workspaceRoleLabel(workspace.myPermissions)} — ${detectWorkspacePreset(workspace.myPermissions) ?? "custom"} access`}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600"
                  >
                    {workspaceRoleLabel(workspace.myPermissions)} · {detectWorkspacePreset(workspace.myPermissions) ?? "Custom"}
                  </span>
                )
              )}
            </div>
            <p className="mt-1.5 text-sm text-slate-500">
              {workspace?.isBoardGuest
                ? "You have guest access to selected boards only; workspace details and other boards are private."
                : "Browse and manage the boards in this workspace."}
            </p>
            {workspace?.isBoardGuest &&
              (() => {
                // Was a hardcoded "limited access" string, which could say
                // something different from the real "Board guest ·
                // Contributor" chip shown once you open one of these
                // boards. Shows the real preset here too now — but only
                // when it's the SAME across every board this guest can see;
                // the owner can set a different level per board (see
                // BoardMembersModal's picker), so if they ever do, this
                // falls back to the generic label rather than claiming one
                // level that isn't actually true for every board listed
                // below.
                const presets = boards.map((board) => (board.myPermissions ? detectGuestPreset(board.myPermissions) : null));
                const uniform = presets.length > 0 && presets.every((preset) => preset === presets[0]) ? presets[0] : null;
                return (
                  <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-700">
                    {/* "Guest" alone, not "Board guest" — the only kind of guest this app has IS a board guest, so the extra word was never disambiguating anything. */}
                    Guest <span className="text-violet-400">·</span> {uniform ?? "limited access"}
                  </span>
                );
              })()}
          </div>
          <div className="flex items-center justify-between gap-3 sm:justify-end">
            {myPermissions.canAddBoards && (
              <button
                type="button"
                onClick={() => {
                  setIsCreating(true);
                  setCreateError(null);
                  setSearchQuery("");
                }}
                className="flex items-center gap-2 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                <PlusIcon className="h-4 w-4" />
                New board
              </button>
            )}
            {!workspace?.isBoardGuest && (
              <AvatarStack members={members} onClick={() => setIsMembersModalOpen(true)} />
            )}
          </div>
        </div>

        <div className="mb-4 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white/80 p-3 shadow-sm sm:flex-row sm:items-center">
          <label className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search boards"
              aria-label="Search boards"
              className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
            />
          </label>
          <div className="flex items-center justify-between gap-3 sm:justify-end">
            <label className="flex items-center gap-2 text-xs text-slate-500">
              <span className="whitespace-nowrap">Sort by</span>
              <select
                value={sortOrder}
                onChange={(event) =>
                  setSortOrder(event.target.value === "created" ? "created" : "name")
                }
                aria-label="Sort boards"
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-700 outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              >
                <option value="name">Name (A–Z)</option>
                <option value="created">Recently created</option>
              </select>
            </label>
            <div className="flex rounded-lg border border-slate-200 bg-white p-0.5" aria-label="Board view">
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                aria-label="Grid view"
                title="Grid view"
                aria-pressed={viewMode === "grid"}
                className={`cursor-pointer rounded-md p-1.5 ${
                  viewMode === "grid" ? "bg-brand-50 text-brand-700" : "text-slate-400 hover:text-slate-700"
                }`}
              >
                <GridIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode("list")}
                aria-label="List view"
                title="List view"
                aria-pressed={viewMode === "list"}
                className={`cursor-pointer rounded-md p-1.5 ${
                  viewMode === "list" ? "bg-brand-50 text-brand-700" : "text-slate-400 hover:text-slate-700"
                }`}
              >
                <ListIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        {!isLoadingBoards && visibleBoards.length > 0 && (
          <p className="mb-3 text-xs text-slate-500" aria-live="polite">
            {visibleBoards.length} board{visibleBoards.length === 1 ? "" : "s"}
            {searchQuery.trim() ? " found" : ""}
          </p>
        )}

        <div className={viewMode === "grid" ? "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" : "space-y-2"}>
          {visibleBoards.map((board, i) => (
            <div
              key={board.id}
              className={`group relative ${
                viewMode === "list"
                  ? "flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-brand-200 hover:shadow-md"
                  : ""
              }`}
            >
              <Link
                href={`/boards/${board.id}`}
                aria-label={`Open ${board.title}`}
                className={`absolute inset-0 z-0 ${
                  viewMode === "grid" ? "rounded-xl" : "rounded-xl"
                }`}
              />
              <div
                className={`pointer-events-none ${
                  viewMode === "grid"
                    ? `relative z-10 flex h-28 flex-col justify-between rounded-xl bg-gradient-to-br p-3 text-white shadow-sm transition hover:shadow-lg ${
                        BOARD_GRADIENTS[i % BOARD_GRADIENTS.length]
                      }`
                    : "pointer-events-none relative z-10 flex min-w-0 flex-1 items-center gap-3"
                }`}
              >
                {viewMode === "list" && (
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white ${
                      BOARD_GRADIENTS[i % BOARD_GRADIENTS.length]
                    }`}
                  >
                    <LayoutIcon className="h-5 w-5 opacity-90" />
                  </div>
                )}
                <div className={viewMode === "grid" ? "flex min-h-0 flex-col justify-between" : "min-w-0 flex-1"}>
                  {viewMode === "grid" && <LayoutIcon className="h-5 w-5 opacity-80" />}
                  {/* EditableTitle intercepts its own click (preventDefault +
                      stopPropagation) so renaming doesn't navigate into the board. */}
                  <EditableTitle
                    value={board.title}
                    onSave={(next) => handleRenameBoard(board.id, next)}
                    disabled={!myPermissions.canEditBoards}
                    className={`pointer-events-auto line-clamp-2 text-sm font-semibold ${
                      viewMode === "grid" ? "text-white hover:bg-white/15" : "text-slate-900"
                    }`}
                    inputClassName={`w-full rounded-md px-1.5 py-0.5 text-sm font-semibold outline-none ring-2 ${
                      viewMode === "grid"
                        ? "border border-white/40 bg-white/20 text-white placeholder-white/70 ring-white/30"
                        : "border border-brand-300 bg-white text-slate-900 ring-brand-100"
                    }`}
                  />
                </div>
              </div>
              {viewMode === "list" && (
                <div className="pointer-events-none mr-9 flex shrink-0 items-center gap-6 text-right">
                  <div className="hidden text-left sm:block">
                    <p className="text-sm text-slate-700">
                      {board.listOrder.length} list{board.listOrder.length === 1 ? "" : "s"}
                    </p>
                    <p className="text-[11px] text-slate-400">on this board</p>
                  </div>
                  <div className="hidden min-w-28 sm:block">
                    <p className="text-[11px] text-slate-400">Created</p>
                    <time className="text-sm text-slate-600" dateTime={board.createdAt}>
                      {new Intl.DateTimeFormat(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      }).format(new Date(board.createdAt))}
                    </time>
                  </div>
                </div>
              )}
              {myPermissions.canDeleteBoards && (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDeletingBoard(board);
                  }}
                  aria-label={`Delete ${board.title}`}
                  className={`absolute z-20 rounded-md p-1.5 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 ${
                    viewMode === "grid"
                      ? "right-2 top-2 bg-black/20 text-white backdrop-blur-sm hover:bg-black/40"
                      : "right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:bg-red-50 hover:text-red-500"
                  }`}
                >
                  <TrashIcon className={viewMode === "grid" ? "h-3.5 w-3.5" : "h-4 w-4"} />
                </button>
              )}
            </div>
          ))}

        </div>

        {!isLoadingBoards && visibleBoards.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 px-5 py-12 text-center">
            <p className="text-sm font-medium text-slate-700">
              {boards.length === 0 ? "No boards yet" : "No matching boards"}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {boards.length === 0
                ? myPermissions.canAddBoards
                  ? "Create a board to start organizing work."
                  : "Boards created in this workspace will appear here."
                : "Try another name or clear your search."}
            </p>
            {boards.length > 0 && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="mt-3 text-sm font-medium text-brand-600 hover:text-brand-700"
              >
                Clear search
              </button>
            )}
          </div>
        )}
      </div>

      <Modal
        open={isCreating}
        onClose={closeCreateDialog}
        title="Create a board"
        widthClassName="max-w-md"
      >
        <p className="mb-4 text-sm text-slate-500">
          Give your board a name. You can add lists and tasks once it’s created.
        </p>
        <form onSubmit={handleCreateBoard}>
          <label htmlFor="new-board-title" className="mb-1.5 block text-sm font-medium text-slate-700">
            Board name
          </label>
          <input
            autoFocus
            id="new-board-title"
            type="text"
            placeholder="e.g. Product roadmap"
            value={newBoardTitle}
            onChange={(event) => {
              setNewBoardTitle(event.target.value);
              if (createError) setCreateError(null);
            }}
            aria-invalid={!!createError}
            aria-describedby={createError ? "board-create-error" : undefined}
            className={`w-full rounded-lg border bg-white px-3 py-2.5 text-sm outline-none ring-2 ${
              createError
                ? "border-red-300 ring-red-100"
                : "border-slate-200 ring-transparent focus:border-brand-300 focus:ring-brand-100"
            }`}
          />
          {createError && (
            <p id="board-create-error" className="mt-1.5 text-sm text-red-600">
              {createError}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={closeCreateDialog}
              disabled={isSubmittingBoard}
              className="rounded-lg px-3.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmittingBoard}
              className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:cursor-wait disabled:opacity-60"
            >
              {isSubmittingBoard ? "Creating..." : "Create board"}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!deletingBoard}
        title="Delete this board?"
        description={`"${deletingBoard?.title}" and every list and card on it will be permanently deleted.`}
        onCancel={() => setDeletingBoard(null)}
        onConfirm={handleDeleteBoard}
      />

      {user && workspace && !workspace.isBoardGuest && (
        <MembersModal
          open={isMembersModalOpen}
          onClose={() => setIsMembersModalOpen(false)}
          workspaceName={workspace?.name ?? "Workspace"}
          members={members}
          isOwner={isOwner}
          currentUserId={user.id}
          onInvite={handleInviteMember}
          onRemove={handleRemoveMember}
          onUpdatePermissions={handleUpdateMemberPermissions}
          inviteLink={
            inviteToken && typeof window !== "undefined"
              ? `${window.location.origin}/invite/${inviteToken}`
              : null
          }
          isLoadingInviteLink={isLoadingInviteLink}
          onRegenerateInviteLink={handleRegenerateInviteLink}
        />
      )}
    </main>
  );
}

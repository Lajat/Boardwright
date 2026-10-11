"use client";

import { useCallback, useEffect, useMemo, useRef, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useActiveWorkspace } from "@/context/ActiveWorkspaceContext";
import { useToast } from "@/components/ui/Toast";
import { apiFetch, ApiError } from "@/lib/apiClient";
import { publishSidebarSync } from "@/lib/sidebarSync";
import { getSocket } from "@/lib/socket";
import { EditableTitle } from "@/components/ui/EditableTitle";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { avatarColorFor, initialsFor } from "@/lib/avatar";
import {
  FolderIcon,
  CrownIcon,
  PlusIcon,
  TrashIcon,
  SpinnerIcon,
  SearchIcon,
  GridIcon,
  ListIcon,
} from "@/components/ui/icons";
import { ProfileMenu } from "@/components/ProfileMenu";
import type { Workspace } from "@fluxboard/shared-types";
import {
  SocketEvents,
  type WorkspaceMembershipPayload,
  type AccessRevokedPayload,
  type MemberPermissionsUpdatedPayload,
} from "@fluxboard/shared-types";

export default function WorkspacesPage() {
  const { user, accessToken, isLoading: authLoading } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const { setActiveWorkspaceId } = useActiveWorkspace();

  // This page isn't "inside" any particular workspace — clear the
  // sidebar's highlighted/auto-expanded one so it doesn't keep showing a
  // stale selection from wherever the user was before.
  useEffect(() => {
    setActiveWorkspaceId(null);
  }, [setActiveWorkspaceId]);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(true);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isSubmittingWorkspace, setIsSubmittingWorkspace] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<"name" | "created">(() => {
    if (typeof window === "undefined") return "name";
    const stored = window.localStorage.getItem("fluxboard:workspaces-sort-order");
    return stored === "created" ? "created" : "name";
  });
  const [viewMode, setViewMode] = useState<"grid" | "list">(() => {
    if (typeof window === "undefined") return "grid";
    const stored = window.localStorage.getItem("fluxboard:workspaces-view-mode");
    return stored === "list" ? "list" : "grid";
  });
  const [deletingWorkspace, setDeletingWorkspace] = useState<Workspace | null>(null);

  useEffect(() => {
    window.localStorage.setItem("fluxboard:workspaces-sort-order", sortOrder);
    window.localStorage.setItem("fluxboard:workspaces-view-mode", viewMode);
  }, [sortOrder, viewMode]);
  const deletedWorkspaceIds = useRef(new Set<string>());
  const createWorkspaceInFlight = useRef(false);

  function closeCreateDialog() {
    if (isSubmittingWorkspace) return;
    setIsCreating(false);
    setNewWorkspaceName("");
    setCreateError(null);
  }

  const visibleWorkspaces = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return workspaces
      .filter((workspace) => workspace.name.toLocaleLowerCase().includes(query))
      .sort((a, b) =>
        sortOrder === "name"
          ? a.name.localeCompare(b.name)
          : b.createdAt.localeCompare(a.createdAt)
      );
  }, [workspaces, searchQuery, sortOrder]);

  // A create reaches this tab through both the socket event and the HTTP
  // response. Upserting by id makes either arrival order safe and prevents
  // duplicate workspace cards.
  const upsertWorkspace = useCallback((workspace: Workspace) => {
    deletedWorkspaceIds.current.delete(workspace.id);
    setWorkspaces((prev) => (prev.some((ws) => ws.id === workspace.id) ? prev : [...prev, workspace]));
  }, []);

  // Redirect to login if not authenticated — this page requires a user.
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace("/login");
    }
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!accessToken) return;

    apiFetch<{ items: Workspace[] }>("/workspaces", { accessToken })
      .then((res) => {
        // Keep any membership event that arrived while this request was in
        // flight; the response is only a snapshot from before that event.
        setWorkspaces((prev) => {
          const fetched = res.items.filter((workspace) => !deletedWorkspaceIds.current.has(workspace.id));
          const fetchedIds = new Set(fetched.map((workspace) => workspace.id));
          return [...fetched, ...prev.filter((workspace) => !fetchedIds.has(workspace.id))];
        });
      })
      .catch((err) =>
        showToast(err instanceof ApiError ? err.message : "Failed to load workspaces", "error")
      )
      .finally(() => setIsLoadingWorkspaces(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  useEffect(() => {
    function openCreateWorkspace() {
      setIsCreating(true);
      setCreateError(null);
      setSearchQuery("");
    }

    window.addEventListener("fluxboard:create-workspace", openCreateWorkspace);
    if (new URLSearchParams(window.location.search).get("create") === "1") {
      openCreateWorkspace();
      router.replace("/workspaces", { scroll: false });
    }
    return () => window.removeEventListener("fluxboard:create-workspace", openCreateWorkspace);
  }, [router]);

  // If someone adds this user to a workspace while they're sitting on this
  // exact page, the new workspace appears in the grid immediately — no
  // refresh needed. This relies on the shared socket already being in
  // this user's personal `user:<id>` room, which happens automatically at
  // connection time via the httpOnly auth cookie (see lib/socket.ts) — no
  // explicit join call needed here.
  useEffect(() => {
    if (!user) return;
    const socket = getSocket();

    function handleMemberAdded(payload: WorkspaceMembershipPayload & { workspace?: Workspace }) {
      if (payload.member.id !== user!.id || !payload.workspace) return;
      upsertWorkspace(payload.workspace);
      // Creating a workspace also emits MEMBER_ADDED to its creator (that's
      // how the sidebar learns about it). "You were added to <your own new
      // workspace>" would be a nonsense toast, so only announce workspaces
      // somebody ELSE owns.
      if (payload.workspace.ownerId !== user!.id) {
        showToast(`You were added to "${payload.workspace.name}"`);
      }
    }

    // The counterpart to the above: if someone is removed from a
    // workspace WHILE already sitting on this exact grid, AuthContext's
    // global listener will try to redirect them to /workspaces — but
    // they're already here, so that redirect alone does nothing and the
    // now-inaccessible workspace would otherwise just sit in the grid,
    // stale, until a manual refresh. This removes it from view directly.
    function handleAccessRevoked(payload: AccessRevokedPayload) {
      if (payload.resourceType === "board") {
        apiFetch<{ items: Workspace[] }>("/workspaces", { accessToken })
          .then((result) => {
            const visibleIds = new Set(result.items.map((workspace) => workspace.id));
            if (!visibleIds.has(payload.workspaceId)) deletedWorkspaceIds.current.add(payload.workspaceId);
            setWorkspaces(result.items);
          })
          .catch((err) => showToast(err instanceof ApiError ? err.message : "Could not refresh workspace access.", "error"));
        return;
      }
      deletedWorkspaceIds.current.add(payload.workspaceId);
      setWorkspaces((prev) => prev.filter((ws) => ws.id !== payload.workspaceId));
    }

    function handleAccessGranted(payload: { workspaceId: string; resourceType: "board" }) {
      if (payload.resourceType !== "board") return;
      apiFetch<{ items: Workspace[] }>("/workspaces", { accessToken })
        .then((result) => {
          deletedWorkspaceIds.current.delete(payload.workspaceId);
          setWorkspaces(result.items);
        })
        .catch((err) => showToast(err instanceof ApiError ? err.message : "Could not refresh workspace access.", "error"));
    }

    function handleMemberPermissionsUpdated({ workspaceId, member }: MemberPermissionsUpdatedPayload) {
      if (member.id !== user!.id) return;
      setWorkspaces((prev) =>
        prev.map((workspace) =>
          workspace.id === workspaceId
            ? { ...workspace, myPermissions: member.permissions }
            : workspace
        )
      );
    }

    socket.on(SocketEvents.MEMBER_ADDED, handleMemberAdded);
    socket.on(SocketEvents.ACCESS_REVOKED, handleAccessRevoked);
    socket.on(SocketEvents.ACCESS_GRANTED, handleAccessGranted);
    socket.on(SocketEvents.MEMBER_PERMISSIONS_UPDATED, handleMemberPermissionsUpdated);
    return () => {
      socket.off(SocketEvents.MEMBER_ADDED, handleMemberAdded);
      socket.off(SocketEvents.ACCESS_REVOKED, handleAccessRevoked);
      socket.off(SocketEvents.ACCESS_GRANTED, handleAccessGranted);
      socket.off(SocketEvents.MEMBER_PERMISSIONS_UPDATED, handleMemberPermissionsUpdated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function handleCreateWorkspace(e: FormEvent) {
    e.preventDefault();
    if (createWorkspaceInFlight.current) return;
    if (!newWorkspaceName.trim()) {
      setCreateError("Workspace name is required.");
      return;
    }

    createWorkspaceInFlight.current = true;
    setIsSubmittingWorkspace(true);
    try {
      const created = await apiFetch<Workspace>("/workspaces", {
        method: "POST",
        accessToken,
        body: { name: newWorkspaceName },
      });
      upsertWorkspace(created);
      publishSidebarSync({ type: "workspace-upserted", workspace: created });
      setNewWorkspaceName("");
      setIsCreating(false);
      setCreateError(null);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to create workspace", "error");
    } finally {
      createWorkspaceInFlight.current = false;
      setIsSubmittingWorkspace(false);
    }
  }

  async function handleRenameWorkspace(workspaceId: string, name: string) {
    try {
      const updated = await apiFetch<Workspace>(`/workspaces/${workspaceId}`, {
        method: "PATCH",
        accessToken,
        body: { name },
      });
      setWorkspaces((prev) => prev.map((ws) => (ws.id === workspaceId ? updated : ws)));
      publishSidebarSync({ type: "workspace-upserted", workspace: updated });
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to rename workspace", "error");
    }
  }

  async function handleDeleteWorkspace() {
    if (!deletingWorkspace) return;
    try {
      await apiFetch(`/workspaces/${deletingWorkspace.id}`, { method: "DELETE", accessToken });
      deletedWorkspaceIds.current.add(deletingWorkspace.id);
      setWorkspaces((prev) => prev.filter((ws) => ws.id !== deletingWorkspace.id));
      publishSidebarSync({ type: "workspace-deleted", workspaceId: deletingWorkspace.id });
      showToast("Workspace deleted");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to delete workspace", "error");
    } finally {
      setDeletingWorkspace(null);
    }
  }

  if (authLoading || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <SpinnerIcon className="h-6 w-6 text-brand-500" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-brand-50 via-slate-50 to-slate-50">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
        <div className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm">
                <FolderIcon className="h-5 w-5" />
              </div>
              <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">Your workspaces</h1>
            </div>
            <p className="mt-2 text-sm text-slate-500">
              Find and manage the spaces where your team works.
            </p>
          </div>
          <div className="flex items-center justify-between gap-3 sm:justify-end">
            <button
              type="button"
              onClick={() => {
                setIsCreating(true);
                setCreateError(null);
                setSearchQuery("");
              }}
              className="flex min-h-11 w-auto items-center justify-center gap-2 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
            >
              <PlusIcon className="h-4 w-4" />
              New workspace
            </button>
            <div className="hidden sm:block">
              <ProfileMenu />
            </div>
          </div>
        </div>

        <div className="mb-4 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white/80 p-3 shadow-sm sm:flex-row sm:items-center">
          <label className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search workspaces"
              aria-label="Search workspaces"
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
                aria-label="Sort workspaces"
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-700 outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              >
                <option value="name">Name (A–Z)</option>
                <option value="created">Recently created</option>
              </select>
            </label>
            <div className="flex rounded-lg border border-slate-200 bg-white p-0.5" aria-label="Workspace view">
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

        {!isLoadingWorkspaces && visibleWorkspaces.length > 0 && (
          <p className="mb-3 text-xs text-slate-500" aria-live="polite">
            {visibleWorkspaces.length} workspace{visibleWorkspaces.length === 1 ? "" : "s"}
            {searchQuery.trim() ? " found" : ""}
          </p>
        )}

        {isLoadingWorkspaces ? (
          <div className="flex justify-center py-16">
            <SpinnerIcon className="h-6 w-6 text-brand-400" />
          </div>
        ) : (
          <div
            className={
              viewMode === "grid"
                ? "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
                : "space-y-2"
            }
          >
            {visibleWorkspaces.map((ws, index) => (
              <div
                key={ws.id}
                style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
                className={`group relative animate-[toast-in_0.3s_ease-out_both] rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition duration-200 hover:border-brand-200 hover:shadow-lg ${
                  viewMode === "grid"
                    ? "hover:-translate-y-0.5"
                    : "flex items-center justify-between gap-4"
                }`}
              >
                <Link
                  href={`/workspaces/${ws.id}`}
                  aria-label={`Open ${ws.name}`}
                  className="absolute inset-0 z-0 rounded-xl"
                />
                <div className={`pointer-events-none relative z-10 flex ${viewMode === "list" ? "items-center gap-3" : "flex-col"}`}>
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 ${
                      viewMode === "grid" ? "mb-1" : ""
                    }`}
                  >
                    <FolderIcon className="h-4 w-4" />
                  </div>
                  <div className={`min-w-0 ${viewMode === "list" ? "flex-1 pr-8" : "mt-2"}`}>
                    <div className="flex min-w-0 items-center gap-2">
                      <EditableTitle
                        as="h2"
                        value={ws.name}
                        onSave={(next) => handleRenameWorkspace(ws.id, next)}
                        disabled={!ws.myPermissions?.canEditWorkspace}
                        className="pointer-events-auto font-semibold text-slate-900"
                      />
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <p className="text-xs text-slate-400">
                        {ws.memberIds.length} member{ws.memberIds.length === 1 ? "" : "s"}
                      </p>
                      {ws.ownerId === user.id && (
                        <span
                          title="You own this workspace"
                          aria-label="You own this workspace"
                          className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-amber-700"
                        >
                          <CrownIcon aria-hidden="true" className="h-3.5 w-3.5" />
                          Owner
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                {viewMode === "list" && (
                  <div className="pointer-events-none mr-9 flex shrink-0 items-center gap-6">
                    {ws.memberPreview && ws.memberPreview.length > 0 && (
                      <div
                        className="flex items-center"
                        aria-label={`${ws.memberPreview.length} workspace members`}
                      >
                        {ws.memberPreview.slice(0, 4).map((member, memberIndex) => (
                          <span
                            key={member.id}
                            title={member.displayName}
                            aria-label={member.displayName}
                            role="img"
                            className={`flex h-8 w-8 items-center justify-center rounded-full border-2 border-white text-[10px] font-semibold text-white ${avatarColorFor(
                              member.id
                            )} ${memberIndex > 0 ? "-ml-2" : ""}`}
                          >
                            {initialsFor(member.displayName)}
                          </span>
                        ))}
                        {ws.memberPreview.length > 4 && (
                          <span className="-ml-2 flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-slate-100 text-[10px] font-semibold text-slate-600">
                            +{ws.memberPreview.length - 4}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="hidden min-w-28 text-right sm:block">
                      <p className="text-[11px] text-slate-400">Created</p>
                      <time className="text-sm text-slate-600" dateTime={ws.createdAt}>
                        {new Intl.DateTimeFormat(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        }).format(new Date(ws.createdAt))}
                      </time>
                    </div>
                  </div>
                )}
                <button
                  onClick={() => setDeletingWorkspace(ws)}
                  aria-label={`Delete ${ws.name}`}
                  className={`absolute right-3 z-20 rounded-md p-1.5 text-slate-300 opacity-100 hover:bg-red-50 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100 ${
                    viewMode === "list" ? "top-1/2 -translate-y-1/2" : "top-3"
                  }`}
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {!isLoadingWorkspaces && visibleWorkspaces.length === 0 && !isCreating && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 px-5 py-12 text-center">
            <p className="text-sm font-medium text-slate-700">
              {workspaces.length === 0 ? "No workspaces yet" : "No matching workspaces"}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {workspaces.length === 0
                ? "Create a workspace to get started."
                : "Try another name or clear your search."}
            </p>
            {workspaces.length > 0 && (
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
        title="Create a workspace"
        widthClassName="max-w-md"
      >
        <p className="mb-4 text-sm text-slate-500">
          Give your workspace a name. You can invite members and create boards after it’s set up.
        </p>
        <form onSubmit={handleCreateWorkspace}>
          <label htmlFor="new-workspace-name" className="mb-1.5 block text-sm font-medium text-slate-700">
            Workspace name
          </label>
          <input
            autoFocus
            id="new-workspace-name"
            type="text"
            placeholder="e.g. Marketing"
            value={newWorkspaceName}
            onChange={(event) => {
              setNewWorkspaceName(event.target.value);
              if (createError) setCreateError(null);
            }}
            aria-invalid={!!createError}
            aria-describedby={createError ? "workspace-create-error" : undefined}
            className={`w-full rounded-lg border bg-white px-3 py-2.5 text-sm outline-none ring-2 ${
              createError
                ? "border-red-300 ring-red-100"
                : "border-slate-200 ring-transparent focus:border-brand-300 focus:ring-brand-100"
            }`}
          />
          {createError && (
            <p id="workspace-create-error" className="mt-1.5 text-sm text-red-600">
              {createError}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={closeCreateDialog}
              disabled={isSubmittingWorkspace}
              className="rounded-lg px-3.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmittingWorkspace}
              className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-700 disabled:cursor-wait disabled:opacity-60"
            >
              {isSubmittingWorkspace ? "Creating..." : "Create workspace"}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!deletingWorkspace}
        title="Delete this workspace?"
        description={`"${deletingWorkspace?.name}" and every board, list, and card inside it will be permanently deleted for all members.`}
        onCancel={() => setDeletingWorkspace(null)}
        onConfirm={handleDeleteWorkspace}
      />
    </main>
  );
}

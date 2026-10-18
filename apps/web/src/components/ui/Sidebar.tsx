"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { useActiveWorkspace } from "@/context/ActiveWorkspaceContext";
import { NotificationBell } from "@/components/NotificationBell";
import { ProfileMenu } from "@/components/ProfileMenu";
import { apiFetch } from "@/lib/apiClient";
import { getSocket } from "@/lib/socket";
import { SIDEBAR_SYNC_EVENT, type SidebarSyncDetail } from "@/lib/sidebarSync";
import { APP_NAME } from "@/lib/constants";
import { avatarColorFor, initialsFor } from "@/lib/avatar";
import { Logo } from "./Logo";
import {
  FolderIcon,
  ChevronDownIcon,
  MenuIcon,
  SidebarIcon,
  XIcon,
  LogOutIcon,
  PlusIcon,
  SpinnerIcon,
  SearchIcon,
  InfoIcon,
} from "./icons";
import type { Board, Workspace } from "@boardwright/shared-types";
import {
  SocketEvents,
  type WorkspaceMembershipPayload,
  type AccessRevokedPayload,
} from "@boardwright/shared-types";

const COLLAPSE_STORAGE_KEY = "boardwright_sidebar_collapsed";

/**
 * Persistent navigation for every authenticated page: a searchable
 * workspace switcher keeps the full list out of the sidebar, while the
 * selected workspace's boards remain one click away.
 *
 * Responsive in two different ways depending on screen size:
 *  - Desktop (sm+): a persistent rail, collapsible between a full view
 *    (names visible) and an icon-only rail — state remembered in
 *    localStorage across visits.
 *  - Mobile: hidden by default as an off-canvas drawer, opened via a
 *    floating hamburger button and closed on backdrop click or navigating
 *    anywhere (so it never lingers open over the page you just navigated
 *    to).
 */
export function Sidebar() {
  const { user, accessToken, logout } = useAuth();
  const { activeWorkspaceId } = useActiveWorkspace();
  const pathname = usePathname();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isWorkspaceMenuOpen, setIsWorkspaceMenuOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const [boardsByWorkspace, setBoardsByWorkspace] = useState<Record<string, Board[]>>({});
  const [loadingBoardsFor, setLoadingBoardsFor] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const deletedWorkspaceIds = useRef(new Set<string>());
  // The desktop preference is shared through localStorage, but the mobile
  // drawer always needs its full labels regardless of that preference.
  const isEffectivelyCollapsed = isCollapsed && !isMobileOpen;

  // Restore the desktop collapsed/expanded preference — read once on
  // mount, guarded for SSR since localStorage doesn't exist there.
  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem(COLLAPSE_STORAGE_KEY) : null;
    if (stored) setIsCollapsed(stored === "1");
  }, []);

  useEffect(() => {
    if (!accessToken) return;
    apiFetch<{ items: Workspace[] }>("/workspaces", { accessToken })
      .then((res) => {
        // Preserve a workspace announced by the socket while this request
        // was in flight; the response may be an older snapshot.
        setWorkspaces((prev) => {
          const fetched = res.items.filter((workspace) => !deletedWorkspaceIds.current.has(workspace.id));
          const fetchedIds = new Set(fetched.map((workspace) => workspace.id));
          return [...fetched, ...prev.filter((workspace) => !fetchedIds.has(workspace.id))];
        });
      })
      .catch(() => {
        // Non-critical for the rest of the app to function — the sidebar
        // just stays empty rather than blocking the page with an error.
      });
  }, [accessToken]);

  // Keeps the sidebar's own workspace list in sync with membership
  // changes, live — without this, the sidebar fetches once on mount and
  // then never updates: getting added to a new workspace, or removed
  // from one, wouldn't be reflected here until a full page reload, even
  // though every OTHER part of the app (the /workspaces grid, the global
  // access-revoked redirect) already reacts to these events.
  useEffect(() => {
    if (!user) return;
    const socket = getSocket();

    function handleMemberAdded(payload: WorkspaceMembershipPayload & { workspace?: Workspace }) {
      if (payload.member.id !== user!.id || !payload.workspace) return;
      deletedWorkspaceIds.current.delete(payload.workspace.id);
      setWorkspaces((prev) =>
        prev.some((ws) => ws.id === payload.workspace!.id) ? prev : [...prev, payload.workspace!]
      );
    }

    function handleAccessRevoked(payload: AccessRevokedPayload) {
      if (payload.resourceType === "board") {
        setBoardsByWorkspace((prev) => ({
          ...prev,
          [payload.workspaceId]: (prev[payload.workspaceId] ?? []).filter(
            (board) => board.id !== payload.resourceId
          ),
        }));
        void refreshWorkspaceAccess(payload.workspaceId);
        return;
      }
      deletedWorkspaceIds.current.add(payload.workspaceId);
      setWorkspaces((prev) => prev.filter((ws) => ws.id !== payload.workspaceId));
      setBoardsByWorkspace((prev) => {
        const next = { ...prev };
        delete next[payload.workspaceId];
        return next;
      });
    }

    async function refreshWorkspaceAccess(workspaceId: string) {
      try {
        const [workspaceResult, boardResult] = await Promise.all([
          apiFetch<{ items: Workspace[] }>("/workspaces", { accessToken }),
          apiFetch<{ items: Board[] }>(`/workspaces/${workspaceId}/boards`, { accessToken }),
        ]);
        const visibleWorkspace = workspaceResult.items.find((workspace) => workspace.id === workspaceId);
        if (!visibleWorkspace) {
          deletedWorkspaceIds.current.add(workspaceId);
          setWorkspaces((previous) => previous.filter((workspace) => workspace.id !== workspaceId));
          setBoardsByWorkspace((previous) => {
            const next = { ...previous };
            delete next[workspaceId];
            return next;
          });
          return;
        }
        deletedWorkspaceIds.current.delete(workspaceId);
        setWorkspaces((previous) => previous.some((workspace) => workspace.id === workspaceId)
          ? previous.map((workspace) => workspace.id === workspaceId ? visibleWorkspace : workspace)
          : [...previous, visibleWorkspace]);
        setBoardsByWorkspace((previous) => previous[workspaceId]
          ? { ...previous, [workspaceId]: boardResult.items }
          : previous);
      } catch (error) {
        console.error("[sidebar] Could not refresh board access:", error);
      }
    }

    function handleAccessGranted(payload: { workspaceId: string; resourceType: "board"; resourceId: string }) {
      if (payload.resourceType === "board") void refreshWorkspaceAccess(payload.workspaceId);
    }

    // Neither the sidebar nor the main /workspaces grid ever joins a
    // workspace's own room (only its detail/board pages do), so a plain
    // room-scoped WORKSPACE_DELETED broadcast never reached here at all
    // — the backend now also emits this directly to every member's own
    // personal room specifically so this handler receives it regardless
    // of which page the member is currently on. Same cleanup as
    // handleAccessRevoked above, since losing access and the workspace
    // itself ceasing to exist have the same effect on this component's
    // state either way.
    function handleWorkspaceDeleted(workspace: Workspace) {
      deletedWorkspaceIds.current.add(workspace.id);
      setWorkspaces((prev) => prev.filter((ws) => ws.id !== workspace.id));
      setBoardsByWorkspace((prev) => {
        const next = { ...prev };
        delete next[workspace.id];
        return next;
      });
    }

    function handleWorkspaceUpdated(workspace: Workspace) {
      setWorkspaces((prev) => prev.map((ws) => (ws.id === workspace.id ? workspace : ws)));
    }

    // Without this, a new board only ever shows up in whichever tab
    // created it, and only after that tab's own HTTP response — the
    // sidebar's boardsByWorkspace map is separate local state, so it
    // never learns a board was created unless something tells it to.
    // The workspace board-list page already joins `workspace:<id>` via
    // "join-workspace" when you're viewing it, and since the socket
    // connection is a shared singleton (see lib/socket.ts), the sidebar
    // receives events for any room joined from anywhere in the app —
    // it just never had a handler registered for this one. Only update
    // a workspace's board list if it's already loaded (i.e. previously
    // expanded) — for one that hasn't been fetched yet, the normal
    // lazy-load in loadBoards() will correctly pick it up whenever the
    // user actually expands it.
    function handleBoardCreated(board: Board) {
      setBoardsByWorkspace((prev) => {
        if (!prev[board.workspaceId]) return prev;
        if (prev[board.workspaceId].some((b) => b.id === board.id)) return prev;
        return { ...prev, [board.workspaceId]: [...prev[board.workspaceId], board] };
      });
    }

    function handleBoardDeleted(board: Board) {
      setBoardsByWorkspace((prev) => {
        if (!prev[board.workspaceId]) return prev;
        return {
          ...prev,
          [board.workspaceId]: prev[board.workspaceId].filter((b) => b.id !== board.id),
        };
      });
    }

    function handleBoardUpdated(board: Board) {
      setBoardsByWorkspace((prev) => {
        if (!prev[board.workspaceId]) return prev;
        return {
          ...prev,
          [board.workspaceId]: prev[board.workspaceId].map((current) =>
            current.id === board.id ? board : current
          ),
        };
      });
    }

    function handleSidebarSync(event: Event) {
      const { detail } = event as CustomEvent<SidebarSyncDetail>;
      switch (detail.type) {
        case "workspace-upserted":
          deletedWorkspaceIds.current.delete(detail.workspace.id);
          setWorkspaces((prev) =>
            prev.some((workspace) => workspace.id === detail.workspace.id)
              ? prev.map((workspace) => (workspace.id === detail.workspace.id ? detail.workspace : workspace))
              : [...prev, detail.workspace]
          );
          break;
        case "workspace-deleted":
          deletedWorkspaceIds.current.add(detail.workspaceId);
          setWorkspaces((prev) => prev.filter((workspace) => workspace.id !== detail.workspaceId));
          setBoardsByWorkspace((prev) => {
            const next = { ...prev };
            delete next[detail.workspaceId];
            return next;
          });
          break;
        case "board-upserted":
          setBoardsByWorkspace((prev) => {
            const boards = prev[detail.board.workspaceId];
            if (!boards) return prev;
            return {
              ...prev,
              [detail.board.workspaceId]: boards.some((board) => board.id === detail.board.id)
                ? boards.map((board) => (board.id === detail.board.id ? detail.board : board))
                : [...boards, detail.board],
            };
          });
          break;
        case "board-deleted":
          handleBoardDeleted(detail.board);
          break;
      }
    }

    socket.on(SocketEvents.MEMBER_ADDED, handleMemberAdded);
    socket.on(SocketEvents.ACCESS_REVOKED, handleAccessRevoked);
    socket.on(SocketEvents.ACCESS_GRANTED, handleAccessGranted);
    socket.on(SocketEvents.WORKSPACE_DELETED, handleWorkspaceDeleted);
    socket.on(SocketEvents.WORKSPACE_UPDATED, handleWorkspaceUpdated);
    socket.on(SocketEvents.BOARD_CREATED, handleBoardCreated);
    socket.on(SocketEvents.BOARD_UPDATED, handleBoardUpdated);
    socket.on(SocketEvents.BOARD_DELETED, handleBoardDeleted);
    window.addEventListener(SIDEBAR_SYNC_EVENT, handleSidebarSync);
    return () => {
      socket.off(SocketEvents.MEMBER_ADDED, handleMemberAdded);
      socket.off(SocketEvents.ACCESS_REVOKED, handleAccessRevoked);
      socket.off(SocketEvents.ACCESS_GRANTED, handleAccessGranted);
      socket.off(SocketEvents.WORKSPACE_DELETED, handleWorkspaceDeleted);
      socket.off(SocketEvents.WORKSPACE_UPDATED, handleWorkspaceUpdated);
      socket.off(SocketEvents.BOARD_CREATED, handleBoardCreated);
      socket.off(SocketEvents.BOARD_UPDATED, handleBoardUpdated);
      socket.off(SocketEvents.BOARD_DELETED, handleBoardDeleted);
      window.removeEventListener(SIDEBAR_SYNC_EVENT, handleSidebarSync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Auto-expand whichever workspace the current page says it's "inside"
  // (see ActiveWorkspaceContext) — this is what makes landing directly on
  // a board page still show that board's workspace expanded and
  // highlighted in the sidebar, not just workspace-list pages.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    setExpandedId(activeWorkspaceId);
    if (!boardsByWorkspace[activeWorkspaceId]) {
      loadBoards(activeWorkspaceId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);

  // Close the mobile drawer automatically on every navigation — without
  // this, tapping a board link inside the drawer would navigate AND leave
  // the drawer sitting open over the new page.
  useEffect(() => {
    setIsMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    setIsWorkspaceMenuOpen(false);
    setWorkspaceQuery("");
  }, [pathname]);

  useEffect(() => {
    if (!isWorkspaceMenuOpen) return;

    function closeOnOutsideClick(event: PointerEvent) {
      if (event.target instanceof Node && !workspaceMenuRef.current?.contains(event.target)) {
        setIsWorkspaceMenuOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setIsWorkspaceMenuOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isWorkspaceMenuOpen]);

  async function loadBoards(workspaceId: string) {
    setLoadingBoardsFor(workspaceId);
    try {
      const res = await apiFetch<{ items: Board[] }>(`/workspaces/${workspaceId}/boards`, {
        accessToken,
      });
      setBoardsByWorkspace((prev) => ({ ...prev, [workspaceId]: res.items }));
    } catch {
      // Same reasoning as the workspaces fetch above.
    } finally {
      setLoadingBoardsFor(null);
    }
  }

  function expandWorkspace(workspaceId: string) {
    setExpandedId(workspaceId);
    if (!boardsByWorkspace[workspaceId]) loadBoards(workspaceId);
  }

  function toggleExpand(workspaceId: string) {
    if (expandedId === workspaceId) {
      setExpandedId(null);
      return;
    }
    expandWorkspace(workspaceId);
  }

  function toggleCollapsed() {
    setIsCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
      }
      return next;
    });
  }

  function openWorkspaceCreation(e: MouseEvent<HTMLAnchorElement>) {
    setIsWorkspaceMenuOpen(false);
    if (pathname === "/workspaces") {
      e.preventDefault();
      window.dispatchEvent(new Event("boardwright:create-workspace"));
    }
  }

  if (!user) return null;
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  const filteredWorkspaces = workspaces.filter((workspace) =>
    workspace.name.toLocaleLowerCase().includes(workspaceQuery.trim().toLocaleLowerCase())
  );

  return (
    <>
      {/* Mobile-only top bar — hidden entirely on desktop, where the
          sidebar is always visible (at minimum as an icon rail). This
          replaces what was previously an isolated floating hamburger
          button positioned independently of the page's own branding,
          which is exactly why it could end up sitting on top of it: two
          separately-positioned elements both anchored to the same
          corner. A single persistent bar containing BOTH the menu toggle
          and the logo together — the same structure Gmail/Notion/Linear
          use for their mobile web headers — means there's only one
          element in that region, so nothing can overlap it, on every
          page, since this is rendered once here rather than per-page. */}
      <div className="fixed inset-x-0 top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white px-3 py-2 shadow-sm sm:hidden">
        <button
          onClick={() => setIsMobileOpen(true)}
          aria-label="Open navigation"
          className="rounded-lg p-3 text-slate-600 hover:bg-slate-100"
        >
          <MenuIcon className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2">
          <Logo size={24} />
          <span className="text-sm font-semibold text-slate-800">{APP_NAME}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <NotificationBell />
          <ProfileMenu />
        </div>
      </div>

      {isMobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/40 sm:hidden"
          onClick={() => setIsMobileOpen(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform duration-200 sm:sticky sm:top-0 sm:z-0 sm:h-screen sm:translate-x-0 sm:transition-[width] ${
          isMobileOpen ? "translate-x-0" : "-translate-x-full"
        } ${isCollapsed ? "sm:w-16" : "sm:w-64"}`}
      >
        <div
          className={`flex border-b border-slate-100 py-3 ${
            isEffectivelyCollapsed
              ? "flex-col items-center gap-2 px-0"
              : "items-center justify-between gap-2 px-3"
          }`}
        >
          {isEffectivelyCollapsed ? (
            <>
              <div className="flex w-full items-center justify-between gap-2 border-b border-slate-100 px-1 pb-2">
                <Link href="/workspaces" title={APP_NAME} className="flex items-center">
                  <Logo size={24} />
                </Link>
                <button
                  onClick={toggleCollapsed}
                  aria-label="Expand sidebar"
                  aria-expanded={false}
                  title="Expand sidebar"
                  className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:flex"
                >
                  <SidebarIcon className="h-4 w-4" />
                </button>
              </div>
              <div className="hidden sm:flex">
                <NotificationBell />
              </div>
            </>
          ) : (
            <>
              <Link href="/workspaces" className="flex min-w-0 items-center gap-2">
                <Logo size={32} />
                <span className="truncate text-sm font-semibold text-slate-800">{APP_NAME}</span>
              </Link>
              <div className="ml-auto hidden items-center sm:flex">
                <NotificationBell />
              </div>
              <button
                onClick={toggleCollapsed}
                aria-label="Collapse sidebar"
                aria-expanded={true}
                title="Collapse sidebar"
                className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:flex"
              >
                <SidebarIcon className="h-4 w-4" />
              </button>
            </>
          )}
          <button
            onClick={() => setIsMobileOpen(false)}
            aria-label="Close navigation"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 sm:hidden"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div ref={workspaceMenuRef} className="relative border-b border-slate-100 p-2">
          <button
            type="button"
            onClick={() => {
              if (isEffectivelyCollapsed) {
                toggleCollapsed();
                setIsWorkspaceMenuOpen(true);
                return;
              }
              setIsWorkspaceMenuOpen((open) => !open);
            }}
            aria-expanded={isWorkspaceMenuOpen}
            aria-controls="workspace-switcher-options"
            aria-label={activeWorkspace?.name ?? "Choose workspace"}
            title={activeWorkspace?.name ?? "Choose workspace"}
            className={`flex w-full items-center rounded-lg text-left text-sm text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              isEffectivelyCollapsed ? "justify-center p-1.5" : "gap-2 px-2 py-2"
            }`}
          >
            <div
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold text-white ${
                activeWorkspace ? avatarColorFor(activeWorkspace.id) : "bg-brand-600"
              }`}
            >
              {activeWorkspace ? initialsFor(activeWorkspace.name) : <FolderIcon className="h-4 w-4" />}
            </div>
            {!isEffectivelyCollapsed && (
              <>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {activeWorkspace?.name ?? "Workspaces"}
                </span>
                <ChevronDownIcon
                  className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${
                    isWorkspaceMenuOpen ? "rotate-180" : ""
                  }`}
                />
              </>
            )}
          </button>

          {isWorkspaceMenuOpen && (
            <div className="absolute left-2 right-2 top-full z-50 mt-1 rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
              <label className="relative block">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={workspaceQuery}
                  onChange={(event) => setWorkspaceQuery(event.target.value)}
                  placeholder="Find a workspace"
                  aria-label="Find a workspace"
                  className="w-full rounded-lg border border-slate-200 py-2 pl-8 pr-2 text-xs outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                />
              </label>
              <div
                id="workspace-switcher-options"
                role="listbox"
                aria-label="Workspaces"
                className="scrollbar-thin mt-2 max-h-60 overflow-y-auto"
              >
                {filteredWorkspaces.map((workspace) => (
                  <Link
                    key={workspace.id}
                    href={`/workspaces/${workspace.id}`}
                    role="option"
                    aria-selected={workspace.id === activeWorkspaceId}
                    onClick={() => setIsWorkspaceMenuOpen(false)}
                    className={`flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-slate-50 ${
                      workspace.id === activeWorkspaceId ? "bg-brand-50 text-brand-700" : "text-slate-700"
                    }`}
                  >
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[9px] font-semibold text-white ${avatarColorFor(
                        workspace.id
                      )}`}
                    >
                      {initialsFor(workspace.name)}
                    </span>
                    <span className="truncate">{workspace.name}</span>
                  </Link>
                ))}
                {filteredWorkspaces.length === 0 && (
                  <p className="px-2 py-3 text-center text-xs text-slate-400">No matching workspaces</p>
                )}
              </div>
              <div className="mt-1 border-t border-slate-100 pt-1">
                <Link
                  href="/workspaces?create=1"
                  onClick={openWorkspaceCreation}
                  className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium text-brand-600 hover:bg-brand-50"
                >
                  <PlusIcon className="h-4 w-4" />
                  Create workspace
                </Link>
                <Link
                  href="/workspaces"
                  onClick={() => setIsWorkspaceMenuOpen(false)}
                  className="block rounded-lg px-2 py-2 text-xs text-slate-500 hover:bg-slate-50"
                >
                  View all workspaces
                </Link>
              </div>
            </div>
          )}
        </div>

        <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 py-3">
          {workspaces.filter((workspace) => workspace.id === activeWorkspaceId).map((ws) => {
            const isExpanded = expandedId === ws.id;
            const isActive = activeWorkspaceId === ws.id;
            const boards = boardsByWorkspace[ws.id];

            return (
              <div key={ws.id} className="mb-0.5">
                <div
                  className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm ${
                    isActive ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  <button
                    onClick={() => toggleExpand(ws.id)}
                    aria-label={isExpanded ? "Collapse" : "Expand"}
                    className={`shrink-0 rounded p-0.5 hover:bg-black/5 ${isEffectivelyCollapsed ? "hidden" : ""}`}
                  >
                    <ChevronDownIcon
                      className={`h-3.5 w-3.5 transition-transform ${isExpanded ? "" : "-rotate-90"}`}
                    />
                  </button>
                  {isEffectivelyCollapsed ? (
                    <button
                      type="button"
                      onClick={() => {
                        toggleCollapsed();
                        expandWorkspace(ws.id);
                      }}
                      title={`${ws.name} boards`}
                      aria-label={`${ws.name} boards`}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-brand-600 hover:bg-brand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    >
                      <FolderIcon className="h-4 w-4" />
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1 truncate font-medium">Boards</span>
                  )}
                </div>

                {isExpanded && !isEffectivelyCollapsed && (
                  <div className="ml-6 mt-0.5 space-y-0.5 border-l border-slate-100 pl-2">
                    {loadingBoardsFor === ws.id ? (
                      <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-slate-400">
                        <SpinnerIcon className="h-3 w-3" /> Loading...
                      </div>
                    ) : (
                      <>
                        {(boards ?? []).map((board) => {
                          const isBoardActive = pathname === `/boards/${board.id}`;
                          return (
                            <Link
                              key={board.id}
                              href={`/boards/${board.id}`}
                              title={board.title}
                              className={`block truncate rounded-md px-2 py-1.5 text-xs ${
                                isBoardActive
                                  ? "bg-brand-100 font-medium text-brand-700"
                                  : "text-slate-500 hover:bg-slate-50"
                              }`}
                            >
                              {board.title}
                            </Link>
                          );
                        })}
                        {boards?.length === 0 && (
                          <p className="px-2 py-1 text-xs text-slate-300">No boards yet</p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {!activeWorkspaceId && pathname === "/workspaces" && !isEffectivelyCollapsed && (
            <p className="mt-3 rounded-lg px-2 py-3 text-xs leading-relaxed text-slate-500">
              Choose a workspace above to see its boards, or create one from the workspace menu.
            </p>
          )}

        </nav>

        <div className="space-y-1 border-t border-slate-100 p-2">
          <Link
            href="/about"
            title="About Boardwright"
            aria-current={pathname === "/about" ? "page" : undefined}
            onClick={() => setIsMobileOpen(false)}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm ${
              pathname === "/about"
                ? "bg-brand-50 text-brand-700"
                : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
            }`}
          >
            <InfoIcon className="h-4 w-4 shrink-0" />
            {!isEffectivelyCollapsed && <span className="truncate">About Boardwright</span>}
          </Link>
          <button
            onClick={logout}
            aria-label="Log out"
            title="Log out"
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <LogOutIcon className="h-4 w-4 shrink-0" />
            {!isEffectivelyCollapsed && <span className="truncate">Log out</span>}
          </button>
        </div>
      </aside>
    </>
  );
}

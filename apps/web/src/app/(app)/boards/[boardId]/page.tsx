"use client";

import { useEffect, useState, useRef, useCallback, FormEvent } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useAuth } from "@/context/AuthContext";
import { useActiveWorkspace } from "@/context/ActiveWorkspaceContext";
import { useToast } from "@/components/ui/Toast";
import { apiFetch, ApiError } from "@/lib/apiClient";
import { publishSidebarSync } from "@/lib/sidebarSync";
import { getSocket } from "@/lib/socket";
import { GUEST_PERMISSION_PRESETS, detectGuestPreset } from "@/lib/permissionPresets";
import { BoardColumn } from "@/components/BoardColumn";
import { TaskCardView } from "@/components/TaskCard";
import { CardDetailModal, type CardUpdates } from "@/components/CardDetailModal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EditableTitle } from "@/components/ui/EditableTitle";
import { AvatarStack } from "@/components/ui/AvatarStack";
import { BoardMembersModal } from "@/components/BoardMembersModal";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  TrashIcon,
  PlusIcon,
  SpinnerIcon,
  XIcon,
} from "@/components/ui/icons";
import {
  LABEL_COLORS,
  PRIORITY_META,
  type Board,
  type List,
  type Card,
  type BoardPresencePayload,
  type LabelColor,
  type Priority,
  type Workspace,
  type WorkspaceMember,
  type BoardGuest,
} from "@fluxboard/shared-types";
import {
  SocketEvents,
  type CardMovedPayload,
  type WorkspaceMembershipPayload,
  type MemberPermissionsUpdatedPayload,
  type BoardGuestAddedPayload,
  type BoardGuestRemovedPayload,
  type AccessRevokedPayload,
} from "@fluxboard/shared-types";

/**
 * Local shape for a list plus its resolved cards, in on-screen order.
 * The backend gives us List.cardOrder (an array of ids); we resolve those
 * ids against a flat `cardsById` map so components can render actual card
 * objects without threading the whole map through every prop.
 */
interface ListWithCards extends Omit<List, "cardOrder"> {
  cardOrder: string[];
}

/**
 * Lists and cards, drag-and-drop (via dnd-kit), and the live multi-user
 * sync for both.
 *
 * Drag-and-drop uses optimistic local updates (handleDragEnd) backed by
 * an atomic, self-healing move on the server (moveCard in
 * cardController) — a card is never trusted to be "in exactly one list"
 * purely because the frontend thinks so.
 *
 * pendingMoveCardIds disables re-dragging a card while its previous move
 * is still being persisted, keeping rapid consecutive moves ordered.
 *
 * Every socket handler here is idempotent by design: this tab's own
 * actions can arrive back via both the HTTP response and the socket
 * broadcast for that same event, and both must agree on the outcome
 * without duplicating anything.
 */
export default function BoardPage() {
  const { accessToken, isLoading: authLoading, user } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const params = useParams<{ boardId: string }>();
  const boardId = params.boardId;

  const [board, setBoard] = useState<Board | null>(null);
  const [lists, setLists] = useState<ListWithCards[]>([]);
  const [cardsById, setCardsById] = useState<Record<string, Card>>({});
  const [newListTitle, setNewListTitle] = useState("");
  const [isAddingList, setIsAddingList] = useState(false);
  const [isSubmittingList, setIsSubmittingList] = useState(false);
  const [listTitleError, setListTitleError] = useState<string | null>(null);
  const createListInFlight = useRef(false);
  const [activeCard, setActiveCard] = useState<Card | null>(null);
  // Tracks card ids with a move request currently in flight. Dragging the
  // same card again before its previous PATCH /cards/:id/move response
  // returns is exactly what triggered the duplicate-card database bug
  // fixed in moveCard — this stops that at the source, on the frontend,
  // as a first line of defense (the backend fix makes it safe even if
  // this were somehow bypassed, but preventing the double-request in the
  // first place is simpler than relying on the race-recovery alone).
  const [pendingMoveCardIds, setPendingMoveCardIds] = useState<Set<string>>(new Set());
  const isMovePending = pendingMoveCardIds.size > 0;
  const [isLoadingBoard, setIsLoadingBoard] = useState(true);
  const [openCard, setOpenCard] = useState<Card | null>(null);
  const [confirmingBoardDelete, setConfirmingBoardDelete] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const { setActiveWorkspaceId } = useActiveWorkspace();

  // Tell the sidebar which workspace this board belongs to, once we know
  // it — a board page only has boardId in its URL, so this can't be set
  // until the board itself has loaded. See ActiveWorkspaceContext.
  useEffect(() => {
    if (board?.workspaceId) setActiveWorkspaceId(board.workspaceId);
  }, [board?.workspaceId, setActiveWorkspaceId]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [boardGuests, setBoardGuests] = useState<BoardGuest[]>([]);
  const [activeBoardUserIds, setActiveBoardUserIds] = useState<string[]>([]);
  const [isMembersModalOpen, setIsMembersModalOpen] = useState(false);
  const [cardSearch, setCardSearch] = useState("");
  const [isMobileFilterSummaryOpen, setIsMobileFilterSummaryOpen] = useState(false);
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterPanelRef = useRef<HTMLDivElement>(null);
  const [selectedAssigneeId, setSelectedAssigneeId] = useState<string | null>(null);
  const [selectedPriority, setSelectedPriority] = useState<Priority | "none" | "any">("any");
  const [selectedDueDate, setSelectedDueDate] = useState<"any" | "overdue" | "next7" | "no-date">("any");
  const [selectedLabel, setSelectedLabel] = useState<LabelColor | "any">("any");
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [isLoadingInviteLink, setIsLoadingInviteLink] = useState(false);
  // Computed early (rather than inline in JSX) because it's also needed
  // inside a useEffect further down, and hooks can't follow a conditional
  // return.
  const isOwner = !!(workspace && user && workspace.ownerId === user.id);
  // The current user's own permissions in this board's workspace, derived
  // from the `members` list we already fetch for the avatar stack. While
  // `members` hasn't loaded yet, default to full permissions rather than
  // locking every button — the real enforcement is server-side anyway
  // (see apps/api/src/lib/permissions.ts), so this is purely a UX default
  // to avoid a flash of disabled buttons before the fetch resolves.
  const myPermissions = user
    ? board?.myPermissions ?? members.find((m) => m.id === user.id)?.permissions ?? {
        canAdd: false,
        canEdit: false,
        canDelete: false,
      }
    : { canAdd: false, canEdit: false, canDelete: false };
  // Shown once per board, on mobile only, the first time there's more
  // than fits on screen — the edge fade is a subtle enough cue that a
  // first-time visitor might miss it entirely, so this spells it out
  // once and then gets out of the way for good.
  const [showSwipeHint, setShowSwipeHint] = useState(false);

  // Tracks whether the board's horizontal scroll container currently has
  // more content off-screen to the left/right — drives the edge fade
  // gradients and arrow buttons below, so there's always a visible cue
  // once lists overflow the viewport instead of the row just silently
  // growing off the edge of the screen.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    if (!isFilterPanelOpen) return;

    function closeOnOutsideClick(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !filterPanelRef.current?.contains(event.target) &&
        !filterButtonRef.current?.contains(event.target)
      ) {
        setIsFilterPanelOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsFilterPanelOpen(false);
        filterButtonRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isFilterPanelOpen]);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atStart = el.scrollLeft <= 4;
    setCanScrollLeft(!atStart);
    // The -4 tolerance absorbs sub-pixel rounding so the right-edge fade
    // doesn't flicker on/off when the content width is (basically) exactly
    // the container width.
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    // Any real scroll movement means the user has already discovered they
    // can scroll — dismiss the hint immediately rather than waiting out
    // its timer.
    if (!atStart) setShowSwipeHint(false);
  }, []);

  // The first time this board's lists overflow the screen, show the
  // one-time swipe hint (mobile only — see the JSX below) unless this
  // board has already shown it earlier in the session.
  useEffect(() => {
    if (!canScrollRight || !boardId) return;
    const key = `fluxboard_swipe_hint_${boardId}`;
    if (sessionStorage.getItem(key)) return;

    setShowSwipeHint(true);
    sessionStorage.setItem(key, "1");
    const timeout = setTimeout(() => setShowSwipeHint(false), 4000);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canScrollRight, boardId]);

  // Re-check whenever the list count changes (adding/removing a list can
  // push the row from "fits on screen" to "overflows" or back), and on
  // window resize (rotating a phone, resizing a browser window).
  useEffect(() => {
    updateScrollState();
    window.addEventListener("resize", updateScrollState);
    // A window "resize" isn't the only way the scroller's width changes —
    // collapsing/expanding the sidebar resizes it too, with no window event.
    const el = scrollRef.current;
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateScrollState) : null;
    if (el && observer) observer.observe(el);
    return () => {
      window.removeEventListener("resize", updateScrollState);
      observer?.disconnect();
    };
  }, [updateScrollState, lists.length]);

  useEffect(() => {
    if (!isAddingList) return;
    const frame = window.requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      scroller?.scrollTo({ left: scroller.scrollWidth, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isAddingList]);

  function scrollByColumn(direction: 1 | -1) {
    scrollRef.current?.scrollBy({ left: direction * 320, behavior: "smooth" });
  }

  function openAddList() {
    setIsAddingList(true);
    setListTitleError(null);
  }

  // Sensors, tuned for BOTH mouse and touch:
  //  - MouseSensor: a drag only "activates" after the pointer has moved a
  //    few pixels, so a plain click (e.g. opening the card modal) is never
  //    mistaken for a drag.
  //  - TouchSensor: on a touchscreen a finger landing on a card could be
  //    the start of a scroll OR of a drag, so we require a short
  //    press-and-hold (delay) before a drag begins. Moving before the delay
  //    elapses cancels the activation and the browser scrolls normally;
  //    holding still for the delay and then moving lifts the card (and
  //    dnd-kit blocks scrolling from that point on). This pairs with
  //    `touch-manipulation` on the card — see TaskCardView.
  //  - KeyboardSensor: lets a card be picked up and moved with arrow keys
  //    once focused, for keyboard/accessibility support.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace("/login");
    }
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!accessToken) return;
    loadBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, boardId]);

  // The board response only carries workspaceId, not the workspace's own
  // name/owner or its member list — fetched separately once we know which
  // workspace this board belongs to, purely to power the avatar
  // stack + members modal in the header (mirrors the same pattern as the
  // workspace boards-list page).
  useEffect(() => {
    if (!accessToken || !board?.workspaceId) return;
    apiFetch<Workspace>(`/workspaces/${board.workspaceId}`, { accessToken })
      .then(async (ws) => {
        setWorkspace(ws);
        if (ws.isBoardGuest) {
          setMembers([]);
          setBoardGuests([]);
          return;
        }
        const [membersRes, guestsRes] = await Promise.all([
          apiFetch<{ items: WorkspaceMember[] }>(`/workspaces/${board.workspaceId}/members`, { accessToken }),
          apiFetch<{ items: BoardGuest[] }>(`/boards/${boardId}/guests`, { accessToken }),
        ]);
        setMembers(membersRes.items);
        setBoardGuests(guestsRes.items);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status !== 404) {
          showToast(err.message, "error");
        }
      });
  }, [accessToken, board?.workspaceId, boardId, showToast]);

  // Workspace-level real-time awareness: this board can disappear (this
  // exact board deleted, or its whole workspace deleted) or get renamed by
  // someone else, and the member list can change — all while this page is
  // open and only joined to the BOARD's room, not the workspace's. This
  // separate effect/room is what catches those cases.
  useEffect(() => {
    if (!board?.workspaceId || !accessToken) return;
    const socket = getSocket();
    const workspaceId = board.workspaceId;
    if (!workspace?.isBoardGuest) socket.emit("join-workspace", workspaceId);
    function rejoinWorkspaceOnReconnect() {
      if (!workspace?.isBoardGuest) socket.emit("join-workspace", workspaceId);
    }
    socket.on("connect", rejoinWorkspaceOnReconnect);

    function handleBoardUpdated(updated: Board) {
      if (updated.id !== boardId) return;
      setBoard(updated);
    }

    function handleBoardDeleted(deleted: Board) {
      if (deleted.id !== boardId) return;
      showToast(`"${deleted.title}" was deleted`, "error");
      router.replace(`/workspaces/${workspaceId}`);
    }

    function handleWorkspaceDeleted(deleted: Workspace) {
      if (deleted.id !== workspaceId) return;
      showToast(`"${deleted.name}" was deleted`, "error");
      router.replace("/workspaces");
    }

    async function handleAccessRevoked(payload: AccessRevokedPayload) {
      if (
        payload.resourceType === "board" && payload.resourceId !== boardId ||
        payload.resourceType === "workspace" && payload.workspaceId !== workspaceId
      ) return;
      if (payload.resourceType === "workspace") {
        try {
          const [currentBoard, updatedWorkspace] = await Promise.all([
            apiFetch<Board>(`/boards/${boardId}`, { accessToken }),
            apiFetch<Workspace>(`/workspaces/${workspaceId}`, { accessToken }),
          ]);
          setBoard(currentBoard);
          setWorkspace(updatedWorkspace);
          if (updatedWorkspace.isBoardGuest) {
            setMembers([]);
            showToast(`Workspace access changed. This board is still shared with you.`);
            return;
          }
        } catch {
          // The access check below is authoritative; a revoked board is
          // sent to the safe workspace list rather than left on screen.
        }
      }
      showToast(`You no longer have access to "${payload.resourceName}".`, "error");
      router.replace("/workspaces");
    }

    function handleMemberAdded({ workspaceId: wsId, member }: WorkspaceMembershipPayload) {
      if (wsId !== workspaceId) return;
      setMembers((prev) => (prev.some((m) => m.id === member.id) ? prev : [...prev, member]));
    }

    function handleMemberRemoved({
      workspaceId: wsId,
      userId,
    }: {
      workspaceId: string;
      userId: string;
    }) {
      if (wsId !== workspaceId) return;
      setMembers((prev) => prev.filter((m) => m.id !== userId));
    }

    function handleMemberPermissionsUpdated({ workspaceId: wsId, member }: MemberPermissionsUpdatedPayload) {
      if (wsId !== workspaceId) return;
      setMembers((prev) => prev.map((m) => (m.id === member.id ? member : m)));
    }

    // Keeps BoardMembersModal/AvatarStack in sync in real time when a board
    // guest accepts an invite or is removed — previously nothing updated
    // this list, so the owner only saw a newly-accepted guest after a full
    // page reload. Scoped by boardId (not workspaceId): a board guest is
    // never tied to the workspace the way a member is.
    function handleBoardGuestAdded({ boardId: bId, guest }: BoardGuestAddedPayload) {
      if (bId !== boardId) return;
      setBoardGuests((prev) => (prev.some((g) => g.id === guest.id) ? prev : [...prev, guest]));
    }

    function handleBoardGuestRemoved({ boardId: bId, userId }: BoardGuestRemovedPayload) {
      if (bId !== boardId) return;
      setBoardGuests((prev) => prev.filter((g) => g.id !== userId));
    }

    socket.on(SocketEvents.BOARD_UPDATED, handleBoardUpdated);
    socket.on(SocketEvents.BOARD_DELETED, handleBoardDeleted);
    socket.on(SocketEvents.WORKSPACE_DELETED, handleWorkspaceDeleted);
    socket.on(SocketEvents.ACCESS_REVOKED, handleAccessRevoked);
    socket.on(SocketEvents.MEMBER_ADDED, handleMemberAdded);
    socket.on(SocketEvents.MEMBER_REMOVED, handleMemberRemoved);
    socket.on(SocketEvents.MEMBER_PERMISSIONS_UPDATED, handleMemberPermissionsUpdated);
    socket.on(SocketEvents.BOARD_GUEST_ADDED, handleBoardGuestAdded);
    socket.on(SocketEvents.BOARD_GUEST_REMOVED, handleBoardGuestRemoved);

    return () => {
      if (!workspace?.isBoardGuest) socket.emit("leave-workspace", workspaceId);
      socket.off("connect", rejoinWorkspaceOnReconnect);
      socket.off(SocketEvents.BOARD_UPDATED, handleBoardUpdated);
      socket.off(SocketEvents.BOARD_DELETED, handleBoardDeleted);
      socket.off(SocketEvents.WORKSPACE_DELETED, handleWorkspaceDeleted);
      socket.off(SocketEvents.ACCESS_REVOKED, handleAccessRevoked);
      socket.off(SocketEvents.MEMBER_ADDED, handleMemberAdded);
      socket.off(SocketEvents.MEMBER_REMOVED, handleMemberRemoved);
      socket.off(SocketEvents.MEMBER_PERMISSIONS_UPDATED, handleMemberPermissionsUpdated);
      socket.off(SocketEvents.BOARD_GUEST_ADDED, handleBoardGuestAdded);
      socket.off(SocketEvents.BOARD_GUEST_REMOVED, handleBoardGuestRemoved);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board?.workspaceId, boardId, accessToken, workspace?.isBoardGuest]);

  // Real-time sync: join this board's room and apply events from OTHER
  // clients (and, harmlessly, our own — every handler below is written to
  // be idempotent, so re-applying an event we already reflected locally
  // via optimistic UI just re-does the same no-op change).
  useEffect(() => {
    if (!accessToken) return;
    const socket = getSocket();
    setActiveBoardUserIds([]);

    function handleBoardPresence({ boardId: eventBoardId, userIds }: BoardPresencePayload) {
      if (eventBoardId === boardId) setActiveBoardUserIds(userIds);
    }

    // Room membership lives on the server-side connection and is wiped
    // out on every disconnect — a dropped wifi connection or a laptop
    // waking from sleep silently reconnects the underlying socket but
    // leaves it in no rooms at all unless we explicitly rejoin here.
    function rejoinOnReconnect() {
      socket.emit("join-board", boardId);
    }
    socket.on(SocketEvents.BOARD_PRESENCE_UPDATED, handleBoardPresence);
    socket.on("connect", rejoinOnReconnect);
    if (socket.connected) rejoinOnReconnect();

    function upsertCard(card: Card) {
      setCardsById((prev) => ({ ...prev, [card.id]: card }));
      setLists((prev) =>
        prev.map((list) =>
          list.id === card.listId && !list.cardOrder.includes(card.id)
            ? { ...list, cardOrder: [...list.cardOrder, card.id] }
            : list
        )
      );
    }

    function handleCardUpdated(card: Card) {
      setCardsById((prev) => (prev[card.id] ? { ...prev, [card.id]: card } : prev));
    }

    function handleCardDeleted({ cardId }: { cardId: string; listId: string }) {
      setCardsById((prev) => {
        const next = { ...prev };
        delete next[cardId];
        return next;
      });
      setLists((prev) =>
        prev.map((list) => ({ ...list, cardOrder: list.cardOrder.filter((id) => id !== cardId) }))
      );
    }

    function handleCardMoved({ cardId, toListId, newIndex }: CardMovedPayload) {
      setLists((prev) => {
        const next = prev.map((l) => ({ ...l, cardOrder: l.cardOrder.filter((id) => id !== cardId) }));
        const dest = next.find((l) => l.id === toListId);
        if (dest) dest.cardOrder.splice(newIndex, 0, cardId);
        return next;
      });
      setCardsById((prev) =>
        prev[cardId] ? { ...prev, [cardId]: { ...prev[cardId], listId: toListId } } : prev
      );
    }

    function handleListCreated(list: List) {
      setLists((prev) =>
        prev.some((l) => l.id === list.id) ? prev : [...prev, { ...list, cardOrder: list.cardOrder }]
      );
    }

    function handleListUpdated(list: List) {
      setLists((prev) => prev.map((l) => (l.id === list.id ? { ...l, title: list.title } : l)));
    }

    function handleListDeleted({ listId }: { listId: string; boardId: string }) {
      setLists((prev) => prev.filter((l) => l.id !== listId));
    }

    function handleListReordered({ listOrder }: { boardId: string; listOrder: string[] }) {
      setLists((prev) => {
        const byId = new Map(prev.map((l) => [l.id, l]));
        return listOrder.map((id) => byId.get(id)).filter((l): l is ListWithCards => !!l);
      });
    }

    socket.on(SocketEvents.CARD_CREATED, upsertCard);
    socket.on(SocketEvents.CARD_UPDATED, handleCardUpdated);
    socket.on(SocketEvents.CARD_DELETED, handleCardDeleted);
    socket.on(SocketEvents.CARD_MOVED, handleCardMoved);
    socket.on(SocketEvents.LIST_CREATED, handleListCreated);
    socket.on(SocketEvents.LIST_UPDATED, handleListUpdated);
    socket.on(SocketEvents.LIST_DELETED, handleListDeleted);
    socket.on(SocketEvents.LIST_REORDERED, handleListReordered);

    return () => {
      socket.emit("leave-board", boardId);
      socket.off("connect", rejoinOnReconnect);
      socket.off(SocketEvents.BOARD_PRESENCE_UPDATED, handleBoardPresence);
      socket.off(SocketEvents.CARD_CREATED, upsertCard);
      socket.off(SocketEvents.CARD_UPDATED, handleCardUpdated);
      socket.off(SocketEvents.CARD_DELETED, handleCardDeleted);
      socket.off(SocketEvents.CARD_MOVED, handleCardMoved);
      socket.off(SocketEvents.LIST_CREATED, handleListCreated);
      socket.off(SocketEvents.LIST_UPDATED, handleListUpdated);
      socket.off(SocketEvents.LIST_DELETED, handleListDeleted);
      socket.off(SocketEvents.LIST_REORDERED, handleListReordered);
    };
  }, [boardId, accessToken]);

  /** Fetches the board, its lists, and every list's cards, then flattens cards into one lookup map. */
  async function loadBoard() {
    try {
      const [boardRes, listsRes] = await Promise.all([
        apiFetch<Board>(`/boards/${boardId}`, { accessToken }),
        apiFetch<{ items: List[] }>(`/boards/${boardId}/lists`, { accessToken }),
      ]);
      setBoard(boardRes);

      const nextCardsById: Record<string, Card> = {};
      const listsWithCards: ListWithCards[] = [];

      for (const list of listsRes.items) {
        const cardsRes = await apiFetch<{ items: Card[] }>(`/lists/${list.id}/cards`, {
          accessToken,
        });
        cardsRes.items.forEach((card) => {
          nextCardsById[card.id] = card;
        });
        listsWithCards.push({ ...list, cardOrder: cardsRes.items.map((c) => c.id) });
      }

      setCardsById(nextCardsById);
      setLists(listsWithCards);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        showToast("This board is no longer available to you.", "error");
        router.replace("/workspaces");
        return;
      }
      showToast(err instanceof ApiError ? err.message : "Failed to load board", "error");
    } finally {
      setIsLoadingBoard(false);
    }
  }

  async function handleRenameBoard(nextTitle: string) {
    try {
      const updated = await apiFetch<Board>(`/boards/${boardId}`, {
        method: "PATCH",
        accessToken,
        body: { title: nextTitle },
      });
      setBoard(updated);
      publishSidebarSync({ type: "board-upserted", board: updated });
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to rename board", "error");
    }
  }

  async function handleDeleteBoard() {
    try {
      await apiFetch(`/boards/${boardId}`, { method: "DELETE", accessToken });
      if (board) publishSidebarSync({ type: "board-deleted", board });
      showToast("Board deleted");
      router.push(board ? `/workspaces/${board.workspaceId}` : "/workspaces");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to delete board", "error");
    }
  }

  async function handleInviteGuest(email: string) {
    await apiFetch<{ invitationSent: boolean }>(
      `/boards/${boardId}/guests`,
      { method: "POST", accessToken, body: { email } }
    );
    showToast("Board invitation sent");
  }

  async function handleRemoveGuest(guest: BoardGuest) {
    try {
      await apiFetch(`/boards/${boardId}/guests/${guest.id}`, {
        method: "DELETE",
        accessToken,
      });
      setBoardGuests((prev) => prev.filter((entry) => entry.id !== guest.id));
      showToast(`${guest.displayName} was removed from the board`);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to remove board guest", "error");
    }
  }

  async function handleUpdateGuestPermissions(guest: BoardGuest, preset: "Viewer" | "Contributor") {
    const permissions = GUEST_PERMISSION_PRESETS[preset];
    // Applied optimistically, same as every other permission toggle in the
    // app (MembersModal's preset buttons do the same) — the picker should
    // feel immediate, and the PATCH response below reconciles it with
    // whatever the server actually persisted if anything differs.
    setBoardGuests((prev) => prev.map((entry) => (entry.id === guest.id ? { ...entry, permissions } : entry)));
    try {
      const updated = await apiFetch<BoardGuest>(`/boards/${boardId}/guests/${guest.id}`, {
        method: "PATCH",
        accessToken,
        body: permissions,
      });
      setBoardGuests((prev) => prev.map((entry) => (entry.id === guest.id ? updated : entry)));
    } catch (err) {
      // Roll back to what the guest actually had before the optimistic update.
      setBoardGuests((prev) => prev.map((entry) => (entry.id === guest.id ? guest : entry)));
      showToast(err instanceof ApiError ? err.message : "Failed to update that guest's permissions", "error");
    }
  }

  // Lazily fetch the invite link only once the owner actually opens the
  // members modal — see the identical pattern (and full reasoning) on the
  // workspace boards-list page.
  useEffect(() => {
    if (!isMembersModalOpen || !isOwner || inviteToken || !accessToken) return;
    setIsLoadingInviteLink(true);
    apiFetch<{ token: string }>(`/boards/${boardId}/invite-link`, { accessToken })
      .then((res) => setInviteToken(res.token))
      .catch((err) => showToast(err instanceof ApiError ? err.message : "Failed to load invite link", "error"))
      .finally(() => setIsLoadingInviteLink(false));
  }, [isMembersModalOpen, isOwner, inviteToken, accessToken, boardId, showToast]);

  async function handleRegenerateInviteLink() {
    try {
      const res = await apiFetch<{ token: string }>(
        `/boards/${boardId}/invite-link/regenerate`,
        { method: "POST", accessToken }
      );
      setInviteToken(res.token);
      showToast("Board invite link rotated");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to regenerate invite link", "error");
    }
  }

  async function handleCreateList(e: FormEvent) {
    e.preventDefault();
    if (createListInFlight.current) return;
    if (!newListTitle.trim()) {
      setListTitleError("List name is required.");
      return;
    }

    createListInFlight.current = true;
    setIsSubmittingList(true);
    try {
      const created = await apiFetch<List>(`/boards/${boardId}/lists`, {
        method: "POST",
        accessToken,
        body: { title: newListTitle },
      });
      // Same guard as handleAddCard above — LIST_CREATED can arrive over
      // the socket before this HTTP response resolves.
      setLists((prev) => (prev.some((l) => l.id === created.id) ? prev : [...prev, { ...created, cardOrder: [] }]));
      setNewListTitle("");
      setIsAddingList(false);
      setListTitleError(null);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to create list", "error");
    } finally {
      createListInFlight.current = false;
      setIsSubmittingList(false);
    }
  }

  async function handleRenameList(listId: string, title: string) {
    try {
      await apiFetch<List>(`/boards/${boardId}/lists/${listId}`, {
        method: "PATCH",
        accessToken,
        body: { title },
      });
      setLists((prev) => prev.map((l) => (l.id === listId ? { ...l, title } : l)));
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to rename list", "error");
    }
  }

  async function handleDeleteList(listId: string) {
    try {
      await apiFetch(`/boards/${boardId}/lists/${listId}`, { method: "DELETE", accessToken });
      setLists((prev) => prev.filter((l) => l.id !== listId));
      showToast("List deleted");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to delete list", "error");
    }
  }

  async function handleAddCard(listId: string, title: string) {
    try {
      const created = await apiFetch<Card>(`/lists/${listId}/cards`, {
        method: "POST",
        accessToken,
        body: { title },
      });
      setCardsById((prev) => ({ ...prev, [created.id]: created }));
      // Guarded the same way the socket CARD_CREATED handler is — the
      // real-time event for this exact card can arrive over the socket
      // BEFORE this HTTP response resolves (they race independently), so
      // without this check the card gets appended twice in the tab that
      // created it: once from the socket event, once from here.
      setLists((prev) =>
        prev.map((list) =>
          list.id === listId && !list.cardOrder.includes(created.id)
            ? { ...list, cardOrder: [...list.cardOrder, created.id] }
            : list
        )
      );
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to add card", "error");
    }
  }

  async function handleSaveCard(cardId: string, updates: CardUpdates) {
    try {
      const updated = await apiFetch<Card>(`/cards/${cardId}`, {
        method: "PATCH",
        accessToken,
        body: updates,
      });
      setCardsById((prev) => ({ ...prev, [cardId]: updated }));
      showToast("Card updated");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to update card", "error");
    }
  }

  async function handleDeleteCard(cardId: string) {
    try {
      await apiFetch(`/cards/${cardId}`, { method: "DELETE", accessToken });
      setCardsById((prev) => {
        const next = { ...prev };
        delete next[cardId];
        return next;
      });
      setLists((prev) =>
        prev.map((list) => ({ ...list, cardOrder: list.cardOrder.filter((id) => id !== cardId) }))
      );
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to delete card", "error");
    }
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveCard(cardsById[event.active.id as string] ?? null);
  }

  // Escape key, or the OS cancelling the touch (incoming call, gesture
  // conflict). Without this the drag ends without onDragEnd ever firing.
  function handleDragCancel() {
    setActiveCard(null);
  }

  /**
   * Core drag-and-drop logic. `over.id` is either another card's id
   * (dropped near/on a card) or a "column-<listId>" id (dropped into an
   * empty column, or below the last card). We resolve both cases down to
   * "destination list id + destination index", update local state
   * optimistically, then persist via the moveCard endpoint.
   */
  async function handleDragEnd(event: DragEndEvent) {
    setActiveCard(null);
    const { active, over } = event;
    if (!over) return;

    const activeCardId = active.id as string;
    const overId = over.id as string;

    const sourceList = lists.find((l) => l.cardOrder.includes(activeCardId));
    if (!sourceList) return;

    let destListId: string;
    let destIndex: number;

    if (overId.startsWith("column-")) {
      // Dropped directly on a column (usually an empty one, or the gap
      // below the last card) — place at the end of that list.
      destListId = overId.replace("column-", "");
      const destList = lists.find((l) => l.id === destListId);
      destIndex = destList ? destList.cardOrder.length : 0;
    } else {
      // Dropped on/near another card — that card's list is the destination.
      const destList = lists.find((l) => l.cardOrder.includes(overId));
      if (!destList) return;
      destListId = destList.id;
      destIndex = destList.cardOrder.indexOf(overId);
      const activeRect = active.rect.current.translated;
      const overMidpoint = over.rect.top + over.rect.height / 2;
      if (activeRect && activeRect.top + activeRect.height / 2 > overMidpoint) {
        destIndex += 1;
      }
    }

    const sourceIndex = sourceList.cardOrder.indexOf(activeCardId);
    if (sourceList.id === destListId) {
      const finalIndex = sourceIndex < destIndex ? destIndex - 1 : destIndex;
      if (sourceIndex === finalIndex) return; // dropped back where it started
      destIndex = finalIndex;
    }

    // Optimistic local update — the UI reflects the move immediately,
    // before the backend confirms it. If the API call below fails, we
    // reload from the server to correct any drift rather than leaving the
    // UI in a state the backend never agreed to.
    setLists((prev) => {
      const next = prev.map((l) => ({ ...l, cardOrder: [...l.cardOrder] }));
      const from = next.find((l) => l.id === sourceList.id)!;
      from.cardOrder = from.cardOrder.filter((id) => id !== activeCardId);
      const to = next.find((l) => l.id === destListId)!;
      to.cardOrder.splice(destIndex, 0, activeCardId);
      return next;
    });

    setPendingMoveCardIds((prev) => new Set(prev).add(activeCardId));
    try {
      await apiFetch(`/cards/${activeCardId}/move`, {
        method: "PATCH",
        accessToken,
        body: { toListId: destListId, newIndex: destIndex },
      });
    } catch (err) {
      showToast(
        err instanceof ApiError ? err.message : "Failed to move card — reloading board",
        "error"
      );
      loadBoard(); // resync with the server's actual state
    } finally {
      setPendingMoveCardIds((prev) => {
        const next = new Set(prev);
        next.delete(activeCardId);
        return next;
      });
    }
  }

  const hasActiveFilters =
    cardSearch.trim().length > 0 ||
    selectedAssigneeId !== null ||
    selectedPriority !== "any" ||
    selectedDueDate !== "any" ||
    selectedLabel !== "any";
  const activeFilterCount = [
    selectedAssigneeId !== null,
    selectedPriority !== "any",
    selectedDueDate !== "any",
    selectedLabel !== "any",
  ].filter(Boolean).length;
  const selectedAssigneeName =
    selectedAssigneeId === "unassigned"
      ? "Unassigned"
      : members.find((member) => member.id === selectedAssigneeId)?.displayName ?? "Assignee";
  const selectedLabelName =
    selectedLabel === "any" ? "" : `${selectedLabel[0].toUpperCase()}${selectedLabel.slice(1)}`;
  const selectedDueDateName = {
    any: "",
    overdue: "Overdue",
    next7: "Due in 7 days",
    "no-date": "No due date",
  }[selectedDueDate];
  const activeFilterChips = [
    ...(selectedAssigneeId
      ? [{ label: `Assignee: ${selectedAssigneeName}`, onClear: () => setSelectedAssigneeId(null) }]
      : []),
    ...(selectedPriority !== "any"
      ? [{
          label: `Priority: ${selectedPriority === "none" ? "None" : PRIORITY_META[selectedPriority].label}`,
          onClear: () => setSelectedPriority("any"),
        }]
      : []),
    ...(selectedDueDate !== "any"
      ? [{ label: `Due: ${selectedDueDateName}`, onClear: () => setSelectedDueDate("any") }]
      : []),
    ...(selectedLabel !== "any"
      ? [{ label: `Label: ${selectedLabelName}`, onClear: () => setSelectedLabel("any") }]
      : []),
  ];
  const activeCriteriaChips = [
    ...(cardSearch.trim()
      ? [{ label: `Search: “${cardSearch.trim()}”`, onClear: () => setCardSearch("") }]
      : []),
    ...activeFilterChips,
  ];
  const shouldCollapseMobileChips = activeCriteriaChips.length >= 3;
  function matchesCardFilters(card: Card) {
    const query = cardSearch.trim().toLowerCase();
    if (
      query &&
      ![card.title, card.description ?? "", card.taskId ?? ""]
        .some((value) => value.toLowerCase().includes(query))
    ) {
      return false;
    }
    if (selectedAssigneeId === "unassigned" && card.assigneeId) return false;
    if (
      selectedAssigneeId &&
      selectedAssigneeId !== "unassigned" &&
      card.assigneeId !== selectedAssigneeId
    ) {
      return false;
    }
    if (selectedPriority === "none" && card.priority) return false;
    if (selectedPriority !== "any" && selectedPriority !== "none" && card.priority !== selectedPriority) {
      return false;
    }
    if (selectedLabel !== "any" && !card.labels?.includes(selectedLabel)) return false;
    if (selectedDueDate !== "any") {
      if (selectedDueDate === "no-date") {
        if (card.dueDate) return false;
      } else {
        if (!card.dueDate) return false;
        const dueDay = new Date(card.dueDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        dueDay.setHours(0, 0, 0, 0);
        if (selectedDueDate === "overdue" && dueDay >= today) return false;
        if (selectedDueDate === "next7") {
          const lastIncludedDay = new Date(today);
          lastIncludedDay.setDate(lastIncludedDay.getDate() + 7);
          if (dueDay < today || dueDay > lastIncludedDay) return false;
        }
      }
    }
    return true;
  }

  function clearCardFilters() {
    setCardSearch("");
    setSelectedAssigneeId(null);
    setSelectedPriority("any");
    setSelectedDueDate("any");
    setSelectedLabel("any");
  }

  if (authLoading || isLoadingBoard) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <SpinnerIcon className="h-6 w-6 text-brand-500" />
      </main>
    );
  }

  return (
    // .board-viewport gives this page a definite, viewport-sized height (see
    // globals.css) so the lists area below can fill it exactly and nothing
    // scrolls except the lists themselves.
    <main className="board-viewport flex flex-col overflow-hidden bg-slate-50">
      {/* A solid, non-sticky bar: the page itself no longer scrolls, so there's
          nothing to stick to — and no translucent/blurred header for cards to
          slide underneath. */}
      <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto] items-center gap-x-2 gap-y-2 [grid-template-areas:'breadcrumb_actions'_'title_title'] sm:grid-cols-[minmax(0,1fr)_auto] sm:grid-rows-[auto_auto] sm:gap-y-1 sm:[grid-template-areas:'breadcrumb_breadcrumb'_'title_actions']">
          <Link
            href={board ? `/workspaces/${board.workspaceId}` : "/workspaces"}
            className="[grid-area:breadcrumb] inline-flex min-w-0 items-center gap-1 text-sm text-slate-500 hover:text-brand-600"
          >
            <ChevronLeftIcon className="h-4 w-4 shrink-0" /> Back to boards
          </Link>
          <div className="flex min-w-0 items-center gap-2 [grid-area:title]">
            <EditableTitle
              as="h1"
              value={board?.title ?? ""}
              onSave={handleRenameBoard}
              disabled={!myPermissions.canEdit}
              className="min-w-0 flex-1 !overflow-hidden !whitespace-nowrap !text-ellipsis text-xl font-bold text-slate-900 sm:text-2xl"
              inputClassName="w-full max-w-md rounded-md border border-brand-300 bg-white px-2 py-1 text-xl font-bold text-slate-900 outline-none ring-2 ring-brand-100 sm:text-2xl"
            />
            {lists.length > 0 && (
              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                {lists.length} list{lists.length === 1 ? "" : "s"}
              </span>
            )}
            {/* A guest can't open BoardMembersModal (see the gate below) —
                deliberately: its own copy promises guests never see the
                workspace's member list. But knowing your own access level
                isn't a privacy leak the way seeing everyone else's would
                be, so it gets this one small read-only chip instead of the
                full modal. */}
            {workspace?.isBoardGuest && (
              <span
                className="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700"
                title={`Board guest — ${detectGuestPreset(myPermissions) ?? "custom"} access`}
              >
                Board guest · {detectGuestPreset(myPermissions) ?? "Custom"}
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center justify-end gap-2 [grid-area:actions] sm:gap-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              {myPermissions.canAdd && (
                <button
                  type="button"
                  onClick={openAddList}
                  aria-label="Add list"
                  title="Add list"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 hover:bg-brand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 sm:h-auto sm:w-auto sm:gap-1.5 sm:px-2.5 sm:py-1.5 sm:text-sm sm:font-medium"
                >
                  <PlusIcon className="h-4 w-4" />
                  <span className="hidden sm:inline">Add list</span>
                </button>
              )}
              {(members.length > 0 || boardGuests.length > 0) && (
                <AvatarStack
                  members={members}
                  guests={boardGuests}
                  activeMemberIds={activeBoardUserIds}
                  onClick={() => setIsMembersModalOpen(true)}
                  size="sm"
                />
              )}
            </div>
            {myPermissions.canDelete && (
              <button
                type="button"
                onClick={() => setConfirmingBoardDelete(true)}
                aria-label="Delete board"
                title="Delete board"
                className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 sm:text-slate-500"
              >
                <TrashIcon className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <label className="min-w-0 flex-1 sm:max-w-xs">
            <span className="sr-only">Search cards</span>
            <input
              type="search"
              value={cardSearch}
              onChange={(event) => setCardSearch(event.target.value)}
              placeholder="Search cards"
              className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            />
          </label>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div className="relative">
              <button
                ref={filterButtonRef}
                type="button"
                onClick={() => setIsFilterPanelOpen((open) => !open)}
                aria-expanded={isFilterPanelOpen}
                aria-controls="board-filter-panel"
                className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                  activeFilterCount > 0
                    ? "border-brand-200 bg-brand-50 text-brand-700"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                Filters
                {activeFilterCount > 0 && (
                  <span className="rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] leading-none text-white">
                    {activeFilterCount}
                  </span>
                )}
              </button>
              {isFilterPanelOpen && (
                <>
                  <div
                    className="fixed inset-0 z-20 bg-slate-900/20 sm:hidden"
                    aria-hidden="true"
                    onClick={() => setIsFilterPanelOpen(false)}
                  />
                  <div
                    ref={filterPanelRef}
                    id="board-filter-panel"
                    role="dialog"
                    aria-label="Filter cards"
                    className="fixed left-3 right-3 top-1/2 z-30 grid max-h-[min(80dvh,36rem)] -translate-y-1/2 gap-3 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-2xl sm:absolute sm:left-0 sm:right-auto sm:top-full sm:mt-2 sm:max-h-[min(70vh,32rem)] sm:w-[26rem] sm:translate-y-0 sm:grid-cols-2 sm:shadow-xl"
                  >
                <label className="grid gap-1 text-xs font-medium text-slate-500">
                  Assignee
                  <select
                    value={selectedAssigneeId ?? "any"}
                    onChange={(event) =>
                      setSelectedAssigneeId(event.target.value === "any" ? null : event.target.value)
                    }
                    className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm font-normal text-slate-700 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  >
                    <option value="any">Anyone</option>
                    <option value="unassigned">Unassigned</option>
                    {members.map((member) => (
                      <option key={member.id} value={member.id}>{member.displayName}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs font-medium text-slate-500">
                  Priority
                  <select
                    value={selectedPriority}
                    onChange={(event) => setSelectedPriority(event.target.value as Priority | "none" | "any")}
                    className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm font-normal text-slate-700 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  >
                    <option value="any">Any priority</option>
                    <option value="none">No priority</option>
                    {(["high", "medium", "low"] as const).map((priority) => (
                      <option key={priority} value={priority}>{PRIORITY_META[priority].label}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs font-medium text-slate-500">
                  Due date
                  <select
                    value={selectedDueDate}
                    onChange={(event) =>
                      setSelectedDueDate(event.target.value as typeof selectedDueDate)
                    }
                    className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm font-normal text-slate-700 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  >
                    <option value="any">Any due date</option>
                    <option value="overdue">Overdue</option>
                    <option value="next7">Due in the next 7 days</option>
                    <option value="no-date">No due date</option>
                  </select>
                </label>
                <label className="grid gap-1 text-xs font-medium text-slate-500">
                  Label
                  <select
                    value={selectedLabel}
                    onChange={(event) => setSelectedLabel(event.target.value as LabelColor | "any")}
                    className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm font-normal text-slate-700 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                  >
                    <option value="any">Any label</option>
                    {LABEL_COLORS.map((color) => (
                      <option key={color} value={color}>
                        {color[0].toUpperCase()}{color.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
                {hasActiveFilters && (
                  <div className="sm:col-span-2">
                    <button
                      type="button"
                      onClick={clearCardFilters}
                      className="text-left text-xs font-medium text-brand-700 hover:text-brand-900"
                    >
                      Clear all filters
                    </button>
                    <p className="mt-1 text-[11px] text-slate-400">Clear filters to reorder cards.</p>
                  </div>
                )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        {hasActiveFilters && (
          <div className="mt-2">
            {shouldCollapseMobileChips && (
              <div className="mb-1 flex items-center justify-between sm:hidden">
                <button
                  type="button"
                  onClick={() => setIsMobileFilterSummaryOpen((open) => !open)}
                  aria-expanded={isMobileFilterSummaryOpen}
                  aria-controls="applied-filter-chips"
                  className="inline-flex items-center gap-1 rounded-md py-1 text-xs font-medium text-brand-700 hover:text-brand-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {activeCriteriaChips.length} filters applied
                  <span aria-hidden="true">{isMobileFilterSummaryOpen ? "Hide" : "Show"}</span>
                </button>
                {!isMobileFilterSummaryOpen && (
                  <button
                    type="button"
                    onClick={clearCardFilters}
                    className="rounded-md px-1.5 py-1 text-xs font-medium text-slate-500 hover:text-slate-800"
                  >
                    Clear all
                  </button>
                )}
              </div>
            )}
            <div
              id="applied-filter-chips"
              aria-label="Applied filters"
              className={`flex flex-wrap items-center gap-1.5 ${
                shouldCollapseMobileChips && !isMobileFilterSummaryOpen ? "hidden" : "flex"
              } sm:flex`}
            >
              {activeCriteriaChips.map((chip) => (
                <span
                  key={chip.label}
                  className={`inline-flex max-w-full items-center gap-1 rounded-full border py-1 pl-2.5 pr-1 text-xs ${
                    chip.label.startsWith("Search:")
                      ? "border-sky-200 bg-sky-50 text-sky-800"
                      : "border-brand-200 bg-brand-50 text-brand-800"
                  }`}
                >
                  <span className="truncate">{chip.label}</span>
                  <button
                    type="button"
                    onClick={chip.onClear}
                    aria-label={`Remove ${chip.label} filter`}
                    className="rounded-full p-0.5 hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
              <button
                type="button"
                onClick={clearCardFilters}
                className="px-1.5 py-1 text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline sm:hidden"
              >
                Clear all
              </button>
              <button
                type="button"
                onClick={clearCardFilters}
                className="hidden px-1.5 py-1 text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline sm:inline-flex"
              >
                Clear all
              </button>
            </div>
          </div>
        )}
      </header>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {/* Relative wrapper so the fade gradients and arrow buttons can sit
            on top of the scrollable row at fixed screen edges. */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* absolute inset-0 (instead of h-full): the scroller is pinned to
              the wrapper's box, so its height is definite no matter how the
              flex layout above it resolves. Columns use max-h-full and scroll
              internally; the scroller itself only ever scrolls sideways. */}
          <div
            ref={scrollRef}
            onScroll={updateScrollState}
            data-dragging={activeCard ? "true" : "false"}
            className="board-scroll scrollbar-thin absolute inset-0 flex items-stretch gap-3 overflow-x-auto overflow-y-hidden p-4 sm:gap-4 sm:p-6"
          >
            {lists.map((list) => (
              <BoardColumn
                key={list.id}
                listId={list.id}
                title={list.title}
                cards={list.cardOrder
                  .map((id) => cardsById[id])
                  .filter((card): card is Card => !!card && matchesCardFilters(card))}
                members={members}
                onAddCard={handleAddCard}
                onDeleteCard={handleDeleteCard}
                onOpenCard={setOpenCard}
                onRenameList={handleRenameList}
                onDeleteList={handleDeleteList}
                canAdd={myPermissions.canAdd}
                canEdit={myPermissions.canEdit}
                canDelete={myPermissions.canDelete}
                pendingMoveCardIds={pendingMoveCardIds}
                isBoardMovePending={isMovePending}
                disableDrag={hasActiveFilters}
              />
            ))}

            {myPermissions.canAdd && isAddingList && (
            <div className="board-column-snap w-[85vw] shrink-0 sm:w-72">
              {isAddingList ? (
                <form onSubmit={handleCreateList} className="rounded-xl bg-white p-2.5 shadow-sm ring-1 ring-slate-200">
                  <input
                    autoFocus
                    type="text"
                    placeholder="List name"
                    value={newListTitle}
                    onChange={(e) => {
                      setNewListTitle(e.target.value);
                      if (listTitleError) setListTitleError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setIsAddingList(false);
                        setNewListTitle("");
                        setListTitleError(null);
                      }
                    }}
                    aria-invalid={!!listTitleError}
                    className={`w-full rounded-md border px-2.5 py-1.5 text-sm outline-none ring-2 ${
                      listTitleError ? "border-red-300 ring-red-100" : "border-brand-300 ring-brand-100"
                    }`}
                  />
                  {listTitleError && <p className="mt-1 text-xs text-red-600">{listTitleError}</p>}
                  <div className="mt-1.5 flex gap-1.5">
                    <button
                      type="submit"
                      disabled={isSubmittingList}
                      className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
                    >
                      {isSubmittingList ? "Adding..." : "Add list"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsAddingList(false);
                        setNewListTitle("");
                        setListTitleError(null);
                      }}
                      className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
            )}
          </div>

          {/* Left/right edge cues + scroll arrows. The edge cue is a
              soft, low-opacity black shadow — NOT the previous flat
              slate-50 color panel. That's the actual fix: an opaque
              background color painted over a card visibly washes it out
              as it passes underneath (cards are white/bordered, so a
              solid color panel replaces their color entirely in that
              strip); a subtle shadow-style gradient (5% black, fading to
              transparent) barely darkens whatever's beneath it instead of
              replacing it — still a visible "there's more here" cue, on
              every screen size (mobile has no hover state, so this is
              also mobile's persistent equivalent of the buttons below),
              without the translucent-card side effect. */}
          {canScrollLeft && (
            <>
              <div className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-6 bg-gradient-to-r from-black/5 to-transparent sm:w-10" />
              {/* Anchored to the bottom edge, not vertically centered on
                  the whole scroll container — the container spans nearly
                  the full viewport height, so centering relative to IT
                  (rather than to the actual column content, which is
                  usually much shorter) left these floating in empty
                  space below the cards on most boards. A fixed bottom
                  offset stays predictable regardless of column height,
                  and never risks sitting on top of a card the way a
                  height-dependent center position could on a very tall
                  column. */}
              <button
                onClick={() => scrollByColumn(-1)}
                aria-label="Scroll lists left"
                className="absolute bottom-4 left-2 z-[1] hidden rounded-full bg-white p-1.5 text-slate-500 shadow-md ring-1 ring-slate-200 transition hover:text-brand-600 sm:flex"
              >
                <ChevronLeftIcon className="h-4 w-4" />
              </button>
            </>
          )}

          {canScrollRight && (
            <>
              <div className="pointer-events-none absolute inset-y-0 right-0 z-[1] w-6 bg-gradient-to-l from-black/5 to-transparent sm:w-10" />
              <button
                onClick={() => scrollByColumn(1)}
                aria-label="Scroll lists right"
                className="absolute bottom-4 right-2 z-[1] hidden rounded-full bg-white p-1.5 text-slate-500 shadow-md ring-1 ring-slate-200 transition hover:text-brand-600 sm:flex"
              >
                <ChevronRightIcon className="h-4 w-4" />
              </button>
            </>
          )}

          {/* One-time mobile-only nudge — see the effect above for when
              this shows/hides. Positioned low so it never sits over a
              card someone might be trying to tap. */}
          {showSwipeHint && (
            <div className="pointer-events-none absolute bottom-4 right-3 z-[2] flex animate-[toast-in_0.2s_ease-out] items-center gap-1.5 rounded-full bg-slate-900/90 px-3 py-1.5 text-xs font-medium text-white shadow-lg sm:hidden">
              Swipe for more lists
              <ChevronRightIcon className="h-3.5 w-3.5 animate-pulse" />
            </div>
          )}
        </div>

        {/* Renders a floating copy of the card being dragged, following the
            cursor — without this, dnd-kit only moves the original element,
            which can look janky mid-drag across columns. */}
        <DragOverlay>
          {/* Presentational copy only — never the sortable <TaskCard>, which
              would register a second draggable under the same id. */}
          {activeCard ? <TaskCardView card={activeCard} members={members} canDelete={false} isOverlay /> : null}
        </DragOverlay>
      </DndContext>

      <CardDetailModal
        card={openCard}
        members={members}
        onClose={() => setOpenCard(null)}
        onSave={handleSaveCard}
        onDelete={handleDeleteCard}
        canEdit={myPermissions.canEdit}
        canDelete={myPermissions.canDelete}
      />

      <ConfirmDialog
        open={confirmingBoardDelete}
        title="Delete this board?"
        description={`"${board?.title}" and every list and card on it will be permanently deleted.`}
        onCancel={() => setConfirmingBoardDelete(false)}
        onConfirm={handleDeleteBoard}
      />

      {user && workspace && !workspace.isBoardGuest && (
        <BoardMembersModal
          open={isMembersModalOpen}
          onClose={() => setIsMembersModalOpen(false)}
          workspaceName={workspace.name}
          boardName={board?.title ?? "Board"}
          members={members}
          guests={boardGuests}
          activeUserIds={activeBoardUserIds}
          currentUserId={user.id}
          isOwner={isOwner}
          onInvite={handleInviteGuest}
          onRemove={handleRemoveGuest}
          onUpdateGuestPermissions={handleUpdateGuestPermissions}
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

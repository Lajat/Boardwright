"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";
import { apiFetch, ApiError } from "@/lib/apiClient";
import { getSocket } from "@/lib/socket";
import { BellIcon, CheckIcon, ClockIcon, LayoutIcon, XIcon } from "./ui/icons";
import { SocketEvents, type Notification } from "@boardwright/shared-types";

type NotificationTab = "actionable" | "updates";
type InviteAction = "accept" | "decline" | "snooze";

function isInvitation(notification: Notification) {
  return (notification.type === "workspace_invite" || notification.type === "board_invite") &&
    notification.link.startsWith("/invite/");
}

function relativeTime(date: string) {
  const seconds = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  if (Math.abs(seconds) < 3600) return formatter.format(Math.round(seconds / 60), "minute");
  if (Math.abs(seconds) < 86400) return formatter.format(Math.round(seconds / 3600), "hour");
  return formatter.format(Math.round(seconds / 86400), "day");
}

function invitationToken(notification: Notification) {
  const match = notification.link.match(/^\/invite\/([^/?#]+)/);
  return match?.[1] ?? null;
}

export function NotificationBell() {
  const { accessToken } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [tab, setTab] = useState<NotificationTab>("actionable");
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const notificationsRef = useRef<Notification[]>([]);
  const [panelPosition, setPanelPosition] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  useEffect(() => {
    notificationsRef.current = notifications;
  }, [notifications]);

  useEffect(() => {
    if (!accessToken) return;
    // Only notifications that ARE actually snoozed, with a real future
    // timestamp. Previously, every non-snoozed item was mapped to Infinity
    // as a sentinel "no deadline" value and left in the list; since most
    // notifications have no snooze, nextSnooze was Infinity on almost every
    // render, `!Infinity` is false so the early-return never caught it, and
    // `setTimeout(fn, Infinity)` is coerced by the browser to a 0ms delay —
    // firing immediately, refetching, producing a new `notifications`
    // array, and re-running this very effect. That was a tight loop hitting
    // GET /notifications nonstop for any user with no snoozed invitations.
    const futureSnoozeTimes = notifications
      .map((item) => (item.snoozedUntil ? new Date(item.snoozedUntil).getTime() : null))
      .filter((time): time is number => time !== null && time > Date.now());
    if (futureSnoozeTimes.length === 0) return;
    const nextSnooze = Math.min(...futureSnoozeTimes);
    const timer = window.setTimeout(async () => {
      try {
        const result = await apiFetch<{ items: Notification[]; unreadCount: number }>("/notifications", { accessToken });
        notificationsRef.current = result.items;
        setNotifications(result.items);
        setUnreadCount(result.unreadCount);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : "Could not refresh a snoozed invitation.", "error");
      }
    }, Math.max(0, nextSnooze - Date.now() + 50));
    return () => window.clearTimeout(timer);
  }, [notifications, accessToken, showToast]);

  function upsertNotification(notification: Notification) {
    const current = notificationsRef.current;
    const existing = current.find((item) => item.id === notification.id);
    if (existing && existing.isRead !== notification.isRead) {
      setUnreadCount((count) => Math.max(0, count + (notification.isRead ? -1 : 1)));
    }
    const next = [notification, ...current.filter((item) => item.id !== notification.id)]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 30);
    notificationsRef.current = next;
    setNotifications(next);
  }

  useEffect(() => {
    if (!accessToken) {
      notificationsRef.current = [];
      setNotifications([]);
      setUnreadCount(0);
      return;
    }

    const socket = getSocket();
    let active = true;
    const createdDuringFetch: Notification[] = [];

    async function hydrate() {
      const fetchStartedAt = createdDuringFetch.length;
      try {
        const result = await apiFetch<{ items: Notification[]; unreadCount: number }>("/notifications", { accessToken });
        if (!active) return;
        const fetchedIds = new Set(result.items.map((item) => item.id));
        const newLiveItems = createdDuringFetch
          .slice(fetchStartedAt)
          .filter((item) => !fetchedIds.has(item.id) && !item.isRead);
        setNotifications((current) => {
          const merged = new Map(result.items.map((item) => [item.id, item]));
          current.forEach((item) => {
            if (!merged.has(item.id)) merged.set(item.id, item);
          });
          const next = [...merged.values()]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 30);
          notificationsRef.current = next;
          return next;
        });
        setUnreadCount(result.unreadCount + newLiveItems.length);
      } catch (err) {
        if (active) {
          console.error("[notifications] Could not refresh notifications:", err);
          showToast(err instanceof ApiError ? err.message : "Could not refresh notifications.", "error");
        }
      }
    }

    function handleCreated(notification: Notification) {
      createdDuringFetch.push(notification);
      const exists = notificationsRef.current.some((item) => item.id === notification.id);
      upsertNotification(notification);
      if (!exists && !notification.isRead) setUnreadCount((count) => count + 1);
    }

    function handleUpdated(notification: Notification) {
      upsertNotification(notification);
    }

    function refreshWhenVisible() {
      if (document.visibilityState === "visible") void hydrate();
    }

    socket.on(SocketEvents.NOTIFICATION_CREATED, handleCreated);
    socket.on(SocketEvents.NOTIFICATION_UPDATED, handleUpdated);
    socket.on("connect", hydrate);
    window.addEventListener("focus", hydrate);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    void hydrate();

    return () => {
      active = false;
      socket.off(SocketEvents.NOTIFICATION_CREATED, handleCreated);
      socket.off(SocketEvents.NOTIFICATION_UPDATED, handleUpdated);
      socket.off("connect", hydrate);
      window.removeEventListener("focus", hydrate);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [accessToken, showToast]);

  useEffect(() => {
    if (!isOpen) return;
    function updatePanelPosition() {
      const anchor = buttonRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(392, window.innerWidth - 16);
      const left = window.innerWidth < 640
        ? Math.max(8, (window.innerWidth - width) / 2)
        : Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
      const below = window.innerHeight - anchor.bottom - 8;
      const above = anchor.top - 8;
      const openBelow = below >= Math.min(260, window.innerHeight - 24) || below >= above;
      const maxHeight = Math.max(180, Math.min(560, openBelow ? below : above, window.innerHeight - 16));
      setPanelPosition({
        left,
        width,
        maxHeight,
        ...(openBelow ? { top: anchor.bottom + 8 } : { bottom: window.innerHeight - anchor.top + 8 }),
      });
    }
    updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  async function markRead(notification: Notification) {
    if (notification.isRead) return;
    upsertNotification({ ...notification, isRead: true });
    try {
      await apiFetch(`/notifications/${notification.id}/read`, { method: "PATCH", accessToken });
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not mark notification as read.", "error");
    }
  }

  async function respondToInvitation(notification: Notification, action: InviteAction) {
    const token = invitationToken(notification);
    if (!token) {
      showToast("This invitation link is not valid.", "error");
      return;
    }
    setBusyIds((current) => new Set(current).add(notification.id));
    try {
      const response = await apiFetch<{ snoozedUntil?: string }>(`/invites/${token}/respond`, {
        method: "POST",
        accessToken,
        body: { action },
      });
      const updated: Notification = {
        ...notification,
        isRead: true,
        isResolved: action !== "snooze",
        ...(response.snoozedUntil ? { snoozedUntil: response.snoozedUntil } : { snoozedUntil: undefined }),
      };
      upsertNotification(updated);
      showToast(
        action === "accept" ? "Invitation accepted. Access is ready."
          : action === "decline" ? "Invitation declined."
            : "Invitation snoozed for 24 hours."
      );
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not respond to the invitation.", "error");
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(notification.id);
        return next;
      });
    }
  }

  async function markAllRead() {
    const previous = notifications;
    const allRead = notifications.map((item) => ({ ...item, isRead: true }));
    setNotifications(allRead);
    notificationsRef.current = allRead;
    setUnreadCount(0);
    try {
      await apiFetch("/notifications/read-all", { method: "PATCH", accessToken });
    } catch (err) {
      notificationsRef.current = previous;
      setNotifications(previous);
      setUnreadCount(previous.filter((item) => !item.isRead).length);
      showToast(err instanceof ApiError ? err.message : "Could not mark notifications as read.", "error");
    }
  }

  function openNotification(notification: Notification) {
    void markRead(notification);
    setIsOpen(false);
    router.push(notification.link);
  }

  const actionableItems = notifications.filter((item) =>
    isInvitation(item) && !item.isResolved &&
    !(item.snoozedUntil && new Date(item.snoozedUntil).getTime() > Date.now())
  );
  const updateItems = notifications.filter((item) => !actionableItems.some((actionable) => actionable.id === item.id));
  const displayed = tab === "actionable" ? actionableItems : updateItems;
  const groups = new Map<string, Notification[]>();
  displayed.forEach((item) => {
    const groupable = tab === "updates" &&
      ["workspace_removed", "board_removed", "invitation_response"].includes(item.type);
    const key = groupable ? `${item.type}:${item.title}` : item.id;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  });

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        onClick={() => setIsOpen((previous) => !previous)}
        aria-label="Notifications"
        title="Notifications"
        aria-expanded={isOpen}
        className="relative rounded-full p-3 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
      >
        <BellIcon className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white ring-2 ring-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && panelPosition && typeof document !== "undefined" && createPortal(
        <section
          ref={panelRef}
          aria-label="Notifications"
          style={{
            position: "fixed",
            left: panelPosition.left,
            top: panelPosition.top,
            bottom: panelPosition.bottom,
            width: panelPosition.width,
            maxHeight: panelPosition.maxHeight,
          }}
          className="z-[100] flex flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-2xl shadow-slate-900/20 ring-1 ring-black/[0.02] animate-[modal-in_0.15s_ease-out]"
        >
          <header className="border-b border-slate-100 px-4 pt-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold tracking-tight text-slate-900">Notifications</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {actionableItems.length ? `${actionableItems.length} invitation${actionableItems.length === 1 ? "" : "s"} need your attention` : "You’re all caught up"}
                </p>
              </div>
              {unreadCount > 0 && (
                <button type="button" onClick={() => void markAllRead()}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-700 transition hover:bg-brand-50">
                  Mark all read
                </button>
              )}
            </div>
            <div className="flex gap-1" role="tablist" aria-label="Notification categories">
              {([
                ["actionable", `Actionable${actionableItems.length ? ` · ${actionableItems.length}` : ""}`],
                ["updates", "Updates"],
              ] as const).map(([value, label]) => (
                <button key={value} type="button" role="tab" aria-selected={tab === value}
                  onClick={() => setTab(value)}
                  className={`relative px-3 py-2.5 text-xs font-semibold transition ${
                    tab === value ? "text-brand-700" : "text-slate-500 hover:text-slate-800"
                  }`}>
                  {label}
                  {tab === value && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand-600" />}
                </button>
              ))}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {displayed.length === 0 ? (
              <div className="flex flex-col items-center px-6 py-12 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
                  {tab === "actionable" ? <CheckIcon className="h-5 w-5" /> : <BellIcon className="h-5 w-5" />}
                </span>
                <p className="mt-3 text-sm font-semibold text-slate-800">
                  {tab === "actionable" ? "No invitations waiting" : "No updates yet"}
                </p>
                <p className="mt-1 max-w-[240px] text-xs leading-relaxed text-slate-500">
                  {tab === "actionable" ? "New workspace and board invitations will appear here." : "Workspace changes and access updates will show here."}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {[...groups.entries()].map(([groupKey, items]) => {
                  const first = items[0];
                  const grouped = items.length > 1;
                  const isExpanded = expandedGroups.has(groupKey);
                  const snoozedUntil = first.snoozedUntil && new Date(first.snoozedUntil) > new Date()
                    ? first.snoozedUntil
                    : undefined;
                  return (
                    <article key={groupKey} className="relative">
                      {grouped ? (
                        <>
                          <button type="button" onClick={() => setExpandedGroups((current) => {
                            const next = new Set(current);
                            if (next.has(groupKey)) next.delete(groupKey);
                            else next.add(groupKey);
                            return next;
                          })}
                            className={`flex w-full items-start gap-3 px-4 py-4 text-left transition hover:bg-slate-50 ${items.some((item) => !item.isRead) ? "bg-brand-50/30" : ""}`}>
                            <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                              first.type === "workspace_removed" || first.type === "board_removed" ? "bg-rose-50 text-rose-600" : "bg-indigo-50 text-indigo-600"
                            }`}>
                              {first.type === "invitation_response" ? <CheckIcon className="h-4 w-4" /> : <LayoutIcon className="h-4 w-4" />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-semibold text-slate-900">
                                {first.type === "invitation_response" ? `Invitation responses (${items.length})` : `Workspace access changes (${items.length})`}
                              </span>
                              <span className="mt-1 block text-xs leading-relaxed text-slate-600">
                                {first.type === "invitation_response"
                                  ? `${items.length} people responded to your invitations`
                                  : `Access changed for ${items.length} workspace${items.length === 1 ? "" : "s"}`}
                              </span>
                              <span className="mt-2 block text-[11px] text-slate-400">{relativeTime(first.createdAt)}</span>
                            </span>
                            <span className="mt-1 text-xs font-semibold text-brand-700">{isExpanded ? "Hide" : "View"}</span>
                          </button>
                          {isExpanded && (
                            <ul className="space-y-1 bg-slate-50/60 px-4 py-3">
                              {items.map((item) => (
                                <li key={item.id} className="group/row flex items-center gap-1">
                                  <button type="button" onClick={() => openNotification(item)}
                                    className="min-w-0 flex-1 rounded-lg px-3 py-2 text-left transition hover:bg-white">
                                    <span className="block text-xs font-semibold text-slate-800">{item.body}</span>
                                    <span className="mt-1 block text-[10px] text-slate-400">{relativeTime(item.createdAt)}</span>
                                  </button>
                                  {!item.isRead && (
                                    <button
                                      type="button"
                                      onClick={() => void markRead(item)}
                                      title="Mark as read"
                                      aria-label="Mark as read, without opening this notification"
                                      className="shrink-0 rounded-full p-1.5 text-slate-300 opacity-100 transition hover:bg-brand-50 hover:text-brand-700 sm:opacity-0 sm:group-hover/row:opacity-100"
                                    >
                                      <CheckIcon className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      ) : (
                        <div className={`group/row flex items-start gap-3 px-4 py-4 transition ${first.isRead ? "" : "bg-brand-50/30"}`}>
                          {!first.isRead && <span aria-label="Unread" className="absolute left-1.5 top-6 h-2 w-2 rounded-full bg-brand-500" />}
                          <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                            isInvitation(first) ? "bg-brand-50 text-brand-700"
                              : first.type.includes("removed") ? "bg-rose-50 text-rose-600"
                                : "bg-slate-100 text-slate-600"
                          }`}>
                            {isInvitation(first) ? <LayoutIcon className="h-4 w-4" /> : first.type.includes("removed") ? <XIcon className="h-4 w-4" /> : <BellIcon className="h-4 w-4" />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start gap-2">
                              {/* A SIBLING of the navigate-button below, not nested inside it — a
                                  button-in-a-button isn't valid HTML, and nesting it would make every
                                  click navigate regardless of which one was pressed. Reading a
                                  notification while working on something else shouldn't force a
                                  context switch, so this lets someone clear the unread dot without
                                  leaving the page they're on. */}
                              <button type="button" onClick={() => openNotification(first)} className="block min-w-0 flex-1 text-left">
                                <span className="flex items-center gap-2">
                                  <span className="truncate text-sm font-semibold text-slate-900">{first.title}</span>
                                  {!first.isRead && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />}
                                </span>
                                <span className="mt-1 block text-xs leading-relaxed text-slate-600">{first.body}</span>
                                <span className="mt-2 block text-[11px] text-slate-400">{relativeTime(first.createdAt)}</span>
                              </button>
                              {!first.isRead && (
                                <button
                                  type="button"
                                  onClick={() => void markRead(first)}
                                  title="Mark as read"
                                  aria-label="Mark as read, without opening this notification"
                                  className="shrink-0 rounded-full p-1.5 text-slate-300 opacity-100 transition hover:bg-brand-50 hover:text-brand-700 sm:opacity-0 sm:group-hover/row:opacity-100"
                                >
                                  <CheckIcon className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>

                            {isInvitation(first) && !first.isResolved && (
                              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                                {snoozedUntil && (
                                  <span className="mr-auto inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-700">
                                    <ClockIcon className="h-3 w-3" /> Later · {relativeTime(snoozedUntil)}
                                  </span>
                                )}
                                <button type="button" disabled={busyIds.has(first.id)} onClick={() => void respondToInvitation(first, "accept")}
                                  className="rounded-lg bg-gradient-to-br from-brand-500 to-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:from-brand-600 hover:to-violet-700 disabled:opacity-50">
                                  {busyIds.has(first.id) ? "Saving…" : "Accept"}
                                </button>
                                <button type="button" disabled={busyIds.has(first.id)} onClick={() => void respondToInvitation(first, "decline")}
                                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
                                  Decline
                                </button>
                                {!snoozedUntil && (
                                  <button type="button" disabled={busyIds.has(first.id)} onClick={() => void respondToInvitation(first, "snooze")}
                                    className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 disabled:opacity-50">
                                    Later
                                  </button>
                                )}
                              </div>
                            )}
                            {first.isResolved && isInvitation(first) && (
                              <span className="mt-2 inline-flex rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700">
                                Invitation responded to
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
          <footer className="border-t border-slate-100 px-4 py-2 text-center">
            <button type="button" onClick={() => {
              setIsOpen(false);
              router.push("/workspaces");
            }} className="text-xs font-semibold text-slate-500 transition hover:text-brand-700">
              Go to your workspaces
            </button>
          </footer>
        </section>,
        document.body
      )}
    </div>
  );
}

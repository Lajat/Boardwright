"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import { Modal } from "./ui/Modal";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { avatarColorFor, initialsFor } from "@/lib/avatar";
import { emailError } from "@/lib/validation";
import { CheckIcon, CrownIcon, LinkIcon, SearchIcon, SpinnerIcon, TrashIcon, UserPlusIcon } from "./ui/icons";
import type { BoardGuest, WorkspaceMember } from "@fluxboard/shared-types";

type AccessLevel = "owner" | "member" | "guest";
type AccessFilter = "total" | "viewing";

/**
 * One row in the combined access list — a workspace owner, a workspace
 * member, or a single-board guest, normalized to the same shape so they can
 * be searched, sorted, and rendered together. `source` keeps a reference to
 * the original record: only a `guest` row can be removed from here (removing
 * a workspace member/owner is a workspace-level action that lives in
 * MembersModal, not this board-scoped one).
 */
interface AccessRow {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  accessLevel: AccessLevel;
  source: WorkspaceMember | BoardGuest;
}

const ACCESS_LEVEL_BADGE: Record<AccessLevel, { label: string; className: string }> = {
  owner: { label: "Owner", className: "bg-amber-50 text-amber-700" },
  member: { label: "Workspace member", className: "bg-slate-100 text-slate-600" },
  guest: { label: "Board guest", className: "bg-indigo-50 text-indigo-700" },
};

interface BoardMembersModalProps {
  open: boolean;
  onClose: () => void;
  boardName: string;
  workspaceName: string;
  /** Everyone in the board's workspace — included here because every workspace member can already see this board; only board guests (below) are scoped to this board alone. */
  members: WorkspaceMember[];
  guests: BoardGuest[];
  /** IDs of whoever currently has this board open, member or guest alike — drives the "Viewing" badge and the live count. */
  activeUserIds: string[];
  currentUserId: string;
  isOwner: boolean;
  inviteLink: string | null;
  isLoadingInviteLink: boolean;
  onInvite: (email: string) => Promise<void>;
  onRemove: (guest: BoardGuest) => Promise<void>;
  onRegenerateInviteLink: () => Promise<void>;
}

/**
 * Everyone with access to this board — workspace owner and members (who can
 * see every board in the workspace) plus single-board guests (scoped to
 * just this one) — in one searchable list, each tagged with how they got
 * in. Mirrors MembersModal's "People with access" list and search pattern
 * so the two feel like the same feature at two different scopes, while only
 * offering the invite-link/invite-by-email/remove actions that make sense
 * at board scope: inviting here always creates a board-only guest, and only
 * board guests can be removed from this modal (removing a workspace member
 * is a workspace-wide action and belongs in MembersModal instead).
 */
export function BoardMembersModal({
  open,
  onClose,
  boardName,
  workspaceName,
  members,
  guests,
  activeUserIds,
  currentUserId,
  isOwner,
  inviteLink,
  isLoadingInviteLink,
  onInvite,
  onRemove,
  onRegenerateInviteLink,
}: BoardMembersModalProps) {
  const [email, setEmail] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [isInviting, setIsInviting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AccessFilter>("total");
  const [removingGuest, setRemovingGuest] = useState<BoardGuest | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const inviteInFlight = useRef(false);

  const activeIds = useMemo(() => new Set(activeUserIds), [activeUserIds]);

  const rows = useMemo<AccessRow[]>(() => {
    const memberRows: AccessRow[] = members.map((member) => ({
      id: member.id,
      email: member.email,
      displayName: member.displayName,
      avatarUrl: member.avatarUrl,
      accessLevel: member.role === "owner" ? "owner" : "member",
      source: member,
    }));
    // A board guest is, by definition, not a workspace member (see the
    // BoardGuest type) — this filter is just a defensive guard against
    // showing the same person twice if that invariant is ever violated,
    // not an expected case.
    const memberIds = new Set(memberRows.map((row) => row.id));
    const guestRows: AccessRow[] = guests
      .filter((guest) => !memberIds.has(guest.id))
      .map((guest) => ({
        id: guest.id,
        email: guest.email,
        displayName: guest.displayName,
        avatarUrl: guest.avatarUrl,
        accessLevel: "guest",
        source: guest,
      }));
    return [...memberRows, ...guestRows].sort((a, b) => {
      const rank: Record<AccessLevel, number> = { owner: 0, member: 1, guest: 2 };
      if (rank[a.accessLevel] !== rank[b.accessLevel]) return rank[a.accessLevel] - rank[b.accessLevel];
      return a.displayName.localeCompare(b.displayName);
    });
  }, [members, guests]);

  const viewingCount = useMemo(() => rows.filter((row) => activeIds.has(row.id)).length, [rows, activeIds]);

  const visibleRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows
      .filter((row) => filter === "total" || activeIds.has(row.id))
      .filter(
        (row) => !query || row.displayName.toLowerCase().includes(query) || row.email.toLowerCase().includes(query)
      );
  }, [rows, search, filter, activeIds]);

  async function handleInvite(event: FormEvent) {
    event.preventDefault();
    if (inviteInFlight.current) return;
    const error = emailError(email);
    if (error) {
      setInviteError(error);
      return;
    }
    inviteInFlight.current = true;
    setIsInviting(true);
    setInviteError(null);
    try {
      await onInvite(email.trim());
      setEmail("");
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Could not send the invitation.");
    } finally {
      inviteInFlight.current = false;
      setIsInviting(false);
    }
  }

  async function handleCopy() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setInviteError("Clipboard access failed. Select and copy the link from the field.");
    }
  }

  return (
    <>
      <Modal open={open} onClose={onClose} title="Board access" widthClassName="max-w-lg">
        <div className="mb-5 rounded-2xl border border-brand-100 bg-gradient-to-br from-brand-50 via-white to-indigo-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-700">
            {workspaceName} <span className="px-1 text-slate-300">/</span> {boardName}
          </p>
          <p className="mt-2 text-sm font-semibold text-slate-900">Who can see this board</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">
            Every workspace member can already open this board. Guests you invite below see only this board — not
            the workspace name, its other boards, or its member list.
          </p>
        </div>

        {isOwner && (
          <div className="mb-6 space-y-4">
            <section>
              <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <LinkIcon className="h-4 w-4" /> Private board invite link
              </p>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={isLoadingInviteLink ? "Creating secure link..." : inviteLink ?? ""}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label="Board invite link"
                  className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600 outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={!inviteLink}
                  className="flex shrink-0 items-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:opacity-50"
                >
                  {copied ? <CheckIcon className="h-4 w-4" /> : <LinkIcon className="h-4 w-4" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                People review the board and accept before access is granted, as a board guest.{" "}
                <button
                  type="button"
                  onClick={() => setConfirmRegenerate(true)}
                  className="font-medium text-brand-700 underline decoration-brand-200 underline-offset-2 hover:text-brand-900"
                >
                  Rotate link
                </button>
              </p>
            </section>

            <form onSubmit={handleInvite} className="rounded-2xl border border-slate-200 bg-white p-3">
              <label htmlFor="board-guest-email" className="mb-2 block text-xs font-semibold text-slate-700">
                Invite a board guest by email
              </label>
              <div className="flex gap-2">
                <input
                  id="board-guest-email"
                  type="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setInviteError(null);
                  }}
                  placeholder="teammate@example.com"
                  className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                />
                <button
                  type="submit"
                  disabled={isInviting}
                  className="flex shrink-0 items-center gap-1.5 rounded-xl bg-brand-600 px-3.5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
                >
                  {isInviting ? <SpinnerIcon className="h-4 w-4" /> : <UserPlusIcon className="h-4 w-4" />}
                  Invite
                </button>
              </div>
              {inviteError && <p role="alert" className="mt-2 text-xs text-red-600">{inviteError}</p>}
              <p className="mt-2 text-xs text-slate-500">
                To add someone to the whole workspace instead, invite them from the workspace's members panel.
              </p>
            </form>
          </div>
        )}

        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-700">People with access</h3>
          <div className="mb-2 flex gap-1" role="tablist" aria-label="Filter people by access">
          {(
            [
              ["total", `Total · ${rows.length}`],
              ["viewing", `Viewing · ${viewingCount}`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value)}
              className={`relative px-3 py-2 text-xs font-semibold transition ${
                filter === value ? "text-brand-700" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {label}
              {filter === value && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand-600" />}
            </button>
          ))}
          </div>
        </div>
        {/* <div className="mb-2 flex gap-1" role="tablist" aria-label="Filter people by access">
          {(
            [
              ["total", `Total · ${rows.length}`],
              ["viewing", `Viewing · ${viewingCount}`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value)}
              className={`relative px-3 py-2 text-xs font-semibold transition ${
                filter === value ? "text-brand-700" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {label}
              {filter === value && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand-600" />}
            </button>
          ))}
        </div> */}

        {/* <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-700">People with access</h3>
          <span className="text-right text-xs text-slate-400">
            {activeMemberCount > 0 && (
              <span className="mr-2 font-medium text-emerald-700">{activeMemberCount} viewing</span>
            )}
            {members.length} total
          </span>
        </div> */}

        <label className="relative mb-2 block">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find by name or email"
            aria-label="Find by name or email"
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
          />
        </label>

        {rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-8 text-center">
            <p className="text-sm font-medium text-slate-700">No one has access yet</p>
            <p className="mt-1 text-xs text-slate-500">Invite someone to collaborate on this board.</p>
          </div>
        ) : (
          <ul className="max-h-[min(50vh,28rem)] space-y-1 overflow-y-auto">
            {visibleRows.map((row) => {
              const badge = ACCESS_LEVEL_BADGE[row.accessLevel];
              return (
                <li key={row.id} className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-slate-50">
                  <span
                    className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${avatarColorFor(
                      row.id
                    )}`}
                  >
                    {initialsFor(row.displayName)}
                    {activeIds.has(row.id) && (
                      <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-white" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {row.displayName}
                      {row.id === currentUserId && <span className="ml-1.5 font-normal text-slate-400">(you)</span>}
                    </p>
                    <p className="truncate text-xs text-slate-500">{row.email}</p>
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium ${badge.className}`}
                  >
                    {row.accessLevel === "owner" && <CrownIcon aria-hidden="true" className="h-3 w-3" />}
                    {badge.label}
                  </span>
                  {isOwner && row.accessLevel === "guest" && (
                    <button
                      type="button"
                      onClick={() => setRemovingGuest(row.source as BoardGuest)}
                      aria-label={`Remove ${row.displayName} from this board`}
                      className="rounded-lg p-2 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  )}
                </li>
              );
            })}
            {visibleRows.length === 0 && (
              <li className="px-2 py-6 text-center text-sm text-slate-400">
                {search.trim()
                  ? "No people match that search."
                  : "No one is viewing this board right now."}
              </li>
            )}
          </ul>
        )}
      </Modal>

      <ConfirmDialog
        open={!!removingGuest}
        title={`Remove ${removingGuest?.displayName ?? "guest"}?`}
        description={`They will immediately lose access to "${boardName}" and receive a notification.`}
        onCancel={() => setRemovingGuest(null)}
        onConfirm={async () => {
          if (removingGuest) await onRemove(removingGuest);
          setRemovingGuest(null);
        }}
      />
      <ConfirmDialog
        open={confirmRegenerate}
        title="Rotate this invite link?"
        description="The current link stops working immediately. Anyone with the new link can request access to this board."
        onCancel={() => setConfirmRegenerate(false)}
        onConfirm={async () => {
          await onRegenerateInviteLink();
          setConfirmRegenerate(false);
        }}
      />
    </>
  );
}

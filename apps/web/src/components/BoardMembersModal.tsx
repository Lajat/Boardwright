"use client";

import { useRef, useState, type FormEvent } from "react";
import { Modal } from "./ui/Modal";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { avatarColorFor, initialsFor } from "@/lib/avatar";
import { emailError } from "@/lib/validation";
import { CheckIcon, LinkIcon, SpinnerIcon, TrashIcon, UserPlusIcon } from "./ui/icons";
import type { BoardGuest } from "@fluxboard/shared-types";

interface BoardMembersModalProps {
  open: boolean;
  onClose: () => void;
  boardName: string;
  workspaceName: string;
  guests: BoardGuest[];
  activeGuestIds: string[];
  isOwner: boolean;
  inviteLink: string | null;
  isLoadingInviteLink: boolean;
  onInvite: (email: string) => Promise<void>;
  onRemove: (guest: BoardGuest) => Promise<void>;
  onRegenerateInviteLink: () => Promise<void>;
}

export function BoardMembersModal({
  open,
  onClose,
  boardName,
  workspaceName,
  guests,
  activeGuestIds,
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
  const [removing, setRemoving] = useState<BoardGuest | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const inviteInFlight = useRef(false);
  const activeIds = new Set(activeGuestIds);

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
          <p className="mt-2 text-sm font-semibold text-slate-900">Share this board, not the whole workspace</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">
            Guests can see only this board. Other boards, workspace settings, and the member directory stay private.
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
                People review the board and accept before access is granted.{" "}
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
                Invite by email
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
              <p className="mt-2 text-xs text-slate-500">The invitation appears in their notification inbox for approval.</p>
            </form>
          </div>
        )}

        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">Board-only guests</h3>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
            {guests.length} {guests.length === 1 ? "person" : "people"}
          </span>
        </div>
        {guests.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-8 text-center">
            <p className="text-sm font-medium text-slate-700">No board guests yet</p>
            <p className="mt-1 text-xs text-slate-500">Invite someone to collaborate on this board only.</p>
          </div>
        ) : (
          <ul className="max-h-[min(45vh,24rem)] space-y-1 overflow-y-auto">
            {guests.map((guest) => (
              <li key={guest.id} className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-slate-50">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${avatarColorFor(guest.id)}`}>
                  {initialsFor(guest.displayName)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{guest.displayName}</p>
                  <p className="truncate text-xs text-slate-500">{guest.email}</p>
                </div>
                {activeIds.has(guest.id) && (
                  <span className="rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700">Viewing</span>
                )}
                {isOwner && (
                  <button
                    type="button"
                    onClick={() => setRemoving(guest)}
                    aria-label={`Remove ${guest.displayName} from this board`}
                    className="rounded-lg p-2 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.displayName ?? "guest"}?`}
        description={`They will immediately lose access to "${boardName}" and receive a notification.`}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (removing) await onRemove(removing);
          setRemoving(null);
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

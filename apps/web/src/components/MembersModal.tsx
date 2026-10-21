"use client";

import { useRef, useState, FormEvent } from "react";
import { Modal } from "./ui/Modal";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { avatarColorFor, initialsFor } from "@/lib/avatar";
import { emailError as getEmailError } from "@/lib/validation";
import { UserPlusIcon, TrashIcon, SpinnerIcon, LinkIcon, CheckIcon, SearchIcon } from "./ui/icons";
import {
  WORKSPACE_PERMISSION_PRESETS as permissionPresets,
  detectWorkspacePreset,
  workspaceRoleLabel,
  type PermissionPreset,
} from "@/lib/permissionPresets";
import type { WorkspaceMember, WorkspacePermissions } from "@boardwright/shared-types";

type PermissionAxis = "Boards" | "Cards";
type PermissionAction = "Add" | "Edit" | "Delete";
type PermissionField =
  | "canAddBoards"
  | "canEditBoards"
  | "canDeleteBoards"
  | "canAddCards"
  | "canEditCards"
  | "canDeleteCards";
const permissionFields: Record<PermissionAxis, Record<PermissionAction, PermissionField>> = {
  Boards: {
    Add: "canAddBoards",
    Edit: "canEditBoards",
    Delete: "canDeleteBoards",
  },
  Cards: {
    Add: "canAddCards",
    Edit: "canEditCards",
    Delete: "canDeleteCards",
  },
};

interface MembersModalProps {
  open: boolean;
  onClose: () => void;
  workspaceName: string;
  members: WorkspaceMember[];
  activeMemberIds?: string[];
  isOwner: boolean;
  currentUserId: string;
  onInvite: (email: string) => Promise<void>;
  onRemove: (member: WorkspaceMember) => Promise<void>;
  /** Updates a member's board-management and board-content permissions. */
  onUpdatePermissions: (member: WorkspaceMember, updates: Partial<WorkspacePermissions>) => Promise<void>;
  /** Full shareable URL (e.g. "https://app.com/invite/abc123"), or null while it's still loading/not yet fetched. Owner-only feature — parent only needs to fetch this when isOwner is true. */
  inviteLink: string | null;
  isLoadingInviteLink: boolean;
  onRegenerateInviteLink: () => Promise<void>;
}

/**
 * Full members panel for a workspace: shows everyone with access, and —
 * owner only — two ways to bring someone in (invite by email, or share a
 * join link), plus a remove button per member. Non-owners get a read-only
 * view of who they're collaborating with, which is exactly what the
 * avatar stack that opens this modal implies ("here's who's on this")
 * without exposing membership management to people who shouldn't have it.
 */
export function MembersModal({
  open,
  onClose,
  workspaceName,
  members,
  activeMemberIds = [],
  isOwner,
  currentUserId,
  onInvite,
  onRemove,
  onUpdatePermissions,
  inviteLink,
  isLoadingInviteLink,
  onRegenerateInviteLink,
}: MembersModalProps) {
  const activeMembers = new Set(activeMemberIds);
  const activeMemberCount = members.filter((member) => activeMembers.has(member.id)).length;
  const [email, setEmail] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [touched, setTouched] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [isInviting, setIsInviting] = useState(false);
  const inviteInFlight = useRef(false);
  const permissionUpdateQueues = useRef(new Map<string, Promise<void>>());
  const [removingMember, setRemovingMember] = useState<WorkspaceMember | null>(null);
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const [savingPermissionKeys, setSavingPermissionKeys] = useState<Set<string>>(() => new Set());

  function setPermissionSaving(key: string, isSaving: boolean) {
    setSavingPermissionKeys((current) => {
      const next = new Set(current);
      if (isSaving) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function queuePermissionUpdate(
    member: WorkspaceMember,
    key: string,
    updates: Partial<WorkspacePermissions>
  ) {
    setPermissionSaving(key, true);
    const previous = permissionUpdateQueues.current.get(member.id) ?? Promise.resolve();
    let operation: Promise<void>;
    operation = previous
      .catch(() => undefined)
      .then(() => onUpdatePermissions(member, updates))
      .finally(() => {
        setPermissionSaving(key, false);
        if (permissionUpdateQueues.current.get(member.id) === operation) {
          permissionUpdateQueues.current.delete(member.id);
        }
      });
    permissionUpdateQueues.current.set(member.id, operation);
    return operation;
  }

  const validationError = getEmailError(email);
  const visibleMembers = members
    .filter((member) => {
      const query = memberSearch.trim().toLowerCase();
      return !query || member.displayName.toLowerCase().includes(query) || member.email.toLowerCase().includes(query);
    })
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === "owner" ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    if (inviteInFlight.current) return;
    setTouched(true);
    setInviteError(null);
    if (validationError) return;

    inviteInFlight.current = true;
    setIsInviting(true);
    try {
      await onInvite(email.trim());
      setEmail("");
      setTouched(false);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Failed to send invite.");
    } finally {
      inviteInFlight.current = false;
      setIsInviting(false);
    }
  }

  async function handleCopyLink() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 2000);
    } catch {
      // Clipboard API can be blocked (permissions, insecure context, very
      // old browser) — the link is still selectable/copyable by hand
      // right there in the input, so this isn't a hard failure.
    }
  }

  /** Keep the delete dependency valid client-side; the API independently enforces it too. */
  async function handleTogglePermission(
    member: WorkspaceMember,
    axis: "Boards" | "Cards",
    action: PermissionAction,
    enabled: boolean
  ) {
    const fullField = permissionFields[axis][action];
    const updates: Partial<WorkspacePermissions> = { [fullField]: enabled };

    if (!enabled && action !== "Delete") {
      const deleteField = permissionFields[axis].Delete;
      if (member.permissions[deleteField]) {
        updates[deleteField] = false;
      }
    }

    const key = `${member.id}-${fullField}`;
    await queuePermissionUpdate(member, key, updates);
  }

  async function handleToggleWorkspaceEdit(member: WorkspaceMember, enabled: boolean) {
    const key = `${member.id}-canEditWorkspace`;
    await queuePermissionUpdate(member, key, { canEditWorkspace: enabled });
  }

  async function handleApplyPreset(member: WorkspaceMember, preset: PermissionPreset) {
    const key = `${member.id}-preset`;
    await queuePermissionUpdate(member, key, permissionPresets[preset]);
  }

  function getActivePreset(member: WorkspaceMember) {
    return detectWorkspacePreset(member.permissions);
  }

  return (
    <>
      <Modal open={open} onClose={onClose} title={`${workspaceName} · Members`} widthClassName="max-w-lg">
        {isOwner && (
          <div className="mb-5 space-y-4">
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                <LinkIcon className="h-3.5 w-3.5" /> Invite link
              </p>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={isLoadingInviteLink ? "Loading..." : inviteLink ?? ""}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500 outline-none"
                />
                <button
                  onClick={handleCopyLink}
                  disabled={!inviteLink}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-900 disabled:opacity-50"
                >
                  {justCopied ? <CheckIcon className="h-4 w-4" /> : <LinkIcon className="h-4 w-4" />}
                  {justCopied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-slate-400">
                Anyone with this link can review the workspace invitation before joining.{" "}
                <button
                  onClick={() => setConfirmingRegenerate(true)}
                  className="font-medium text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
                >
                  Regenerate link
                </button>
              </p>
            </div>

            <div className="flex items-center gap-2 text-xs text-slate-300">
              <div className="h-px flex-1 bg-slate-100" />
              or
              <div className="h-px flex-1 bg-slate-100" />
            </div>

            <form onSubmit={handleInvite} className="flex flex-col gap-1.5">
              <div className="flex gap-2">
                <input
                  type="email"
                  placeholder="Invite by email..."
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (inviteError) setInviteError(null);
                  }}
                  onBlur={() => setTouched(true)}
                  aria-invalid={touched && !!validationError}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 ${
                    touched && validationError
                      ? "border-red-300 focus:border-red-400 focus:ring-red-100"
                      : "border-slate-200 focus:border-brand-400 focus:ring-brand-100"
                  }`}
                />
                <button
                  type="submit"
                  disabled={isInviting}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-500 to-violet-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:from-brand-600 hover:to-violet-700 disabled:opacity-50"
                >
                  {isInviting ? <SpinnerIcon className="h-4 w-4" /> : <UserPlusIcon className="h-4 w-4" />}
                  Invite
                </button>
              </div>
              {touched && validationError && <p className="text-xs text-red-600">{validationError}</p>}
              {inviteError && <p className="text-xs text-red-600">{inviteError}</p>}
              <p className="mt-0.5 text-xs text-slate-400">
                They need an existing boardwright account and must accept the invitation first.
              </p>
            </form>
          </div>
        )}

        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-700">People with access</h3>
          <span className="text-right text-xs text-slate-400">
            {activeMemberCount > 0 && (
              <span className="mr-2 font-medium text-emerald-700">{activeMemberCount} viewing</span>
            )}
            {members.length} total
          </span>
        </div>
        <label className="relative mb-2 block">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={memberSearch}
            onChange={(event) => setMemberSearch(event.target.value)}
            placeholder="Find by name or email"
            aria-label="Find workspace member by name or email"
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none transition focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
          />
        </label>
        <ul className="max-h-[min(55vh,32rem)] space-y-1 overflow-y-auto">
          {visibleMembers.map((member) => (
            <li key={member.id} className="rounded-lg px-2 py-2 hover:bg-slate-50">
              <div className="flex items-center gap-3">
                <span
                  className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${avatarColorFor(
                    member.id
                  )}`}
                >
                  {initialsFor(member.displayName)}
                  {activeMembers.has(member.id) && (
                    <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-white" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">
                    {member.displayName}
                    {member.id === currentUserId && (
                      <span className="ml-1.5 font-normal text-slate-400">(you)</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-slate-400">{member.email}</p>
                </div>
                {activeMembers.has(member.id) && (
                  <span className="shrink-0 text-[11px] font-medium text-emerald-700">Viewing board</span>
                )}
                {member.role === "owner" ? (
                  // An owner's access isn't governed by the preset system
                  // below (they always have full access), so there's
                  // nothing to append here the way there is for a member.
                  <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-600">
                    Owner
                  </span>
                ) : (
                  <>
                    {/* One combined pill rather than two: "Member" answers who
                        they are, the preset after the dot answers what they can
                        do. Showing both as separate badges doubled the visual
                        weight of every row for not much extra clarity — this
                        keeps the row the same height as the Owner row above it. */}
                    <span
                      className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600"
                      title={
                        getActivePreset(member)
                          ? `${workspaceRoleLabel(member.permissions)} — ${getActivePreset(member)} access`
                          : `${workspaceRoleLabel(member.permissions)} — custom access (doesn't match a preset)`
                      }
                    >
                      {workspaceRoleLabel(member.permissions)}
                      {getActivePreset(member) ? ` · ${getActivePreset(member)}` : " · Custom"}
                    </span>
                    {isOwner && (
                      <button
                        onClick={() => setRemovingMember(member)}
                        aria-label={`Remove ${member.displayName}`}
                        className="shrink-0 rounded-md p-1.5 text-slate-300 hover:bg-red-50 hover:text-red-500"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Workspace owners can set permissions for non-owner members. */}
              {isOwner && member.role !== "owner" && (
                <div className="ml-12 mt-3 space-y-3">
                  <fieldset disabled={savingPermissionKeys.has(`${member.id}-preset`)}>
                    <legend className="mb-1.5 flex w-full items-center justify-between text-xs font-semibold text-slate-600">
                      Access preset
                      <span className="font-normal text-slate-500">
                        {getActivePreset(member) ?? "Custom"}
                      </span>
                    </legend>
                    <div className="grid grid-cols-3 gap-1.5" role="group" aria-label={`${member.displayName} access preset`}>
                      {(["Viewer", "Contributor", "Full access"] as const).map((preset) => {
                        const isActive = getActivePreset(member) === preset;
                        return (
                          <button
                            key={preset}
                            type="button"
                            aria-pressed={isActive}
                            onClick={() => handleApplyPreset(member, preset)}
                            className={`rounded-lg border px-2 py-2 text-left text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-brand-300 ${
                              isActive
                                ? "border-brand-300 bg-brand-50 text-brand-700"
                                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
                            }`}
                          >
                            <span className="block">{preset}</span>
                            <span className="mt-0.5 block text-[10px] font-normal leading-tight text-slate-500">
                              {preset === "Viewer" && "View only"}
                              {preset === "Contributor" && "Work with board content"}
                              {preset === "Full access" && "All board and content actions"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>

                  <label className="flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2.5 text-xs">
                    <input
                      type="checkbox"
                      checked={member.permissions.canEditWorkspace}
                      disabled={savingPermissionKeys.has(`${member.id}-canEditWorkspace`)}
                      aria-label={`Edit workspace settings for ${member.displayName}`}
                      onChange={(event) => handleToggleWorkspaceEdit(member, event.target.checked)}
                      className="mt-0.5 h-4 w-4 cursor-pointer rounded border-slate-300 accent-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
                    />
                    <span>
                      <span className="block font-medium text-slate-700">Edit workspace name</span>
                      <span className="mt-0.5 block text-[10px] leading-tight text-slate-500">
                        Allows this member to rename the workspace. The owner can always rename it.
                      </span>
                    </span>
                  </label>

                  <div className="overflow-hidden rounded-lg border border-slate-200">
                    <table className="w-full table-fixed text-left text-xs">
                      <caption className="sr-only">
                        Permissions for {member.displayName}
                      </caption>
                      <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        <tr>
                          <th scope="col" className="w-[40%] px-3 py-2">Area</th>
                          {(["Add", "Edit", "Delete"] as const).map((action) => (
                            <th key={action} scope="col" className="px-2 py-2 text-center">{action}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {(["Boards", "Cards"] as const).map((axis) => (
                          <tr key={axis}>
                            <th scope="row" className="px-3 py-2.5 text-left font-medium text-slate-700">
                              <span className="block">{axis === "Boards" ? "Boards" : "Board content"}</span>
                              <span className="mt-0.5 block text-[10px] font-normal leading-tight text-slate-500">
                                {axis === "Boards" ? "Create, rename, and remove boards" : "Lists, cards, and comments"}
                              </span>
                            </th>
                            {(["Add", "Edit", "Delete"] as const).map((action) => {
                              const field = permissionFields[axis][action];
                              const checked = member.permissions[field];
                              const canDeleteBeEnabled =
                                member.permissions[permissionFields[axis].Add] &&
                                member.permissions[permissionFields[axis].Edit];
                              const deleteBlocked = action === "Delete" && !checked && !canDeleteBeEnabled;
                              const isSaving = savingPermissionKeys.has(`${member.id}-${field}`);
                              return (
                                <td key={field} className="px-2 py-2.5 text-center">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={isSaving || deleteBlocked}
                                    aria-label={`${action} ${axis === "Boards" ? "boards" : "board content"} for ${member.displayName}`}
                                    title={deleteBlocked ? "Requires Add and Edit to be enabled" : undefined}
                                    onChange={(event) => handleTogglePermission(member, axis, action, event.target.checked)}
                                    className="h-4 w-4 cursor-pointer rounded border-slate-300 accent-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
                                  />
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <p className="text-[11px] leading-relaxed text-slate-500">
                    Workspace members can view its boards. These settings control changes; deleting requires both Add and Edit.
                    {[...savingPermissionKeys].some((key) => key.startsWith(`${member.id}-`)) && (
                      <span className="ml-1 inline-flex items-center gap-1 text-slate-600">
                        <SpinnerIcon className="h-3 w-3" /> Saving
                      </span>
                    )}
                  </p>
                </div>
              )}
            </li>
          ))}
          {visibleMembers.length === 0 && (
            <li className="px-2 py-6 text-center text-sm text-slate-400">No people match that search.</li>
          )}
        </ul>
      </Modal>

      <ConfirmDialog
        open={!!removingMember}
        title="Remove this member?"
        description={`${removingMember?.displayName} will immediately lose access to "${workspaceName}" and every board in it — including any board they currently have open.`}
        confirmLabel="Remove"
        onCancel={() => setRemovingMember(null)}
        onConfirm={async () => {
          if (removingMember) await onRemove(removingMember);
          setRemovingMember(null);
        }}
      />

      <ConfirmDialog
        open={confirmingRegenerate}
        title="Regenerate the invite link?"
        description="The current link will stop working immediately. Anyone you've already shared it with will need the new one."
        confirmLabel="Regenerate"
        danger={false}
        onCancel={() => setConfirmingRegenerate(false)}
        onConfirm={async () => {
          await onRegenerateInviteLink();
          setConfirmingRegenerate(false);
        }}
      />
    </>
  );
}

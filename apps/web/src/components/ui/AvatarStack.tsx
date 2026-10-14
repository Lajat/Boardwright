"use client";

import { useMemo } from "react";
import { avatarColorFor, initialsFor } from "@/lib/avatar";
import { buildAccessList } from "@/lib/access";
import type { BoardGuest, WorkspaceMember } from "@fluxboard/shared-types";

interface AvatarStackProps {
  members: WorkspaceMember[];
  /** Single-board guests to include alongside workspace members. Omit on the workspace-level stack, where there's no board and so no guest concept. */
  guests?: BoardGuest[];
  activeMemberIds?: string[];
  onClick?: () => void;
  /** How many circles to render before collapsing the rest into a "+N" bubble. */
  max?: number;
  size?: "sm" | "md";
}

const SIZE_CLASSES = {
  sm: "h-7 w-7 text-[11px] -ml-2 first:ml-0",
  md: "h-9 w-9 text-xs -ml-2.5 first:ml-0",
};

/**
 * The overlapping circle-of-avatars pattern seen at the top of most
 * collaborative apps (Trello, Linear, Figma, ...) — a compact, at-a-glance
 * answer to "who has access to this?". Purely a trigger button: clicking
 * it is meant to open a MembersModal/BoardMembersModal for the actual
 * invite/remove/detail UI, this component only renders the summary.
 *
 * Ordering: online people first, then offline — matching the green "viewing"
 * ring, so the people actually active right now are the ones visible before
 * the stack collapses into "+N". The owner is pinned first *within*
 * whichever bucket they're in (first among online people if they're online,
 * first among offline people if they're not), rather than always leading
 * the whole stack — an offline owner shouldn't bump an online teammate out
 * of the visible slots.
 */
export function AvatarStack({
  members,
  guests = [],
  activeMemberIds,
  onClick,
  max = 4,
  size = "md",
}: AvatarStackProps) {
  const activeMembers = useMemo(() => new Set(activeMemberIds ?? []), [activeMemberIds]);

  const people = useMemo(() => {
    const rank: Record<"owner" | "member" | "guest", number> = { owner: 0, member: 1, guest: 2 };
    return buildAccessList(members, guests).sort((a, b) => {
      const aOnline = activeMembers.has(a.id);
      const bOnline = activeMembers.has(b.id);
      if (aOnline !== bOnline) return aOnline ? -1 : 1; // online bucket first
      if (rank[a.accessLevel] !== rank[b.accessLevel]) return rank[a.accessLevel] - rank[b.accessLevel]; // owner first within the bucket
      return a.displayName.localeCompare(b.displayName);
    });
  }, [members, guests, activeMembers]);

  const visible = people.slice(0, max);
  const overflow = people.length - visible.length;
  const activeCount = people.filter((person) => activeMembers.has(person.id)).length;
  const sizeClass = SIZE_CLASSES[size];

  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      title="View or manage board members"
      aria-label={
        activeMemberIds
          ? `${people.length} ${people.length === 1 ? "person" : "people"} with access, ${activeCount} currently viewing this board — view or manage`
          : `${people.length} ${people.length === 1 ? "person" : "people"} with access — view or manage`
      }
      className="group flex items-center rounded-full transition hover:opacity-90 disabled:cursor-default"
    >
      {visible.map((person, index) => (
        <span
          key={person.id}
          title={`${person.displayName}${person.accessLevel === "owner" ? " (owner)" : person.accessLevel === "guest" ? " (board guest)" : ""}${activeMembers.has(person.id) ? " — viewing this board" : ""}`}
          style={{ zIndex: visible.length - index }}
          className={`relative flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ${
            activeMembers.has(person.id) ? "ring-emerald-500 ring-offset-1" : "ring-white"
          } ${sizeClass} ${avatarColorFor(person.id)}`}
        >
          {initialsFor(person.displayName)}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className={`relative flex shrink-0 items-center justify-center rounded-full bg-slate-200 font-semibold text-slate-600 ring-2 ${
            people.slice(max).some((person) => activeMembers.has(person.id))
              ? "ring-emerald-500 ring-offset-1"
              : "ring-white"
          } ${sizeClass}`}
          title={`${overflow} more ${overflow === 1 ? "person" : "people"}`}
        >
          +{overflow}
        </span>
      )}
    </button>
  );
}

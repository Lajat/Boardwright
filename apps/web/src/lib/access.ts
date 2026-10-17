import type { BoardGuest, WorkspaceMember } from "@boardwright/shared-types";

export type AccessLevel = "owner" | "member" | "guest";

/**
 * One person who can see a board — a workspace owner, a workspace member,
 * or a single-board guest, normalized to the same shape. `source` keeps a
 * reference to the original record for callers that need the full object
 * back (e.g. to call onRemove with a real BoardGuest).
 */
export interface AccessPerson {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  accessLevel: AccessLevel;
  source: WorkspaceMember | BoardGuest;
}

/**
 * Merges a board's workspace members and single-board guests into one list,
 * owner first, then members, then guests, alphabetically within each group.
 * Shared by AvatarStack (who's shown in the header stack) and
 * BoardMembersModal (the full access list) so "who has access to this
 * board" is computed exactly once and can't drift between the two.
 */
export function buildAccessList(members: WorkspaceMember[], guests: BoardGuest[]): AccessPerson[] {
  const memberRows: AccessPerson[] = members.map((member) => ({
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
  const guestRows: AccessPerson[] = guests
    .filter((guest) => !memberIds.has(guest.id))
    .map((guest) => ({
      id: guest.id,
      email: guest.email,
      displayName: guest.displayName,
      avatarUrl: guest.avatarUrl,
      accessLevel: "guest" as const,
      source: guest,
    }));
  const rank: Record<AccessLevel, number> = { owner: 0, member: 1, guest: 2 };
  return [...memberRows, ...guestRows].sort((a, b) => {
    if (rank[a.accessLevel] !== rank[b.accessLevel]) return rank[a.accessLevel] - rank[b.accessLevel];
    return a.displayName.localeCompare(b.displayName);
  });
}

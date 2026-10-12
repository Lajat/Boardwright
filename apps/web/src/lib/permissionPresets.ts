export type PermissionPreset = "Viewer" | "Contributor" | "Full access";

interface WorkspacePresetFlags {
  canAddBoards: boolean;
  canEditBoards: boolean;
  canDeleteBoards: boolean;
  canAddCards: boolean;
  canEditCards: boolean;
  canDeleteCards: boolean;
}

interface GuestPresetFlags {
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

/** The three access levels a workspace member can be set to — unchanged from MembersModal's original definition, just given a home both it and BoardMembersModal can import from. */
export const WORKSPACE_PERMISSION_PRESETS: Record<PermissionPreset, WorkspacePresetFlags> = {
  Viewer: {
    canAddBoards: false,
    canEditBoards: false,
    canDeleteBoards: false,
    canAddCards: false,
    canEditCards: false,
    canDeleteCards: false,
  },
  Contributor: {
    canAddBoards: false,
    canEditBoards: false,
    canDeleteBoards: false,
    canAddCards: true,
    canEditCards: true,
    canDeleteCards: false,
  },
  "Full access": {
    canAddBoards: true,
    canEditBoards: true,
    canDeleteBoards: true,
    canAddCards: true,
    canEditCards: true,
    canDeleteCards: true,
  },
};

/**
 * A board guest only ever acts on cards within the single board they're
 * scoped to — there's no "add a board" concept for them — so their preset
 * table is just the Cards axis of the workspace table above, derived from
 * it rather than hand-copied a second time. This is what keeps "Contributor"
 * meaning the same add+edit-no-delete permissions whether it's shown next
 * to a workspace member or a board guest (and matches the backend's
 * DEFAULT_GUEST_CARD_PERMISSIONS in apps/api/src/lib/permissions.ts).
 */
export const GUEST_PERMISSION_PRESETS: Record<PermissionPreset, GuestPresetFlags> = Object.fromEntries(
  (Object.keys(WORKSPACE_PERMISSION_PRESETS) as PermissionPreset[]).map((preset) => [
    preset,
    {
      canAdd: WORKSPACE_PERMISSION_PRESETS[preset].canAddCards,
      canEdit: WORKSPACE_PERMISSION_PRESETS[preset].canEditCards,
      canDelete: WORKSPACE_PERMISSION_PRESETS[preset].canDeleteCards,
    },
  ])
) as Record<PermissionPreset, GuestPresetFlags>;

/** Which preset a workspace member's current permission flags match exactly, or null if they've been customized away from all three (shown as "Custom"). */
export function detectWorkspacePreset(permissions: WorkspacePresetFlags): PermissionPreset | null {
  return (
    (Object.keys(WORKSPACE_PERMISSION_PRESETS) as PermissionPreset[]).find((preset) =>
      (Object.keys(WORKSPACE_PERMISSION_PRESETS[preset]) as (keyof WorkspacePresetFlags)[]).every(
        (field) => permissions[field] === WORKSPACE_PERMISSION_PRESETS[preset][field]
      )
    ) ?? null
  );
}

/** Which preset a board guest's current permission flags match exactly, or null if customized. */
export function detectGuestPreset(permissions: GuestPresetFlags): PermissionPreset | null {
  return (
    (Object.keys(GUEST_PERMISSION_PRESETS) as PermissionPreset[]).find(
      (preset) =>
        permissions.canAdd === GUEST_PERMISSION_PRESETS[preset].canAdd &&
        permissions.canEdit === GUEST_PERMISSION_PRESETS[preset].canEdit &&
        permissions.canDelete === GUEST_PERMISSION_PRESETS[preset].canDelete
    ) ?? null
  );
}

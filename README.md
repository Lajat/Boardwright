# Fluxboard

A real-time collaborative Kanban board: drag-and-drop boards, lists, and
cards, with live multi-user sync, granular per-person permissions, and
both workspace-wide and single-board shareable invite links. Built as a
clean, well-structured full-stack TypeScript monorepo, not a
distributed-systems showcase (see
[`resilient-stack`](https://github.com/Lajat/resilient-stack) for that side
of the portfolio instead).

**Live:** [fluxboard.vercel.app](https://fluxboard.vercel.app)

## Features

- **Auth** — signup/login/refresh via httpOnly JWT cookies, forgot/reset
  password
- **Workspaces** — create a workspace, invite teammates via a shareable
  link, owner-controlled membership
- **Board guests** — invite someone to a single board without giving them
  workspace access at all, by email or by a per-board shareable link; they
  see only that one board, never the workspace's name, its other boards,
  or its member list
- **Granular permissions** — three named access levels (Viewer,
  Contributor, Full access) layered over per-person `canAdd`/`canEdit`/
  `canDelete` flags, settable by the workspace owner or an Admin (a member
  explicitly granted permission-management rights, short of full
  ownership); board guests are capped at Contributor, since Full access
  would let someone outside the workspace delete cards on a board they
  don't otherwise belong to
- **Notifications** — invitations, access changes, and board/workspace
  activity surface in a notification bell with read/unread state,
  per-item mark-as-read that doesn't force navigation away from what
  you're doing, and snoozing
- **Boards → Lists → Cards** — full CRUD, drag-and-drop reordering both
  within a list and across lists, with a database-level guard against a
  card ending up recorded in two lists at once
- **Card details** — description, due date (can't be set in the past),
  color labels, priority, assignee, a short human-readable id (e.g. `TT-7`)
- **Board search and filters** — find cards by text, assignee, priority, due
  date, or label; teammate avatars provide quick assignee filters
- **Live board presence** — see which workspace members currently have a
  board open; presence is temporary and tracked per API instance
- **Comments** — a discussion thread on every card
- **Real-time sync** — every mutation (card moved, list reordered, comment
  added, workspace deleted, member removed, etc.) is broadcast live to
  everyone affected — not just people currently viewing the same board,
  but anyone signed in whose sidebar or workspace list needs to reflect it
- **Responsive** — a proper mobile layout, not just a squeezed desktop one

## Architecture

```mermaid
flowchart TB
    Browser(["Browser"])
    Vercel["Vercel<br/>apps/web — Next.js"]
    CloudFront["CloudFront<br/>(HTTPS termination)"]
    EB["Elastic Beanstalk<br/>apps/api — Node/Express + Socket.io"]
    Atlas[("MongoDB Atlas")]

    Browser -->|HTTPS| Vercel
    Vercel -->|"REST + WebSocket, HTTPS"| CloudFront
    CloudFront -->|"HTTP (internal)"| EB
    EB --> Atlas
```

**Why CloudFront sits in front of the API:** Elastic Beanstalk's own domain
only serves plain HTTP. Since the frontend is on Vercel over HTTPS, a
browser refuses to let an HTTPS page call an HTTP API at all (mixed-content
blocking) — CloudFront terminates HTTPS at the edge and talks plain HTTP to
Elastic Beanstalk internally, which the browser never sees.

**Auth cookies and cross-site requests:** browser REST calls use the
frontend's same-origin `/api-proxy` rewrite. Socket.IO connects directly
to the API and authenticates with a short-lived ticket fetched through
that proxy, so real-time updates do not depend on the browser sending a
frontend-domain cookie to the API domain. Production auth cookies retain
`sameSite: "none"` for direct API compatibility; `NODE_ENV=production` is
baked into the Docker image so the cookie policy is set correctly.

## Real-time event scoping

Not every real-time event is scoped the same way, and getting this wrong
was the source of two real bugs (a newly created board never appearing in
the sidebar, and a deleted workspace staying stale there too):

```mermaid
flowchart LR
    subgraph Board room
        A["card:moved<br/>card:created<br/>comment:added<br/>board:guest-added<br/>board:guest-removed"]
    end
    subgraph Workspace room
        B["board:created<br/>board:deleted"]
    end
    subgraph Personal room<br/>(user:userId)
        C["member:added<br/>access:revoked<br/>workspace:deleted"]
    end
```

- **Board-room events** reach anyone with that specific board open.
- **Workspace-room events** reach anyone viewing that workspace's
  board-list page.
- **Personal-room events** reach a specific user's own connection,
  regardless of what page they're currently on — necessary for anything
  that should update a component like the sidebar, which never joins a
  workspace's room at all unless you're actively looking at it.

## Monorepo structure

```mermaid
flowchart TB
    Root["fluxboard/ (pnpm workspace root)"]
    Web["apps/web<br/>Next.js + TypeScript + Tailwind"]
    Api["apps/api<br/>Node/Express + TypeScript + Socket.io"]
    Shared["packages/shared-types<br/>Card, Board, List, User, Comment, SocketEvents"]

    Root --> Web
    Root --> Api
    Root --> Shared
    Web -->|"imports types from"| Shared
    Api -->|"imports types from"| Shared
    Web <-->|"REST + WebSocket"| Api
```

`Card`, `Board`, `List`, `Comment`, and every real-time event name are
defined **once**, in `packages/shared-types`, and imported by both the
frontend and the backend. A type change on one side is a compile error on
the other if they've drifted — not a runtime bug discovered later.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Next.js (App Router) + TypeScript + Tailwind CSS |
| Drag & drop | `dnd-kit` |
| Backend | Node.js + Express + TypeScript |
| Real-time | Socket.io |
| Database | MongoDB Atlas (Mongoose) |
| Auth | JWT in httpOnly cookies (access + refresh) |
| Deploy | Vercel (frontend) · AWS Elastic Beanstalk + CloudFront (backend) |
| CI/CD | GitHub Actions — build, typecheck, integration tests, auto-deploy |
| Monorepo tooling | pnpm workspaces + Turborepo |

## Getting started

```bash
pnpm install
cp apps/api/.env.example apps/api/.env   # fill in MongoDB URI + JWT secrets
cp apps/web/.env.example apps/web/.env
pnpm dev        # runs both apps/web and apps/api in parallel via Turborepo
```

## What's intentionally not built

- File attachments on cards
- Dragging to reorder lists themselves (only cards are draggable; column
  order is fixed)
- Real-time cursors and card-level editing indicators

## License

MIT — see [`LICENSE`](./LICENSE).

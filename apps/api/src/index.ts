import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { connectToDatabase } from "./config/database";
import { WorkspaceModel } from "./models/Workspace";
import { BoardModel } from "./models/Board";
import { SocketEvents } from "@boardwright/shared-types";
import authRoutes from "./routes/authRoutes";
import workspaceRoutes from "./routes/workspaceRoutes";
import boardRoutes from "./routes/boardRoutes";
import listRoutes from "./routes/listRoutes";
import cardRoutes from "./routes/cardRoutes";
import commentRoutes from "./routes/commentRoutes";
import notificationRoutes from "./routes/notificationRoutes";
import invitationRoutes from "./routes/invitationRoutes";

const PORT = process.env.PORT || 4000;
const WEB_ORIGIN = process.env.WEB_ORIGIN || "http://localhost:3000";

const app = express();
// Needed for the new rate limiter (lib/rateLimit.ts) to see each real
// client's IP rather than the load balancer's — this app runs behind one
// in production (Elastic Beanstalk's ALB), and without this, req.ip
// reports the balancer's address for every request, putting everyone in
// the same bucket. "1" trusts exactly one hop (the ALB) rather than
// blindly trusting the whole X-Forwarded-For chain.
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
// `credentials: true` is required for the browser to actually attach the
// httpOnly auth cookies on cross-origin requests (the frontend and API
// run on different ports/origins in dev, and typically different
// subdomains in production) — and a credentialed request can't use the
// wildcard "*" origin, so this must be a specific, exact origin rather
// than left as the previous no-argument cors() default.
app.use(cors({ origin: WEB_ORIGIN, credentials: true }));

// Registered before any auth-protected router, since those routers apply
// requireAuth unconditionally (router.use with no path matches every
// request that reaches them) — health checks must never accidentally end
// up behind auth just because of route registration order.
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Mounted at root rather than under /api/* — nginx or a load balancer in
// front of this service is what would add an /api prefix if needed later,
// keeping this service's own routing simple.
app.use(authRoutes);
app.use(invitationRoutes);
app.use(workspaceRoutes);
app.use(boardRoutes);
app.use(listRoutes);
app.use(cardRoutes);
app.use(commentRoutes);
app.use(notificationRoutes);

// Socket.io needs the raw http.Server, not the Express app directly, so it
// can upgrade HTTP connections to WebSocket connections.
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: WEB_ORIGIN, credentials: true },
});

const boardPresence = new Map<string, Map<string, Set<string>>>();

function broadcastBoardPresence(boardId: string) {
  const userIds = [...(boardPresence.get(boardId)?.keys() ?? [])];
  io.to(`board:${boardId}`).emit(SocketEvents.BOARD_PRESENCE_UPDATED, { boardId, userIds });
}

function removeBoardPresence(boardId: string, userId: string, socketId: string) {
  const users = boardPresence.get(boardId);
  const sockets = users?.get(userId);
  if (!users || !sockets || !sockets.delete(socketId)) return;
  if (sockets.size === 0) users.delete(userId);
  if (users.size === 0) boardPresence.delete(boardId);
  broadcastBoardPresence(boardId);
}

io.use((socket, next) => {
  const ticket = socket.handshake.auth?.ticket;
  const userId = typeof ticket === "string"
    ? getUserIdFromSocketTicket(ticket)
    : getUserIdFromHandshake(socket.handshake.headers.cookie);

  if (!userId) {
    next(new Error("Socket authentication failed"));
    return;
  }

  socket.data.userId = userId;
  next();
});

io.on("connection", (socket) => {
  console.log(`[socket] client connected: ${socket.id}`);

  const userId = socket.data.userId as string;
  socket.join(`user:${userId}`);

  const joinedPresenceBoards = new Set<string>();
  const boardJoinRequests = new Map<string, number>();
  let nextBoardJoinRequestId = 0;

  // Clients join a per-board "room" so events only reach people actually
  // looking at that board, not every connected client on the whole app.
  // Membership is checked using socket.data.userId set above — if the
  // connection wasn't identified (no valid cookie at handshake time), this
  // silently declines to join rather than trusting an unauthenticated
  // socket with a bare boardId.
  socket.on("join-board", async (boardId: string) => {
    if (typeof boardId !== "string" || !boardId) return;
    const requestId = ++nextBoardJoinRequestId;
    boardJoinRequests.set(boardId, requestId);
    const authenticatedUserId = userId;
    if (!authenticatedUserId || !(await socketCanAccessBoard(authenticatedUserId, boardId))) {
      if (boardJoinRequests.get(boardId) === requestId) boardJoinRequests.delete(boardId);
      return;
    }
    if (!socket.connected || boardJoinRequests.get(boardId) !== requestId) return;
    boardJoinRequests.delete(boardId);

    socket.join(`board:${boardId}`);
    if (joinedPresenceBoards.has(boardId)) return;
    joinedPresenceBoards.add(boardId);

    const users = boardPresence.get(boardId) ?? new Map<string, Set<string>>();
    const sockets = users.get(authenticatedUserId) ?? new Set<string>();
    const isFirstConnection = sockets.size === 0;
    sockets.add(socket.id);
    users.set(authenticatedUserId, sockets);
    boardPresence.set(boardId, users);
    if (isFirstConnection) broadcastBoardPresence(boardId);
    else socket.emit(SocketEvents.BOARD_PRESENCE_UPDATED, { boardId, userIds: [...users.keys()] });
  });

  socket.on("leave-board", (boardId: string) => {
    if (typeof boardId !== "string" || !boardId) return;
    boardJoinRequests.delete(boardId);
    socket.leave(`board:${boardId}`);
    if (!joinedPresenceBoards.delete(boardId) || !userId) return;
    removeBoardPresence(boardId, userId, socket.id);
  });

  // Same idea, one level up: the workspace's board-list page joins this
  // room to get live updates when a board is created/renamed/deleted, or
  // when someone is added to or removed from the workspace.
  socket.on("join-workspace", async (workspaceId: string) => {
    if (!(await socketIsWorkspaceMember(socket.data.userId, workspaceId))) return;
    socket.join(`workspace:${workspaceId}`);
  });

  socket.on("leave-workspace", (workspaceId: string) => {
    socket.leave(`workspace:${workspaceId}`);
  });

  socket.on("disconnect", () => {
    boardJoinRequests.clear();
    for (const boardId of joinedPresenceBoards) {
      if (userId) removeBoardPresence(boardId, userId, socket.id);
    }
    console.log(`[socket] client disconnected: ${socket.id}`);
  });
});

/**
 * Extracts and verifies the accessToken cookie from a raw `Cookie` header
 * string (the shape socket.handshake.headers.cookie comes in as — unlike
 * Express requests, Socket.io's handshake object isn't run through
 * cookie-parser, so this small manual parse stands in for that). Returns
 * the userId it encodes, or undefined if the cookie is missing, malformed,
 * or the token itself is invalid/expired.
 */
function getUserIdFromHandshake(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;

  const accessToken = cookieHeader
    .split(";")
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith("accessToken="))
    ?.slice("accessToken=".length);

  if (!accessToken) return undefined;

  try {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) return undefined;
    const decoded = jwt.verify(decodeURIComponent(accessToken), secret) as { userId: string };
    return decoded.userId;
  } catch {
    return undefined;
  }
}

function getUserIdFromSocketTicket(ticket: string): string | undefined {
  try {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) return undefined;
    const decoded = jwt.verify(ticket, secret, { audience: "boardwright-socket" }) as {
      userId?: unknown;
      purpose?: unknown;
    };
    return decoded.purpose === "socket" && typeof decoded.userId === "string"
      ? decoded.userId
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the given (already-identified) user is a member of a workspace. */
async function socketIsWorkspaceMember(userId: string | undefined, workspaceId: string) {
  if (!userId) return false;
  try {
    const workspace = await WorkspaceModel.findById(workspaceId);
    return !!workspace && workspace.memberIds.some((id) => id.toString() === userId);
  } catch {
    return false; // malformed workspaceId, etc. — fail closed
  }
}

/** Whether the given (already-identified) user can access a board, via its workspace. */
async function socketCanAccessBoard(userId: string | undefined, boardId: string) {
  if (!userId) return false;
  try {
    const board = await BoardModel.findById(boardId);
    if (!board) return false;
    if (await socketIsWorkspaceMember(userId, board.workspaceId.toString())) return true;
    return board.guestPermissions.some((guest) => guest.userId.toString() === userId);
  } catch {
    return false;
  }
}

// Stored on the Express app so REST controllers (which don't otherwise
// have access to the socket server) can reach it via req.app.get("io") to
// broadcast an event after a mutation — e.g. cardController emits
// CARD_MOVED after persisting a drag-and-drop move to the database.
app.set("io", io);

connectToDatabase()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`[api] listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[api] failed to start:", err.message);
    process.exit(1);
  });

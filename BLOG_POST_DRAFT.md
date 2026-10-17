# The bug that only showed up in the tab that fixed it

*A debugging story from building [boardwright](https://github.com/Lajat/boardwright), a real-time
collaborative Kanban board.*

## The setup

boardwright syncs board changes across every open tab in real time, using
Socket.io. Drag a card to another column, and everyone else looking at that
board sees it move — no refresh needed.

To test this, the obvious move is two browser windows side by side: drag a
card in window A, watch it appear in window B. I did that test, and it
worked perfectly.

Then I tried something slightly different — I added a *new* card instead of
moving an existing one. And the card I'd just created showed up **twice**,
in the exact tab I'd created it in. The other window? Showed it once, like
it should.

## The clue that mattered

That asymmetry was the whole puzzle. If the bug were in how the server
persisted the card, or in how the socket event was broadcast, *every* tab
would see the duplicate — not just the one that made the request.

Something was different about being the tab that *initiated* the action.

## What's actually racing

Creating a card in boardwright does two things on the backend, in this order:

```javascript
const cardResponse = toCardResponse(card);
io.to(`board:${list.boardId}`).emit(SocketEvents.CARD_CREATED, cardResponse);
res.status(201).json(cardResponse);
```

The Socket.io broadcast fires, *then* the HTTP response is sent. I'd assumed
this ordering didn't matter — both happen essentially instantly, right
after the database write.

But a WebSocket push and an HTTP response are two completely different
delivery paths back to the browser, and nothing guarantees which one
arrives first. On localhost, over a real network, in whatever load the
event loop was under at that exact moment — the WebSocket message won the
race often enough to matter.

So in the tab that created the card, this happened:

1. Socket event arrives first → my `CARD_CREATED` handler adds the card to
   the board's local state
2. A moment later, the original `fetch()` call *also* resolves → its own
   success handler adds the card to local state **again**

Every other tab only ever received step 1 — a single, correctly-guarded
socket event. Only the creating tab had two separate code paths racing to
update the same state.

## The fix (and the real lesson)

My socket handlers were already written defensively — they checked "is
this card already in the list?" before adding it, specifically because I
knew events could theoretically arrive more than once. That guard is why
duplicates never showed up anywhere *except* the creating tab.

The bug wasn't missing idempotency. It was **inconsistent** idempotency —
the code path that handled "my own request just succeeded" had no such
check, because I'd mentally filed it as a separate, safe case: *this is
just me updating my own UI after my own action, what could double it?*

The fix was one line — the same existence check, applied to the one
handler I'd treated as exempt:

```javascript
setLists((prev) =>
  prev.map((list) =>
    list.id === listId && !list.cardOrder.includes(created.id)
      ? { ...list, cardOrder: [...list.cardOrder, created.id] }
      : list
  )
);
```

## Why this generalizes

Any time a system has more than one path to the same state update — an
optimistic UI update *and* a server-authoritative broadcast, a cache *and*
a source of truth, a webhook *and* a polling fallback — the assumption that
"my own action's response is safe to trust unconditionally" is exactly the
gap an attacker (or in this case, a race condition) will find. Every
handler that mutates shared state needs the same discipline, including the
one that feels the most trustworthy because it's *your own* request coming
back to you.

## A postscript: the same lesson bit twice

Months later, building the workspace sidebar, I hit the exact same shape
of bug again — a newly created workspace showed up twice in the tab that
created it. Same root cause: I'd added a socket event so the sidebar (a
separate component with its own state) would learn about new workspaces,
which meant the page's *own* "add it directly from the HTTP response"
handler was now a second path to the same state — and I'd forgotten to
guard that one too. The lesson from the first bug generalizes, but it
doesn't apply itself; every new code path to shared state needs the same
question asked of it, every time.

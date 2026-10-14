# Live chat support (SupportModule)

Real-time chat between customers / drivers and FORKY support agents. REST is the source of truth, Socket.IO delivers events in real time. Base `/api/v1`, Socket.IO on the same host and port (`http://localhost:4000`).

A live chat **is a Ticket** (`source = "CHAT"`, tag `live-chat`) plus a **ChatSession** that holds queue / agent / timing state. Messages are `ticket_messages`, so agents keep every ticket tool: order context, refund-from-ticket, escalation, canned replies, internal notes, SLA, CSAT, history. Ended chats always stay visible as tickets with the full transcript.

Not to be confused with `/orders/:id/messages` (order-scoped masked chat customer / restaurant / driver, `OrderChatService`), which is unchanged.

Demo / reference client: `admin/public/chat-demo.html` (served at http://localhost:3000/chat-demo.html). It is a protocol test harness for the mobile developers, not a product UI.

## State machine

```
                       start (agents online, in hours)
  (no session) ───────────────────────────────────────────▶ WAITING ──accept / auto-assign──▶ ACTIVE
        │                                                     │  │                              │  │
        │ start while offline / outside hours /               │  │ requester cancels            │  │ agent or requester ends,
        │ chat disabled / no agent online                     │  └──────────────▶ ENDED ◀───────┘  │ idle timeout
        ▼                                                     │                                    │
     MISSED (= converted to a ticket)  ◀── queue timeout, all agents offline (grace), requester gone ┘ (WAITING only)
                                          agent transfer by tier: ACTIVE ──▶ WAITING (re-queued for a Tier 2 / Finance agent)
```

| Status | Meaning |
|---|---|
| `WAITING` | queued, no agent yet. The requester may already send messages. |
| `ACTIVE` | an agent is attached (`agent.firstName` visible to the requester). |
| `ENDED` | closed (`endedBy` REQUESTER / AGENT / SYSTEM, `endReason` REQUESTER_ENDED, AGENT_ENDED, IDLE, CONVERTED). Can be rated once. |
| `MISSED` | **converted to a ticket**: no live agent handled it (`endReason` NO_AGENTS, OUTSIDE_HOURS, DISABLED, QUEUE_TIMEOUT, REQUESTER_LEFT). Nothing is lost: the first message and everything sent so far is on the ticket. |

At most one `WAITING` / `ACTIVE` chat per user (DB-enforced); `start` returns the existing one with `existing: true`.

### Never lose a message (offline behaviour)

`POST .../chat/start` with the same body always works:

1. **Live** (`mode: "live"`): chat enabled, inside `support.chat.hours`, at least one agent ONLINE with a fresh heartbeat. A chat is queued even if every online agent is at max concurrency (it waits; the queue timeout converts it if nobody frees up).
2. **Ticket** (`mode: "ticket"`): chat disabled, outside hours, or no agent online. A real ticket (normal tier / priority / SLA rules, first message + attachments + order link stored, requester type customer or driver) is created and a `MISSED` session is returned so apps can keep writing. Reason is `DISABLED`, `OUTSIDE_HOURS` or `NO_AGENTS`.
3. A `WAITING` chat is converted automatically (session `MISSED`, ticket kept, all messages kept, push + email + in-app notification, events `chat.ended` + `chat.converted`) when: the queue timeout passes (`support.chat.queueTimeoutMinutes`), no agent is available for `support.chat.noAgentGraceSec` (agents went offline, hours ended, chat disabled), or the requester is gone for `support.chat.waitingDisconnectSec` (no socket in `user:{id}` and no API call for that chat; REST calls on the chat count as a heartbeat).
4. One open ticket per conversation: messages sent to a `MISSED` session (`POST .../:id/messages`) are appended to the same ticket, and a new `start` for the same order within 24 h reuses the open ticket of the previous `MISSED` conversation (response `appended: true` when offline) instead of creating a duplicate.
5. The ticket appears in the staff ticket queue (`/admin/support/tickets?source=CHAT`, UI `/support/tickets`) and in the requester's ticket list (`GET /customer|driver/support/tickets`). Agent replies on it (console or ticket page) notify the requester (push / email / in-app) and are visible when the app reopens the session (`GET .../chat/:id/messages`).

## Requester REST (customer and driver, identical routes)

Prefix `/customer/support/chat` (customer app) or `/driver/support/chat` (driver app). A user can only ever see their own sessions (anything else is `404`).

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/availability` | - | `{enabled, available, reason: null\|DISABLED\|OUTSIDE_HOURS\|NO_AGENTS, hours, agentsOnline, waiting, estimatedWaitSec, topics:[{code,label}], limits:{maxMessageLength:2000,maxAttachments:3,attachmentTypes}}` |
| POST | `/start` (20/min) | `{topic, orderId?, message, attachments?}` | live: `{mode:"live", existing, session, queue:{position,estimatedWaitSec}\|null, messages}`; offline: `{mode:"ticket", reason, appended, ticketId, ticketNumber, ticket:{id,number,status}, session, message}` |
| GET | `/active` | - | `{mode:"live", existing:true, session, queue, messages}` or `{session:null}` |
| GET | `/sessions` | - | `{data:[session]}` newest first (reopen an ended / converted chat) |
| GET | `/:id/messages` | `?after=<messageId or ISO time>` | `{session, messages}` (never internal notes) |
| POST | `/:id/messages` (60/min) | `{body?, attachments?}` | message. 409 when the chat has ended; on a `MISSED` session the message joins the ticket |
| POST | `/:id/read` | - | `{readAt, count}` marks agent / system messages read |
| POST | `/:id/typing` (120/min) | `{typing?: true}` | `{ok}` |
| POST | `/:id/end` | - | session (idempotent) |
| POST | `/:id/rate` | `{rating 1-5, feedback?}` | session; only once, only after `ENDED` with an agent |

`topic` is a ticket category: `MISSING_ITEM, WRONG_ITEM, NEVER_ARRIVED, VERY_LATE, FOOD_QUALITY, RESTAURANT_CANCELLED, PAYMENT, PAYOUT, ACCOUNT, SAFETY, OTHER` (`availability.topics` lists the ones offered to that app). `orderId` must belong to the requester (customer's own order; driver's assigned or past order) else `404`.

Messages: max 2000 characters after sanitising (HTML tags and control characters are stripped; render as plain text). Attachments: up to 3 image URLs (`jpg, jpeg, png, webp, gif, heic`) obtained from the uploads endpoint (`POST /uploads` multipart `file` -> `{url}`; in the current build the route is mounted at the server root `http://localhost:4000/uploads`). Other URLs are rejected with 400.

Session object (requester view): `{id, ticketId, ticketNumber, status, requesterType, topic, orderId, orderCode, agent:{firstName}|null, queue:{position,estimatedWaitSec}|null, queuedAt, acceptedAt, endedAt, endedBy, endReason, convertedToTicket, lastActivityAt, rating, canRate, unread}`. Message: `{id, senderType: CUSTOMER|DRIVER|AGENT|SYSTEM, senderName (agent first name only), body, attachments, createdAt, readAt}`. No staff ids, emails or internal notes are ever sent to a requester.

## Agent REST (`/admin/support/chat/*`)

`view` = `support:view`, `edit` = `support:edit`. Super admin passes everything. Replying / ending / transferring requires being the assigned agent or a supervisor (`support:approve`). Tier 2 chats need `support:approve`, Finance chats `finance:view`.

| Method | Path | Perm | Body / query | Response |
|---|---|---|---|---|
| GET | `/queue` | view | `?status=WAITING,ACTIVE,ENDED,MISSED` (default WAITING,ACTIVE; ENDED/MISSED = last 24 h) | `{data:[item], serverTime}`; item = `{id, ticketId, ticketNumber, status, mine, requesterType, requesterId, requesterName, topic, category, priority, tier, slaBreached, orderId, orderCode, orderStatus, agentId, agentName, queuedAt, acceptedAt, endedAt, endedBy, endReason, waitSec, firstResponseSec, lastActivityAt, position, unread, lastMessage, rating, transferCount}` |
| GET | `/agents` | view | - | `[{id,name,firstName,role,status,activeChats,maxConcurrentChats,canTier2,canFinance,lastHeartbeatAt}]` |
| GET | `/stats` | view | - | `{waiting, active, longestWaitSec, avgWaitSec, avgFirstResponseSec, abandoned, startedToday, endedToday, avgRating, agentsOnline, agentsAway, chatsPerAgentToday:[{agentId,name,chats}], me:{status,maxConcurrentChats,activeChats}}` |
| GET / PUT | `/presence` | view / edit | PUT `{status: ONLINE\|AWAY\|OFFLINE, maxConcurrentChats?}` | `{status, maxConcurrentChats, activeChats, lastHeartbeatAt}` (GET also counts as a heartbeat) |
| POST | `/presence/heartbeat` | edit | - | same; send every 30 s while Online |
| GET | `/:id` | view | - | `{session, ticket, messages (incl. internal notes), orderContext (as /admin/support/order-context), requester, history:{chats,tickets}}`. A driver chat never exposes the customer's email or history, a customer chat hides the driver's phone |
| POST | `/:id/accept` | edit | - | detail. Atomic: a second agent gets `409`. Needs agent not OFFLINE, below max concurrency, able to handle the ticket tier |
| POST | `/:id/messages` | edit | `{body?, attachments?}` | message. ACTIVE only; on a `MISSED` chat it is sent as a ticket reply (requester notified) |
| POST | `/:id/notes` | edit | `{body}` | internal note (agents only, never emitted to the requester) |
| POST | `/:id/typing` | edit | `{typing?}` | `{ok}` |
| POST | `/:id/read` | edit | - | marks requester messages read (emits `chat.read`) |
| POST | `/:id/transfer` | edit | `{agentId}` to another non-offline agent with capacity, or `{tier: TIER2\|FINANCE}` to escalate (ticket escalated, chat returns to WAITING and is picked by a capable agent); `reason?` | detail; audit-logged |
| POST | `/:id/end` | edit | `{note?, reasonCode?, chargedTo?, resolution?}`; with `reasonCode` + `chargedTo` the ticket is resolved in the same step | detail; audit-logged |
| POST | `/:id/convert` | edit | - | ends a running chat and keeps the conversation as an open ticket (tag `chat-followup`) |

Refunds / credits / escalation tools stay on the ticket (`/admin/support/tickets/:ticketId/refund` etc.); the console links to the ticket page.

## Socket.IO

Connect with the JWT: `io(url, { auth: { token } })`. The server joins `user:{userId}` for everybody, and `support:agents` for staff with `support:view` (super admin included). Requesters only ever receive events for their own sessions (they are emitted to `user:{requesterUserId}`).

### Server -> requester (customer / driver)

| Event | Payload |
|---|---|
| `chat.queued` | `{sessionId, session, queue:{position,estimatedWaitSec}, requeued?}` |
| `chat.queue_position` | `{sessionId, position, estimatedWaitSec}` (whenever the queue changes) |
| `chat.accepted` | `{sessionId, agent:{firstName}, acceptedAt, waitSec}` |
| `chat.message` | `{sessionId, message}` (agent, system and own messages; never internal notes) |
| `chat.typing` | `{sessionId, by:"AGENT", typing, agent:{firstName}}` |
| `chat.read` | `{sessionId, by:"AGENT", at, count}` agent read your messages |
| `chat.transferred` | `{sessionId, agent:{firstName}\|null, status:"ACTIVE"\|"WAITING", tier?, queue?}` |
| `chat.ended` | `{sessionId, status:"ENDED"\|"MISSED", endedBy, reason, message, endedAt, canRate, convertedToTicket, ticketId, ticketNumber}` |
| `chat.converted` | `{sessionId, ticketId, ticketNumber, reason, message}` queued chat became a ticket (also followed by `chat.ended` with status MISSED) |
| `notification` | in-app / push copy when an agent replies while you are not connected (existing event) |

### Server -> agents (`support:agents` room)

| Event | Payload |
|---|---|
| `chat.new` | queue item (see `/queue`) for a new chat, or for an offline chat converted straight to a ticket |
| `chat.updated` | queue item + `event` (`accepted, auto_assigned, transferred, escalated, requeued, converted, ended, rated, offline_message`) |
| `chat.message` | `{sessionId, message}` including internal notes (`internal: true`) and sender ids |
| `chat.typing` | `{sessionId, by:"REQUESTER"\|"AGENT", typing, agentId}` |
| `chat.read` | `{sessionId, by, at, count}` |
| `agent.presence` | `{userId, name, status, activeChats, max, stale?}` |

### Client -> server (optional, REST is equivalent)

| Event | Payload | Notes |
|---|---|---|
| `chat.typing` | `{sessionId, typing}` | requester or the assigned agent; ownership is checked server-side, foreign sessions are ignored |
| `agent.presence` | `{status}` or `{}` | support agents only; with `status` it sets presence, without it it is a heartbeat |

## Sequence diagrams

Live chat with a queue:

```
Customer app            API / Socket.IO                Agent console
 POST /start ────────────▶ create ticket + session(WAITING)
 ◀─ {mode:live, queue}      emit chat.queued ─▶ customer      emit chat.new ─────────▶ (support:agents)
                            auto-assign tick (5 s) OR POST /:id/accept ◀──────────────── Accept
 chat.accepted ◀────────── claim (atomic WAITING→ACTIVE)       chat.updated ──────────▶
 POST /:id/messages ─────▶ save + chat.message ──────────────────────────────────────▶
 chat.message ◀─────────── POST /admin/.../:id/messages ◀────────────────────────────── reply
 POST /:id/typing, /read ▶ chat.typing / chat.read ─────────────────────────────────▶ (and back to the customer)
 chat.ended ◀───────────── POST /admin/.../:id/end ◀────────────────────────────────── End (optionally resolve ticket)
 POST /:id/rate ─────────▶ csat saved on session + ticket
```

Offline / timeout:

```
Customer app                API                                    Notes
 POST /start ─────────────▶ no agent / outside hours / disabled ─▶ ticket T-xxxx + MISSED session
 ◀─ {mode:"ticket", ticketNumber, reason}                          shows in /support/tickets and customer ticket list
 POST /:id/messages ──────▶ appended to the same ticket            agent replies by ticket page or console -> push/email

 POST /start (queued) ───▶ WAITING ... queue timeout / agents offline / requester gone
 chat.converted + chat.ended(MISSED) ◀── ticket kept, notification sent
```

## Background jobs (every 5 s, `ChatSchedulerService`)

* stale presence: ONLINE / AWAY with no heartbeat for `support.chat.presenceTimeoutSec` -> OFFLINE (`agent.presence {stale:true}`); their ACTIVE chats go back to WAITING with a system message.
* auto-assign: oldest waiting chat to the least-loaded ONLINE agent with free capacity who can handle the tier (`support.chat.autoAssign`). Also triggered on new chat, agent going Online and any chat ending.
* queue timeout, no-agent grace and requester-gone conversion to a ticket (see above).
* idle auto-close: ACTIVE chat without a visible message for `support.chat.autoCloseIdleMinutes` -> ENDED (`endedBy SYSTEM`, `endReason IDLE`) with a system message.

When an agent replies and the requester has no socket in `user:{id}`, a push + in-app notification (event `chat.message`) is sent (at most one per minute per chat).

## Settings (`/admin/settings`, group `support`)

| Key | Default | Meaning |
|---|---|---|
| `support.chat.enabled` | `true` | off = every start becomes a ticket (`DISABLED`) |
| `support.chat.hours` | 24/7 `{timezone:"America/Toronto", days:[0..6], start:"00:00", end:"24:00"}` | outside = ticket (`OUTSIDE_HOURS`); `days` 0 = Sunday |
| `support.chat.maxConcurrentPerAgent` | `4` | per-agent override via `PUT /presence {maxConcurrentChats}` |
| `support.chat.autoCloseIdleMinutes` | `15` | decimals allowed (0.05 = 3 s) |
| `support.chat.queueTimeoutMinutes` | `10` | WAITING longer -> ticket |
| `support.chat.autoAssign` | `true` | false = agents must Accept manually |
| `support.chat.estimatedHandleMinutes` | `5` | used for the wait estimate |
| `support.chat.presenceTimeoutSec` | `120` | no heartbeat -> OFFLINE |
| `support.chat.noAgentGraceSec` | `30` | waiting chats become tickets when no agent is available this long |
| `support.chat.waitingDisconnectSec` | `90` | waiting requester gone this long -> ticket |

## Admin console

`/support/chat` ("Live chat" first in the Support menu): left list with filters Waiting / Mine / All / Missed-converted / Ended, wait timers and Customer / Driver badges; centre conversation (live messages, typing, read receipts, canned replies, internal notes, image attachments, Accept / Transfer / End / Keep as ticket, links to the ticket and refund); right requester / order / history context; top bar presence selector (the heartbeat keeps running while the agent browses other admin pages) and live stats. Sound and browser-title counter on new chats / messages.

## Security notes

* Requester endpoints scope every query by `requesterUserId` + `requesterType`; foreign ids return 404. Socket events go to the requester's private room only.
* Internal notes are `internal = true` rows: excluded from requester REST, never emitted to `user:{id}`.
* Agents are identified to requesters by first name only.
* Accept / transfer / end / convert / presence changes are audit-logged (`support.chat.*`) in addition to the global staff interceptor.

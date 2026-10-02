import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Icon } from "@iconify/react/offline";
import { toast } from "react-toastify";
import { Badge, Button, Card, EmptyState, ErrorState, Loading, PageHeader, StatCard, StatusBadge } from "../../ui";
import { useFetch, useLocalState } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { errorMessage, http } from "../../lib/api";
import { getSocket, useSocketEvent } from "../../lib/socket";
import { titleCase } from "../../lib/format";
import { ChatList, Composer, ContextPanel, EndModal, Thread, TransferModal } from "./chatParts";
import { chime, clock, humanSec, presenceKeeper, STATUS_LABEL, STATUS_TONE } from "./chatKit";

const BASE = "/admin/support/chat";
const SM = { padding: "4px 10px", fontSize: 12 };
const FILTERS = [
  { key: "waiting", label: "Waiting" },
  { key: "mine", label: "Mine" },
  { key: "all", label: "All" },
  { key: "missed", label: "Missed / converted" },
  { key: "ended", label: "Ended" },
];
const PRESENCE = [
  { value: "ONLINE", label: "Online", color: "#22c55e" },
  { value: "AWAY", label: "Away", color: "#f59e0b" },
  { value: "OFFLINE", label: "Offline", color: "#94a3b8" },
];

/** Re-render every second (wait timers). */
function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export default function LiveChat() {
  const { user, can } = useAuth();
  const canEdit = can("support", "edit");
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("id") || "";
  const [filter, setFilter] = useLocalState("chat.filter", "all");
  const [sound, setSound] = useLocalState("chat.sound", true);
  const [modal, setModal] = useState(null);

  // ---- data
  const queue = useFetch(`${BASE}/queue`, { status: "WAITING,ACTIVE,ENDED,MISSED" }, { refreshMs: 30000 });
  const stats = useFetch(`${BASE}/stats`, undefined, { refreshMs: 15000 });
  const pres = useFetch(`${BASE}/presence`);
  const detail = useFetch(selectedId ? `${BASE}/${selectedId}` : null);
  const [items, setItems] = useState([]);
  const [msgs, setMsgs] = useState([]);
  const [typing, setTyping] = useState({});
  const [conn, setConn] = useState(true);
  const selRef = useRef(selectedId);
  selRef.current = selectedId;
  const soundRef = useRef(sound);
  soundRef.current = sound;

  useEffect(() => {
    if (queue.data?.data) setItems(queue.data.data);
  }, [queue.data]);
  useEffect(() => {
    setMsgs(detail.data?.messages || []);
  }, [detail.data]);
  useEffect(() => {
    if (!selectedId) setMsgs([]);
  }, [selectedId]);

  const presence = pres.data?.status || "OFFLINE";
  useEffect(() => {
    if (presence === "OFFLINE") presenceKeeper.stop();
    else presenceKeeper.start();
  }, [presence]);

  // ---- helpers
  const refreshAll = useCallback(() => {
    queue.reload();
    stats.reload();
    if (selRef.current) detail.reload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const statsTimer = useRef();
  const refreshStatsSoon = () => {
    clearTimeout(statsTimer.current);
    statsTimer.current = setTimeout(() => stats.reload(), 600);
  };
  const markRead = useCallback((id) => http.post(`${BASE}/${id}/read`, {}).catch(() => undefined), []);

  // ---- realtime
  useSocketEvent("connect", () => {
    setConn(true);
    refreshAll();
    pres.reload();
  });
  useSocketEvent("disconnect", () => setConn(false));
  useSocketEvent("chat.new", (c) => {
    setItems((p) => (p.some((x) => x.id === c.id) ? p.map((x) => (x.id === c.id ? { ...x, ...c, mine: x.mine } : x)) : [c, ...p]));
    if (c.status === "WAITING" && soundRef.current) chime("new");
    refreshStatsSoon();
  });
  useSocketEvent("chat.updated", (c) => {
    setItems((p) => {
      const mine = c.agentId === user?.id;
      const next = { ...c, mine };
      return p.some((x) => x.id === c.id) ? p.map((x) => (x.id === c.id ? next : x)) : [next, ...p];
    });
    if (selRef.current === c.id && ["ended", "converted", "transferred", "escalated", "requeued", "rated", "accepted", "auto_assigned"].includes(c.event)) detail.reload();
    refreshStatsSoon();
  });
  useSocketEvent("chat.message", ({ sessionId, message }) => {
    const mine = message.senderType === "AGENT";
    if (!mine) setTyping((p) => ({ ...p, [sessionId]: 0 }));
    if (sessionId === selRef.current) {
      setMsgs((p) => (message.id && p.some((m) => m.id === message.id) ? p : [...p, message]));
      if (!mine && !message.internal && message.senderType !== "SYSTEM") {
        markRead(sessionId);
        if (document.hidden && soundRef.current) chime("message");
      }
    } else if (!mine && !message.internal && message.senderType !== "SYSTEM") {
      setItems((p) => p.map((x) => (x.id === sessionId ? { ...x, unread: (x.unread || 0) + 1, lastMessage: { body: message.body, senderType: message.senderType, at: message.createdAt } } : x)));
      if (soundRef.current) chime("message");
    }
    if (sessionId === selRef.current) setItems((p) => p.map((x) => (x.id === sessionId ? { ...x, lastMessage: { body: message.body, senderType: message.senderType, at: message.createdAt }, unread: 0 } : x)));
  });
  useSocketEvent("chat.typing", (t) => {
    if (t.by !== "REQUESTER") return;
    setTyping((p) => ({ ...p, [t.sessionId]: t.typing ? Date.now() + 4000 : 0 }));
  });
  useSocketEvent("chat.read", (r) => {
    if (r.by !== "REQUESTER" || r.sessionId !== selRef.current) return;
    setMsgs((p) => p.map((m) => (m.senderType === "AGENT" && !m.readAt ? { ...m, readAt: r.at } : m)));
  });
  useSocketEvent("agent.presence", (a) => {
    if (a.userId === user?.id) pres.reload();
    refreshStatsSoon();
  });

  // ---- derived
  const sel = useMemo(() => items.find((i) => i.id === selectedId) || detail.data?.session || null, [items, selectedId, detail.data]);
  const waiting = items.filter((i) => i.status === "WAITING").length;
  const unreadTotal = items.filter((i) => i.status === "ACTIVE" && i.mine).reduce((n, i) => n + (i.unread || 0), 0);
  const visible = useMemo(() => {
    const f = {
      waiting: (i) => i.status === "WAITING",
      mine: (i) => i.mine && i.status === "ACTIVE",
      all: (i) => i.status === "WAITING" || i.status === "ACTIVE",
      missed: (i) => i.status === "MISSED",
      ended: (i) => i.status === "ENDED",
    }[filter];
    const t = (x) => new Date(x).getTime();
    return items.filter(f).sort((a, b) => (a.status === "WAITING" && b.status === "WAITING" ? t(a.queuedAt) - t(b.queuedAt) : (a.status === "WAITING" ? -1 : b.status === "WAITING" ? 1 : t(b.lastActivityAt) - t(a.lastActivityAt))));
  }, [items, filter]);
  const counts = useMemo(() => ({ waiting, mine: items.filter((i) => i.mine && i.status === "ACTIVE").length, all: items.filter((i) => i.status === "WAITING" || i.status === "ACTIVE").length, missed: items.filter((i) => i.status === "MISSED").length, ended: items.filter((i) => i.status === "ENDED").length }), [items, waiting]);
  const isTyping = sel && typing[sel.id] > now;

  // browser title
  useEffect(() => {
    const prev = document.title;
    document.title = waiting + unreadTotal > 0 ? `(${waiting + unreadTotal}) Live chat` : "Live chat";
    return () => {
      document.title = prev;
    };
  }, [waiting, unreadTotal]);

  // ---- actions
  const select = (id) => {
    setParams({ id }, { replace: true });
    setItems((p) => p.map((x) => (x.id === id ? { ...x, unread: 0 } : x)));
    const c = items.find((x) => x.id === id);
    if (c && c.status === "ACTIVE" && c.mine) markRead(id);
  };
  const act = async (fn, ok) => {
    try {
      const r = await fn();
      if (ok) toast.success(ok);
      return r;
    } catch (e) {
      toast.error(errorMessage(e));
      refreshAll();
      return undefined;
    }
  };
  const setPresence = async (status) => {
    await act(() => http.put(`${BASE}/presence`, { status }));
    pres.reload();
    stats.reload();
  };
  const accept = async (id) => {
    const r = await act(() => http.post(`${BASE}/${id}/accept`, {}), "Chat accepted");
    if (r) {
      setParams({ id }, { replace: true });
      detail.setData(r);
      refreshAll();
    }
  };
  const lastTyping = useRef(0);
  const sendTyping = () => {
    if (!sel || sel.status !== "ACTIVE" || Date.now() - lastTyping.current < 2500) return;
    lastTyping.current = Date.now();
    http.post(`${BASE}/${sel.id}/typing`, { typing: true }).catch(() => undefined);
  };
  const send = async ({ body, attachments, internal }) => {
    const path = internal ? "notes" : "messages";
    const m = await http.post(`${BASE}/${sel.id}/${path}`, { body, attachments });
    setMsgs((p) => (m?.id && p.some((x) => x.id === m.id) ? p : [...p, m]));
    return m;
  };

  const mineCount = stats.data?.me?.activeChats ?? 0;
  const maxChats = stats.data?.me?.maxConcurrentChats ?? 4;
  const d = detail.data;
  const active = sel?.status === "ACTIVE";
  const mineActive = active && (sel?.mine || sel?.agentId === user?.id);

  if (!can("support", "view")) return <EmptyState title="No access" text="You need the Support permission to use live chat." />;

  return (
    <>
      <PageHeader
        title="Live chat"
        subtitle="Real-time conversations with customers and drivers"
        crumbs={[{ label: "Support" }, { label: "Live chat" }]}
        actions={
          <div className="d-flex align-items-center gap-2 flex-wrap">
            {!conn && <Badge tone="danger">Reconnecting…</Badge>}
            <button type="button" className="btn btn-outline-neutral-300 btn-sm radius-8" title={sound ? "Mute notification sounds" : "Unmute"} onClick={() => setSound(!sound)}>
              <Icon icon={sound ? "solar:volume-loud-outline" : "solar:volume-cross-outline"} />
            </button>
            <div className="d-flex align-items-center gap-2" data-testid="presence">
              <span style={{ width: 10, height: 10, borderRadius: 10, background: PRESENCE.find((p) => p.value === presence)?.color }} />
              <select className="form-select form-select-sm w-auto radius-8" value={presence} disabled={!canEdit || pres.loading} onChange={(e) => setPresence(e.target.value)} data-testid="presence-select">
                {PRESENCE.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
          </div>
        }
      />

      <div className="row gy-3 mb-16" data-testid="stats">
        <div className="col-6 col-md-3 col-xl"><StatCard label="Waiting" value={stats.data?.waiting ?? waiting} icon="solar:hourglass-outline" tone="warning" loading={stats.loading && !stats.data} hint={stats.data?.longestWaitSec ? `longest ${humanSec(stats.data.longestWaitSec)}` : undefined} /></div>
        <div className="col-6 col-md-3 col-xl"><StatCard label="Active" value={stats.data?.active ?? 0} icon="solar:chat-round-dots-outline" tone="success" loading={stats.loading && !stats.data} hint={`you ${mineCount}/${maxChats}`} /></div>
        <div className="col-6 col-md-3 col-xl"><StatCard label="Avg wait today" value={humanSec(stats.data?.avgWaitSec)} icon="solar:clock-circle-outline" tone="info" loading={stats.loading && !stats.data} /></div>
        <div className="col-6 col-md-3 col-xl"><StatCard label="Avg first reply" value={humanSec(stats.data?.avgFirstResponseSec)} icon="solar:bolt-outline" tone="purple" loading={stats.loading && !stats.data} /></div>
        <div className="col-6 col-md-3 col-xl"><StatCard label="Abandoned today" value={stats.data?.abandoned ?? 0} icon="solar:user-cross-outline" tone="danger" loading={stats.loading && !stats.data} hint={stats.data?.avgRating ? `CSAT ${stats.data.avgRating}` : undefined} /></div>
        <div className="col-6 col-md-3 col-xl"><StatCard label="Agents online" value={stats.data?.agentsOnline ?? 0} icon="solar:users-group-rounded-outline" tone="primary" loading={stats.loading && !stats.data} hint={stats.data?.agentsAway ? `${stats.data.agentsAway} away` : undefined} /></div>
      </div>

      {presence === "OFFLINE" && canEdit && (
        <div className="alert alert-warning radius-8 d-flex align-items-center justify-content-between gap-3 py-8">
          <span>You are offline. Customers and drivers see "team is offline" and their messages become tickets. Go online to receive chats.</span>
          <Button size="sm" variant="success" onClick={() => setPresence("ONLINE")}>Go online</Button>
        </div>
      )}

      <div className="row g-3" style={{ minHeight: 560 }}>
        {/* left: list */}
        <div className="col-12 col-lg-3 d-flex">
          <Card noPadding className="w-100 d-flex flex-column" bodyClassName="d-flex flex-column p-0" >
            <div className="p-12 border-bottom d-flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" data-testid={`filter-${f.key}`} onClick={() => setFilter(f.key)} className={`btn btn-sm radius-8 px-8 py-4 ${filter === f.key ? "btn-primary-600" : "btn-outline-neutral-300"}`} style={{ fontSize: 12 }}>
                  {f.label} <span className="opacity-75">{counts[f.key]}</span>
                </button>
              ))}
            </div>
            <div className="overflow-auto" style={{ maxHeight: 700 }}>
              {queue.loading && !queue.data ? <Loading text="Loading chats…" minHeight={160} /> : queue.error && !items.length ? <div className="p-16"><ErrorState error={queue.error} onRetry={queue.reload} /></div> : <ChatList items={visible} selectedId={selectedId} onSelect={select} now={now} />}
            </div>
          </Card>
        </div>

        {/* centre: conversation */}
        <div className="col-12 col-lg-6 d-flex">
          <Card noPadding className="w-100" bodyClassName="p-0 d-flex flex-column" >
            {!selectedId ? (
              <EmptyState icon="solar:chat-square-like-outline" title="Select a chat" text={waiting ? `${waiting} customer${waiting === 1 ? " is" : "s are"} waiting for an agent.` : "Pick a conversation from the list. New chats appear here in real time."} />
            ) : detail.loading && !d ? (
              <Loading text="Loading conversation…" minHeight={300} />
            ) : detail.error && !d ? (
              <div className="p-16"><ErrorState error={detail.error} onRetry={detail.reload} /></div>
            ) : sel ? (
              <div className="d-flex flex-column" style={{ height: "max(520px, min(700px, calc(100vh - 200px)))" }}>
                <div className="p-12 border-bottom d-flex flex-wrap align-items-center justify-content-between gap-2">
                  <div className="d-flex align-items-center gap-2">
                    <div>
                      <div className="fw-semibold" data-testid="chat-title">{sel.requesterName} <Badge tone={sel.requesterType === "DRIVER" ? "purple" : "info"}>{titleCase(sel.requesterType)}</Badge></div>
                      <div className="text-xs text-secondary-light">
                        {titleCase(sel.topic)} · <StatusBadge status={sel.status} label={STATUS_LABEL[sel.status]} tone={STATUS_TONE[sel.status]} />
                        {sel.status === "WAITING" && <span className="ms-2 text-warning-main fw-semibold">waiting {clock((now - new Date(sel.queuedAt).getTime()) / 1000)}</span>}
                        {sel.agentName && sel.status !== "WAITING" && <span className="ms-2">with {sel.mine ? "you" : sel.agentName}</span>}
                        {sel.rating && <span className="ms-2">rated {sel.rating}/5</span>}
                      </div>
                    </div>
                  </div>
                  <div className="d-flex flex-wrap gap-1">
                    {sel.status === "WAITING" && canEdit && <Button variant="success" style={SM} icon="solar:check-circle-outline" onClick={() => accept(sel.id)} data-testid="accept">Accept</Button>}
                    {active && canEdit && <Button variant="light" style={SM} icon="solar:transfer-horizontal-outline" onClick={() => setModal("transfer")}>Transfer</Button>}
                    {(active || sel.status === "WAITING") && canEdit && <Button variant="outline-danger" style={SM} icon="solar:close-circle-outline" onClick={() => setModal("end")} data-testid="end">End</Button>}
                    {sel.status !== "MISSED" && canEdit && (active || sel.status === "ENDED") && <Button variant="light" style={SM} icon="solar:ticket-outline" onClick={async () => { const r = await act(() => http.post(`${BASE}/${sel.id}/convert`, {}), "Kept as an open ticket"); if (r) { detail.setData(r); refreshAll(); } }}>Keep as ticket</Button>}
                    <Link to={`/support/tickets/${sel.ticketId}`} style={SM} className="btn btn-outline-primary-600 btn-sm radius-8 d-inline-flex align-items-center gap-1"><Icon icon="solar:ticket-outline" /> Ticket {sel.ticketNumber}</Link>
                    {sel.orderId && can("support", "approve") && <Link to={`/support/tickets/${sel.ticketId}`} style={SM} className="btn btn-warning-600 btn-sm radius-8 d-inline-flex align-items-center gap-1" title="Open the ticket to issue a refund or credit"><Icon icon="solar:wallet-money-outline" /> Refund / credit</Link>}
                  </div>
                </div>
                {sel.status === "WAITING" && canEdit && (
                  <div className="px-12 py-8 bg-warning-focus text-sm d-flex justify-content-between align-items-center">
                    <span>Waiting for an agent{sel.position ? ` (position ${sel.position})` : ""}. Accept it to start replying.</span>
                  </div>
                )}
                {sel.status === "MISSED" && <div className="px-12 py-8 bg-info-focus text-sm">No agent was available, so this chat became ticket {sel.ticketNumber}. Replies go to the customer as ticket messages (notification and email).</div>}
                <Thread messages={msgs} typing={isTyping} requesterName={sel.requesterName} />
                {canEdit ? (
                  <Composer chat={sel} ctx={{ me: { firstName: user?.firstName } }} onSend={send} onTyping={sendTyping} disabled={!(mineActive || sel.status === "MISSED" || (active && can("support", "approve")))} />
                ) : (
                  <div className="p-12 border-top text-sm text-secondary-light">Read-only: you do not have permission to reply.</div>
                )}
              </div>
            ) : null}
          </Card>
        </div>

        {/* right: context */}
        <div className="col-12 col-lg-3 d-flex">
          <Card noPadding className="w-100" title="Context" bodyClassName="p-0">
            {selectedId && d ? <ContextPanel d={d} /> : <EmptyState icon="solar:user-id-outline" title="No chat selected" text="Requester, order and history show up here." />}
          </Card>
        </div>
      </div>

      {modal === "transfer" && sel && <TransferModal chat={sel} me={user?.id} onClose={() => setModal(null)} onDone={(r) => { if (r) detail.setData(r); refreshAll(); }} />}
      {modal === "end" && sel && <EndModal chat={sel} onClose={() => setModal(null)} onDone={(r) => { if (r) detail.setData(r); refreshAll(); }} />}
    </>
  );
}

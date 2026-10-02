import React, { useEffect, useRef, useState } from "react";
import { safeImgUrl, safeUrl } from "../../lib/safe";
import { Link } from "react-router-dom";
import { Icon } from "@iconify/react/offline";
import { toast } from "react-toastify";
import { Avatar, Badge, EmptyState, FormModal, KeyValue, Select, StatusBadge, Switch, TextArea } from "../../ui";
import { useFetch, useForm, useSubmit } from "../../lib/hooks";
import { errorMessage, http } from "../../lib/api";
import { fmtTime, money, timeAgo, titleCase } from "../../lib/format";
import { CHARGED_TO } from "./shared";
import { clock, STATUS_LABEL, STATUS_TONE, uploadImage } from "./chatKit";

const TypeBadge = ({ type }) => <Badge tone={type === "DRIVER" ? "purple" : "info"}>{type === "DRIVER" ? "Driver" : "Customer"}</Badge>;

/** Left pane: one row per chat with live wait timers. */
export function ChatList({ items, selectedId, onSelect, now }) {
  if (!items.length) return <EmptyState icon="solar:chat-round-dots-outline" title="No chats here" text="New chats appear instantly. Set yourself Online to receive them." />;
  return (
    <div className="d-flex flex-column">
      {items.map((c) => {
        const waiting = c.status === "WAITING";
        const sec = waiting ? Math.round((now - new Date(c.queuedAt).getTime()) / 1000) : c.waitSec;
        return (
          <button
            key={c.id}
            type="button"
            data-testid="chat-row"
            onClick={() => onSelect(c.id)}
            className={`text-start border-0 border-bottom px-16 py-12 bg-transparent ${selectedId === c.id ? "bg-primary-50" : ""}`}
            style={selectedId === c.id ? { boxShadow: "inset 3px 0 0 var(--primary-600, #f95a16)" } : undefined}
          >
            <div className="d-flex align-items-center gap-2 mb-4">
              <Avatar name={c.requesterName} size={32} tone={c.requesterType === "DRIVER" ? "purple" : "primary"} />
              <div className="flex-grow-1 text-truncate">
                <div className="fw-semibold text-truncate">{c.requesterName}</div>
                <div className="d-flex gap-1 align-items-center flex-wrap">
                  <TypeBadge type={c.requesterType} />
                  <span className="text-xs text-secondary-light">{titleCase(c.topic)}</span>
                </div>
              </div>
              <div className="text-end flex-shrink-0">
                <Badge tone={STATUS_TONE[c.status]}>{c.status === "MISSED" ? "Missed" : STATUS_LABEL[c.status]}</Badge>
                {c.unread > 0 && <div><span className="badge rounded-pill bg-danger-600 text-white mt-4">{c.unread}</span></div>}
              </div>
            </div>
            <div className="text-sm text-secondary-light text-truncate">{c.lastMessage ? `${c.lastMessage.senderType === "AGENT" ? "You: " : ""}${c.lastMessage.body}` : "No messages"}</div>
            <div className="d-flex justify-content-between text-xs text-secondary-light mt-4">
              <span>{waiting ? <span className={sec > 120 ? "text-danger-main fw-semibold" : "text-warning-main fw-semibold"}>Waiting {clock(sec)}{c.position ? ` · #${c.position}` : ""}</span> : c.status === "ACTIVE" ? `${c.mine ? "You" : c.agentName || "Agent"} · active ${timeAgo(c.lastActivityAt)}` : c.endedAt ? `ended ${timeAgo(c.endedAt)}` : ""}</span>
              {c.orderCode && <span>{c.orderCode}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** Centre pane: transcript with read receipts, internal notes and attachments. */
export function Thread({ messages, typing, requesterName }) {
  const end = useRef();
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, typing]);
  return (
    <div className="flex-grow-1 overflow-auto p-16 d-flex flex-column gap-12" data-testid="thread" style={{ minHeight: 0 }}>
      {messages.length === 0 && <EmptyState icon="solar:chat-round-line-outline" title="No messages yet" />}
      {messages.map((m, i) => {
        const agent = m.senderType === "AGENT";
        const system = m.senderType === "SYSTEM";
        return (
          <div key={m.id || i} className={`d-flex ${system ? "justify-content-center" : agent && !m.internal ? "justify-content-end" : ""}`}>
            <div
              className={`px-12 py-8 radius-8 ${system ? "text-center text-sm text-secondary-light" : ""}`}
              style={{
                maxWidth: system ? "90%" : "78%",
                background: m.internal ? "rgba(234,179,8,.16)" : system ? "transparent" : agent ? "rgba(249,90,22,.14)" : "rgba(128,128,128,.14)",
                border: system ? "1px dashed rgba(128,128,128,.4)" : m.internal ? "1px solid rgba(234,179,8,.5)" : undefined,
              }}
            >
              {!system && (
                <div className="d-flex gap-2 align-items-center text-xs text-secondary-light mb-4">
                  <span className="fw-semibold">{m.internal ? `${m.senderName || "Agent"} (note)` : agent ? m.senderName || "Agent" : requesterName}</span>
                  {m.internal && <Badge tone="warning">Internal note</Badge>}
                  <span>{fmtTime(m.createdAt)}</span>
                </div>
              )}
              {m.body && <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.body}</div>}
              {m.attachments?.length > 0 && (
                <div className="d-flex gap-2 flex-wrap mt-8">
                  {m.attachments.map((u, k) => (
                    <a key={k} href={safeUrl(u)} target="_blank" rel="noopener noreferrer">
                      <img src={safeImgUrl(u)} alt="attachment" className="radius-8" style={{ maxWidth: 160, maxHeight: 120, objectFit: "cover" }} />
                    </a>
                  ))}
                </div>
              )}
              {agent && !m.internal && (
                <div className="text-end text-xs mt-4" style={{ color: m.readAt ? "#22c55e" : undefined }} title={m.readAt ? `Read ${fmtTime(m.readAt)}` : "Delivered"}>
                  <Icon icon={m.readAt ? "solar:check-read-outline" : "solar:check-circle-outline"} /> {m.readAt ? "Read" : "Sent"}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {typing && (
        <div className="text-sm text-secondary-light fst-italic" data-testid="typing">
          {requesterName} is typing…
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

/** Reply composer: canned replies, internal note switch, image attachments. */
export function Composer({ chat, ctx, onSend, onTyping, disabled }) {
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const { busy, run } = useSubmit();
  const replies = useFetch("/admin/support/canned-replies", { limit: 100, audience: chat.requesterType });
  const fileRef = useRef();

  useEffect(() => {
    setBody("");
    setFiles([]);
    setInternal(false);
  }, [chat.id]);

  const pick = async (id) => {
    if (!id) return;
    const r = await run(() => http.post(`/admin/support/canned-replies/${id}/render`, { vars: { customerName: chat.requesterName || "", orderCode: chat.orderCode || "", ticketNumber: chat.ticketNumber || "", agentName: ctx?.me?.firstName || "" } }));
    if (r?.body) setBody((b) => (b ? `${b}\n${r.body}` : r.body));
  };
  const attach = async (e) => {
    const list = [...(e.target.files || [])].slice(0, 3 - files.length);
    if (!list.length) return;
    setUploading(true);
    try {
      for (const f of list) {
        const r = await uploadImage(f);
        setFiles((p) => [...p, r.url]);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const send = async () => {
    if (!body.trim() && !files.length) return;
    const ok = await run(() => onSend({ body, attachments: files, internal }));
    if (ok !== undefined) {
      setBody("");
      setFiles([]);
    }
  };

  return (
    <div className="p-12 border-top" style={internal ? { background: "rgba(234,179,8,.08)" } : undefined}>
      {files.length > 0 && (
        <div className="d-flex gap-2 mb-8">
          {files.map((u) => (
            <span key={u} className="position-relative">
              <img src={safeImgUrl(u)} alt="" className="radius-8" style={{ width: 56, height: 56, objectFit: "cover" }} />
              <button type="button" className="btn btn-sm p-0 position-absolute top-0 end-0 bg-danger-600 text-white rounded-circle" style={{ width: 18, height: 18, lineHeight: 1 }} onClick={() => setFiles((p) => p.filter((x) => x !== u))}>×</button>
            </span>
          ))}
        </div>
      )}
      <textarea
        data-testid="composer"
        className="form-control radius-8 mb-8"
        rows={2}
        disabled={disabled}
        placeholder={disabled ? "This chat is not active" : internal ? "Internal note - the requester never sees this" : "Type a reply - Enter to send, Shift+Enter for a new line"}
        value={body}
        maxLength={2000}
        onChange={(e) => {
          setBody(e.target.value);
          if (!internal) onTyping?.();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2">
        <div className="d-flex align-items-center gap-2 flex-wrap">
          <Switch className="mb-0" label="Internal note" checked={internal} onChange={setInternal} />
          <select className="form-select form-select-sm w-auto radius-8" value="" disabled={disabled && !internal} onChange={(e) => pick(e.target.value)} data-testid="canned">
            <option value="">Canned reply…</option>
            {(replies.data?.data || []).filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.title}{r.shortcut ? ` (${r.shortcut})` : ""}</option>)}
          </select>
          <label className={`btn btn-outline-neutral-300 btn-sm radius-8 mb-0 d-inline-flex align-items-center gap-1 ${internal ? "disabled" : ""}`} title="Attach image (max 3)">
            <Icon icon="solar:gallery-add-outline" /> {uploading ? "Uploading…" : "Image"}
            <input ref={fileRef} type="file" hidden accept="image/*" multiple onChange={attach} disabled={internal || files.length >= 3} />
          </label>
        </div>
        <button type="button" data-testid="send" className={`btn ${internal ? "btn-warning-600" : "btn-primary-600"} btn-sm px-16 py-8 radius-8 d-inline-flex align-items-center gap-2`} disabled={busy || uploading || (disabled && !internal) || (!body.trim() && !files.length)} onClick={send}>
          <Icon icon={internal ? "solar:notes-outline" : "solar:plain-2-outline"} className="text-lg" />
          {internal ? "Add note" : "Send"}
        </button>
      </div>
    </div>
  );
}

/** Right pane: requester summary, order, history. */
export function ContextPanel({ d }) {
  if (!d) return null;
  const r = d.requester;
  const oc = d.orderContext;
  const o = oc?.order;
  return (
    <div className="p-16 d-flex flex-column gap-16 overflow-auto" style={{ minHeight: 0 }} data-testid="context">
      <section>
        <h6 className="text-sm text-secondary-light text-uppercase mb-8">{r?.type === "DRIVER" ? "Driver" : "Customer"}</h6>
        {r ? (
          <>
            <div className="d-flex align-items-center gap-2 mb-8">
              <Avatar name={r.name} size={40} tone={r.type === "DRIVER" ? "purple" : "primary"} />
              <div>
                <div className="fw-semibold">{r.name}</div>
                <div className="text-xs text-secondary-light">{r.email}</div>
              </div>
            </div>
            <KeyValue
              cols={1}
              items={[
                { label: "Phone", value: r.phoneMasked || "-" },
                { label: "Member since", value: r.memberSince ? new Date(r.memberSince).toLocaleDateString("en-CA") : "-" },
                { label: "Orders", value: r.orders },
                ...(r.type === "DRIVER" ? [{ label: "Driver status", value: <StatusBadge status={r.driverStatus} /> }, { label: "Rating", value: r.rating ?? "-" }, { label: "Vehicle", value: titleCase(r.vehicleType) }] : [{ label: "Flags", value: r.fraudFlag || r.blocked ? <Badge tone="danger">{r.fraudFlag ? "Fraud flag" : "Blocked"}</Badge> : "None" }]),
              ]}
            />
          </>
        ) : (
          <div className="text-secondary-light text-sm">Profile unavailable</div>
        )}
      </section>
      <section>
        <h6 className="text-sm text-secondary-light text-uppercase mb-8">Order</h6>
        {o ? (
          <>
            <div className="d-flex align-items-center justify-content-between mb-4">
              <Link to={`/orders/${o.id}`} className="fw-semibold text-primary-600">{o.code}</Link>
              <StatusBadge status={o.status} />
            </div>
            <div className="text-sm text-secondary-light mb-8">{oc.restaurant?.name || "-"} · {money(o.total)}{o.minutesLate > 0 ? ` · ${o.minutesLate} min late` : ""}</div>
            <div className="text-sm">{(oc.items || []).filter((i) => !i.removed).slice(0, 6).map((i) => <div key={i.id}>{i.quantity}× {i.name}</div>)}</div>
            {oc.driver && <div className="text-sm text-secondary-light mt-8">Driver: {oc.driver.name}</div>}
            {oc.refunds?.length > 0 && <div className="text-xs mt-8">Prior refunds: {oc.refunds.map((x) => money(x.amount)).join(", ")}</div>}
          </>
        ) : (
          <div className="text-secondary-light text-sm">No order linked to this chat.</div>
        )}
      </section>
      <section>
        <h6 className="text-sm text-secondary-light text-uppercase mb-8">Previous chats and tickets</h6>
        {!d.history?.chats?.length && !d.history?.tickets?.length && <div className="text-secondary-light text-sm">First contact.</div>}
        {d.history?.tickets?.map((t) => (
          <div key={t.id} className="d-flex justify-content-between gap-2 text-sm mb-4">
            <Link to={`/support/tickets/${t.id}`} className="text-primary-600 text-truncate">{t.number} · {t.subject}</Link>
            <StatusBadge status={t.status} />
          </div>
        ))}
      </section>
    </div>
  );
}

export function TransferModal({ chat, me, onClose, onDone }) {
  const agents = useFetch("/admin/support/chat/agents");
  const f = useForm({ mode: "agent", agentId: "", reason: "" });
  const { busy, run } = useSubmit();
  const v = f.values;
  const opts = (agents.data || []).filter((a) => a.id !== me && a.status !== "OFFLINE").map((a) => ({ value: a.id, label: `${a.name} (${a.status.toLowerCase()}, ${a.activeChats}/${a.maxConcurrentChats})` }));
  const submit = () => run(() => http.post(`/admin/support/chat/${chat.id}/transfer`, v.mode === "agent" ? { agentId: v.agentId, reason: v.reason || undefined } : { tier: v.mode, reason: v.reason || undefined }), { success: "Chat transferred", onDone: (r) => { onClose(); onDone(r); } });
  return (
    <FormModal open onClose={onClose} title="Transfer chat" onSubmit={submit} busy={busy} submitText="Transfer" disabled={v.mode === "agent" && !v.agentId}>
      <Select label="Transfer to" allowEmpty={false} options={[{ value: "agent", label: "Another online agent" }, { value: "TIER2", label: "Escalate to Tier 2 (supervisor queue)" }, { value: "FINANCE", label: "Escalate to Finance" }]} {...f.bind("mode")} />
      {v.mode === "agent" && <Select label="Agent" required options={opts} placeholder={agents.loading ? "Loading…" : opts.length ? "Choose an agent" : "No other agent is online"} {...f.bind("agentId")} />}
      <TextArea label="Handover note" rows={2} {...f.bind("reason")} />
    </FormModal>
  );
}

export function EndModal({ chat, onClose, onDone }) {
  const codes = useFetch("/admin/support/reason-codes");
  const f = useForm({ resolve: false, reasonCode: "", chargedTo: "PLATFORM", resolution: "" });
  const { busy, run } = useSubmit();
  const v = f.values;
  const submit = () => run(() => http.post(`/admin/support/chat/${chat.id}/end`, v.resolve ? { reasonCode: v.reasonCode, chargedTo: v.chargedTo, resolution: v.resolution || undefined } : {}), { success: "Chat ended", onDone: (r) => { onClose(); onDone(r); } });
  return (
    <FormModal open onClose={onClose} title="End chat" onSubmit={submit} busy={busy} submitText="End chat" submitVariant="danger" disabled={v.resolve && !v.reasonCode}>
      <p className="text-sm text-secondary-light">The transcript stays on the ticket. Without resolving, the ticket stays open for follow-up.</p>
      <Switch label="Also resolve the ticket" checked={v.resolve} onChange={(x) => f.set("resolve", x)} />
      {v.resolve && (
        <>
          <Select label="Reason code" required options={(codes.data || []).map((r) => ({ value: r.code, label: r.label }))} {...f.bind("reasonCode")} />
          <Select label="Charged to" allowEmpty={false} options={CHARGED_TO} {...f.bind("chargedTo")} />
          <TextArea label="Resolution summary" rows={2} {...f.bind("resolution")} />
        </>
      )}
    </FormModal>
  );
}

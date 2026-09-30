import React, { useState } from "react";
import { toast } from "react-toastify";
import { Card, EmptyState, ErrorState, Loading, PageHeader } from "../../ui";
import { useFetch } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { errorMessage, http } from "../../lib/api";
import { titleCase } from "../../lib/format";

const CH_LABEL = { IN_APP: "In-app", PUSH: "Push", EMAIL: "Email", SMS: "SMS" };

export default function NotificationMatrix() {
  const { can } = useAuth();
  const canEdit = can("notifications", "edit");
  const { data, loading, error, reload, setData } = useFetch("/admin/notification-matrix");
  const [busy, setBusy] = useState(null);

  if (loading && !data) return <><PageHeader title="Notification Matrix" /><Loading /></>;
  if (error) return <><PageHeader title="Notification Matrix" /><ErrorState error={error} onRetry={reload} /></>;

  const matrix = data?.matrix || {};
  const channels = data?.channels || Object.keys(CH_LABEL);
  const audiences = data?.audiences || ["CUSTOMER", "RESTAURANT", "DRIVER", "ADMIN"];
  const events = [...(data?.events || [])].sort((a, b) => a.event.localeCompare(b.event));

  const toggle = async (event, audience, channel) => {
    const cur = matrix[event]?.[audience] || [];
    const next = cur.includes(channel) ? cur.filter((c) => c !== channel) : [...cur, channel];
    const key = `${event}|${audience}|${channel}`;
    setBusy(key);
    const prev = data;
    setData({ ...data, matrix: { ...matrix, [event]: { ...(matrix[event] || {}), [audience]: next } } });
    try {
      const r = await http.patch("/admin/notification-matrix", { event, audience, channels: next });
      if (r?.matrix) setData((d) => ({ ...d, matrix: r.matrix }));
    } catch (e) {
      setData(prev);
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Notification Matrix" subtitle="Choose which channels each event uses for each audience. Changes save instantly." crumbs={[{ label: "System" }, { label: "Notification Matrix" }]} />
      <Card noPadding>
        {events.length === 0 ? (
          <EmptyState title="No notification events defined" />
        ) : (
          <div className="table-responsive scroll-sm">
            <table className="table bordered-table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Event</th>
                  {audiences.map((a) => (
                    <th key={a}>{titleCase(a)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.event}>
                    <td>
                      <div className="fw-semibold font-monospace text-sm">{ev.event}</div>
                      {ev.variables?.length > 0 && <div className="text-xs text-secondary-light">{ev.variables.join(", ")}</div>}
                    </td>
                    {audiences.map((a) => {
                      if (!ev.audiences?.includes(a)) return <td key={a} className="text-secondary-light">—</td>;
                      const on = matrix[ev.event]?.[a] || [];
                      return (
                        <td key={a}>
                          <div className="d-flex flex-wrap gap-1">
                            {channels.map((c) => {
                              const active = on.includes(c);
                              return (
                                <button
                                  key={c}
                                  type="button"
                                  disabled={!canEdit || busy === `${ev.event}|${a}|${c}`}
                                  onClick={() => toggle(ev.event, a, c)}
                                  className={`btn btn-sm radius-8 py-1 px-2 text-xs ${active ? "btn-primary-600" : "btn-outline-neutral-300 text-secondary-light"}`}
                                  aria-pressed={active}
                                >
                                  {CH_LABEL[c] || titleCase(c)}
                                </button>
                              );
                            })}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

import React, { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Link, useNavigate } from "react-router-dom";
import { http } from "../../lib/api";
import { createNotificationStore, safeUrl, useNotify, useStore } from "../../lib/notify";
import { getSocket } from "../../lib/socket";
import { fmtDateTime } from "../../lib/format";
import { Badge, Button, Card, EmptyState, ErrorState, Loading, PageHeader } from "../../ui";
import { CATEGORY_KEYS, CATEGORY_META, CategoryIcon, relTime, useMinuteTick } from "./shared";

const CSS = `
.fk-nrow:hover,.fk-nrow:focus-within{background:var(--bs-tertiary-bg,#f3f4f6)}
.fk-nrow-main{background:transparent;border:0;text-align:start;min-width:0}
.fk-nrow-main:focus-visible,.fk-nrow-act:focus-visible,.fk-chip:focus-visible,.fk-tab:focus-visible{outline:2px solid var(--primary-600,#f97316);outline-offset:-2px}
.fk-nrow-act{width:34px;height:34px;border:0;background:transparent;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:var(--bs-secondary-color,#6b7280)}
.fk-nrow-act:hover{background:var(--bs-secondary-bg,#e5e7eb)}
.fk-chip{border:1px solid var(--bs-border-color,#d1d5db);background:transparent;color:inherit;border-radius:999px;padding:4px 12px;font-size:13px;white-space:nowrap}
.fk-chip[aria-pressed="true"]{background:var(--primary-600,#f97316);border-color:var(--primary-600,#f97316);color:#fff}
.fk-tab{border:0;background:transparent;padding:10px 16px;font-weight:600;color:var(--bs-secondary-color,#6b7280);border-bottom:2px solid transparent}
.fk-tab[aria-selected="true"]{color:var(--primary-600,#f97316);border-bottom-color:var(--primary-600,#f97316)}
`;

/**
 * "See all" notification center (Admin Console /inbox, Restaurant Portal /portal/notifications).
 * It owns its own list state (filters, paging) so the header bell keeps showing the latest notifications; both are kept in sync by the
 * realtime events (notification, notification.read).
 */
export default function NotificationsPage({ title = "Notifications", subtitle, crumbs }) {
  const ctx = useNotify();
  const navigate = useNavigate();
  const restaurant = ctx?.app === "restaurant";
  const store = useMemo(() => createNotificationStore({ http, getSocket: () => getSocket(), pageSize: 20 }), []);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  const s = useStore(store);
  const [tab, setTab] = useState("all");
  const [category, setCategory] = useState("");
  useMinuteTick();

  const apply = (nextTab, nextCategory) => {
    setTab(nextTab);
    setCategory(nextCategory);
    store.setFilter({ unread: nextTab === "unread", category: nextCategory });
  };

  const openItem = (n) => {
    store.markRead(n.id);
    const url = safeUrl(n.url, null);
    if (url) navigate(url);
  };

  const items = s.items || [];
  const settingsPath = restaurant ? "/portal/notification-settings" : "/notification-settings";
  const initial = !s.loaded;

  return (
    <>
      <style>{CSS}</style>
      <PageHeader
        title={title}
        subtitle={subtitle}
        crumbs={crumbs}
        actions={
          <>
            <Link to={settingsPath} className="btn btn-outline-neutral-300 text-primary-light btn-sm px-16 py-8 radius-8 d-inline-flex align-items-center gap-2">
              <Icon icon="solar:settings-outline" className="text-lg" aria-hidden="true" /> Settings
            </Link>
            <Button variant="light" icon="solar:check-read-outline" disabled={!s.unread} onClick={() => store.markAllRead()}>
              Mark all read
            </Button>
          </>
        }
      />
      <Card noPadding>
        <div className="px-16 pt-8 border-bottom">
          <div role="tablist" aria-label="Show" className="d-flex gap-1">
            <button type="button" role="tab" id="fk-tab-all" aria-selected={tab === "all"} aria-controls="fk-nlist" className="fk-tab" onClick={() => apply("all", category)}>
              All
            </button>
            <button type="button" role="tab" id="fk-tab-unread" aria-selected={tab === "unread"} aria-controls="fk-nlist" className="fk-tab" onClick={() => apply("unread", category)}>
              Unread{s.unread ? ` (${s.unread})` : ""}
            </button>
          </div>
        </div>
        <div className="px-16 py-12 d-flex flex-wrap gap-2 border-bottom" role="group" aria-label="Filter by category">
          <button type="button" className="fk-chip" aria-pressed={category === ""} onClick={() => apply(tab, "")}>
            All categories
          </button>
          {CATEGORY_KEYS.map((k) => (
            <button key={k} type="button" className="fk-chip" aria-pressed={category === k} onClick={() => apply(tab, category === k ? "" : k)}>
              {CATEGORY_META[k].label}
            </button>
          ))}
        </div>

        <div id="fk-nlist" role="tabpanel" aria-labelledby={tab === "all" ? "fk-tab-all" : "fk-tab-unread"} aria-busy={s.loading}>
          {initial && !s.error && <Loading text="Loading notifications..." minHeight={220} />}
          {s.error && items.length === 0 && (
            <div className="p-16">
              <ErrorState error="Could not load your notifications." onRetry={() => store.refresh()} />
            </div>
          )}
          {s.loaded && !s.error && items.length === 0 && (
            <EmptyState
              icon="solar:inbox-outline"
              title={tab === "unread" ? (category ? `No unread ${CATEGORY_META[category].label.toLowerCase()} notifications` : "No unread notifications") : category ? `No ${CATEGORY_META[category].label.toLowerCase()} notifications` : "You are all caught up"}
              text={tab === "unread" || category ? "Try another filter to see older notifications." : "New alerts will show up here as they happen."}
            />
          )}
          {items.length > 0 && (
            <ul className="list-unstyled mb-0" aria-label="Notifications" data-testid="notification-list">
              {items.map((n) => {
                const meta = CATEGORY_META[n.category] || CATEGORY_META.system;
                const hasLink = !!safeUrl(n.url, null);
                return (
                  <li key={n.id} className={`fk-nrow d-flex align-items-start border-bottom ${n.readAt ? "" : "bg-primary-50"}`} data-unread={n.readAt ? "0" : "1"} data-id={n.id}>
                    <button type="button" className="fk-nrow-main flex-grow-1 d-flex align-items-start gap-3 px-16 py-16" onClick={() => openItem(n)}>
                      <CategoryIcon category={n.category} size={40} />
                      <span className="d-block flex-grow-1" style={{ minWidth: 0 }}>
                        <span className={`d-block text-break ${n.readAt ? "" : "fw-semibold"}`}>
                          {!n.readAt && <span className="visually-hidden">Unread: </span>}
                          {n.title}
                        </span>
                        {n.body && <span className="d-block text-secondary-light text-sm text-break">{n.body}</span>}
                        <span className="d-flex flex-wrap align-items-center gap-2 mt-1">
                          <Badge tone={meta.tone}>{meta.label}</Badge>
                          <span className="text-secondary-light text-xs" title={fmtDateTime(n.createdAt)}>
                            {relTime(n.createdAt)}
                          </span>
                          {hasLink && (
                            <span className="text-primary-600 text-xs d-inline-flex align-items-center gap-1">
                              Open <Icon icon="solar:arrow-right-outline" aria-hidden="true" />
                            </span>
                          )}
                        </span>
                      </span>
                      {!n.readAt && <span className="d-inline-block rounded-circle bg-primary-600 flex-shrink-0 mt-2" style={{ width: 10, height: 10 }} aria-hidden="true" />}
                    </button>
                    <span className="d-flex flex-column flex-sm-row gap-1 py-12 pe-12 flex-shrink-0">
                      {!n.readAt && (
                        <button type="button" className="fk-nrow-act" title="Mark as read" aria-label={`Mark as read: ${n.title}`} onClick={() => store.markRead(n.id)}>
                          <Icon icon="solar:check-read-outline" className="text-xl" aria-hidden="true" />
                        </button>
                      )}
                      <button type="button" className="fk-nrow-act" title="Delete" aria-label={`Delete: ${n.title}`} onClick={() => store.remove(n.id)}>
                        <Icon icon="solar:trash-bin-minimalistic-outline" className="text-xl" aria-hidden="true" />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {items.length > 0 && (
            <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 px-16 py-12">
              <span className="text-secondary-light text-sm" role="status">
                Showing {items.length} notification{items.length === 1 ? "" : "s"}
              </span>
              {s.hasMore && (
                <Button variant="outline" loading={s.loading} onClick={() => store.loadMore()}>
                  Load more
                </Button>
              )}
            </div>
          )}
        </div>
      </Card>
    </>
  );
}

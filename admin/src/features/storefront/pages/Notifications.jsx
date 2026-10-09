import React, { useEffect } from "react";
import { Link, Navigate } from "react-router-dom";
import { useNotifications } from "../../../lib/notify";
import PushBanner from "../components/PushBanner";
import { ErrorBox, Loading, Ri, Spinner } from "../components/ui";
import { CATEGORY_KEYS, CATEGORY_LABEL, categoryIcon, timeAgo } from "../lib/notifyFmt";
import { errorMessage } from "../lib/sfApi";
import { useSfAuth } from "../lib/SfAuth";

const EMPTY = { unread: false, category: "" };

function Row({ it, n }) {
  const unread = !it.readAt;
  return (
    <li className={`sf-nrow ${unread ? "unread" : ""}`} data-testid="notif-row" data-unread={unread ? "1" : "0"}>
      <button type="button" className="sf-nrow-main" onClick={() => n.open(it)}>
        <span className="sf-nic">
          <Ri name={categoryIcon(it.category)} />
        </span>
        <span className="sf-ntext">
          <span className="sf-ntitle">
            {it.title}
            {unread && <span className="visually-hidden"> (unread)</span>}
          </span>
          {it.body ? <span className="sf-nbody sf-nbody-full">{it.body}</span> : null}
          <span className="sf-ntime">
            {CATEGORY_LABEL[it.category] || "Update"} - {timeAgo(it.createdAt)}
          </span>
        </span>
        {unread && <span className="sf-ndot" aria-hidden="true" />}
      </button>
      <div className="sf-nrow-actions">
        {unread && (
          <button type="button" className="sf-iconbtn" aria-label={`Mark "${it.title}" as read`} title="Mark as read" onClick={() => n.markRead(it.id)} data-testid="notif-read">
            <Ri name="check-line" />
          </button>
        )}
        <button type="button" className="sf-iconbtn" aria-label={`Delete "${it.title}"`} title="Delete" onClick={() => n.remove(it.id)} data-testid="notif-delete">
          <Ri name="delete-bin-line" />
        </button>
      </div>
    </li>
  );
}

export default function Notifications() {
  const { user, loading: authLoading } = useSfAuth();
  const n = useNotifications();
  const { items = [], unread = 0, loaded, loading, hasMore, error, connected, filter, store } = n;

  // the store is shared with the header bell: start from the unfiltered list and give it back that way
  useEffect(() => {
    if (!user || !store) return undefined;
    const f = store.getSnapshot().filter;
    if (f.unread || f.category) store.setFilter(EMPTY);
    return () => {
      const cur = store.getSnapshot().filter;
      if (cur.unread || cur.category) store.setFilter(EMPTY);
    };
  }, [user, store]);

  if (authLoading) return <div className="sf-container"><Loading /></div>;
  if (!user) return <Navigate to="/order/login?next=/order/notifications" replace />;

  const tab = filter?.unread ? "unread" : "all";
  const category = filter?.category || "";
  // on the Unread tab a row leaves the list as soon as it is read
  const shown = tab === "unread" ? items.filter((i) => !i.readAt) : items;
  const first = !loaded && loading;
  const empty = loaded && !error && shown.length === 0;

  return (
    <div className="sf-container sf-narrow" data-testid="notifications-page">
      <div className="sf-row-between">
        <h1 className="sf-h1 mb-0">Notifications</h1>
        <button type="button" className="sf-btn sf-btn-light sf-btn-sm" onClick={n.markAllRead} disabled={!unread} data-testid="mark-all">
          <Ri name="check-double-line" /> Mark all read
        </button>
      </div>
      <p className="sf-small sf-muted mt-1">
        <span data-testid="notif-count">{unread > 0 ? `${unread} unread` : "You are all caught up"}</span> -{" "}
        {connected ? "updating live" : "refreshing every 30 seconds"} -{" "}
        <Link to="/order/account#notifications">Notification settings</Link>
      </p>

      <PushBanner />

      <div className="sf-tabs mt-2" role="tablist" aria-label="Show notifications">
        <button type="button" role="tab" aria-selected={tab === "all"} className={tab === "all" ? "on" : ""} onClick={() => n.setFilter({ unread: false })} data-testid="tab-all">
          All
        </button>
        <button type="button" role="tab" aria-selected={tab === "unread"} className={tab === "unread" ? "on" : ""} onClick={() => n.setFilter({ unread: true })} data-testid="tab-unread">
          Unread{unread > 0 ? ` (${unread})` : ""}
        </button>
      </div>
      <div className="sf-filters" role="group" aria-label="Category">
        <button type="button" className={`sf-chip ${category === "" ? "on" : ""}`} aria-pressed={category === ""} onClick={() => n.setFilter({ category: "" })}>
          Everything
        </button>
        {CATEGORY_KEYS.map((c) => (
          <button key={c} type="button" className={`sf-chip ${category === c ? "on" : ""}`} aria-pressed={category === c} onClick={() => n.setFilter({ category: category === c ? "" : c })} data-testid={`chip-${c}`}>
            <Ri name={categoryIcon(c)} /> {CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>

      {error && <ErrorBox message={errorMessage(error)} onRetry={n.refresh} />}
      {first && <Loading text="Loading your notifications..." />}
      {empty && (
        <div className="sf-center sf-muted py-5" data-testid="notif-empty">
          <Ri name="notification-off-line" className="sf-bigicon" />
          <p className="mt-2 mb-0">
            <b>{tab === "unread" || category ? "Nothing here" : "No notifications yet"}</b>
          </p>
          <p className="sf-small">
            {tab === "unread" ? "You have no unread notifications." : category ? "No notifications in this category." : "Updates about your orders and your account will show up here."}
          </p>
          {(tab === "unread" || category) && (
            <button type="button" className="sf-btn sf-btn-light sf-btn-sm" onClick={() => n.setFilter(EMPTY)}>
              Show everything
            </button>
          )}
        </div>
      )}
      {shown.length > 0 && (
        <ul className="sf-nrows" aria-busy={loading} data-testid="notif-list">
          {shown.map((it) => (
            <Row key={it.id} it={it} n={n} />
          ))}
        </ul>
      )}
      {hasMore && (
        <div className="sf-center mt-3">
          <button type="button" className="sf-btn sf-btn-light" disabled={loading} onClick={n.loadMore} data-testid="notif-more">
            {loading ? <Spinner size={16} /> : null} Show more
          </button>
        </div>
      )}
    </div>
  );
}

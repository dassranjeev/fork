import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import ThemeToggleButton from "../helper/ThemeToggleButton";
import { useAuth } from "../lib/auth";
import { disconnectSocket } from "../lib/socket";
import { fullName } from "../lib/format";
import { usePortal } from "../features/portal/context";
import { Avatar } from "../ui";
import NotifyRoot from "../features/notifications/NotifyRoot";
import NotificationBell from "../features/notifications/NotificationBell";
import PushBanner from "../features/notifications/PushBanner";
import AlarmBanner from "../features/notifications/AlarmBanner";

// the Accept / Reject popup for new orders (restaurant portal only): loaded on demand so the other surfaces do not carry it
const NewOrderPopup = React.lazy(() => import("../features/notifications/NewOrderPopup"));

/** Sidebar order of sections. Feature menus declare `section`; unknown sections go last. */
export const SECTION_ORDER = [
  "MAIN",
  "ADMIN & SUPER ADMIN",
  "RESTAURANTS",
  "DRIVERS",
  "CUSTOMERS",
  "OPERATIONS",
  "MARKETING & CONTENT",
  "FINANCE",
  "SUPPORT",
  "ASSISTANT",
  "SYSTEM",
  // restaurant portal
  "STORE",
  "MENU",
  "MONEY",
  "GROWTH",
  "ACCOUNT",
];

function useOutside(ref, handler) {
  useEffect(() => {
    const fn = (e) => ref.current && !ref.current.contains(e.target) && handler();
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [ref, handler]);
}

const MENU_CSS = `
.fk-menu-panel{z-index:1040;overflow:hidden;background:var(--bs-body-bg,#fff);color:var(--bs-body-color,inherit);border:1px solid var(--bs-border-color-translucent,rgba(0,0,0,.12));text-align:start}
.fk-menu-panel .dropdown-item{display:flex;width:100%;clear:both;font-weight:400;text-align:inherit;text-decoration:none;white-space:nowrap;background:transparent;border:0;cursor:pointer}
.fk-menu-panel .dropdown-item:focus-visible,.fk-menu-btn:focus-visible{outline:2px solid var(--primary-600,#f97316);outline-offset:2px}
`;

/**
 * Header menu (profile). Deliberately NOT Bootstrap's `dropdown-menu` class: Bootstrap's document-level keydown handler claims every
 * .dropdown-menu and throws on Tab / Escape when the menu was not opened by Bootstrap's own JS. Escape closes and gives the focus back to
 * the trigger, Tab out of the widget closes, items are real links / buttons; clicking an item closes it.
 */
function Dropdown({ trigger, children, width = 320, align = "end" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const btn = useRef(null);
  useOutside(ref, () => setOpen(false));
  const onKeyDown = (e) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
      if (btn.current) btn.current.focus();
    }
  };
  const onBlur = (e) => {
    // keyboard focus left the whole widget: close (focus stays where the user moved it)
    if (open && e.relatedTarget && ref.current && !ref.current.contains(e.relatedTarget)) setOpen(false);
  };
  const trig = React.cloneElement(trigger, {
    ref: btn,
    "aria-haspopup": "true",
    "aria-expanded": open,
    className: `${trigger.props.className || ""} fk-menu-btn`.trim(),
    onClick: () => setOpen((o) => !o),
  });
  return (
    <div className="position-relative" ref={ref} onKeyDown={onKeyDown} onBlur={onBlur}>
      <style>{MENU_CSS}</style>
      {trig}
      {open && (
        <div className="fk-menu-panel p-0 radius-12 shadow header-dropdown" style={{ position: "absolute", [align === "start" ? "left" : "right"]: 0, top: 48, width, maxWidth: "calc(100vw - 24px)" }} onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({ item, openKey, setOpenKey, pathname }) {
  const hasChildren = item.children?.length > 0;
  const isChildActive = hasChildren && item.children.some((c) => pathname === c.to || (c.to !== "/" && pathname.startsWith(c.to + "/")));
  const key = item.label;
  const open = openKey === key || (openKey === null && isChildActive);
  if (!hasChildren && item.href) {
    return (
      <li>
        <a href={item.href} target="_blank" rel="noopener noreferrer">
          <Icon icon={item.icon || "solar:record-circle-outline"} className="menu-icon" />
          <span>{item.label}</span>
          <Icon icon="solar:arrow-right-up-outline" className="ms-auto" />
        </a>
      </li>
    );
  }
  if (!hasChildren) {
    return (
      <li>
        <NavLink to={item.to} end={item.to === "/" || item.to === "/portal"} className={({ isActive }) => (isActive ? "active-page" : "")}>
          <Icon icon={item.icon || "solar:record-circle-outline"} className="menu-icon" />
          <span>{item.label}</span>
          {item.badge ? <span className="badge bg-danger-600 text-white ms-auto">{item.badge}</span> : null}
        </NavLink>
      </li>
    );
  }
  return (
    <li className={`dropdown ${open || isChildActive ? "open" : ""}`}>
      <a
        href="#!"
        onClick={(e) => {
          e.preventDefault();
          setOpenKey(open ? "" : key);
        }}
      >
        <Icon icon={item.icon || "solar:record-circle-outline"} className="menu-icon" />
        <span>{item.label}</span>
      </a>
      <ul className="sidebar-submenu" style={{ display: open || isChildActive ? "block" : "none" }}>
        {item.children.map((c) => (
          <li key={c.to}>
            <NavLink to={c.to} className={({ isActive }) => (isActive ? "active-page" : "")}>
              <i className="ri-circle-fill circle-icon text-primary-600 w-auto" style={{ fontSize: 8 }} /> {c.label}
              {c.badge ? <span className="badge bg-danger-600 text-white ms-auto">{c.badge}</span> : null}
            </NavLink>
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * Application shell: sidebar (permission-filtered) + top bar + <Outlet/>.
 * `menu` entries: { section, order, label, icon, to?, perm?: [module, action], roles?: RestaurantRole[], children?: [{label,to,perm?}] }
 */
/** The Admin Console and the Restaurant Portal share this shell; the notification machinery (bell, push, alarm) mounts around it. */
export default function AppShell(props) {
  return (
    <NotifyRoot portal={props.portal || "admin"}>
      <Shell {...props} />
    </NotifyRoot>
  );
}

function Shell({ menu, home = "/", portal = "admin", topbarLeft, extraNav }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [openKey, setOpenKey] = useState(null);
  const { user, can, isSuper, logout, restaurantRole, impersonating, impersonationInfo, exitImpersonation } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [quick, setQuick] = useState("");
  // a grocery-type store sees "Catalog" instead of "Menu" and no kitchen display (menu entries: retailLabel, hideForRetail)
  const portalCtx = usePortal();
  const retail = portal === "restaurant" && !!portalCtx.retail;

  useEffect(() => setMobile(false), [pathname]);
  useEffect(() => setOpenKey(null), [pathname]);

  const groups = useMemo(() => {
    const allowed = (it) => {
      if (it.superOnly && !isSuper) return false; // Super Admin only (for example System Health)
      if (it.roles && !it.roles.includes(restaurantRole)) return false;
      if (it.perm && !can(it.perm[0], it.perm[1] || "view")) return false;
      // anyPerm: [[module, action], ...] - visible when the staff member has at least one of them
      if (it.anyPerm && !it.anyPerm.some((p) => can(p[0], p[1] || "view"))) return false;
      return true;
    };
    const filtered = menu
      .map((it) => {
        if (!allowed(it)) return null;
        if (retail && it.hideForRetail) return null;
        if (retail && it.retailLabel) it = { ...it, label: it.retailLabel };
        if (it.children) {
          const children = it.children.filter(allowed);
          if (!children.length) return null;
          return { ...it, children };
        }
        return it;
      })
      .filter(Boolean);
    const bySection = {};
    filtered.forEach((it) => (bySection[it.section || "MAIN"] ||= []).push(it));
    Object.values(bySection).forEach((arr) => arr.sort((a, b) => (a.order ?? 50) - (b.order ?? 50)));
    return Object.keys(bySection)
      .sort((a, b) => (SECTION_ORDER.indexOf(a) + 1 || 99) - (SECTION_ORDER.indexOf(b) + 1 || 99))
      .map((s) => ({ section: s, items: bySection[s] }));
  }, [menu, can, isSuper, restaurantRole, retail]);

  const doLogout = async () => {
    disconnectSocket();
    await logout();
    // hard navigation (replace): drops all in-memory state and the authenticated history entry
    window.location.replace("/sign-in");
  };

  useEffect(() => {
    document.body.style.paddingTop = impersonating ? "44px" : "";
    return () => {
      document.body.style.paddingTop = "";
    };
  }, [impersonating]);

  return (
    <section className={mobile ? "overlay active" : "overlay"}>
      {impersonating && <style>{".sidebar{top:44px !important;height:calc(100vh - 44px) !important}"}</style>}
      {impersonating && (
        <div
          role="alert"
          data-impersonation-banner
          className="d-flex flex-wrap align-items-center justify-content-center gap-3 px-16 py-8 text-white fw-semibold"
          style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 2000, background: "#b45309", minHeight: 44 }}
        >
          <Icon icon="solar:eye-bold" className="text-xl" />
          <span>
            Viewing {impersonationInfo?.restaurantName || "restaurant"} as admin
            {impersonationInfo?.adminName ? ` (${impersonationInfo.adminName})` : ""} — actions are audited
          </span>
          <button type="button" className="btn btn-light btn-sm radius-8 px-12 py-4 fw-semibold" onClick={exitImpersonation}>
            Exit to admin console
          </button>
        </div>
      )}
      <aside className={collapsed ? "sidebar active" : mobile ? "sidebar sidebar-open" : "sidebar"}>
        <button onClick={() => setMobile(false)} type="button" className="sidebar-close-btn">
          <Icon icon="radix-icons:cross-2" />
        </button>
        <div>
          <Link to={home} className="sidebar-logo">
            <img src="/brand/logo-horizontal-orange.png" alt="FORKSY" className="light-logo" />
            <img src="/brand/logo-horizontal-orange.png" alt="FORKSY" className="dark-logo" />
            <img src="/brand/icon-96.png" alt="FORKSY" className="logo-icon" />
          </Link>
        </div>
        <div className="sidebar-menu-area">
          <ul className="sidebar-menu" id="sidebar-menu">
            {groups.map((g) => (
              <React.Fragment key={g.section}>
                {g.section !== "MAIN" && <li className="sidebar-menu-group-title">{g.section}</li>}
                {g.items.map((it) => (
                  <MenuItem key={it.label} item={it} openKey={openKey} setOpenKey={setOpenKey} pathname={pathname} />
                ))}
              </React.Fragment>
            ))}
            {extraNav}
          </ul>
        </div>
      </aside>

      <main className={collapsed ? "dashboard-main active" : "dashboard-main"}>
        <div className="navbar-header">
          <div className="row align-items-center justify-content-between">
            <div className="col-auto">
              <div className="d-flex flex-wrap align-items-center gap-4">
                <button type="button" className="sidebar-toggle" onClick={() => setCollapsed(!collapsed)}>
                  <Icon icon={collapsed ? "iconoir:arrow-right" : "heroicons:bars-3-solid"} className="icon text-2xl non-active" />
                </button>
                <button onClick={() => setMobile(!mobile)} type="button" className="sidebar-mobile-toggle">
                  <Icon icon="heroicons:bars-3-solid" className="icon" />
                </button>
                {portal === "admin" && (
                  <form
                    className="navbar-search"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (quick.trim()) navigate(`/orders?search=${encodeURIComponent(quick.trim())}`);
                    }}
                  >
                    <input type="text" name="search" placeholder="Find order by code, name, phone…" value={quick} onChange={(e) => setQuick(e.target.value)} />
                    <Icon icon="ion:search-outline" className="icon" />
                  </form>
                )}
                {topbarLeft}
              </div>
            </div>
            <div className="col-auto">
              <div className="d-flex flex-wrap align-items-center gap-3">
                <ThemeToggleButton />
                <NotificationBell portal={portal} />
                <Dropdown
                  width={260}
                  trigger={
                    <button type="button" className="d-flex justify-content-center align-items-center rounded-circle border-0 bg-transparent p-0">
                      <Avatar name={fullName(user)} src={user?.avatarUrl} size={40} />
                    </button>
                  }
                >
                  <div className="py-12 px-16 radius-8 bg-primary-50 m-2">
                    <h6 className="text-lg text-primary-light fw-semibold mb-2">{fullName(user)}</h6>
                    <span className="text-secondary-light fw-medium text-sm">{user?.roleName || (user?.restaurantRole ? user.restaurantRole.replace(/_/g, " ") : user?.type)}</span>
                  </div>
                  <ul className="to-top-list list-unstyled mb-0 p-2">
                    <li>
                      <Link className="dropdown-item text-black px-0 py-8 hover-bg-transparent hover-text-primary d-flex align-items-center gap-3" to={portal === "admin" ? "/account" : "/portal/account"}>
                        <Icon icon="solar:user-linear" className="icon text-xl" /> My Profile &amp; Security
                      </Link>
                    </li>
                    <li>
                      <Link className="dropdown-item text-black px-0 py-8 hover-bg-transparent hover-text-primary d-flex align-items-center gap-3" to={portal === "admin" ? "/notification-settings" : "/portal/notification-settings"}>
                        <Icon icon="solar:bell-outline" className="icon text-xl" /> Notification Settings
                      </Link>
                    </li>
                    <li>
                      <button className="dropdown-item text-black px-0 py-8 hover-bg-transparent hover-text-danger d-flex align-items-center gap-3 border-0 bg-transparent w-100" onClick={doLogout}>
                        <Icon icon="lucide:power" className="icon text-xl" /> Log Out
                      </button>
                    </li>
                  </ul>
                </Dropdown>
              </div>
            </div>
          </div>
        </div>

        {portal === "restaurant" && <AlarmBanner />}
        {portal === "restaurant" && (
          <React.Suspense fallback={null}>
            <NewOrderPopup />
          </React.Suspense>
        )}

        <div className="dashboard-main-body">
          <PushBanner portal={portal} />
          <React.Suspense fallback={<div className="p-5 text-center text-secondary-light">Loading…</div>}>
            <Outlet />
          </React.Suspense>
        </div>

        <footer className="d-footer">
          <div className="row align-items-center justify-content-between">
            <div className="col-auto">
              <p className="mb-0">© {new Date().getFullYear()} FORKSY. All rights reserved.</p>
            </div>
            <div className="col-auto">
              <p className="mb-0">Food delivery network · Ontario, Canada</p>
            </div>
          </div>
        </footer>
      </main>
    </section>
  );
}

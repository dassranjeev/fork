import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import ThemeToggleButton from "../helper/ThemeToggleButton";
import { useAuth } from "../lib/auth";
import { http } from "../lib/api";
import { disconnectSocket, getSocket, useSocketEvent } from "../lib/socket";
import { fullName, timeAgo } from "../lib/format";
import { Avatar } from "../ui";

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

function Dropdown({ trigger, children, width = 320, align = "end" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useOutside(ref, () => setOpen(false));
  return (
    <div className="position-relative" ref={ref}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div className={`dropdown-menu show p-0 radius-12 shadow`} style={{ position: "absolute", [align]: 0, top: 48, width, zIndex: 1040 }} onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

function NotificationBell() {
  const [items, setItems] = useState([]);
  const [count, setCount] = useState(0);
  const load = useCallback(async () => {
    try {
      const [list, unread] = await Promise.all([http.get("/notifications", { limit: 8 }), http.get("/notifications/unread-count")]);
      setItems(list.data || []);
      setCount(unread.count || 0);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    load();
    getSocket();
  }, [load]);
  useSocketEvent("notification", (n) => {
    setItems((prev) => [{ id: n.id, title: n.title, body: n.body, createdAt: n.at, readAt: null }, ...prev].slice(0, 8));
    setCount((c) => c + 1);
  });
  const readAll = async () => {
    await http.post("/notifications/read", {});
    setCount(0);
    setItems((p) => p.map((i) => ({ ...i, readAt: new Date().toISOString() })));
  };
  return (
    <Dropdown
      width={360}
      trigger={
        <button type="button" className="has-indicator w-40-px h-40-px bg-neutral-200 rounded-circle d-flex justify-content-center align-items-center position-relative">
          <Icon icon="iconoir:bell" className="text-primary-light text-xl" />
          {count > 0 && (
            <span className="position-absolute top-0 end-0 badge rounded-pill bg-danger-600 text-white" style={{ fontSize: 10 }}>
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      }
    >
      <div className="py-12 px-16 radius-8 bg-primary-50 d-flex align-items-center justify-content-between gap-2 m-2">
        <h6 className="text-lg text-primary-light fw-semibold mb-0">Notifications</h6>
        <button className="btn btn-link p-0 text-primary-600 text-sm" onClick={(e) => { e.stopPropagation(); readAll(); }}>
          Mark all read
        </button>
      </div>
      <div className="max-h-400-px overflow-y-auto scroll-sm">
        {items.length === 0 && <p className="text-center text-secondary-light py-24 mb-0">You're all caught up</p>}
        {items.map((n) => (
          <div key={n.id} className={`px-16 py-12 border-bottom ${n.readAt ? "" : "bg-primary-50"}`}>
            <div className="fw-semibold text-sm">{n.title}</div>
            <div className="text-secondary-light text-sm">{n.body}</div>
            <div className="text-secondary-light text-xs mt-1">{timeAgo(n.createdAt)}</div>
          </div>
        ))}
      </div>
    </Dropdown>
  );
}

function MenuItem({ item, openKey, setOpenKey, pathname }) {
  const hasChildren = item.children?.length > 0;
  const isChildActive = hasChildren && item.children.some((c) => pathname === c.to || (c.to !== "/" && pathname.startsWith(c.to + "/")));
  const key = item.label;
  const open = openKey === key || (openKey === null && isChildActive);
  if (!hasChildren) {
    return (
      <li>
        <NavLink to={item.to} end={item.to === "/" || item.to === "/portal"} className={({ isActive }) => (isActive ? "active-page" : "")}>
          <Icon icon={item.icon || "solar:circle-outline"} className="menu-icon" />
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
        <Icon icon={item.icon || "solar:circle-outline"} className="menu-icon" />
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
export default function AppShell({ menu, home = "/", portal = "admin", topbarLeft, extraNav }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [openKey, setOpenKey] = useState(null);
  const { user, can, logout, restaurantRole } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [quick, setQuick] = useState("");

  useEffect(() => setMobile(false), [pathname]);
  useEffect(() => setOpenKey(null), [pathname]);

  const groups = useMemo(() => {
    const allowed = (it) => {
      if (it.roles && !it.roles.includes(restaurantRole)) return false;
      if (it.perm && !can(it.perm[0], it.perm[1] || "view")) return false;
      return true;
    };
    const filtered = menu
      .map((it) => {
        if (!allowed(it)) return null;
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
  }, [menu, can, restaurantRole]);

  const doLogout = async () => {
    disconnectSocket();
    await logout();
    navigate("/sign-in");
  };

  return (
    <section className={mobile ? "overlay active" : "overlay"}>
      <aside className={collapsed ? "sidebar active" : mobile ? "sidebar sidebar-open" : "sidebar"}>
        <button onClick={() => setMobile(false)} type="button" className="sidebar-close-btn">
          <Icon icon="radix-icons:cross-2" />
        </button>
        <div>
          <Link to={home} className="sidebar-logo">
            <img src="/assets/images/forksy-logo.svg" alt="FORKSY" className="light-logo" />
            <img src="/assets/images/forksy-logo-light.svg" alt="FORKSY" className="dark-logo" />
            <img src="/assets/images/forksy-icon.svg" alt="FORKSY" className="logo-icon" />
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
                <NotificationBell />
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

        <div className="dashboard-main-body">
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

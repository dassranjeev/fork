import React, { Fragment, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ToastContainer } from "react-toastify";
import RouteScrollToTop from "./helper/RouteScrollToTop";
import { AuthProvider, RequireAuth, useAuth } from "./lib/auth";
import { ConfirmProvider } from "./ui";
import AppShell from "./layout/AppShell";
import { adminFeatures, portalFeatures } from "./features/registry";

const SignIn = lazy(() => import("./features/auth/SignIn"));
const ForgotPassword = lazy(() => import("./features/auth/ForgotPassword"));
const RestaurantApply = lazy(() => import("./features/auth/RestaurantApply"));
const Account = lazy(() => import("./features/auth/Account"));
// customer website: public layout at /order/*, its own session + cart (no admin sidebar, no admin auth)
const Storefront = lazy(() => import("./features/storefront/Storefront"));

function Forbidden() {
  return (
    <div className="text-center py-80">
      <h4 className="mb-8">Access denied</h4>
      <p className="text-secondary-light">Your role does not include permission for this page. Ask a Super Admin to update your role.</p>
    </div>
  );
}

function NotFound() {
  return (
    <div className="text-center py-80">
      <h4 className="mb-8">Page not found</h4>
      <p className="text-secondary-light">The page you are looking for does not exist.</p>
    </div>
  );
}

/** Wrap an element with a permission / restaurant-role check. */
function Guard({ perm, anyPerm, roles, children }) {
  const { can, restaurantRole } = useAuth();
  if (perm && !can(perm[0], perm[1] || "view")) return <Forbidden />;
  if (anyPerm && !anyPerm.some((p) => can(p[0], p[1] || "view"))) return <Forbidden />;
  if (roles && !roles.includes(restaurantRole)) return <Forbidden />;
  return children;
}

const toRoutes = (features) =>
  features
    .flatMap((f) => f.routes || [])
    .map((r) => <Route key={r.path || "index"} path={r.path?.replace(/^\//, "")} index={r.index} element={<Guard perm={r.perm} anyPerm={r.anyPerm} roles={r.roles}>{r.element}</Guard>} />);

const adminMenu = adminFeatures.flatMap((f) => f.menu || []);
const portalMenu = portalFeatures.flatMap((f) => f.menu || []);
const PortalProvider = portalFeatures.find((f) => f.Provider)?.Provider || Fragment;

function HomeRedirect() {
  const { isRestaurant } = useAuth();
  return isRestaurant ? <Navigate to="/portal" replace /> : null;
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ConfirmProvider>
          <RouteScrollToTop />
          <React.Suspense fallback={<div className="p-5 text-center text-secondary-light">Loading…</div>}>
            <Routes>
              <Route path="/sign-in" element={<SignIn />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/apply" element={<RestaurantApply />} />
              <Route path="/order/*" element={<Storefront />} />

              {/* Restaurant portal + KDS */}
              <Route
                path="/portal"
                element={
                  <RequireAuth type="restaurant">
                    <PortalProvider>
                      <AppShell menu={portalMenu} home="/portal" portal="restaurant" />
                    </PortalProvider>
                  </RequireAuth>
                }
              >
                {toRoutes(portalFeatures)}
                <Route path="account" element={<Account />} />
                <Route path="*" element={<NotFound />} />
              </Route>

              {/* Admin console (staff + super admin) */}
              <Route
                path="/"
                element={
                  <RequireAuth type="admin">
                    <AppShell menu={adminMenu} home="/" portal="admin" />
                  </RequireAuth>
                }
              >
                {toRoutes(adminFeatures)}
                <Route path="account" element={<Account />} />
                <Route path="*" element={<NotFound />} />
              </Route>
              <Route path="*" element={<HomeRedirect />} />
            </Routes>
          </React.Suspense>
          <ToastContainer position="top-right" autoClose={4000} newestOnTop pauseOnFocusLoss={false} />
        </ConfirmProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;

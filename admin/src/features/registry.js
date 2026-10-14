/**
 * Feature registry. Each feature folder exports from its index.js:
 *   routes: [{ path: 'orders', element: <Page/>, perm?: ['orders','view'], roles?: ['OWNER',...] }]   (paths relative to the shell root)
 *   menu:   [{ section, order, label, icon, to?, perm?, roles?, children?: [{ label, to, perm? }] }]
 * Admin features mount at "/", the restaurant portal mounts at "/portal".
 * Use React.lazy() for pages.
 */
import * as dashboard from "./dashboard";
import * as orders from "./orders";
import * as restaurants from "./restaurants";
import * as drivers from "./drivers";
import * as customers from "./customers";
import * as platform from "./platform";
import * as finance from "./finance";
import * as support from "./support";
import * as marketing from "./marketing";
import * as assistant from "./assistant";
import * as system from "./system";
import * as health from "./health";
import * as verification from "./verification";
import * as portal from "./portal";

export const adminFeatures = [dashboard, orders, restaurants, drivers, customers, platform, finance, support, marketing, assistant, system, health, verification];
export const portalFeatures = [portal];

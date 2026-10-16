import { Action, Module } from './enums';
import { PermissionMap } from '../database/entities/identity.entities';

const A = Action;
const M = Module;
const ALL = [A.VIEW, A.CREATE, A.EDIT, A.DELETE, A.APPROVE, A.EXPORT];
const RW = [A.VIEW, A.CREATE, A.EDIT];
const V = [A.VIEW];
const VE = [A.VIEW, A.EXPORT];

/** The staff roles from the spec (PDF section 3.1). Super Admin bypasses checks; listed here for the UI matrix. */
export interface DefaultRole {
  name: string;
  description: string;
  permissions: PermissionMap;
  refundLimit: number | null;
}

export const ALL_MODULES = Object.values(M);

export const DEFAULT_ROLES: DefaultRole[] = [
  {
    name: 'Operations Manager',
    description: 'City/zone performance. Zones, delivery fees, restaurant & driver approvals, live ops map.',
    refundLimit: 50,
    permissions: {
      [M.DASHBOARD]: V,
      [M.LIVE_MAP]: [A.VIEW, A.EDIT],
      [M.ORDERS]: [A.VIEW, A.EDIT, A.EXPORT],
      [M.RESTAURANTS]: [A.VIEW, A.EDIT, A.APPROVE, A.EXPORT],
      [M.DRIVERS]: [A.VIEW, A.EDIT, A.APPROVE, A.EXPORT],
      [M.CUSTOMERS]: V,
      [M.ZONES]: [A.VIEW, A.CREATE, A.EDIT, A.DELETE],
      [M.PRICING]: [A.VIEW, A.EDIT],
      [M.PROMOTIONS]: V,
      [M.SUPPORT]: V,
      [M.REPORTS]: VE,
      [M.NOTIFICATIONS]: [A.VIEW, A.CREATE],
      [M.OPERATIONS]: [A.VIEW, A.CREATE, A.EDIT],
    },
  },
  {
    name: 'Dispatcher',
    description: 'Live order flow. Live map, manual driver assignment, order status overrides.',
    refundLimit: 0,
    permissions: {
      [M.DASHBOARD]: V,
      [M.LIVE_MAP]: [A.VIEW, A.EDIT],
      [M.ORDERS]: [A.VIEW, A.EDIT],
      [M.RESTAURANTS]: V,
      [M.DRIVERS]: V,
      [M.SUPPORT]: V,
      [M.OPERATIONS]: [A.VIEW, A.EDIT],
    },
  },
  {
    name: 'Customer Support Agent',
    description: 'Customer tickets. View orders, refunds up to the set limit, credits, chat/call customers.',
    refundLimit: 50,
    permissions: {
      [M.DASHBOARD]: V,
      [M.ORDERS]: [A.VIEW, A.EDIT],
      [M.CUSTOMERS]: [A.VIEW, A.EDIT],
      [M.RESTAURANTS]: V,
      [M.DRIVERS]: V,
      [M.SUPPORT]: [A.VIEW, A.CREATE, A.EDIT],
      [M.FINANCE]: [], // refunds are gated by refundLimit, not finance module
    },
  },
  {
    name: 'Support Supervisor',
    description: 'Tier 2: refunds above the agent limit, fraud, disputes, account bans.',
    refundLimit: 250,
    permissions: {
      [M.DASHBOARD]: V,
      [M.ORDERS]: [A.VIEW, A.EDIT, A.APPROVE],
      [M.CUSTOMERS]: [A.VIEW, A.EDIT, A.APPROVE],
      [M.RESTAURANTS]: V,
      [M.DRIVERS]: V,
      [M.SUPPORT]: [A.VIEW, A.CREATE, A.EDIT, A.APPROVE, A.EXPORT],
      [M.REPORTS]: VE,
    },
  },
  {
    name: 'Restaurant Success Manager',
    description: 'Merchant onboarding & health. Onboarding, menu review, merchant tickets, promo setup.',
    refundLimit: 0,
    permissions: {
      [M.DASHBOARD]: V,
      [M.ORDERS]: V,
      [M.RESTAURANTS]: [A.VIEW, A.CREATE, A.EDIT, A.APPROVE, A.EXPORT],
      [M.PROMOTIONS]: RW,
      [M.SUPPORT]: [A.VIEW, A.CREATE, A.EDIT],
      [M.CONTENT]: V,
      [M.REPORTS]: VE,
      [M.ZONES]: V,
    },
  },
  {
    name: 'Driver Operations',
    description: 'Driver fleet. Onboarding, document checks, deactivation, incentives.',
    refundLimit: 0,
    permissions: {
      [M.DASHBOARD]: V,
      [M.ORDERS]: V,
      [M.DRIVERS]: [A.VIEW, A.CREATE, A.EDIT, A.DELETE, A.APPROVE, A.EXPORT],
      [M.ZONES]: V,
      [M.SUPPORT]: V,
      [M.NOTIFICATIONS]: [A.VIEW, A.CREATE],
      [M.OPERATIONS]: RW,
      [M.REPORTS]: VE,
      [M.LIVE_MAP]: V,
    },
  },
  {
    name: 'Finance Manager',
    description: 'Money in and out. Settlements, payouts, refunds above limit, invoices, tax reports.',
    refundLimit: null,
    permissions: {
      [M.DASHBOARD]: V,
      [M.ORDERS]: VE,
      [M.FINANCE]: ALL,
      [M.RESTAURANTS]: V,
      [M.DRIVERS]: V,
      [M.REPORTS]: [A.VIEW, A.EXPORT, A.CREATE],
      [M.AUDIT]: V,
      [M.PRICING]: V,
    },
  },
  {
    name: 'Marketing Manager',
    description: 'Growth. Promo codes, banners, push campaigns, loyalty rules.',
    refundLimit: 0,
    permissions: {
      [M.DASHBOARD]: V,
      [M.PROMOTIONS]: ALL,
      [M.CONTENT]: ALL,
      [M.SITE]: [A.VIEW, A.EDIT],
      [M.NOTIFICATIONS]: ALL,
      [M.CUSTOMERS]: V,
      [M.RESTAURANTS]: V,
      [M.REPORTS]: VE,
    },
  },
  {
    name: 'Analyst (read-only)',
    description: 'Reporting. All dashboards and exports; no write actions.',
    refundLimit: 0,
    permissions: Object.fromEntries(
      ALL_MODULES.filter((m) => ![M.STAFF, M.ROLES, M.AUDIT, M.SETTINGS].includes(m)).map((m) => [m, VE]),
    ),
  },
];

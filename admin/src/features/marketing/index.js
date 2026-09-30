import React from "react";

const Promotions = React.lazy(() => import("./Promotions"));
const GiftCards = React.lazy(() => import("./GiftCards"));
const Campaigns = React.lazy(() => import("./Campaigns"));
const Referrals = React.lazy(() => import("./Referrals"));
const Templates = React.lazy(() => import("./Templates"));
const Banners = React.lazy(() => import("./Content").then((m) => ({ default: m.Banners })));
const CmsPages = React.lazy(() => import("./Content").then((m) => ({ default: m.CmsPages })));
const Faqs = React.lazy(() => import("./Content").then((m) => ({ default: m.Faqs })));

export const routes = [
  { path: "promotions", element: <Promotions />, perm: ["promotions", "view"] },
  { path: "gift-cards", element: <GiftCards />, perm: ["promotions", "view"] },
  { path: "referrals", element: <Referrals />, perm: ["promotions", "view"] },
  { path: "campaigns", element: <Campaigns />, perm: ["notifications", "view"] },
  { path: "notification-templates", element: <Templates />, perm: ["content", "view"] },
  { path: "banners", element: <Banners />, perm: ["content", "view"] },
  { path: "cms-pages", element: <CmsPages />, perm: ["content", "view"] },
  { path: "faqs", element: <Faqs />, perm: ["content", "view"] },
];

const S = "MARKETING & CONTENT";
export const menu = [
  { section: S, order: 10, label: "Promotions", icon: "solar:ticket-sale-outline", to: "/promotions", perm: ["promotions", "view"] },
  { section: S, order: 11, label: "Gift Cards", icon: "solar:gift-outline", to: "/gift-cards", perm: ["promotions", "view"] },
  { section: S, order: 12, label: "Referrals", icon: "solar:users-group-two-rounded-outline", to: "/referrals", perm: ["promotions", "view"] },
  { section: S, order: 13, label: "Campaigns", icon: "solar:letter-outline", to: "/campaigns", perm: ["notifications", "view"] },
  { section: S, order: 14, label: "Notification Templates", icon: "solar:chat-square-like-outline", to: "/notification-templates", perm: ["content", "view"] },
  { section: S, order: 15, label: "Banners", icon: "solar:gallery-wide-outline", to: "/banners", perm: ["content", "view"] },
  {
    section: S,
    order: 16,
    label: "Content",
    icon: "solar:document-text-outline",
    perm: ["content", "view"],
    children: [
      { label: "CMS Pages", to: "/cms-pages", perm: ["content", "view"] },
      { label: "FAQs", to: "/faqs", perm: ["content", "view"] },
    ],
  },
];

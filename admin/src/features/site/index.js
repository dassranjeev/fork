import React from "react";

const Overview = React.lazy(() => import("./Overview"));
const SectionPage = React.lazy(() => import("./SectionPage"));

/** Website settings (docs/site-settings.md): the General settings of the customer website, backed by /api/v1/admin/site/*. */
export const routes = [
  { path: "site", element: <Overview />, perm: ["site", "view"] },
  { path: "site/:section", element: <SectionPage />, perm: ["site", "view"] },
];

const S = "MARKETING & CONTENT";
export const menu = [
  {
    section: S,
    order: 17,
    label: "Website settings",
    icon: "solar:global-outline",
    perm: ["site", "view"],
    children: [
      { label: "Overview & health", to: "/site", perm: ["site", "view"] },
      { label: "General", to: "/site/general", perm: ["site", "view"] },
      { label: "Logo & icons", to: "/site/branding", perm: ["site", "view"] },
      { label: "Title, SEO & meta", to: "/site/seo", perm: ["site", "view"] },
      { label: "GEO", to: "/site/geo", perm: ["site", "view"] },
      { label: "AEO (answers)", to: "/site/aeo", perm: ["site", "view"] },
      { label: "AIO (AI search)", to: "/site/aio", perm: ["site", "view"] },
      { label: "Footer", to: "/site/footer", perm: ["site", "view"] },
      { label: "Analytics", to: "/site/integrations", perm: ["site", "view"] },
      { label: "Custom CSS / JS", to: "/site/scripts", perm: ["site", "view"] },
    ],
  },
];

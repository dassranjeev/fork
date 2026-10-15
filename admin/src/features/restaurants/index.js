import React from "react";

const RestaurantList = React.lazy(() => import("./RestaurantList"));
const RestaurantDetail = React.lazy(() => import("./RestaurantDetail"));
const RestaurantCreate = React.lazy(() => import("./RestaurantCreate"));
const Onboarding = React.lazy(() => import("./Onboarding"));
const PanelLauncher = React.lazy(() => import("./PanelLauncher"));
const Merchants = React.lazy(() => import("./Merchants"));
const ReviewsModeration = React.lazy(() => import("./ReviewsModeration"));

export const routes = [
  { path: "restaurants", element: <RestaurantList />, perm: ["restaurants", "view"] },
  { path: "restaurants/new", element: <RestaurantCreate />, perm: ["restaurants", "create"] },
  { path: "restaurants/onboarding", element: <Onboarding />, perm: ["restaurants", "view"] },
  { path: "restaurants/merchants", element: <Merchants />, perm: ["restaurants", "view"] },
  { path: "restaurants/reviews", element: <ReviewsModeration />, perm: ["restaurants", "view"] },
  { path: "restaurants/panels", element: <PanelLauncher />, perm: ["restaurants", "edit"] },
  { path: "restaurants/:id", element: <RestaurantDetail />, perm: ["restaurants", "view"] },
];

export const menu = [
  {
    section: "BUSINESSES",
    order: 10,
    label: "Businesses",
    icon: "solar:shop-2-outline",
    perm: ["restaurants", "view"],
    children: [
      { label: "All Businesses", to: "/restaurants" },
      { label: "Onboarding Pipeline", to: "/restaurants/onboarding" },
      { label: "Merchants", to: "/restaurants/merchants" },
      { label: "Reviews", to: "/restaurants/reviews" },
      { label: "Open a business panel", to: "/restaurants/panels", perm: ["restaurants", "edit"] },
      { label: "Add Business", to: "/restaurants/new", perm: ["restaurants", "create"] },
    ],
  },
];

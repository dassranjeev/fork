import React from "react";

const RestaurantList = React.lazy(() => import("./RestaurantList"));
const RestaurantDetail = React.lazy(() => import("./RestaurantDetail"));
const RestaurantCreate = React.lazy(() => import("./RestaurantCreate"));
const Onboarding = React.lazy(() => import("./Onboarding"));
const Merchants = React.lazy(() => import("./Merchants"));
const ReviewsModeration = React.lazy(() => import("./ReviewsModeration"));

export const routes = [
  { path: "restaurants", element: <RestaurantList />, perm: ["restaurants", "view"] },
  { path: "restaurants/new", element: <RestaurantCreate />, perm: ["restaurants", "create"] },
  { path: "restaurants/onboarding", element: <Onboarding />, perm: ["restaurants", "view"] },
  { path: "restaurants/merchants", element: <Merchants />, perm: ["restaurants", "view"] },
  { path: "restaurants/reviews", element: <ReviewsModeration />, perm: ["restaurants", "view"] },
  { path: "restaurants/:id", element: <RestaurantDetail />, perm: ["restaurants", "view"] },
];

export const menu = [
  {
    section: "RESTAURANTS",
    order: 10,
    label: "Restaurants",
    icon: "solar:shop-2-outline",
    perm: ["restaurants", "view"],
    children: [
      { label: "All Restaurants", to: "/restaurants" },
      { label: "Onboarding Pipeline", to: "/restaurants/onboarding" },
      { label: "Merchants", to: "/restaurants/merchants" },
      { label: "Reviews", to: "/restaurants/reviews" },
      { label: "Add Restaurant", to: "/restaurants/new", perm: ["restaurants", "create"] },
    ],
  },
];

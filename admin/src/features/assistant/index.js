import React from "react";

const Overview = React.lazy(() => import("./Overview"));
const Restaurants = React.lazy(() => import("./Restaurants"));
const Editor = React.lazy(() => import("./Editor"));
const Central = React.lazy(() => import("./Central"));
const TrainingOverview = React.lazy(() => import("./AdminTraining").then((m) => ({ default: m.AdminTrainingOverview })));
const TrainingRestaurants = React.lazy(() => import("./AdminTraining").then((m) => ({ default: m.AdminTrainingRestaurants })));
const TrainingEditor = React.lazy(() => import("./AdminTraining").then((m) => ({ default: m.AdminTrainingEditor })));
const TrainingCentral = React.lazy(() => import("./AdminTraining").then((m) => ({ default: m.AdminTrainingCentral })));

/**
 * Admin Console > Assistant. To add a page: create the component, add a route + a child entry below with the
 * permission it needs. Staff see the group when they have restaurants:view OR settings:view.
 */
const ANY = [["restaurants", "view"], ["settings", "view"]];

export const routes = [
  { path: "assistant", element: <Overview />, anyPerm: ANY },
  { path: "assistant/restaurants", element: <Restaurants />, perm: ["restaurants", "view"] },
  { path: "assistant/restaurants/:id", element: <Editor />, perm: ["restaurants", "view"] },
  { path: "assistant/central", element: <Central />, perm: ["settings", "view"] },
  { path: "assistant/training", element: <TrainingOverview />, perm: ["restaurants", "view"] },
  { path: "assistant/training/restaurants", element: <TrainingRestaurants />, perm: ["restaurants", "view"] },
  { path: "assistant/training/restaurants/:id", element: <TrainingEditor />, perm: ["restaurants", "view"] },
  { path: "assistant/training/central", element: <TrainingCentral />, perm: ["settings", "view"] },
];

export const menu = [
  {
    section: "ASSISTANT",
    order: 10,
    label: "Assistant",
    icon: "solar:chat-round-dots-outline",
    anyPerm: ANY,
    children: [
      { label: "Overview", to: "/assistant", anyPerm: ANY },
      { label: "Restaurant bots", to: "/assistant/restaurants", perm: ["restaurants", "view"] },
      { label: "Central bot (FORKY site)", to: "/assistant/central", perm: ["settings", "view"] },
      { label: "Training", to: "/assistant/training", perm: ["restaurants", "view"] },
      { label: "Training coverage", to: "/assistant/training/restaurants", perm: ["restaurants", "view"] },
      { label: "Central bot training", to: "/assistant/training/central", perm: ["settings", "view"] },
    ],
  },
];

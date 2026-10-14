import React, { useCallback, useEffect, useState } from "react";
import { Badge, ErrorState, Loading, Tabs } from "../../../ui";
import Aliases from "./Aliases";
import Bench from "./Bench";
import Documents from "./Documents";
import Knowledge from "./Knowledge";
import Overview from "./Overview";
import Review from "./Review";
import Unanswered from "./Unanswered";
import Versions from "./Versions";
import { problem, useTrainingApi } from "./kit";

/**
 * The bot training area: Overview, Knowledge, Nicknames & synonyms, Documents, Unanswered inbox, Test bench, Versions & publish.
 * Used by the restaurant portal, the admin editor of any restaurant and the admin editor of the central (FORKY website) bot.
 *   base   "/restaurant/assistant/training" | "/admin/assistant/training/restaurants/<id>" | "/admin/assistant/training/central"
 *   params { restaurantId } for portal accounts with several locations
 */
export default function TrainingArea({ base, params, canEdit, staff = false, central = false }) {
  const api = useTrainingApi(base, params);
  const [ov, setOv] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("overview");
  const [preset, setPreset] = useState(null);

  const reload = useCallback(() => {
    api.get("/overview").then((d) => { setOv(d); setError(null); }).catch((e) => setError(problem(e)));
  }, [api]);
  useEffect(() => {
    setOv(null);
    reload();
  }, [reload]);

  if (error && !ov) return <ErrorState error={{ message: error.message }} onRetry={reload} />;
  if (!ov) return <Loading />;

  const teach = (p) => {
    setPreset(p);
    setTab("knowledge");
  };

  const tabs = [
    { key: "overview", label: "Overview", badge: ov.dirty ? "•" : undefined, content: <Overview api={api} ov={ov} canEdit={canEdit} reload={reload} goTo={setTab} teach={teach} /> },
    { key: "knowledge", label: "Knowledge", content: <Knowledge api={api} canEdit={canEdit} onChanged={reload} preset={preset} onPresetUsed={() => setPreset(null)} /> },
    { key: "aliases", label: central ? "Synonyms" : "Nicknames & synonyms", content: <Aliases api={api} canEdit={canEdit} onChanged={reload} central={central} /> },
    { key: "documents", label: "Documents", content: <Documents api={api} canEdit={canEdit} onChanged={reload} /> },
    {
      key: "unanswered",
      label: "Unanswered inbox",
      badge: ov.unanswered.groups + ov.needsReview || undefined,
      content: (
        <>
          <Unanswered api={api} canEdit={canEdit} onChanged={reload} />
          <Review api={api} canEdit={canEdit} onChanged={reload} />
        </>
      ),
    },
    { key: "bench", label: "Test bench", content: <Bench api={api} canEdit={canEdit} /> },
    { key: "versions", label: "Versions & publish", badge: ov.pendingRequest ? "1" : undefined, content: <Versions api={api} canEdit={canEdit} staff={staff} onChanged={reload} /> },
  ];

  return (
    <div data-testid="training-area">
      <div className="d-flex flex-wrap gap-2 align-items-center mb-16">
        <Badge tone="primary">Live: v{ov.liveVersion}</Badge>
        {ov.dirty ? <Badge tone="warning">Unpublished changes</Badge> : <Badge tone="success">Draft = live</Badge>}
        {ov.requireApproval && !staff && <Badge tone="info">Publishing needs FORKY approval</Badge>}
        {!canEdit && <span className="text-secondary-light text-sm">You can look, but only an owner or location manager can train the assistant.</span>}
      </div>
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
    </div>
  );
}

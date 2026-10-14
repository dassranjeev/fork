import React from "react";
import { Icon } from "@iconify/react/offline";
import { Card, StatusBadge } from "../../ui";
import { http } from "../../lib/api";
import { fmtDate } from "../../lib/format";
import { safeUrl } from "../../lib/safe";
import { Async, useAction, useApi, usePortalFetch } from "./shared";

const LABEL = {
  BUSINESS_LICENCE: "Business licence",
  HEALTH_CERTIFICATE: "Health certificate",
  VOID_CHEQUE: "Void cheque or bank letter",
  HST_CERTIFICATE: "HST certificate",
  AGREEMENT: "Signed agreement",
  MENU: "Menu",
  PHOTOS: "Photos",
  OTHER: "Other document",
};
const label = (type) => LABEL[type] || String(type || "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

const STATE = {
  MISSING: { text: "Not uploaded yet", tone: "neutral", icon: "solar:document-add-outline" },
  PENDING: { text: "Waiting for review", tone: "info", icon: "solar:hourglass-outline" },
  APPROVED: { text: "Approved", tone: "success", icon: "solar:check-circle-bold" },
  REJECTED: { text: "Rejected", tone: "danger", icon: "solar:close-circle-outline" },
  EXPIRED: { text: "Expired", tone: "danger", icon: "solar:calendar-mark-outline" },
};

/** A file picker styled as a button. The picked file is handed to `onPick` and the input is cleared so the same file can be chosen again. */
function UploadButton({ busy, primary, children, onPick }) {
  return (
    <label className={`btn btn-sm radius-8 mb-0 d-inline-flex align-items-center gap-2 ${primary ? "btn-primary-600" : "btn-outline-primary-600"} ${busy ? "disabled" : ""}`}>
      <Icon icon="solar:upload-outline" /> {busy ? "Uploading…" : children}
      <input
        type="file"
        hidden
        disabled={busy}
        accept="application/pdf,image/png,image/jpeg,image/webp,image/gif"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onPick(file);
        }}
      />
    </label>
  );
}

/**
 * Business documents (portal > Store settings > Documents). The owner or manager uploads each required document here; FORKSY staff review and
 * approve them. Manual verification of a business, and the manual "Force verification", depend on these documents being approved.
 *   GET /restaurant/store/documents/checklist   the required documents with the state of the latest upload of each
 *   GET /restaurant/store/documents             every file uploaded so far
 *   POST /uploads, then POST /restaurant/store/documents { type, fileUrl, fileName }
 */
export default function DocumentsTab() {
  const api = useApi();
  const checklist = usePortalFetch("/restaurant/store/documents/checklist");
  const files = usePortalFetch("/restaurant/store/documents");
  const { busy, run } = useAction();

  const upload = async (type, file) => {
    const r = await run(
      type,
      async () => {
        const saved = await http.upload(file);
        return api.post("/restaurant/store/documents", { type, fileUrl: saved.url, fileName: saved.originalName || file.name });
      },
      `${label(type)} uploaded. Our team will review it.`,
    );
    if (r.ok) {
      checklist.reload();
      files.reload();
    }
  };

  return (
    <>
      <Card className="mb-24" title="Required documents" subtitle="Upload a clear photo or PDF of each document. Our team reviews them and tells you if anything has to be uploaded again.">
        <Async state={checklist}>
          {(c) => (
            <>
              <p className="text-secondary-light text-sm mb-16" data-testid="documents-summary">
                {c.allApproved ? "All required documents are approved." : `${c.approved} of ${c.total} required documents approved.`}
              </p>
              <ul className="list-unstyled mb-0 d-flex flex-column gap-3" data-testid="documents-checklist">
                {c.items.map((i) => {
                  const st = STATE[i.status] || STATE.MISSING;
                  return (
                    <li key={i.type} className="border radius-8 p-12 d-flex flex-wrap align-items-center justify-content-between gap-3">
                      <div className="d-flex align-items-start gap-3">
                        <Icon icon={st.icon} className="text-2xl mt-1 flex-shrink-0 text-secondary-light" />
                        <div>
                          <div className="fw-semibold">{label(i.type)}</div>
                          <div className="d-flex flex-wrap align-items-center gap-2 mt-4">
                            <StatusBadge status={st.text} label={st.text} tone={st.tone} />
                            {i.status === "APPROVED" && i.expiresAt && <span className="text-secondary-light text-xs">valid until {fmtDate(i.expiresAt)}</span>}
                          </div>
                          {i.status === "REJECTED" && i.rejectReason && <div className="text-danger-600 text-sm mt-4">Why: {i.rejectReason}</div>}
                        </div>
                      </div>
                      <UploadButton busy={busy === i.type} primary={i.status === "MISSING" || i.status === "REJECTED" || i.status === "EXPIRED"} onPick={(f) => upload(i.type, f)}>
                        {i.status === "MISSING" ? "Upload" : "Upload a new copy"}
                      </UploadButton>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Async>
      </Card>

      <Card title="Everything you uploaded" subtitle="Newest first.">
        <Async state={files} empty={(rows) => !(Array.isArray(rows) ? rows : rows?.data || []).length} emptyProps={{ icon: "solar:document-add-outline", title: "Nothing uploaded yet", text: "Your uploads appear here once you add a document above." }}>
          {(rows) => (
            <ul className="list-unstyled mb-0" data-testid="documents-history">
              {(Array.isArray(rows) ? rows : rows?.data || []).map((d) => (
                <li key={d.id} className="d-flex flex-wrap justify-content-between align-items-center gap-2 py-8 border-bottom">
                  <span>
                    <span className="fw-medium">{label(d.type)}</span>
                    <span className="text-secondary-light text-xs ms-2">{d.createdAt ? fmtDate(d.createdAt) : ""}</span>
                    {d.fileUrl && (
                      <a href={safeUrl(d.fileUrl)} target="_blank" rel="noopener noreferrer" className="text-primary-600 text-sm ms-3">
                        View file
                      </a>
                    )}
                  </span>
                  <StatusBadge status={(STATE[d.status] || STATE.PENDING).text} label={(STATE[d.status] || STATE.PENDING).text} tone={(STATE[d.status] || STATE.PENDING).tone} />
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Card>
    </>
  );
}

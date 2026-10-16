import React, { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Button, EmptyState, ErrorState, Loading, Modal, useConfirm } from "../../ui";
import { http } from "../../lib/api";
import { fmtWhen, messageOf } from "./shared";

/** The saved versions of a section (the newest 50 are kept): look at one, put it back. */
export function HistoryModal({ open, section, canRestore, onClose, onRestored }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    setRows(null);
    setError(null);
    setView(null);
    try {
      setRows(await http.get(`/admin/site/${section}/revisions`, { limit: 30 }));
    } catch (e) {
      setError(messageOf(e));
    }
  }, [section]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const show = async (v) => {
    setBusy(`view-${v}`);
    try {
      setView(await http.get(`/admin/site/${section}/revisions/${v}`));
    } catch (e) {
      toast.error(messageOf(e));
    } finally {
      setBusy(null);
    }
  };
  const restore = async (v) => {
    const c = await confirm({ title: `Put version ${v} back?`, message: "It is saved as a new version; the current values stay in the history.", confirmText: "Restore" });
    if (!c.confirmed) return;
    setBusy(`restore-${v}`);
    try {
      await http.post(`/admin/site/${section}/revisions/${v}/restore`);
      toast.success(`Version ${v} is back`);
      onRestored();
    } catch (e) {
      toast.error(messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="History" size="lg" footer={<Button variant="light" onClick={onClose}>Close</Button>}>
      {error && <ErrorState error={error} onRetry={load} />}
      {!rows && !error && <Loading />}
      {rows && rows.length === 0 && <EmptyState icon="solar:history-outline" title="Nothing saved yet" text="Every save of this page is kept here." />}
      {rows && rows.length > 0 && (
        <div className="table-responsive" data-testid="history">
          <table className="table align-middle mb-0">
            <thead><tr><th>Version</th><th>When</th><th>Who</th><th>What</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.version}>
                  <td className="fw-semibold">{r.version}</td>
                  <td>{fmtWhen(r.createdAt)}</td>
                  <td>{r.createdByName || "-"}</td>
                  <td>{r.note || "saved"}</td>
                  <td className="text-end text-nowrap">
                    <Button variant="light" loading={busy === `view-${r.version}`} onClick={() => show(r.version)}>View</Button>{" "}
                    {canRestore && <Button variant="outline" loading={busy === `restore-${r.version}`} onClick={() => restore(r.version)} data-testid={`restore-${r.version}`}>Restore</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view && (
        <div className="mt-16">
          <div className="fw-semibold mb-8">Version {view.version}</div>
          <pre className="bg-neutral-100 radius-8 p-12 text-xs" style={{ maxHeight: 320, overflow: "auto" }}>{JSON.stringify(view.value, null, 2)}</pre>
        </div>
      )}
    </Modal>
  );
}

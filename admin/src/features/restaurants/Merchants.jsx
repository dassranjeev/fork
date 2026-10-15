import React, { useState } from "react";
import { Link } from "react-router-dom";
import { http } from "../../lib/api";
import { useFetch, useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDate } from "../../lib/format";
import { BoolBadge, Button, Card, DataTable, FilterSelect, FormModal, FormRow, ListToolbar, Modal, PageHeader, StatusBadge, TextInput, Loading } from "../../ui";
import { STATUS_OPTIONS, VerificationCell } from "../verification/shared";

const EMPTY = { businessName: "", legalName: "", hstNumber: "", contactEmail: "", contactPhone: "" };

function MerchantDetail({ id, onClose }) {
  const { data, loading, error } = useFetch(id ? `/admin/restaurants/merchants/${id}` : null);
  return (
    <Modal open={!!id} onClose={onClose} title={data?.businessName || "Merchant"} size="lg">
      {loading ? (
        <Loading />
      ) : error ? (
        <div className="text-danger-600">{error}</div>
      ) : data ? (
        <>
          <div className="row gy-3 mb-24">
            {[
              ["Legal name", data.legalName],
              ["HST number", data.hstNumber],
              ["Contact email", data.contactEmail],
              ["Contact phone", data.contactPhone],
              ["Agreement signed", data.agreementSignedAt ? `${fmtDate(data.agreementSignedAt)} by ${data.agreementSignedBy || "—"}` : "Not signed"],
              ["Bank", data.bank?.accountLast4 ? `•••• ${data.bank.accountLast4} ${data.bank.verified ? "(verified)" : "(unverified)"}` : "—"],
              ["Payout hold", data.payoutHold ? data.payoutHoldReason || "On hold" : "No"],
            ].map(([l, v]) => (
              <div className="col-md-6" key={l}>
                <div className="text-secondary-light text-sm">{l}</div>
                <div className="fw-medium">{v || "—"}</div>
              </div>
            ))}
          </div>
          <h6 className="text-md fw-semibold">Locations</h6>
          {(data.locations || []).length === 0 ? (
            <div className="text-secondary-light">No locations yet.</div>
          ) : (
            <ul className="list-unstyled mb-0">
              {data.locations.map((l) => (
                <li key={l.id} className="d-flex justify-content-between align-items-center py-8 border-bottom">
                  <Link to={`/restaurants/${l.id}`}>
                    {l.name} <span className="text-secondary-light text-sm">· {l.city}</span>
                  </Link>
                  <StatusBadge status={l.status} />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </Modal>
  );
}

export default function Merchants() {
  const { can } = useAuth();
  const list = usePagedList("/admin/restaurants/merchants", { filters: { verification: "" } });
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState(null);
  const form = useForm(EMPTY);
  const { busy, run } = useSubmit();

  const save = () => {
    const body = Object.fromEntries(Object.entries(form.values).filter(([, v]) => v !== ""));
    run(() => http.post("/admin/restaurants/merchants", body), {
      success: "Merchant created",
      onDone: () => {
        setOpen(false);
        form.reset(EMPTY);
        list.reload();
      },
    });
  };

  const columns = [
    { key: "businessName", title: "Business", render: (m) => <span className="fw-semibold">{m.businessName}</span> },
    { key: "hstNumber", title: "HST #" },
    { key: "contactEmail", title: "Contact", render: (m) => (<div>{m.contactEmail || "—"}<div className="text-secondary-light text-xs">{m.contactPhone}</div></div>) },
    { key: "verificationStatus", title: "Verification", render: (m) => <VerificationCell status={m.verificationStatus} dueAt={m.verificationDueAt} /> },
    { key: "agreement", title: "Agreement", render: (m) => <BoolBadge value={!!m.agreementSignedAt} yes="Signed" no="Unsigned" /> },
    { key: "bank", title: "Bank verified", render: (m) => <BoolBadge value={!!m.bank?.verified} /> },
    { key: "payoutHold", title: "Payout hold", render: (m) => (m.payoutHold ? <StatusBadge status="ON_HOLD" /> : "—") },
    { key: "createdAt", title: "Created", render: (m) => fmtDate(m.createdAt) },
  ];

  return (
    <>
      <PageHeader title="Merchants" subtitle="Legal entities that own one or more businesses (restaurants, cafes, bakeries and stores)" crumbs={[{ label: "Businesses", to: "/restaurants" }, { label: "Merchants" }]} />
      <Card>
        <ListToolbar
          list={list}
          placeholder="Search merchants…"
          filters={<FilterSelect value={list.filters.verification} onChange={(v) => list.setFilter("verification", v)} options={STATUS_OPTIONS} placeholder="Verification: any" />}
          actions={can("restaurants", "create") && <Button onClick={() => setOpen(true)}>+ New merchant</Button>}
        />
        <DataTable columns={columns} {...list.tableProps} error={list.error} onRetry={list.reload} onRowClick={(m) => setViewing(m.id)} emptyTitle="No merchants found" />
      </Card>
      <MerchantDetail id={viewing} onClose={() => setViewing(null)} />
      <FormModal open={open} onClose={() => setOpen(false)} title="New merchant" onSubmit={save} busy={busy} submitText="Create merchant" disabled={!form.values.businessName.trim()}>
        <FormRow>
          <TextInput col={12} label="Business name" required {...form.bind("businessName")} />
          <TextInput col={6} label="Legal name" {...form.bind("legalName")} />
          <TextInput col={6} label="HST number" {...form.bind("hstNumber")} />
          <TextInput col={6} label="Contact email" type="email" {...form.bind("contactEmail")} />
          <TextInput col={6} label="Contact phone" {...form.bind("contactPhone")} />
        </FormRow>
      </FormModal>
    </>
  );
}

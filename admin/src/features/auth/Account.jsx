import React, { useState } from "react";
import { safeImgUrl } from "../../lib/safe";
import { toast } from "react-toastify";
import { errorMessage, http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useForm, useSubmit } from "../../lib/hooks";
import { fullName, fmtDateTime } from "../../lib/format";
import { Avatar, Badge, Button, Card, FileInput, KeyValue, PageHeader, TextInput } from "../../ui";

/** "My profile & security": profile, password, two-factor authentication, sessions. */
export default function Account() {
  const { user, reload } = useAuth();
  const profile = useForm({ firstName: user.firstName, lastName: user.lastName, avatarUrl: user.avatarUrl, language: user.language || "en" });
  const pw = useForm({ currentPassword: "", newPassword: "" });
  const { busy, run } = useSubmit();
  const [twofa, setTwofa] = useState(null);
  const [code, setCode] = useState("");
  const [disablePw, setDisablePw] = useState("");

  return (
    <>
      <PageHeader title="My profile & security" subtitle={`${fullName(user)} · ${user.email || user.phone}`} />
      <div className="row gy-4">
        <div className="col-lg-6">
          <Card title="Profile" actions={<Badge tone="primary">{user.roleName || user.restaurantRole || user.type}</Badge>}>
            <div className="d-flex align-items-center gap-3 mb-20">
              <Avatar name={fullName(user)} src={profile.values.avatarUrl} size={64} />
              <FileInput value={profile.values.avatarUrl} onChange={(u) => profile.set("avatarUrl", u)} className="mb-0" />
            </div>
            <div className="row">
              <TextInput col={6} label="First name" {...profile.bind("firstName")} />
              <TextInput col={6} label="Last name" {...profile.bind("lastName")} />
            </div>
            <KeyValue items={[{ label: "Last sign-in", value: fmtDateTime(user.lastLoginAt) }, { label: "Account type", value: user.type }]} />
            <Button className="mt-20" loading={busy} onClick={() => run(async () => { await http.patch("/auth/me", profile.values); await reload(); }, { success: "Profile updated" })}>
              Save profile
            </Button>
          </Card>
        </div>
        <div className="col-lg-6">
          <Card title="Change password">
            <TextInput label="Current password" type="password" autoComplete="current-password" {...pw.bind("currentPassword")} />
            <TextInput label="New password" type="password" autoComplete="new-password" {...pw.bind("newPassword")} hint="Minimum 8 characters with letters and numbers. You will be signed out on all devices." />
            <Button loading={busy} disabled={!pw.values.currentPassword || pw.values.newPassword.length < 8} onClick={() => run(async () => { await http.post("/auth/change-password", pw.values); pw.reset({ currentPassword: "", newPassword: "" }); }, { success: "Password changed" })}>
              Update password
            </Button>
          </Card>
        </div>
        <div className="col-12">
          <Card title="Two-factor authentication" subtitle="Mandatory for staff and restaurant owners (spec 10.1)" actions={<Badge tone={user.twoFactorEnabled ? "success" : "warning"}>{user.twoFactorEnabled ? "Enabled" : "Not enabled"}</Badge>}>
            {!user.twoFactorEnabled && !twofa && (
              <Button onClick={async () => { try { setTwofa(await http.post("/auth/2fa/setup", {})); } catch (e) { toast.error(errorMessage(e)); } }}>Set up authenticator app</Button>
            )}
            {twofa && (
              <div className="d-flex flex-wrap gap-4 align-items-center">
                <img src={safeImgUrl(twofa.qrCode)} alt="QR" style={{ width: 180 }} />
                <div style={{ maxWidth: 360 }}>
                  <p className="text-secondary-light text-sm">Scan the QR code, then enter the 6-digit code to confirm. Manual key: <code>{twofa.secret}</code></p>
                  <div className="d-flex gap-2">
                    <input className="form-control radius-8" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
                    <Button loading={busy} disabled={code.length !== 6} onClick={() => run(async () => { await http.post("/auth/2fa/enable", { code }); setTwofa(null); setCode(""); await reload(); }, { success: "Two-factor enabled" })}>Confirm</Button>
                  </div>
                </div>
              </div>
            )}
            {user.twoFactorEnabled && (
              <div className="d-flex gap-2 align-items-end" style={{ maxWidth: 480 }}>
                <TextInput className="mb-0 flex-grow-1" type="password" autoComplete="current-password" label="Password to disable" value={disablePw} onChange={setDisablePw} />
                <Button variant="outline-danger" loading={busy} disabled={!disablePw} onClick={() => run(async () => { await http.post("/auth/2fa/disable", { password: disablePw }); setDisablePw(""); await reload(); }, { success: "Two-factor disabled" })}>Disable</Button>
              </div>
            )}
          </Card>
        </div>
        <div className="col-12">
          <Card title="Sessions">
            <Button variant="outline-danger" onClick={() => run(async () => { await http.post("/auth/logout-all", {}); }, { success: "Signed out everywhere" })}>Sign out of all devices</Button>
          </Card>
        </div>
      </div>
    </>
  );
}

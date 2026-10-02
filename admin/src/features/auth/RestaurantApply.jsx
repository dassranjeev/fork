import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { errorMessage, http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useForm } from "../../lib/hooks";
import { Select, TextArea, TextInput, MultiCheck, Switch, NumberInput } from "../../ui";
import { AuthFrame } from "./SignIn";

/** Public restaurant application (SOP-01 step 1). Creates owner login + merchant + location (status APPLIED). */
export default function RestaurantApply() {
  const f = useForm({ province: "ON", deliveryEnabled: true, pickupEnabled: true, cuisineIds: [] });
  const [cuisines, setCuisines] = useState([]);
  const [cities, setCities] = useState([]);
  const [busy, setBusy] = useState(false);
  const { acceptSession } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    http.get("/public/cuisines").then((r) => setCuisines(r.data || r)).catch(() => undefined);
    http.get("/public/cities").then((r) => setCities(r.data || r)).catch(() => undefined);
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const v = f.values;
      const body = { ...v, lat: v.lat === "" ? undefined : v.lat, lng: v.lng === "" ? undefined : v.lng };
      const res = await http.post("/auth/restaurant/apply", body);
      if (res.accessToken) {
        await acceptSession(res);
        toast.success("Application received! Upload your documents to continue.");
        navigate("/portal/onboarding");
      } else {
        toast.success("Application received. Sign in to complete onboarding.");
        navigate("/sign-in");
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Apply to join FORKSY" subtitle="Lower commissions, your own kitchen tools and faster payouts. Tell us about your restaurant.">
      <form onSubmit={submit}>
        <h6 className="mb-16">Owner</h6>
        <div className="row">
          <TextInput col={6} label="First name" required {...f.bind("ownerFirstName")} />
          <TextInput col={6} label="Last name" required {...f.bind("ownerLastName")} />
          <TextInput col={6} label="Email" type="email" required {...f.bind("email")} />
          <TextInput col={6} label="Phone" required {...f.bind("phone")} placeholder="416-555-0100" />
          <TextInput col={12} label="Password" type="password" autoComplete="new-password" required {...f.bind("password")} hint="At least 8 characters with letters and numbers" />
        </div>
        <h6 className="mb-16 mt-8">Business</h6>
        <div className="row">
          <TextInput col={6} label="Business name" required {...f.bind("businessName")} />
          <TextInput col={6} label="HST number" {...f.bind("hstNumber")} placeholder="123456789 RT0001" />
          <TextInput col={12} label="Restaurant (location) name" required {...f.bind("restaurantName")} />
          <TextInput col={12} label="Address" required {...f.bind("addressLine1")} />
          <TextInput col={5} label="City" required {...f.bind("city")} />
          <TextInput col={3} label="Province" {...f.bind("province")} />
          <TextInput col={4} label="Postal code" required {...f.bind("postalCode")} />
          {cities.length > 0 && <Select col={12} label="Service city" options={cities.map((c) => ({ value: c.id, label: c.name }))} {...f.bind("cityId")} />}
          <TextArea col={12} label="Description" {...f.bind("description")} />
          {cuisines.length > 0 && <MultiCheck label="Cuisines" cols={3} options={cuisines.map((c) => ({ value: c.id, label: c.name }))} value={f.values.cuisineIds} onChange={(v) => f.set("cuisineIds", v)} />}
          <div className="col-md-6">
            <Switch label="Delivery (FORKSY drivers)" {...f.bindCheck("deliveryEnabled")} />
          </div>
          <div className="col-md-6">
            <Switch label="Pickup / takeout" {...f.bindCheck("pickupEnabled")} />
          </div>
        </div>
        <button type="submit" disabled={busy} className="btn btn-primary-600 text-sm btn-sm px-12 py-16 w-100 radius-12 mt-16">
          {busy ? "Submitting…" : "Submit application"}
        </button>
        <div className="text-center mt-24 text-sm">
          Already applied?{" "}
          <Link to="/sign-in" className="text-primary-600 fw-semibold">
            Sign in
          </Link>
        </div>
      </form>
    </AuthFrame>
  );
}

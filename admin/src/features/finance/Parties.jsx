import React, { useState } from "react";
import { Card, EmptyState, PageHeader } from "../../ui";
import { PARTY_TYPES, PartyPanel, PartyPicker } from "./common";

export default function Parties() {
  const [party, setParty] = useState(null);
  return (
    <>
      <PageHeader title="Bank and hold settings" subtitle="Look up a restaurant or driver to manage bank details, verification and payout holds" crumbs={[{ label: "Finance", to: "/finance" }, { label: "Bank and holds" }]} />
      <div className="row gy-4">
        <div className="col-lg-5">
          <Card title="Find a party">
            <PartyPicker value={party} onChange={setParty} types={PARTY_TYPES.slice(0, 2)} />
          </Card>
        </div>
        <div className="col-lg-7">
          <Card title="Party settings">
            {party ? <PartyPanel key={`${party.partyType}-${party.partyId}`} partyType={party.partyType} partyId={party.partyId} /> : <EmptyState icon="solar:card-search-outline" title="Select a party" text="Choose a restaurant or driver on the left." />}
          </Card>
        </div>
      </div>
    </>
  );
}

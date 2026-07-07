# Connecting Zoho CRM to CallGuard

Once CallGuard has transcribed and scored a call, it can write the compliance
result straight back onto the matching record in your Zoho CRM — the overall
score, pass/fail, when it was scored, and a link back to the call in CallGuard.
When a call contains a compliance **breach**, CallGuard also raises a task on
that record for the record owner to action.

CallGuard matches each scored call to a Zoho record **by the customer's phone
number**, so no manual linking is needed: as long as the number CallGuard sees
on the call exists on a Lead (or Contact) in Zoho, the result lands on it.

This is a one-way sync **from CallGuard into Zoho**. CallGuard never changes the
contact's details, ownership, or anything other than the compliance fields and
breach tasks described below.

## How it works

```
Call scored in CallGuard
   └─ customer phone (E.164)
         │  search Zoho Leads by phone
         ▼
   matching Zoho record
         ├─ update  Compliance Score / Result / Last Scored / CallGuard Link
         └─ on breach → create a Task for the record owner
```

The first time a number is matched, CallGuard remembers the Zoho record id, so
later calls from the same number skip the search and write straight to it.

## 1. Create the compliance fields in Zoho

In Zoho CRM, add these custom fields to the **Leads** module (Setup → Modules
and Fields → Leads → the layout Trust Point uses). Zoho generates the API name
automatically from the label — the labels below are all CallGuard needs:

| Field label         | Field type        | Notes                                   |
|---------------------|-------------------|-----------------------------------------|
| Compliance Score    | Number / Decimal  | 0–100 overall score                     |
| Compliance Result   | Pick List         | Values: `Pass`, `Fail`                  |
| Last Scored         | Date/Time         | When CallGuard last scored a call       |
| CallGuard Link      | URL               | Opens the scored call in CallGuard      |

If Trust Point scores calls against **Contacts** rather than Leads, create the
same four fields on the Contacts module instead and tell us which to use — the
module is configurable (defaults to Leads).

Breaches are written as standard Zoho **Tasks** linked to the record, so no
custom task fields are required.

## 2. Create an OAuth client in Zoho

CallGuard connects to Zoho with OAuth, so credentials can be revoked at any time
from the Zoho side and no password is shared.

1. Go to the Zoho API console for your data centre. Trust Point is UK-based, so
   this is the EU data centre: **https://api-console.zoho.eu**.
2. Create a **Server-based Application**.
3. Set the **Authorized Redirect URI** to:
   ```
   https://app.callguardai.co.uk/api/integrations/zoho/callback
   ```
4. Copy the generated **Client ID** and **Client Secret** — you'll paste these
   into CallGuard in the next step.

CallGuard requests only the scopes it needs: read your fields, read/update the
chosen module (Leads), and create tasks.

## 3. Connect Zoho in CallGuard

In CallGuard: **Integrations → Zoho CRM → Connect**.

1. Paste the **Client ID** and **Client Secret** from step 2.
2. Confirm the data centre (**EU** for Trust Point) and the module (**Leads**).
3. Click **Connect** — you'll be sent to Zoho to approve access, then returned
   to CallGuard. The connection now shows as **Active**.

CallGuard stores the Zoho refresh token encrypted at rest and refreshes the
short-lived access token automatically; you won't need to reconnect unless the
token is revoked in Zoho.

## 4. Test

Make a test call in CloudTalk to (or from) a number that exists on a Zoho Lead.
Once CallGuard finishes scoring it (usually within a minute), open that Lead in
Zoho — the **Compliance Score**, **Result**, **Last Scored** and **CallGuard
Link** fields should be filled in. If the call breached, a **Task** for the
record owner appears on the same Lead.

## Matching notes

- **Phone format.** CallGuard normalises numbers to international format
  (`+44…`). If Zoho stores UK numbers as `07…`, CallGuard searches both the
  `+44…` and `0…` forms so either way matches.
- **No match found.** If the number isn't on any Zoho record, CallGuard scores
  the call as normal and simply skips the write-back — nothing is created in
  Zoho. (We can change this to auto-create a Lead if you'd prefer.)
- **Multiple matches.** If the same number is on more than one record, CallGuard
  writes to the most recently modified one. Tell us if you'd rather it skip
  ambiguous matches instead.

## Troubleshooting

If a scored call doesn't appear in Zoho, check, in order: the call was actually
scored in CallGuard; the customer's number is present on a Zoho record; and the
Zoho connection still shows **Active** in CallGuard → Integrations. If all three
hold, send us the call's phone number and we'll trace the match.

CallGuard never blocks scoring on Zoho — if Zoho is unreachable, the call is
still scored and the write-back is retried, so results are never lost.

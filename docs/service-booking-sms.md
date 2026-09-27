# Service SMS Pipeline

How the Service-Admin texts a customer about their service booking: what the
feature is, what telecom permission it needs before a single message can go out,
and how to wire it into this codebase.

Read it in that order. The permission step has a **7–10 working day lead time**
and is the long pole — start it today and write the code while it clears.

---

## Part 1 — What it is

### The two capabilities

| # | Capability | Status |
|---|---|---|
| 1 | Service-Admin **sees** customer service-booking requests | **Already built and shipped** |
| 2 | Service-Admin **sends the customer an SMS** about that service | **Does not exist** — no SMS provider is wired into this repo at all |

Capability 2 is the entire body of work. It is not "one HTTP call" — Indian SMS
regulation forces a specific shape on the code (see Part 2).

The `Sends to customer → Service SMS` chip on the "Who Uploads What" card is
deliberately flagged `pending: true` at
`client/src/mainComponents/Admin/AdminDash/SuperOverviewKpiCharts.tsx:153`
(rendered by `client/src/mainComponents/WhatYouUpload.tsx`). **The last step of
this guide is to drop that flag.**

### Already built — do not rebuild

| Piece | Where |
|---|---|
| Booking model + status enum | `src/models/CustomerSystem/ServiceBooking.ts` |
| Admin list, branch-scoped | `getServiceBookings` in `src/controllers/CustomerController/serviceBooking.controller.ts` |
| Status transitions | `updateBookingStatus`, same file |
| Routes | `src/routes/customerRoutes/serviceBooking.ts` → `/api/service-bookings` |
| Role gate | `authorize("Super-Admin", "Service-Admin")` on `/admin/all`, `/admin/stats`, `/:id/status` |
| Frontend queue | `client/src/mainComponents/ServiceM/ServiceBookingsManager.tsx` |
| Frontend API | `client/src/redux-store/services/BikeSystemApi2/ServiceBookAdminApi.ts` |
| New-booking push to Service-Admin | `NotificationEvents.serviceBooking` in `src/service/notificationTargeting.ts` |

Two facts to carry into the new work:

- **Service-Admin is branch-scoped on reads.** `getServiceBookings` narrows by
  `getUserBranch(req.user)` when `isServiceAdmin(req.user)` (both in
  `src/types/user.types.ts`). The SMS endpoint must apply the same check, or a
  Service-Admin can text another branch's customer.
- **The recipient's phone number is already on the payload.** The admin list
  populates `{ path: "customer", select: "phoneNumber firebaseUid" }`, so the UI
  has the number without a second lookup.

### How it differs from the push-notification layer already in the repo

`src/service/pushNotification.service.ts` is the closest existing analogue, and
the new pipeline mirrors its shape — but three things change:

| | Push (`notify()`) | SMS |
|---|---|---|
| Message body | Free-form, written in code | **Pre-approved by a telecom regulator**, filled by variables only |
| Cost | Free | Billed per message |
| Trigger | Automatic after a DB write | An admin pressing a button |
| Failure handling | Fully guarded, never throws | Must surface to the admin — they need to know it failed |

That first row is the one that shapes everything. Read on.

---

## Part 2 — How to get permission

### Why you cannot just call an SMS API

Every application-to-person SMS delivered to an Indian mobile number is governed
by TRAI's **TCCCPR 2018** regulation, enforced through **DLT** (Distributed
Ledger Technology) portals run by the telecom operators. Under DLT you pre-register
three separate things, in order, and each has its own approval queue:

```
  Principal Entity  →  Header (sender ID)  →  Content Templates
   (who you are)        (what they see)       (what you may say)
     1–3 days              1–2 days             2–7 days
```

A message whose body does not match an approved template is **rejected by the
operator, not by your code**. It looks exactly like a silent delivery failure —
which is why the audit log in Part 3 is not optional.

### Step 1 — Register the dealership as a Principal Entity (PE)

Pick **one** DLT portal — Jio, Airtel, Vi, or BSNL. Registration propagates to
all operators, so you do not repeat this four times.

**Documents to have ready:**

- Company **PAN** card
- **GST** registration certificate
- Certificate of incorporation / business-registration proof
- Government photo ID of the **authorised signatory**
- **Letter of Authorisation (LOA)** on company letterhead naming that signatory

**Cost:** roughly **₹5,900 + GST**, one-time.
**Outcome:** a **PE ID** — a unique entity identifier, typically issued in **1–3
working days**. You will send this with every API request.

### Step 2 — Register the Header (sender ID)

The Header is the 6-character alphanumeric string the customer sees as the
sender, e.g. `TSNGPL`.

Headers are **registered per category**. TRAI requires the header to indicate the
message type, so a header approved for service traffic cannot be used to send
promotional traffic. Approval takes **1–2 working days**.

### Step 3 — Register each Content Template — pick the right category

This is the step people get wrong, so be deliberate.

The DLT categories are **Promotional**, **Service-Implicit**, **Service-Explicit**,
and **Transactional**. It is tempting to file booking updates as "Transactional"
because they are not marketing — but in current DLT taxonomy **Transactional is
narrowly reserved** for OTPs tied to banking and financial transactions.

> **Service-booking messages belong under Service-Implicit.** The customer has an
> existing relationship with the dealership (they booked a service), so consent is
> implied and no separate opt-in record is needed. Filing them as Transactional
> risks rejection at approval time.

Both Service-Implicit and Transactional deliver to numbers on the **DND registry**;
Promotional does not. So the category choice is about getting *approved*, not
about reach.

Write each template with `{#var#}` placeholders for anything that changes:

```
Hi {#var#}, your service booking at {#var#} on {#var#} at {#var#}
is confirmed. - Tsangpool Honda
```

Register one template per message you intend to send — the four in the catalogue
below are a reasonable starting set. Approval takes **2–7 working days**, and each
approved template returns a **Template ID (DLT_TE_ID)** that must be sent with the
request.

Practical notes that save a rejection cycle:

- Variables cannot be adjacent — `{#var#}{#var#}` is rejected. Put a separator between them.
- A variable typically caps around 30 characters; longer values are truncated in transit.
- The fixed text must match byte-for-byte. Punctuation and spacing count.
- Include the dealership name in the body. Templates that don't identify the sender get rejected.

### Step 4 — Map the approvals into the provider

Once the PE ID, Header and Template IDs exist, enter them in the SMS provider's
panel and pass the Template ID on every send. In MSG91's API the relevant
parameters are **`DLT_TE_ID`** (the approved template) and **`PE_ID`** (your entity).

### What this means for the code — two consequences

1. **The UI must never accept free-form SMS text.** The admin picks a template;
   the server fills the variables. That is why the service layer in Part 3 is a
   *catalogue of builders* mirroring `notificationTargeting.ts`, not a
   `sendSms(to, body)` function. A text box here would produce messages the
   operator silently drops.
2. **Registration is a business task, not an engineering one.** It needs the
   dealership's GST certificate and an authorised signatory. Hand Steps 1–3 to
   whoever holds those documents on day one; the code in Part 3 can be written
   and dry-run tested in parallel without any of it.

### Do not graft this onto ActivityCampaigns

`src/models/AdminFeatures/ActivityCampaigns.ts:81` already has an `smsTemplate`
field, and line 167 carries the comment `//connect a bulk sms api`. That is a
separate, unbuilt **marketing-campaign** feature — Promotional category, different
consent rules, does not reach DND numbers. Keep the two pipelines apart.

---

## Part 3 — How to integrate it into this software

### Provider: MSG91

It is DLT-native (Template ID and PE ID are first-class request fields), it is an
ordinary HTTP API needing no SDK, and `axios` is already a dependency
(`server3/package.json`) — the same reasoning that made the Voyage AI embeddings
client a plain `axios` call rather than a new package.

Twilio also works and also requires DLT. It costs more per message for Indian
destinations and adds a dependency. Pick it only if the dealership already has an
account.

### Build order

Each step compiles against the one before it.

#### 1. `src/types/sms.types.ts`

The template catalogue keys, mirroring `types/notification.types.ts`:

```ts
export const SMS_TEMPLATES = {
  BOOKING_CONFIRMED: "booking-confirmed",
  BOOKING_REMINDER: "booking-reminder",
  VEHICLE_READY: "vehicle-ready",
  BOOKING_CANCELLED: "booking-cancelled",
} as const;

export type SmsTemplateKey =
  (typeof SMS_TEMPLATES)[keyof typeof SMS_TEMPLATES];

export type SmsStatus = "queued" | "sent" | "failed" | "delivered";
```

#### 2. `src/models/SmsMessage.ts`

One row per message, written **before** the provider call. Mirrors
`models/Notification.ts`, and exists for the same reason plus two more: each send
costs real money, and it is a customer-facing action taken by a named staff
member — you need to prove what was sent, to whom, and by whom.

Fields: `to` (normalized 10-digit), `customerId`, `bookingId`, `templateKey`,
`dltTemplateId`, `body` (rendered, for audit), `status`, `providerMessageId`,
`error`, `sentBy`, `sentByRole`, `branchId`, timestamps.

Index `{ bookingId: 1, createdAt: -1 }` for the per-booking history the UI shows,
and `{ branchId: 1, createdAt: -1 }` for branch cost reporting.

#### 3. `src/service/sms/smsProvider.ts`

The **only** file that knows MSG91 exists. Takes `{ to, dltTemplateId, vars }`,
returns a normalized `{ ok, providerMessageId?, error? }`. Never throws.

Honour `SMS_DRY_RUN=true` here by logging and returning a synthetic success
without an HTTP call. There is no test runner in this repo, so a dry-run flag is
the only way to exercise the pipeline without spending money — and it is what
lets you build all of Part 3 while Part 2 is still in an approval queue.

#### 4. `src/service/sms/smsTemplates.ts`

The catalogue, directly mirroring `NotificationEvents` in
`service/notificationTargeting.ts` so call sites stay one-liners:

```ts
export const SmsTemplates = {
  bookingConfirmed: (opts: {
    customerName?: string;
    bookingId: string;
    date: string;
    time: string;
    branchName: string;
  }) => ({
    key: SMS_TEMPLATES.BOOKING_CONFIRMED,
    dltTemplateId: process.env.MSG91_TPL_BOOKING_CONFIRMED!,
    // Order must match the {#var#} order in the DLT-approved template.
    vars: [opts.customerName ?? "Customer", opts.branchName, opts.date, opts.time],
    // Kept in sync with the approved body, for the audit row only — it is
    // never what gets transmitted.
    preview: `Hi ${opts.customerName ?? "Customer"}, your service booking at ${opts.branchName} on ${opts.date} at ${opts.time} is confirmed. - Tsangpool Honda`,
  }),
  // …
};
```

Keeping `dltTemplateId` in env rather than in code lets sandbox and production
DLT registrations differ without a redeploy.

#### 5. `src/service/sms/sms.service.ts`

Orchestration: render → write the `SmsMessage` row as `queued` → call the
provider → update the row to `sent`/`failed`.

**One deliberate difference from `pushNotification.service.ts#notify()`**: that
function is fully guarded and never throws, because it fires automatically after
a DB write and must not fail the request. This one is invoked by an admin
pressing a button, and they need to know it failed — so the explicit-send path
returns a result the controller turns into a 502, while any future automatic
trigger (e.g. on status change) wraps it in `.catch()` exactly like the existing
notify call sites do.

Normalize the recipient with the same 10-digit rule used elsewhere
(`service/salesReport.service.ts:154#normalizePhone`), then prefix `91` for MSG91.

#### 6. `src/controllers/ServiceM/bookingSms.controller.ts`

```
POST /api/service-bookings/:id/sms   body: { templateKey }
```

- `authorize("Super-Admin", "Service-Admin")`
- Load the booking, then **branch-check it** with
  `canAccessBranch(req.user, booking.branch)` (`src/types/user.types.ts:108`) —
  the same guard `getServiceBookings` applies.
- Reject a `templateKey` not in the catalogue. Never trust the client here — it
  maps to a paid external call.
- Also add `GET /api/service-bookings/:id/sms` returning that booking's
  `SmsMessage` rows, so the admin sees what was already sent and doesn't
  double-text.

#### 7. Route wiring — mind the ordering trap

In `src/routes/customerRoutes/serviceBooking.ts`, register the new routes
**above** the parameterized block at the bottom. That file already carries the
comment `// Parameterized routes — LAST`, and the repo has ~19 routers with a
trailing `/:id` catch-all; see the "works locally, 404s in production" section of
`CLAUDE.md` for what goes wrong when one shadows a literal path.

Note the existing `/:id` handlers use `protectCustomer` while yours use
`protect` — different middleware for different audiences. Don't add the SMS route
inside that customer block.

#### 8. Frontend

- `ServiceBookAdminApi.ts`: add a `sendBookingSms` mutation and a
  `getBookingSmsHistory` query. Invalidate `["AdminBooking"]`.
- `ServiceBookingsManager.tsx`: a "Send SMS" control per booking row opening a
  template picker — **a fixed list, not a text box** (Part 2). Show the rendered
  preview before sending, and previous sends underneath.
- Surface failures inline. A failed SMS is the one case where a silent toast is
  wrong: the customer didn't get the message and the admin must know.

#### 9. Drop the pending flag

In `SuperOverviewKpiCharts.tsx:153`, change the Service-Admin entry to
`sends: [{ label: "Service SMS" }]` and delete the comment pointing at this file.
The "Who Uploads What" card then reads as a live capability instead of "Not wired
yet".

### Environment variables

Add to `server3/.env` — `dotenv.config()` takes no path, so that is the file that
loads; `server3/src/.env` is ignored.

```
MSG91_AUTH_KEY=
MSG91_PE_ID=              # Principal Entity ID from DLT registration (Step 1)
MSG91_SENDER_ID=          # the 6-char DLT header, e.g. TSNGPL (Step 2)
MSG91_TPL_BOOKING_CONFIRMED=   # DLT_TE_ID per approved template (Step 3)
MSG91_TPL_BOOKING_REMINDER=
MSG91_TPL_VEHICLE_READY=
MSG91_TPL_BOOKING_CANCELLED=
SMS_DRY_RUN=true          # leave true everywhere except production
```

### Guardrails

- **Cost.** Every send is billed. Enforce a per-booking cap and a short dedupe
  window — same booking + same template within N minutes should be rejected with
  a clear message, not silently sent twice.
- **Opt-out.** DND doesn't block Service-Implicit SMS, but add `smsOptOut` to
  `BaseCustomer` and honour it anyway. A customer who asks to stop should be able
  to stop.
- **PII in logs.** Don't log rendered bodies or full phone numbers at `info`. The
  body is already on the audit row; the log needs only the `SmsMessage` id and
  the outcome.
- **Rate limit.** The global limiter is 100 req / 15 min / IP across `/api`. Bulk
  sends would need a queue, not a loop in the request — see
  `docs/parts-import-background-jobs.md` for why that's currently blocked on
  Cloud Run's CPU-allocation setting.

### Fix this pre-existing bug first if a template needs the bike model

`getServiceBookings` populates:

```ts
{ path: "vehicle", populate: { path: "stockConcept", model: "StockConcept" } }
```

`CustomerVehicle.stockConcept` is declared `refPath: "stockType"` and may point at
**either** `StockConcept` or `StockConceptCSV`. Hardcoding `model` overrides that,
so any booking on a CSV-stock vehicle populates `stockConcept` as `null`. A "your
ACTIVA 125 is ready" template would render blank for those customers. Replace
`model: "StockConcept"` with `refPath: "stockType"`.

### Deploying

The backend does not auto-deploy. Pushing does not ship this — Cloud Run only
changes when someone runs `gcloud run deploy` by hand from `server3/`. Until then
the frontend calls an endpoint that doesn't exist and, because of the `/:id`
catch-all above, gets a **domain-shaped 404** rather than a routing one. Read the
response body: `"Not Found - /api/…"` means genuinely unrouted; anything else
means a catch-all swallowed it.

---

## Sequencing summary

| Day | Business track (Part 2) | Engineering track (Part 3) |
|---|---|---|
| 1 | Submit PE registration with GST + PAN + LOA | Steps 1–5 against `SMS_DRY_RUN=true` |
| 2–3 | PE ID issued → submit Header | Steps 6–8 |
| 3–5 | Header approved → submit 4 Content Templates (Service-Implicit) | Dry-run the full flow end to end |
| 5–10 | Template IDs issued | Fill `.env`, flip `SMS_DRY_RUN=false`, deploy, drop the pending flag |

### References

- [DLT Registration: Complete TRAI Guide for India](https://www.smscountry.com/blog/dlt-registration/)
- [India DLT registration — Infobip Docs](https://www.infobip.com/docs/essentials/asia-registration/dlt-registration)
- [MSG91 — Steps for DLT Process Registration](https://msg91.com/guide/steps-for-dlt-process-registration)
- [MSG91 — Get approval for your SMS content on the DLT platform](https://msg91.com/help/dlt-registration-in-india/get-approval-for-your-sms-content-on-dlt-platform)
- [MSG91 — Map SMS content template on MSG91 API/Panel](https://msg91.com/help/dlt-registration-in-india/map-sms-content-template-on-msg91-api-panel)

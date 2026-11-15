# Phase 2 compatibility and operations

## Old-client create compatibility

The create endpoint continues to accept the Phase 1 request shape:

```json
{ "title": "...", "description": "...", "location": "...", "status": "found" }
```

For that request, `dateReported` is server-generated. The server leaves `eventAt` and custody fields absent; it does not copy `dateReported` into `eventAt` or invent staff confirmation. The authenticated user remains the owner and lifecycle/review fields remain server-controlled. Conflicting `reportType` and `status`, `status: claimed`, and malformed report details are rejected.

An old-client found report, including a pure legacy `status: found` record, remains readable and can appear in public browsing. It is not claimable or approvable until it has sufficient custody information. A reporter may add `finder_reported` or `security_reported` custody by editing their own open found report. Authorized campus security may record `security_confirmed` only after physically verifying campus custody; the server supplies the actor and current timestamp. Missing or contradictory confirmation evidence is not displayed as verified and cannot satisfy Claim eligibility.

Only consistent reporter custody with no confirmation fields, or `security_confirmed` with a BSON staff actor ID and a BSON date timestamp, satisfies the server's Claim eligibility predicate. The same predicate runs before Claim creation and inside the reservation transaction. The staff custody queue includes open found reports with missing custody so staff can review them. New frontend forms continue to require event time and reporter custody for new found reports.

Keep acceptance of the Phase 1 create shape until the minimum supported frontend is confirmed deployed to every allowed origin and old clients are retired. No event, custody, reservation, return, pickup, or handover time is inferred from report creation time.

## Legacy state interpretation and reconciliation

Both canonical `reportType` and `lifecycleStatus` must be absent for legacy interpretation. A partial, null, invalid, or contradictory canonical/legacy combination is returned as unknown and remains visible in owner history but unavailable for normal workflow transitions.

| Stored legacy `status` | API interpretation | Claim behavior |
| --- | --- | --- |
| `lost` | `reportType: lost`, `lifecycleStatus: open` | Readable; not a Claim target |
| `found` | `reportType: found`, `lifecycleStatus: open` | Readable; requires sufficient custody before Claim submission or approval |
| `claimed` | `reportType: unknown`, `lifecycleStatus: unknown` | Historical; no reservation or handover is inferred |

Canonical states are accepted only when all three report/lifecycle/status fields agree. Staff awaiting-handover actions require a matching approved Claim and canonical reservation with no handover metadata on either record. Completed handovers require matching Item and Claim timestamps, staff actor, reservation ID, handover Claim ID, and Item link. Every other approved Claim classification is placed in the legacy/reconciliation queue before pagination.

Claim list DTOs expose `approvedWorkflowStatus` for approved Claims: `awaiting_handover`, `completed`, or `legacy`. The browser shows an awaiting message only for a canonical reservation, a completion message only for matching handover evidence, and a neutral campus-security message for historical or ambiguous approvals. An absent status from an older API is treated as historical by the Phase 2 browser.

### Controlled staff reconciliation procedure

1. Open **Legacy cases** in staff Claim review. Do not approve, reject, add pickup instructions, or confirm a handover from that queue.
2. Compare the Item and Claim with campus security's contemporaneous intake, reservation, and handover records. Contact the claimant and report owner when those records do not establish the current state.
3. If the evidence remains ambiguous, leave both database records unchanged, keep the case in reconciliation, and direct the claimant to campus security for confirmation.
4. If a correction is necessary, have the designated data custodian review the source evidence and record an audited, case-specific change request. Preserve before-values and source references. Use only dates supported by that evidence; never copy `dateReported` or create a past reservation/return/handover time from inference.
5. Use normal staff workflow endpoints only for actions that occur now and have been directly verified. No historical record is changed automatically by Phase 2.

Owner-scoped Item responses include `canArchive`. It is true only for a consistent open/resolved report without an active Claim, or a returned found report whose approved Claim and handover evidence match. Historical returned reports with missing or mismatched evidence require reconciliation before archival.

## Old-client pagination compatibility

List APIs retain their JSON array response, so Phase 1 clients that expect arrays continue to parse responses. They do not read the pagination headers or request later pages. Such a client silently sees only the first 20 records (or the requested bounded page if another client supplies query parameters).

The affected list endpoints are:

- `GET /api/items`
- `GET /api/items/mine`
- `GET /api/items/staff/custody`
- `GET /api/claims`
- `GET /api/claims/received`
- `GET /api/claims/review`

The server defaults to `page=1&limit=20`, caps `limit` at 50, and returns `X-Page`, `X-Page-Size`, `X-Total-Count`, and `X-Has-More`. Query filtering and queue classification happen before the requested page is selected. Detail endpoints are not paginated.

For a coordinated rollout, deploy the backward-compatible backend first, confirm its health and pagination headers through every configured frontend origin, then deploy the Phase 2 browser client. The new client reads page headers and exposes page controls. A browser continues running its already-loaded Phase 1 bundle until it reloads or receives the new bundle; use the normal cache/version rollout for the web host and verify each allowed origin before retiring old clients. A Phase 2 client pointed at a pre-pagination backend will not receive authoritative page headers, so deploy the backend before switching browser clients. Temporary compatibility is limited to the old array body and old create request; unlimited result queries are not restored.

## Database testing policy

The project continues using its existing MongoDB database. Automated tests use mocked database behavior. Real multi-document transaction rollback and concurrency behavior have not been independently verified against a live MongoDB replica set. No live write-based integration tests are authorized as part of this phase.

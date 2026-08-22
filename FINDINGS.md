# Findings

Analysis of 15 consecutive runs of the Restful Booker automation suite, collected on
16 August 2026 over a 12-minute window.

---

## 1. One test degraded under repeated load; the rest held steady

**Observed.** `TC002 — Navigate to rooms and complete a successful booking` failed in 13 of
15 runs. The other three tests passed in all 15.

**Shape of the failure.** This is the part the pass/fail count alone would have hidden:

| Run | Verdict |
|---|---|
| 1 | passed |
| 2–11 | failed |
| 12 | passed |
| 13–15 | failed |

Run 1 succeeded against a rested server. Failures began at run 2 and persisted, with a single
recovery at run 12.

**Interpretation.** A genuinely unstable test fails randomly. This is a step change with one
recovery — the signature of an environment degrading rather than a test misbehaving. Each run
creates a new booking on a shared public sandbox, and the failure appeared once that had
happened twice in quick succession.

**Confirmed by re-test.** Running the suite once, in isolation, roughly 30 minutes after
collection: 4 of 4 passed, TC002 included. Same code, same assertions, different server state.

**Conclusion.** Environmental, not a test defect. No change was made to the test.

---

## 2. The failure is in the browser flow, not the service

**Observed.** UI pass rate 78.33%; API assertion pass rate 100% across all 390 assertions,
every run.

**Why this matters.** The API suite exercises the same booking lifecycle that TC002 drives
through the browser — create, retrieve, update, delete. Those calls succeeded in every run,
including the runs where the browser flow failed.

**Conclusion.** The service accepted and processed bookings throughout. The failure sits above
it — in page rendering or the confirmation step. Diagnosis narrows from "the booking system is
broken" to "the booking *page* did not render its confirmation", which is a materially
different ticket.

This is the value of running UI and API suites against the same system and looking at both
together. Either one alone would have been ambiguous.

---

## 3. The health check is the slowest endpoint

**Observed.** `Health Check (Ping)` averages ~1,900 ms with a P95 of ~2,650 ms. Every other
endpoint — including those performing database writes — sits between 300 ms and 450 ms.

| Endpoint | Avg (ms) |
|---|---:|
| Health Check (Ping) | ~1,900 |
| Get All Bookings | ~620 |
| All others | 300–450 |

**Interpretation.** An endpoint that does nothing should be the fastest, not five times the
slowest. Ping is the first request in the collection, so it absorbs the cold-start cost of
waking a sleeping Heroku dyno. The latency belongs to the platform, not the endpoint.

**Consequence for measurement.** Any average response time computed across the whole
collection is inflated by this one request. It is the reason the P95 (~2,120 ms) sits so far
from the mean (~350 ms) — the distribution has one heavy outlier rather than a broad spread.

**Recommendation.** Issue a warm-up request before timing, or exclude the first request from
performance baselines. Otherwise the suite reports platform behaviour as application
behaviour.

---

## 4. Status code distribution is stable

**Observed.** Across 135 requests: 90 × `200`, 30 × `201`, 15 × `404`.

The `404` is expected. `Verify Deletion` is a negative test that asserts a deleted booking is
no longer retrievable, so a 404 there is a passing test, not an error. The counts divide
exactly by 15, confirming every run executed the full collection with no dropped requests.

---

## Summary

| Finding | Type | Action |
|---|---|---|
| TC002 fails under repeated booking creation | Environmental | None — sandbox limitation, documented |
| API healthy while UI failed | Diagnostic | Narrows failure to presentation layer |
| Cold start inflates response baselines | Measurement defect | Add warm-up request before timing |
| Status codes consistent | Control check | Confirms collection integrity |

**The most useful metric here was not the pass rate.** 78.33% describes the outcome but not
the cause. The *shape* of the failure over time, read alongside a healthy API, is what
distinguished a degrading environment from a broken test — and that distinction is only
visible with a run series behind it.

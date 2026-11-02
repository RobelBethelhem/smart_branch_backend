/* eslint-disable */
// ===========================================================================
// k6 load test for the teller transaction-search endpoint:
//   GET /api/zsmart_branch_requests/transactions?query=<customer/account no.>
//
// Goal: confirm the search holds up at teller-fleet traffic (2000+ req/s) now
// that it is a pure indexed MongoDB read (no per-search Oracle/Flexcube call).
//
// Install k6:  https://k6.io/docs/get-started/installation/
//
// Run (hit the BACKEND directly, not the Vite proxy):
//   k6 run \
//     -e BASE_URL=http://10.1.2.132:5000 \
//     -e TOKEN=<a valid Teller or Admin x-access-token> \
//     -e QUERIES=1000123,1000456,1000789 \
//     loadtest/transactions_search.k6.js
//
// QUERIES = comma-separated REAL Customer_Unique_Number (Teller token) or
// account numbers (Admin token) that exist in TODAY's data, so the query
// actually exercises the index + returns rows. Use several to avoid hammering
// one key.
// ===========================================================================
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:5000';
const TOKEN = __ENV.TOKEN || '';
const QUERIES = (__ENV.QUERIES || '0000001').split(',').map((s) => s.trim()).filter(Boolean);
const TARGET = Number(__ENV.TARGET_RPS || 2000);

export const options = {
  scenarios: {
    search: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 300,
      maxVUs: 3000,
      stages: [
        { target: Math.round(TARGET * 0.25), duration: '30s' },
        { target: Math.round(TARGET * 0.5), duration: '30s' },
        { target: TARGET, duration: '1m' },   // ramp to target
        { target: TARGET, duration: '2m' },   // hold at target
        { target: 0, duration: '20s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],                 // < 1% errors
    http_req_duration: ['p(95)<200', 'p(99)<500'],  // p95 < 200ms, p99 < 500ms
  },
};

export default function () {
  const q = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  const url = `${BASE}/api/zsmart_branch_requests/transactions?query=${encodeURIComponent(q)}`;
  const res = http.get(url, { headers: { 'x-access-token': TOKEN } });
  check(res, {
    'status is 200': (r) => r.status === 200,
    'error flag is false': (r) => {
      try { return r.json('error') === false; } catch (_) { return false; }
    },
  });
}

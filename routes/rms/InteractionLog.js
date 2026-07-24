import { Router } from 'express';
import InteractionLog from '../../models/rms/InteractionLog.js';

const router = Router();

const s = (v, n) => String(v ?? '').slice(0, n);
const MAX_ENTRIES = 1000; // per request, defensive cap

// Public endpoint — the kiosk streams interactions here, batched. It is
// intentionally unauthenticated because logging starts before a customer
// authenticates (session_start, menu taps, login attempts). The global
// generalLimiter still caps abuse per IP.
//
// Body: { entries: [{ ts, session, serial, branch, type, label, path }, ...] }
// Every entry is stamped with the tablet SERIAL number (the audit key).
router.post('/', async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (entries.length === 0) {
      return res.json({ error: false, written: 0 });
    }

    const ip =
      (req.headers['x-forwarded-for']?.split(',')[0] || '').trim() ||
      req.ip ||
      '';

    const docs = entries.slice(0, MAX_ENTRIES).map((e) => ({
      serial: s(e?.serial, 80),
      branch: s(e?.branch, 40),
      session_id: s(e?.session, 80),
      event_type: s(e?.type, 60),
      label: s(e?.label, 200),
      path: s(e?.path, 200),
      ip_address: ip,
      event_ts: s(e?.ts, 40),
    }));

    // ordered:false — one bad doc never blocks the rest of the batch.
    await InteractionLog.insertMany(docs, { ordered: false });

    return res.json({ error: false, written: docs.length });
  } catch (err) {
    console.error('[interaction-logs] insert failed:', err.message);
    return res
      .status(500)
      .json({ error: true, message: 'Failed to store interaction logs' });
  }
});

export default router;

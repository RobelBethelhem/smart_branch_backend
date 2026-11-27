import { Router } from "express";
import mongoose from "mongoose";
import auth from "../../middleware/rms/auth.js";
import roleCheck from "../../middleware/rms/roleCheck.js";
import {
    Customer360Section, Customer360Setting, CustomerArrival, Customer360Audit,
    WIDGET_TYPES, PLACEMENTS, SECTION_MODES,
} from "../../models/rms/Customer360.js";
import { ALLOWED_BINDS, MAX_QUERY_LENGTH, validateSectionQuery } from "../../utils/rms/customer360/sqlGuard.js";
import { WIDGETS, MAX_ROWS, prepareRows } from "../../utils/rms/customer360/widgets.js";
import { SAMPLE_QUERY_BY_TYPE, SAMPLE_ROWS_BY_TYPE } from "../../utils/rms/customer360/defaults.js";
import { buildSections, ensureDefaultSections, loadSections, testQuery } from "../../utils/rms/customer360/runner.js";
import { REQUEST_TYPE_LABELS, cifFromAccount } from "../../utils/rms/customer360/arrivals.js";

// =============================================================================================
// Customer 360
//
//   Who sees it      The branch's Admin always. Other roles of the branch when the Admin has
//                    switched them on (GET/PUT /settings). Tellers and makers, when switched
//                    on, only see the customers assigned to them.
//   What they see    GET /arrivals (the notifications), GET /arrivals/:id (the page).
//   What it is made  Sections, managed by the Super Admin (GET/POST/PUT/DELETE /sections).
//   of               A section shows demo rows, or the rows of a read-only FlexCube query.
//
// Every page view, every "reveal" of masked details and every change to a query is written
// to customer360audits.
// =============================================================================================

const router = Router();

const ALWAYS_ROLES = ["Admin"];
const SELECTABLE_ROLES = ["Authorizer", "Auditor", "Teller", "Maker"];
const DEFAULT_ROLES = ["Authorizer"];
// Roles that, when switched on, see their own customers only.
const OWN_CUSTOMERS_ONLY = ["Teller", "Maker"];

const roleOf = (req) => (Array.isArray(req.user?.roles) ? req.user.roles[0] : req.user?.roles) || "";
const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ""));
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

function audit(req, action, fields = {}) {
    new Customer360Audit({
        user_id: String(req.user?._id || ""),
        user: String(req.user?.user || ""),
        role: roleOf(req),
        branch: String(req.user?.branch || ""),
        action,
        ...fields,
    }).save().catch((error) => console.error("[CUSTOMER360] audit entry not saved:", error.message));
}

// The backoffice asks for arrivals every few seconds, and each time the roles of the branch
// are needed. They are remembered for a few seconds, and forgotten at once when changed here.
const ROLES_CACHE_MS = 15000;
const rolesCache = new Map();

async function enabledRoles(branch, { fresh = false } = {}) {
    const hit = rolesCache.get(branch);
    if (!fresh && hit && Date.now() - hit.at < ROLES_CACHE_MS) return hit.roles;
    const setting = await Customer360Setting.findOne({ branch }).lean();
    const roles = setting ? setting.roles.filter((role) => SELECTABLE_ROLES.includes(role)) : DEFAULT_ROLES;
    if (rolesCache.size > 2000) rolesCache.clear();
    rolesCache.set(branch, { roles, at: Date.now() });
    return roles;
}

async function accessFor(req) {
    const role = roleOf(req);
    const branch = String(req.user?.branch || "");
    if (!branch || (!ALWAYS_ROLES.includes(role) && !SELECTABLE_ROLES.includes(role))) {
        return { role, branch, eligible: false, ownOnly: false };
    }
    const eligible = ALWAYS_ROLES.includes(role) || (await enabledRoles(branch)).includes(role);
    return { role, branch, eligible, ownOnly: OWN_CUSTOMERS_ONLY.includes(role) };
}

const arrivalFilter = (req, access) => ({
    branch: access.branch,
    ...(access.ownOnly ? { assigned_to: String(req.user.user || "") } : {}),
});

function describeArrival(arrival, userId) {
    const account = String(arrival.account_number || "");
    return {
        id: String(arrival._id),
        customer_name: arrival.customer_name || "Customer",
        request_type: arrival.request_type,
        request_label: REQUEST_TYPE_LABELS[arrival.request_type] || arrival.request_type || "Request",
        queue_number: arrival.queue_number || "",
        assigned_to: arrival.assigned_to || "",
        assigned_by: arrival.assigned_by || "system",
        account_tail: account.slice(-4),
        cif: arrival.cif || "",
        simulated: !!arrival.simulated,
        arrived_at: arrival.arrived_at,
        seen: (arrival.seen_by || []).some((entry) => entry.user_id === userId),
    };
}

const markSeen = (arrivalId, userId) => CustomerArrival.updateOne(
    { _id: arrivalId, "seen_by.user_id": { $ne: userId } },
    { $push: { seen_by: { user_id: userId, at: new Date() } } }
).catch((error) => console.error("[CUSTOMER360] seen mark not saved:", error.message));

const customerOf = (arrival) => ({
    cif: arrival.cif || cifFromAccount(arrival.account_number),
    account_number: arrival.account_number || "",
    branch_code: arrival.branch || "",
});


// ---------------------------------------------------------------------------------------------
// For every logged-in user: may I see Customer 360, and what else may I do?
// ---------------------------------------------------------------------------------------------
router.get("/me", auth, async (req, res) => {
    try {
        const access = await accessFor(req);
        res.json({
            error: false,
            data: {
                role: access.role,
                branch: access.branch,
                eligible: access.eligible,
                own_customers_only: access.ownOnly,
                can_set_access: access.role === "Admin",
                can_manage_sections: access.role === "Super_Admin",
            },
        });
    } catch (e) {
        console.error("[CUSTOMER360_ME] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});


// ---------------------------------------------------------------------------------------------
// Arrivals of today in my branch. The backoffice asks for this every few seconds; `since`
// (the newest arrival it already has) keeps the answer small.
// ---------------------------------------------------------------------------------------------
router.get("/arrivals", auth, async (req, res) => {
    try {
        const access = await accessFor(req);
        if (!access.eligible) {
            return res.json({ error: false, data: { eligible: false, arrivals: [], server_time: new Date() } });
        }

        let from = startOfToday();
        const since = req.query.since ? new Date(String(req.query.since)) : null;
        if (since && !Number.isNaN(since.getTime()) && since > from) from = since;

        const arrivals = await CustomerArrival.find({
            ...arrivalFilter(req, access),
            arrived_at: req.query.since ? { $gt: from } : { $gte: from },
        }).sort({ arrived_at: -1 }).limit(50).lean();

        const userId = String(req.user._id);
        res.json({
            error: false,
            data: {
                eligible: true,
                arrivals: arrivals.map((arrival) => describeArrival(arrival, userId)),
                server_time: new Date(),
            },
        });
    } catch (e) {
        console.error("[CUSTOMER360_ARRIVALS] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});

async function findMyArrival(req, res) {
    const access = await accessFor(req);
    if (!access.eligible) {
        res.status(403).json({ error: true, message: "Customer 360 is not switched on for your role in this branch." });
        return null;
    }
    if (!isObjectId(req.params.id)) {
        res.status(400).json({ error: true, message: "Invalid arrival" });
        return null;
    }
    const arrival = await CustomerArrival.findOne({ _id: req.params.id, ...arrivalFilter(req, access) }).lean();
    if (!arrival) {
        res.status(404).json({ error: true, message: "This arrival is not available to you." });
        return null;
    }
    return arrival;
}

router.post("/arrivals/:id/seen", auth, async (req, res) => {
    try {
        const arrival = await findMyArrival(req, res);
        if (!arrival) return;
        await markSeen(arrival._id, String(req.user._id));
        res.json({ error: false });
    } catch (e) {
        console.error("[CUSTOMER360_SEEN] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});

// The Customer 360 page of one arrival.
router.get("/arrivals/:id", auth, async (req, res) => {
    try {
        const arrival = await findMyArrival(req, res);
        if (!arrival) return;

        const sections = await buildSections(customerOf(arrival));
        const userId = String(req.user._id);
        markSeen(arrival._id, userId);
        audit(req, "view", { cif: arrival.cif, account_number: arrival.account_number, arrival_id: String(arrival._id) });

        res.json({
            error: false,
            data: {
                arrival: { ...describeArrival(arrival, userId), seen: true },
                sections,
                has_demo: sections.some((section) => section.mode !== "live"),
            },
        });
    } catch (e) {
        console.error("[CUSTOMER360_VIEW] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});

// The same page with the masked details readable. Asked for explicitly, and logged.
router.post("/arrivals/:id/reveal", auth, async (req, res) => {
    try {
        const arrival = await findMyArrival(req, res);
        if (!arrival) return;

        const sections = await buildSections(customerOf(arrival), { reveal: true });
        audit(req, "reveal", { cif: arrival.cif, account_number: arrival.account_number, arrival_id: String(arrival._id) });

        res.json({ error: false, data: { sections: sections.filter((section) => section.has_sensitive) } });
    } catch (e) {
        console.error("[CUSTOMER360_REVEAL] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});


// ---------------------------------------------------------------------------------------------
// Admin of a branch: which roles of my branch may see Customer 360
// ---------------------------------------------------------------------------------------------
router.get("/settings", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        const branch = String(req.user.branch || "");
        const setting = await Customer360Setting.findOne({ branch }).lean();
        res.json({
            error: false,
            data: {
                branch,
                roles: await enabledRoles(branch, { fresh: true }),
                always: ALWAYS_ROLES,
                selectable: SELECTABLE_ROLES,
                own_customers_only: OWN_CUSTOMERS_ONLY,
                updated_by: setting?.updated_by || "",
                updated_at: setting?.updated_at || null,
            },
        });
    } catch (e) {
        console.error("[CUSTOMER360_SETTINGS] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});

router.put("/settings", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        const branch = String(req.user.branch || "");
        if (!branch) return res.status(400).json({ error: true, message: "Your user has no branch." });
        if (!Array.isArray(req.body?.roles)) return res.status(400).json({ error: true, message: "roles must be a list" });

        const unknown = req.body.roles.filter((role) => !SELECTABLE_ROLES.includes(role));
        if (unknown.length) return res.status(400).json({ error: true, message: `Unknown role: ${unknown.join(", ")}` });

        const roles = SELECTABLE_ROLES.filter((role) => req.body.roles.includes(role));
        const before = await enabledRoles(branch, { fresh: true });
        await Customer360Setting.updateOne(
            { branch },
            { $set: { roles, updated_by: String(req.user.user || ""), updated_at: new Date() } },
            { upsert: true }
        );
        rolesCache.delete(branch);
        audit(req, "settings_update", { details: { before, after: roles } });
        res.json({ error: false, message: "Saved", data: { branch, roles } });
    } catch (e) {
        console.error("[CUSTOMER360_SETTINGS_SAVE] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});

// A made-up arrival, to try the notification and the page without a real customer. It is
// marked "simulated" everywhere it is shown.
router.post("/simulate", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        const branch = String(req.user.branch || "");
        if (!branch) return res.status(400).json({ error: true, message: "Your user has no branch." });

        const text = (value, fallback, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback);
        const account = /^\d{16}$/.test(String(req.body?.account_number || "")) ? String(req.body.account_number) : "";
        const requestType = Object.keys(REQUEST_TYPE_LABELS).includes(req.body?.request_type) ? req.body.request_type : "deposit";

        const arrival = await new CustomerArrival({
            branch,
            request_id: null,
            request_type: requestType,
            customer_name: text(req.body?.customer_name, "Selam Tesfaye", 80),
            account_number: account,
            cif: cifFromAccount(account),
            queue_number: text(req.body?.queue_number, "", 12),
            assigned_to: text(req.body?.assigned_to, String(req.user.user || ""), 80),
            assigned_by: "system",
            simulated: true,
        }).save();

        audit(req, "simulate", { arrival_id: String(arrival._id) });
        res.status(201).json({ error: false, message: "Simulated arrival created", data: describeArrival(arrival.toObject(), String(req.user._id)) });
    } catch (e) {
        console.error("[CUSTOMER360_SIMULATE] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});


// ---------------------------------------------------------------------------------------------
// Super Admin: the sections of the page and their queries
// ---------------------------------------------------------------------------------------------
const SUPER = [auth, roleCheck(["Super_Admin"])];

function readSection(body, { partial = false } = {}) {
    const out = {};
    const has = (name) => body && Object.prototype.hasOwnProperty.call(body, name);
    const need = (name) => !partial || has(name);

    if (need("title")) {
        if (typeof body?.title !== "string" || !body.title.trim()) return { error: "A title is needed." };
        out.title = body.title.trim().slice(0, 80);
    }
    if (need("type")) {
        if (!WIDGET_TYPES.includes(body?.type)) return { error: "Choose the kind of section." };
        out.type = body.type;
    }
    if (has("placement")) {
        if (!PLACEMENTS.includes(body.placement)) return { error: "placement must be side or main." };
        out.placement = body.placement;
    }
    if (has("width")) {
        const width = Number(body.width);
        if (!Number.isInteger(width) || width < 3 || width > 12) return { error: "The width must be a whole number from 3 to 12." };
        out.width = width;
    }
    if (has("order")) {
        const order = Number(body.order);
        if (!Number.isFinite(order)) return { error: "The position must be a number." };
        out.order = order;
    }
    if (has("enabled")) out.enabled = body.enabled === true;
    if (has("mode")) {
        if (!SECTION_MODES.includes(body.mode)) return { error: "mode must be demo or live." };
        out.mode = body.mode;
    }
    if (has("query")) {
        if (typeof body.query !== "string") return { error: "The query must be text." };
        if (body.query.length > MAX_QUERY_LENGTH) return { error: `The query is longer than ${MAX_QUERY_LENGTH} characters.` };
        out.query = body.query;
    }
    if (has("demo_rows")) {
        if (!Array.isArray(body.demo_rows) || body.demo_rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
            return { error: "The demo rows must be a list of rows." };
        }
        if (body.demo_rows.length > MAX_ROWS) return { error: `At most ${MAX_ROWS} demo rows.` };
        if (JSON.stringify(body.demo_rows).length > 300000) return { error: "The demo rows are too large." };
        out.demo_rows = body.demo_rows;
    }
    if (has("options")) {
        if (!body.options || typeof body.options !== "object" || Array.isArray(body.options)) return { error: "options must be an object." };
        if (JSON.stringify(body.options).length > 4000) return { error: "The options are too large." };
        out.options = body.options;
    }
    return { value: out };
}

// A section may only go live with a query that passes the check.
function liveProblem(section) {
    if (section.mode !== "live") return null;
    const check = validateSectionQuery(section.query);
    return check.ok ? null : `This section cannot be switched to Live: ${check.error}`;
}

router.get("/sections", ...SUPER, async (req, res) => {
    try {
        const sections = await loadSections();
        res.json({
            error: false,
            data: {
                sections: sections.map((section) => ({ ...section, id: String(section._id) })),
                widgets: WIDGETS,
                parameters: ALLOWED_BINDS,
                sample_queries: SAMPLE_QUERY_BY_TYPE,
                sample_rows: SAMPLE_ROWS_BY_TYPE,
                limits: { rows: MAX_ROWS, query_length: MAX_QUERY_LENGTH },
            },
        });
    } catch (e) {
        console.error("[CUSTOMER360_SECTIONS] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});

router.post("/sections", ...SUPER, async (req, res) => {
    try {
        const key = String(req.body?.key || "").trim().toLowerCase();
        if (!/^[a-z][a-z0-9_]{1,39}$/.test(key)) {
            return res.status(400).json({ error: true, message: "The short name must start with a letter and use only small letters, digits and _ (2 to 40 characters)." });
        }
        const parsed = readSection(req.body);
        if (parsed.error) return res.status(400).json({ error: true, message: parsed.error });

        const section = { mode: "demo", query: "", demo_rows: [], ...parsed.value, key };
        const problem = liveProblem(section);
        if (problem) return res.status(400).json({ error: true, message: problem });
        if (await Customer360Section.exists({ key })) {
            return res.status(400).json({ error: true, message: "A section with this short name already exists." });
        }

        const saved = await new Customer360Section({
            ...section, built_in: false, version: 1, updated_by: String(req.user.user || ""), updated_at: new Date(),
        }).save();
        audit(req, "section_create", { section_key: key, details: { title: saved.title, type: saved.type, mode: saved.mode } });
        res.status(201).json({ error: false, message: "Section added", data: { ...saved.toObject(), id: String(saved._id) } });
    } catch (e) {
        console.error("[CUSTOMER360_SECTION_CREATE] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});

router.put("/sections/:id", ...SUPER, async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) return res.status(400).json({ error: true, message: "Invalid section" });
        const current = await Customer360Section.findById(req.params.id).lean();
        if (!current) return res.status(404).json({ error: true, message: "Section not found" });

        const parsed = readSection(req.body, { partial: true });
        if (parsed.error) return res.status(400).json({ error: true, message: parsed.error });

        const next = { ...current, ...parsed.value };
        const problem = liveProblem(next);
        if (problem) return res.status(400).json({ error: true, message: problem });

        const saved = await Customer360Section.findByIdAndUpdate(
            current._id,
            { $set: { ...parsed.value, updated_by: String(req.user.user || ""), updated_at: new Date() }, $inc: { version: 1 } },
            { new: true }
        ).lean();

        audit(req, "section_update", {
            section_key: current.key,
            details: {
                changed: Object.keys(parsed.value),
                mode_before: current.mode, mode_after: saved.mode,
                ...(parsed.value.query !== undefined && parsed.value.query !== current.query
                    ? { query_before: current.query, query_after: saved.query } : {}),
            },
        });
        res.json({ error: false, message: "Saved", data: { ...saved, id: String(saved._id) } });
    } catch (e) {
        console.error("[CUSTOMER360_SECTION_UPDATE] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});

router.delete("/sections/:id", ...SUPER, async (req, res) => {
    try {
        if (!isObjectId(req.params.id)) return res.status(400).json({ error: true, message: "Invalid section" });
        const removed = await Customer360Section.findByIdAndDelete(req.params.id).lean();
        if (!removed) return res.status(404).json({ error: true, message: "Section not found" });
        audit(req, "section_delete", { section_key: removed.key, details: { title: removed.title, query: removed.query } });
        res.json({ error: false, message: "Section removed" });
    } catch (e) {
        console.error("[CUSTOMER360_SECTION_DELETE] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});

// Brings back any built-in section that was removed. Sections that exist are left as they are.
router.post("/sections/restore_defaults", ...SUPER, async (req, res) => {
    try {
        await ensureDefaultSections({ force: true });
        audit(req, "section_create", { section_key: "*", details: { restored_defaults: true } });
        res.json({ error: false, message: "Built-in sections restored" });
    } catch (e) {
        console.error("[CUSTOMER360_RESTORE] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});

const customerFromInput = (input) => {
    const account = /^\d{16}$/.test(String(input?.account_number || "").trim()) ? String(input.account_number).trim() : "";
    const cif = /^[A-Za-z0-9]{1,20}$/.test(String(input?.cif || "").trim()) ? String(input.cif).trim() : cifFromAccount(account);
    const branch = /^[A-Za-z0-9]{1,10}$/.test(String(input?.branch_code || "").trim()) ? String(input.branch_code).trim() : "";
    return { cif, account_number: account, branch_code: branch };
};

// Checks a query. With `run`, also runs it once for the given customer and returns the rows.
router.post("/sections/test", ...SUPER, async (req, res) => {
    try {
        const type = WIDGET_TYPES.includes(req.body?.type) ? req.body.type : "table";
        const check = validateSectionQuery(req.body?.query);
        if (!check.ok) return res.json({ error: false, data: { ok: false, error: check.error } });
        if (req.body?.run !== true) return res.json({ error: false, data: { ok: true, checked_only: true, binds_used: check.binds } });

        const customer = customerFromInput(req.body);
        if (!customer.cif && !customer.account_number) {
            return res.status(400).json({ error: true, message: "Give a customer number or a 16-digit account number to run the query for." });
        }
        const result = await testQuery({ type, query: check.sql, customer });
        audit(req, "query_test", {
            cif: customer.cif, account_number: customer.account_number, section_key: String(req.body?.key || ""),
            details: { ok: result.ok, ms: result.ms, rows: result.row_count, query: check.sql },
        });
        res.json({ error: false, data: result });
    } catch (e) {
        console.error("[CUSTOMER360_TEST] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});

// Shows how demo rows will look, without touching FlexCube (the editor's preview).
router.post("/sections/prepare", ...SUPER, (req, res) => {
    const type = WIDGET_TYPES.includes(req.body?.type) ? req.body.type : "table";
    const prepared = prepareRows(type, Array.isArray(req.body?.rows) ? req.body.rows : []);
    res.json({ error: false, data: prepared });
});

// The whole page for any customer, as the branch staff would see it. Database messages are
// included, so that a failing section can be fixed.
router.get("/preview", ...SUPER, async (req, res) => {
    try {
        const customer = customerFromInput(req.query);
        const sections = await buildSections(customer, { showErrors: true, useCache: false });
        audit(req, "preview", { cif: customer.cif, account_number: customer.account_number });
        res.json({
            error: false,
            data: {
                arrival: {
                    id: "preview",
                    customer_name: String(req.query.name || "").trim().slice(0, 80) || "Selam Tesfaye",
                    request_type: "deposit",
                    request_label: "Preview",
                    queue_number: "",
                    assigned_to: "",
                    assigned_by: "system",
                    account_tail: customer.account_number.slice(-4),
                    cif: customer.cif,
                    simulated: true,
                    arrived_at: new Date(),
                    seen: true,
                },
                sections,
                has_demo: sections.some((section) => section.mode !== "live"),
            },
        });
    } catch (e) {
        console.error("[CUSTOMER360_PREVIEW] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});

// Who looked at which customer, who changed which query. Newest first.
router.get("/audit", ...SUPER, async (req, res) => {
    try {
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const filter = {};
        if (req.query.cif) filter.cif = String(req.query.cif);
        if (req.query.action) filter.action = String(req.query.action);
        const entries = await Customer360Audit.find(filter).sort({ at: -1 }).limit(limit).lean();
        res.json({ error: false, data: entries });
    } catch (e) {
        console.error("[CUSTOMER360_AUDIT] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not perform the operation" });
    }
});

export default router;

import mongoose from "mongoose";

const Schema = mongoose.Schema;

// ---------------------------------------------------------------------------------------------
// Customer 360: the page a branch manager (and the roles they allow) sees when a customer's
// request has been assigned to a teller. Four collections:
//   customer360sections   what the page is made of (managed by the Super Admin)
//   customer360settings   which roles of a branch may see it (managed by the branch's Admin)
//   customerarrivals      one record per assigned request: the notification
//   customer360audits     who looked at which customer, who changed which query
// ---------------------------------------------------------------------------------------------

export const WIDGET_TYPES = ["profile", "details", "text", "chips", "stats", "gauges", "line", "bars", "donut", "table"];
export const PLACEMENTS = ["side", "main"];
export const SECTION_MODES = ["demo", "live"];

const sectionSchema = new Schema({
    // Short name used in URLs and logs, e.g. "cash_flow".
    key: { type: String, required: true, unique: true, trim: true, lowercase: true, match: /^[a-z][a-z0-9_]{1,39}$/ },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    type: { type: String, required: true, enum: WIDGET_TYPES },
    // "side" = the narrow left column, "main" = the wide area (12 columns, see width).
    placement: { type: String, enum: PLACEMENTS, default: "main" },
    width: { type: Number, min: 3, max: 12, default: 6 },
    order: { type: Number, default: 100 },
    enabled: { type: Boolean, default: true },
    // demo = show demo_rows; live = run the query against FlexCube.
    mode: { type: String, enum: SECTION_MODES, default: "demo" },
    // A single SELECT. May use :cif, :account_number and :branch_code (utils/rms/customer360/sqlGuard.js).
    query: { type: String, default: "", maxlength: 8000 },
    // What the query would return, as rows. Shown while mode is "demo".
    demo_rows: { type: [Schema.Types.Mixed], default: [] },
    // Display options of the widget (prefix, badge, note …).
    options: { type: Schema.Types.Mixed, default: {} },
    // Counts every saved change; part of the cache key, so an edited query is never served stale.
    version: { type: Number, default: 1 },
    built_in: { type: Boolean, default: false },
    updated_by: { type: String, default: "" },
    updated_at: { type: Date, default: Date.now },
}, { minimize: false });

sectionSchema.index({ order: 1 });

const settingSchema = new Schema({
    branch: { type: String, required: true, unique: true, trim: true },
    // Roles that may see Customer 360 in this branch, next to the Admin (who always may).
    roles: { type: [String], default: ["Authorizer"] },
    updated_by: { type: String, default: "" },
    updated_at: { type: Date, default: Date.now },
});

const arrivalSchema = new Schema({
    branch: { type: String, required: true, trim: true },
    // The request that was assigned. Empty for a simulated arrival.
    request_id: { type: String, default: null },
    request_type: { type: String, default: "" },
    customer_name: { type: String, default: "" },
    account_number: { type: String, default: "" },
    cif: { type: String, default: "" },
    queue_number: { type: String, default: "" },
    assigned_to: { type: String, default: "" },
    // "system" = assigned automatically when the customer asked for a teller,
    // "teller" = a teller took the request herself.
    assigned_by: { type: String, default: "system" },
    simulated: { type: Boolean, default: false },
    arrived_at: { type: Date, default: Date.now },
    seen_by: { type: [{ _id: false, user_id: String, at: Date }], default: [] },
});

// One arrival per request, however often it is assigned.
arrivalSchema.index({ request_id: 1 }, { unique: true, partialFilterExpression: { request_id: { $type: "string" } } });
arrivalSchema.index({ branch: 1, arrived_at: -1 });
// Arrivals are notifications, not records: the request itself stays in its own collection.
arrivalSchema.index({ arrived_at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

const auditSchema = new Schema({
    at: { type: Date, default: Date.now },
    user_id: { type: String, default: "" },
    user: { type: String, default: "" },
    role: { type: String, default: "" },
    branch: { type: String, default: "" },
    // view | reveal | preview | query_test | section_create | section_update | section_delete |
    // settings_update | simulate
    action: { type: String, required: true },
    cif: { type: String, default: "" },
    account_number: { type: String, default: "" },
    arrival_id: { type: String, default: "" },
    section_key: { type: String, default: "" },
    details: { type: Schema.Types.Mixed, default: {} },
}, { minimize: false });

auditSchema.index({ at: -1 });
auditSchema.index({ cif: 1, at: -1 });

export const Customer360Section = mongoose.models.Customer360Section || mongoose.model("Customer360Section", sectionSchema);
export const Customer360Setting = mongoose.models.Customer360Setting || mongoose.model("Customer360Setting", settingSchema);
export const CustomerArrival = mongoose.models.CustomerArrival || mongoose.model("CustomerArrival", arrivalSchema);
export const Customer360Audit = mongoose.models.Customer360Audit || mongoose.model("Customer360Audit", auditSchema);

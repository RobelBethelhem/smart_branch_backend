// Builds the content of a Customer 360 page for one customer: demo rows for sections in demo
// mode, the result of the section's query for sections in live mode.

import { Customer360Section } from "../../../models/rms/Customer360.js";
import { executeReadOnlyBatch } from "../../../lib/db.js";
import { DEFAULT_SECTIONS } from "./defaults.js";
import { validateSectionQuery, bindsFor } from "./sqlGuard.js";
import { prepareRows, MAX_ROWS } from "./widgets.js";

// One section query may take this long; the page shows "could not be loaded" after that.
const QUERY_TIMEOUT_MS = Math.max(1000, parseInt(process.env.CUSTOMER360_QUERY_TIMEOUT_MS, 10) || 15000);

// Several people open the same arrival within a minute or two (the manager, the authorizer,
// the teller). The rows a live query returned are kept that long, so FlexCube is asked once.
const cacheSeconds = parseInt(process.env.CUSTOMER360_CACHE_SECONDS ?? "", 10);
const CACHE_MS = (Number.isNaN(cacheSeconds) ? 120 : Math.max(0, cacheSeconds)) * 1000;      // 0 switches it off
const CACHE_MAX_ENTRIES = 500;
const cache = new Map();

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_MS) {
        cache.delete(key);
        return null;
    }
    return hit.rows;
}

function cacheSet(key, rows) {
    if (CACHE_MS === 0) return;
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { rows, at: Date.now() });
}

let defaultsChecked = false;

/** Puts the built-in sections in place the first time Customer 360 is used. Never overwrites. */
export async function ensureDefaultSections({ force = false } = {}) {
    if (defaultsChecked && !force) return;
    await Promise.all(DEFAULT_SECTIONS.map((section) => Customer360Section.updateOne(
        { key: section.key },
        { $setOnInsert: { ...section, mode: "demo", enabled: true, built_in: true, version: 1, updated_by: "system", updated_at: new Date() } },
        { upsert: true }
    )));
    defaultsChecked = true;
}

export async function loadSections({ onlyEnabled = false } = {}) {
    await ensureDefaultSections();
    const filter = onlyEnabled ? { enabled: true } : {};
    return Customer360Section.find(filter).sort({ order: 1, title: 1 }).lean();
}

const shell = (section) => ({
    key: section.key,
    title: section.title,
    type: section.type,
    placement: section.placement || "main",
    width: section.width || 6,
    mode: section.mode,
    options: section.options || {},
});

/**
 * @param {{ cif: string, account_number: string, branch_code: string }} customer
 * @param {{ reveal?: boolean, sections?: object[], showErrors?: boolean, useCache?: boolean }} options
 *   showErrors: put the database's own message in the result (Super Admin preview only).
 * @returns {Promise<object[]>} one entry per enabled section, in page order
 */
export async function buildSections(customer, { reveal = false, sections = null, showErrors = false, useCache = true } = {}) {
    const list = sections || await loadSections({ onlyEnabled: true });
    const output = new Map();
    const toRun = [];

    for (const section of list) {
        if (section.mode !== "live") {
            const prepared = prepareRows(section.type, section.demo_rows || [], { reveal });
            output.set(section.key, { ...shell(section), rows: prepared.rows, has_sensitive: prepared.has_sensitive });
            continue;
        }

        const check = validateSectionQuery(section.query);
        if (!check.ok) {
            output.set(section.key, {
                ...shell(section), rows: [], has_sensitive: false,
                error: showErrors ? check.error : "This section could not be loaded.",
            });
            continue;
        }

        const cacheKey = `${section._id}:${section.version}:${customer.cif}:${customer.account_number}:${customer.branch_code}`;
        const cached = useCache ? cacheGet(cacheKey) : null;
        if (cached) {
            const prepared = prepareRows(section.type, cached, { reveal });
            output.set(section.key, { ...shell(section), rows: prepared.rows, has_sensitive: prepared.has_sensitive });
            continue;
        }
        toRun.push({ section, cacheKey, key: section.key, sql: check.sql, binds: bindsFor(check.binds, customer) });
    }

    if (toRun.length > 0) {
        const results = await executeReadOnlyBatch(
            toRun.map(({ key, sql, binds }) => ({ key, sql, binds })),
            { timeoutMs: QUERY_TIMEOUT_MS, maxRows: MAX_ROWS }
        );
        results.forEach((result, index) => {
            const { section, cacheKey } = toRun[index];
            if (!result.success) {
                console.error(`[CUSTOMER360] section "${section.key}" failed after ${result.ms} ms: ${result.error}`);
                output.set(section.key, {
                    ...shell(section), rows: [], has_sensitive: false,
                    error: showErrors ? result.error : "This section could not be loaded.",
                });
                return;
            }
            cacheSet(cacheKey, result.rows);
            const prepared = prepareRows(section.type, result.rows, { reveal });
            output.set(section.key, {
                ...shell(section), rows: prepared.rows, has_sensitive: prepared.has_sensitive,
                ...(showErrors && prepared.problems.length ? { problems: prepared.problems } : {}),
            });
        });
    }

    return list.map((section) => output.get(section.key)).filter(Boolean);
}

/** Runs one query once, without the cache: the Test button of the Super Admin. */
export async function testQuery({ type, query, customer }) {
    const check = validateSectionQuery(query);
    if (!check.ok) return { ok: false, error: check.error };

    const [result] = await executeReadOnlyBatch(
        [{ key: "test", sql: check.sql, binds: bindsFor(check.binds, customer) }],
        { timeoutMs: QUERY_TIMEOUT_MS, maxRows: MAX_ROWS }
    );
    if (!result.success) return { ok: false, error: result.error, ms: result.ms };

    const prepared = prepareRows(type, result.rows, { reveal: false });
    return {
        ok: true,
        ms: result.ms,
        row_count: result.rows.length,
        columns: result.rows[0] ? Object.keys(result.rows[0]) : [],
        rows: prepared.rows,
        problems: prepared.problems,
        binds_used: check.binds,
    };
}

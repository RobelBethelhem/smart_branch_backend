// What each kind of Customer 360 section expects from its rows, and how rows are prepared for
// the browser. A "row" is what a query returns: an object with column names as keys. Oracle
// returns the names in capitals, demo rows may use any case; both end up in lower case here.

// Shown to the Super Admin next to the query editor, and used to check demo rows.
export const WIDGETS = {
    profile: {
        label: "Customer header",
        description: "The card with the customer's name. One row.",
        columns: [
            { name: "NAME", required: false, note: "Customer name. The name on the request is used when this is empty." },
            { name: "CIF", required: false, note: "Customer number." },
            { name: "SINCE", required: false, note: "Customer since, e.g. a date or 'Mar 2014'." },
            { name: "SEGMENT", required: false, note: "Shown as a tag, e.g. 'Priority · VIP'." },
            { name: "KYC_STATUS", required: false, note: "Shown as a tag, e.g. 'KYC verified'." },
            { name: "PHOTO", required: false, note: "Customer photo as base64 text." },
        ],
    },
    details: {
        label: "List of details",
        description: "Label and value pairs, one row each.",
        columns: [
            { name: "LABEL", required: true },
            { name: "VALUE", required: true },
            { name: "SENSITIVE", required: false, note: "Y hides most of the value until the user asks to reveal it (logged)." },
        ],
    },
    text: {
        label: "Text",
        description: "One paragraph per row.",
        columns: [{ name: "TEXT", required: true }],
    },
    chips: {
        label: "Highlights",
        description: "Short one-line notes, one row each.",
        columns: [
            { name: "TEXT", required: true },
            { name: "TONE", required: false, note: "info, good, warn or bad." },
        ],
    },
    stats: {
        label: "Figures",
        description: "One tile per row.",
        columns: [
            { name: "LABEL", required: true },
            { name: "VALUE", required: true, note: "A number or a text." },
            { name: "PREFIX", required: false, note: "Shown before the value, e.g. ETB." },
            { name: "SUBTEXT", required: false },
            { name: "TREND", required: false, note: "e.g. '+9.4% vs prior 3M'." },
        ],
    },
    gauges: {
        label: "Scores",
        description: "One ring per row.",
        columns: [
            { name: "LABEL", required: true },
            { name: "VALUE", required: true, note: "A number." },
            { name: "MAX", required: true, note: "The value of a full ring." },
            { name: "DISPLAY", required: false, note: "Text inside the ring, e.g. '11%'. The value when empty." },
            { name: "CAPTION", required: false, note: "e.g. 'Healthy'." },
            { name: "TONE", required: false, note: "good, warn or bad." },
        ],
    },
    line: {
        label: "Trend chart",
        description: "One point per row, in the order returned.",
        columns: [
            { name: "LABEL", required: true, note: "e.g. the month." },
            { name: "VALUE", required: true, note: "A number." },
            { name: "NOTE", required: false, note: "A sentence under the chart (first row that has one)." },
        ],
    },
    bars: {
        label: "In and out chart",
        description: "Two bars per row.",
        columns: [
            { name: "LABEL", required: true, note: "e.g. the month." },
            { name: "VALUE_IN", required: true, note: "A number." },
            { name: "VALUE_OUT", required: true, note: "A number." },
            { name: "NOTE", required: false },
        ],
    },
    donut: {
        label: "Share chart",
        description: "One slice per row.",
        columns: [
            { name: "LABEL", required: true },
            { name: "VALUE", required: true, note: "A number." },
            { name: "HIGHLIGHT", required: false, note: "Y adds the slice to the figure in the middle." },
            { name: "NOTE", required: false },
        ],
    },
    table: {
        label: "Table",
        description: "The rows as they are. The column names become the headings.",
        columns: [],
    },
};

const NUMERIC_COLUMNS = {
    stats: [], gauges: ["value", "max"], line: ["value"], bars: ["value_in", "value_out"], donut: ["value"],
};

export const MAX_ROWS = 200;
const MAX_CELL_LENGTH = 4000;
const MAX_PHOTO_LENGTH = 1500000;     // about 1.1 MB of image

const isYes = (value) => value === true || value === 1 || ["Y", "YES", "TRUE", "1"].includes(String(value ?? "").trim().toUpperCase());

function cell(value, column) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return value.toString("base64").slice(0, MAX_PHOTO_LENGTH);
    if (typeof value === "number" || typeof value === "boolean") return value;
    const text = String(value);
    return text.slice(0, column === "photo" ? MAX_PHOTO_LENGTH : MAX_CELL_LENGTH);
}

/** Hides most of a value. What stays visible depends on what the value looks like. */
export function maskValue(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    const at = text.indexOf("@");
    if (at > 0) return `${text[0]}•••••${text.slice(at)}`;                          // e-mail
    const digits = text.replace(/\D/g, "");
    if (digits.length >= 9 && /^[+\d\s()-]+$/.test(text)) {                         // phone
        const lead = text.startsWith("+") ? `+${digits.slice(0, 3)} ${digits.slice(3, 5)}` : digits.slice(0, 4);
        return `${lead} ••• ••${digits.slice(-2)}`;
    }
    if (text.length <= 4) return "••••";
    return `•••• ${text.slice(-4)}`;
}

/**
 * Rows as the browser gets them: lower-case column names, numbers as numbers, long values cut,
 * sensitive details masked unless `reveal` is set.
 * @returns {{ rows: object[], has_sensitive: boolean, problems: string[] }}
 */
export function prepareRows(type, rawRows, { reveal = false } = {}) {
    const widget = WIDGETS[type];
    const problems = [];
    if (!widget) return { rows: [], has_sensitive: false, problems: [`Unknown section type "${type}".`] };
    if (!Array.isArray(rawRows)) return { rows: [], has_sensitive: false, problems: ["The rows are not a list."] };

    const numeric = NUMERIC_COLUMNS[type] || [];
    let hasSensitive = false;
    const rows = rawRows.slice(0, MAX_ROWS).filter((row) => row && typeof row === "object").map((row) => {
        const out = {};
        for (const [name, value] of Object.entries(row)) {
            // A table shows the column names as headings, so they are kept as written.
            const column = type === "table" ? String(name) : String(name).toLowerCase();
            out[column] = cell(value, column.toLowerCase());
        }
        for (const column of numeric) {
            if (out[column] !== null && out[column] !== undefined && out[column] !== "") {
                const number = Number(out[column]);
                out[column] = Number.isFinite(number) ? number : null;
            }
        }
        if (type === "details") {
            const sensitive = isYes(out.sensitive);
            out.sensitive = sensitive;
            if (sensitive) {
                hasSensitive = true;
                if (!reveal) out.value = maskValue(out.value);
                out.masked = !reveal;
            }
        }
        if (type === "donut") out.highlight = isYes(out.highlight);
        return out;
    });

    const first = rows[0] || {};
    if (rows.length > 0) {
        for (const column of widget.columns.filter((c) => c.required)) {
            if (!(column.name.toLowerCase() in first)) problems.push(`The column ${column.name} is missing.`);
        }
    }
    return { rows, has_sensitive: hasSensitive, problems };
}

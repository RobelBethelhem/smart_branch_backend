// Checks a Customer 360 section query before it is saved and again before it is run.
//
// These queries are typed into a web page by the Super Admin and run against FlexCube, so
// they are held to one shape: a single SELECT that only reads, with the customer passed as
// bind parameters. This check is the first of three guards. The second is that every query
// runs inside a read-only transaction (lib/db.js, executeReadOnly). The third, and the one
// that really counts, is the FlexCube user itself: it should have SELECT rights only.

// The only parameters a query may use. The server fills them in; nothing typed by a user
// reaches the SQL text.
export const ALLOWED_BINDS = ["cif", "account_number", "branch_code"];

const FORBIDDEN_WORDS = [
    "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "DROP", "ALTER", "CREATE", "TRUNCATE", "RENAME",
    "GRANT", "REVOKE", "EXECUTE", "EXEC", "CALL", "BEGIN", "DECLARE", "COMMIT", "ROLLBACK", "SAVEPOINT",
    "LOCK", "PURGE", "FLASHBACK", "AUDIT", "NOAUDIT", "COMMENT", "ANALYZE", "EXPLAIN",
];

// Packages that can reach outside the database or change things from inside a SELECT.
const FORBIDDEN_PREFIXES = ["DBMS_", "UTL_", "SYS.", "OWA_", "HTP.", "CTX_"];

export const MAX_QUERY_LENGTH = 8000;

// Replaces comments and quoted text by spaces, so that the checks below look at SQL only.
// 'O''Brien' and "Column Name" are skipped as a whole; the length of the text is kept.
function withoutLiteralsAndComments(sql) {
    let out = "";
    let i = 0;
    while (i < sql.length) {
        const two = sql.slice(i, i + 2);
        if (two === "--") {
            const end = sql.indexOf("\n", i);
            const stop = end === -1 ? sql.length : end;
            out += " ".repeat(stop - i);
            i = stop;
        } else if (two === "/*") {
            const end = sql.indexOf("*/", i + 2);
            if (end === -1) return { text: out, error: "A comment is opened with /* but never closed." };
            out += " ".repeat(end + 2 - i);
            i = end + 2;
        } else if (sql[i] === "'" || sql[i] === '"') {
            const quote = sql[i];
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === quote && sql[j + 1] === quote) j += 2;      // doubled quote inside the text
                else if (sql[j] === quote) break;
                else j += 1;
            }
            if (j >= sql.length) return { text: out, error: "A quote is opened but never closed." };
            out += " ".repeat(j + 1 - i);
            i = j + 1;
        } else {
            out += sql[i];
            i += 1;
        }
    }
    return { text: out, error: null };
}

/**
 * @param {string} sql
 * @returns {{ ok: boolean, error?: string, binds: string[], sql: string }}
 *   binds: the parameters the query uses, in the order they must be supplied.
 */
export function validateSectionQuery(sql) {
    const text = typeof sql === "string" ? sql.trim() : "";
    const fail = (error) => ({ ok: false, error, binds: [], sql: text });

    if (!text) return fail("The query is empty.");
    if (text.length > MAX_QUERY_LENGTH) return fail(`The query is longer than ${MAX_QUERY_LENGTH} characters.`);

    const stripped = withoutLiteralsAndComments(text);
    if (stripped.error) return fail(stripped.error);
    const code = stripped.text;
    const upper = code.toUpperCase();

    if (code.includes(";")) return fail("Write one statement only, without a semicolon.");
    if (!/^\s*(SELECT|WITH)\b/.test(upper)) return fail("The query must start with SELECT (or WITH … SELECT).");

    for (const word of FORBIDDEN_WORDS) {
        if (new RegExp(`(^|[^A-Z0-9_$#])${word}([^A-Z0-9_$#]|$)`).test(upper)) {
            return fail(`"${word}" is not allowed. A section query may only read data.`);
        }
    }
    if (/\bFOR\s+UPDATE\b/.test(upper)) return fail('"FOR UPDATE" is not allowed. A section query may only read data.');
    if (/\bINTO\b/.test(upper)) return fail('"INTO" is not allowed. A section query may only read data.');
    for (const prefix of FORBIDDEN_PREFIXES) {
        if (new RegExp(`(^|[^A-Z0-9_$#])${prefix.replace(".", "\\.")}`).test(upper)) {
            return fail(`"${prefix}…" is not allowed in a section query.`);
        }
    }
    if (code.includes("@")) return fail('Database links ("@") are not allowed in a section query.');

    // Bind parameters: :name. (A "::" or ":=" would not be valid here anyway.)
    const binds = [];
    const bindPattern = /:([A-Za-z_][A-Za-z0-9_]*|\d+)/g;
    let match;
    while ((match = bindPattern.exec(code)) !== null) {
        const name = match[1].toLowerCase();
        if (!ALLOWED_BINDS.includes(name)) {
            return fail(`Unknown parameter ":${match[1]}". Use ${ALLOWED_BINDS.map((b) => ":" + b).join(", ")}.`);
        }
        if (!binds.includes(name)) binds.push(name);
    }
    if (!binds.includes("cif") && !binds.includes("account_number")) {
        return fail("The query must use :cif or :account_number, otherwise it would return the same data for every customer.");
    }

    return { ok: true, binds, sql: text };
}

/** The bind object for one customer: only the parameters the query really uses. */
export function bindsFor(bindNames, customer) {
    const values = {
        cif: String(customer.cif || ""),
        account_number: String(customer.account_number || ""),
        branch_code: String(customer.branch_code || ""),
    };
    const out = {};
    for (const name of bindNames) out[name] = values[name];
    return out;
}

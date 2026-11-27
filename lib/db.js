// import oracledb from 'oracledb';

// // Initialize Oracle client
// let oracleInitialized = false;
// let dbConfig = null;

// // Optional default schema for connections that authenticate as a user which is
// // NOT the Flexcube schema owner (e.g. a "smartbranch" user with only SELECT
// // grants). Set FLEXCUBE_SCHEMA so UNqualified table names resolve to the owner's
// // schema. Sanitised because it is interpolated into ALTER SESSION (can't bind).
// const FLEXCUBE_SCHEMA = (process.env.FLEXCUBE_SCHEMA || '').replace(/[^A-Za-z0-9_$#]/g, '');

// // Runs once per newly-created pooled connection.
// async function initSession(connection, _requestedTag) {
//     if (FLEXCUBE_SCHEMA) {
//         await connection.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${FLEXCUBE_SCHEMA}`);
//     }
// }

// // Export initialization function to be called after dotenv config()
// export async function initializeOracle() {
//     // Set database configuration from env
//     dbConfig = {
//         user: process.env.FLEXCUBE_DB_USER,
//         password: process.env.FLEXCUBE_DB_PASSWORD,
//         connectString: process.env.FLEXCUBE_DB_CONNECTION_STRING,
//     };

//     try {
//         if (process.env.ORACLE_CLIENT_PATH) {
//             oracledb.initOracleClient({ libDir: process.env.ORACLE_CLIENT_PATH });
//             oracleInitialized = true;
//             console.log('Oracle Client initialized successfully');

//             // Create connection pool
//             try {
//                 await oracledb.createPool({
//                     ...dbConfig,
//                     poolMin: 2,
//                     poolMax: 10,
//                     poolIncrement: 2,
//                     sessionCallback: initSession
//                 });
//                 console.log('Oracle connection pool created successfully');
//             } catch (err) {
//                 console.error('Pool creation error:', err.message);
//                 console.warn('Oracle database features may not work correctly');
//             }
//         } else {
//             console.warn('ORACLE_CLIENT_PATH not set - Oracle features will be disabled');
//         }
//     } catch (err) {
//         console.error('Oracle Client initialization error:', err.message);
//         console.warn('Oracle features will be disabled. To enable, install Oracle Instant Client and set ORACLE_CLIENT_PATH in .env');
//     }
// }

// // Get connection from pool
// async function getConnection() {
//     if (!oracleInitialized) {
//         throw new Error('Oracle client not initialized');
//     }
//     try {
//         // Check out from the pool created in initializeOracle() instead of
//         // opening a brand-new standalone connection (TCP + auth handshake) per
//         // query. Under branch-scale concurrency the per-query connect was a
//         // logon storm risking ORA-12516 / max-session errors. `connection.close()`
//         // in the finally blocks correctly returns the connection to the pool.
//         // Falls back to a direct connection if the pool wasn't created.
//         let pool = null;
//         try { pool = oracledb.getPool(); } catch (_) { pool = null; }
//         const connection = pool
//             ? await pool.getConnection()
//             : await oracledb.getConnection(dbConfig);
//         return connection;
//     } catch (err) {
//         console.error('Error getting database connection:', err);
//         throw err;
//     }
// }

// /**
//  * Execute a query with parameters
//  * @param {string} query - The SQL query to execute
//  * @param {Array} params - Array of parameters for the query
//  * @param {Object} options - Additional options for the query (optional)
//  * @returns {Promise<{success: boolean, data?: any[], rowsAffected?: number, error?: string}>}
//  */
// export async function executeQuery(query, params = [], options = {}) {
//     if (!oracleInitialized) {
//         return {
//             success: false,
//             error: 'Oracle client not initialized'
//         };
//     }

//     let connection;

//     try {
//         // Set some default options for oracledb
//         oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
//         oracledb.fetchAsString = [oracledb.CLOB];
//         oracledb.fetchAsBuffer = [oracledb.BLOB];

//         // Get connection
//         connection = await getConnection();

//         // Detect if this is a DML statement (INSERT, UPDATE, DELETE) that needs commit
//         const queryUpper = query.trim().toUpperCase();
//         const isDML = queryUpper.startsWith('INSERT') ||
//                       queryUpper.startsWith('UPDATE') ||
//                       queryUpper.startsWith('DELETE') ||
//                       queryUpper.startsWith('MERGE');

//         // Execute query with parameters
//         // IMPORTANT: autoCommit: true for DML statements to persist changes
//         const result = await connection.execute(
//             query,
//             params,
//             {
//                 maxRows: 1000,
//                 autoCommit: isDML, // Auto-commit for INSERT/UPDATE/DELETE
//                 ...options
//             }
//         );

//         // Return successful result with rowsAffected for DML statements
//         return {
//             success: true,
//             data: result.rows || [],
//             rowsAffected: result.rowsAffected || 0
//         };

//     } catch (error) {
//         console.error('Database query error:', error);
//         return {
//             success: false,
//             error: error.message
//         };
//     } finally {
//         if (connection) {
//             try {
//                 // Always close the connection
//                 await connection.close();
//             } catch (err) {
//                 console.error('Error closing connection:', err);
//             }
//         }
//     }
// }

// /**
//  * Execute multiple queries in a transaction
//  * @param {Array<{query: string, params: Array}>} queries
//  * @returns {Promise<{success: boolean, error?: string}>}
//  */
// export async function executeTransaction(queries) {
//     if (!oracleInitialized) {
//         return {
//             success: false,
//             error: 'Oracle client not initialized'
//         };
//     }

//     let connection;

//     try {
//         connection = await getConnection();

//         // Start transaction
//         await connection.execute('BEGIN');

//         // Execute all queries
//         for (const { query, params } of queries) {
//             await connection.execute(query, params);
//         }

//         // Commit transaction
//         await connection.execute('COMMIT');

//         return { success: true };

//     } catch (error) {
//         if (connection) {
//             try {
//                 // Rollback on error
//                 await connection.execute('ROLLBACK');
//             } catch (rollbackError) {
//                 console.error('Rollback error:', rollbackError);
//             }
//         }

//         console.error('Transaction error:', error);
//         return {
//             success: false,
//             error: error.message
//         };
//     } finally {
//         if (connection) {
//             try {
//                 await connection.close();
//             } catch (err) {
//                 console.error('Error closing connection:', err);
//             }
//         }
//     }
// }

// // Optional: Pool management functions
// export async function closePool() {
//     try {
//         await oracledb.getPool().close(10);
//     } catch (err) {
//         console.error('Error closing pool:', err);
//     }
// }

// // Handle process termination
// process.on('SIGINT', async () => {
//     try {
//         await closePool();
//     } finally {
//         process.exit(0);
//     }
// });











































































import oracledb from 'oracledb';

// ============================================================
// Oracle Database Configuration
// ============================================================

let oracleInitialized = false;
let dbConfig = null;
let oraclePool = null;

// Optional default schema for connections that authenticate as a
// user which is NOT the Flexcube schema owner.
const FLEXCUBE_SCHEMA = (process.env.FLEXCUBE_SCHEMA || '')
    .replace(/[^A-Za-z0-9_$#]/g, '');

// Prevent shutdown handler from running more than once
let isClosing = false;


// ============================================================
// Keep-alive for idle connections
// ============================================================

// The pool keeps its FlexCube connections open while nobody uses them, and a firewall sits
// between the app server and FlexCube. Firewalls commonly drop connections that stay idle,
// without telling either side. As a precaution a keep-alive probe is sent on idle connections:
// Oracle Client (19c or later) does that when the Easy Connect string carries expire_time
// (minutes). It is added here so that no environment can forget it.
//   FLEXCUBE_EXPIRE_TIME   minutes between probes, default 1; 0 switches it off
// Left alone: a string that already sets expire_time, a full connect descriptor "(DESCRIPTION=…"
// (put (EXPIRE_TIME=1) inside it yourself) and a tnsnames alias (no "/").
export function withKeepAlive(connectString, minutes = process.env.FLEXCUBE_EXPIRE_TIME) {
    if (!connectString) return connectString;

    const parsed = parseInt(minutes ?? '', 10);
    const interval = Number.isNaN(parsed) ? 1 : parsed;
    const trimmed = connectString.trim();

    if (interval <= 0) return trimmed;
    if (trimmed.startsWith('(') || !trimmed.includes('/')) return trimmed;
    if (/expire_time\s*=/i.test(trimmed)) return trimmed;

    return `${trimmed}${trimmed.includes('?') ? '&' : '?'}expire_time=${interval}`;
}

// A request that waits this long for a pooled connection is logged: it means the pool is
// exhausted or its connections are not answering, not that a query is slow.
const SLOW_CONNECTION_MS = 2000;


// ============================================================
// Session Initialization
// ============================================================

// Runs once for each newly-created pooled connection, and only when FLEXCUBE_SCHEMA is set.
//
// node-oracledb calls it as (connection, requestedTag, done) and getConnection() does not
// return until done() has been called. Until November 2026 this was an async function that
// never called done(). The first use of every new pooled connection therefore never returned:
// the request hung for ever, and the pool counted that connection as in use for ever, so
// after poolMax such requests every FlexCube call waited 60 s and failed. Do not turn this
// back into an async function.
function initSession(connection, _requestedTag, done) {
    connection
        .execute(`ALTER SESSION SET CURRENT_SCHEMA = ${FLEXCUBE_SCHEMA}`)
        .then(() => done(), done);
}


// ============================================================
// Initialize Oracle Client + Connection Pool
// ============================================================

export async function initializeOracle() {
    // Read database configuration from environment variables
    dbConfig = {
        user: process.env.FLEXCUBE_DB_USER,
        password: process.env.FLEXCUBE_DB_PASSWORD,
        connectString: withKeepAlive(process.env.FLEXCUBE_DB_CONNECTION_STRING),
    };

    // Check required configuration
    if (!dbConfig.user) {
        console.error('FLEXCUBE_DB_USER is not configured');
        console.warn('Oracle database features will be disabled');
        return false;
    }

    if (!dbConfig.password) {
        console.error('FLEXCUBE_DB_PASSWORD is not configured');
        console.warn('Oracle database features will be disabled');
        return false;
    }

    if (!dbConfig.connectString) {
        console.error('FLEXCUBE_DB_CONNECTION_STRING is not configured');
        console.warn('Oracle database features will be disabled');
        return false;
    }

    // Check Oracle Client path
    if (!process.env.ORACLE_CLIENT_PATH) {
        console.warn(
            'ORACLE_CLIENT_PATH not set - Oracle features will be disabled'
        );
        return false;
    }

    try {
        // --------------------------------------------------------
        // Initialize Oracle Instant Client
        // --------------------------------------------------------

        if (!oracleInitialized) {
            oracledb.initOracleClient({
                libDir: process.env.ORACLE_CLIENT_PATH
            });

            oracleInitialized = true;

            console.log('Oracle Client initialized successfully');
        }

        // --------------------------------------------------------
        // Create connection pool
        // --------------------------------------------------------

        // Read here, not at module load: .env is only loaded after the imports have run.
        const ORACLE_POOL_MAX = Math.max(1, parseInt(process.env.FLEXCUBE_POOL_MAX, 10) || 20);
        const ORACLE_POOL_MIN = Math.min(
            ORACLE_POOL_MAX,
            Math.max(0, parseInt(process.env.FLEXCUBE_POOL_MIN ?? '', 10) || ORACLE_POOL_MAX)
        );

        try {
            oraclePool = await oracledb.createPool({
                ...dbConfig,

                // Fixed-size pool (min = max), as Oracle recommends: no logon storms when a
                // burst arrives after a quiet minute. Size comes from FLEXCUBE_POOL_MAX
                // (default 20); FLEXCUBE_POOL_MIN can lower the idle size if the DBAs ask.
                // Thick mode runs each call on a libuv thread, so UV_THREADPOOL_SIZE (set in
                // the Dockerfile) must stay above the pool size or the extra connections
                // can never be used at the same time.
                poolMin: ORACLE_POOL_MIN,
                poolMax: ORACLE_POOL_MAX,
                poolIncrement: ORACLE_POOL_MIN === ORACLE_POOL_MAX ? 0 : 2,

                // Many statements are built with a variable number of binds; a larger
                // cache keeps the common ones parsed.
                stmtCacheSize: 60,

                // Registered only when there is something to set (see initSession).
                ...(FLEXCUBE_SCHEMA ? { sessionCallback: initSession } : {}),

                // Give connections a reasonable timeout
                poolTimeout: 60,

                // Wait for a connection instead of immediately failing
                queueTimeout: 60000
            });

            console.log('Oracle connection pool created successfully');

            return true;

        } catch (err) {
            // Pool creation failed
            oraclePool = null;

            console.error('==========================================');
            console.error('Oracle connection pool creation FAILED');
            console.error('Error code:', err.code);
            console.error('Error message:', err.message);
            console.error('Full error:', err);
            console.error('==========================================');

            console.warn(
                'Oracle database features may not work correctly'
            );

            return false;
        }

    } catch (err) {
        oracleInitialized = false;
        oraclePool = null;

        console.error('==========================================');
        console.error('Oracle Client initialization FAILED');
        console.error('Error code:', err.code);
        console.error('Error message:', err.message);
        console.error('Full error:', err);
        console.error('==========================================');

        console.warn(
            'Oracle features will be disabled. ' +
            'Check Oracle Instant Client installation and ORACLE_CLIENT_PATH.'
        );

        return false;
    }
}


// ============================================================
// Get Connection From Pool
// ============================================================

async function getConnection() {
    if (!oracleInitialized) {
        throw new Error('Oracle client is not initialized');
    }

    if (!oraclePool) {
        throw new Error(
            'Oracle connection pool is not initialized. ' +
            'Check the pool creation error during application startup.'
        );
    }

    try {
        const startedAt = Date.now();
        const connection = await oraclePool.getConnection();
        const waited = Date.now() - startedAt;

        if (waited > SLOW_CONNECTION_MS) {
            console.warn(
                `[FLEXCUBE] waited ${waited} ms for a pooled connection ` +
                `(${oraclePool.connectionsInUse} of ${oraclePool.connectionsOpen} in use)`
            );
        }

        return connection;

    } catch (err) {
        console.error('Error getting database connection:', err);
        throw err;
    }
}


// ============================================================
// Execute Query
// ============================================================

/**
 * Execute a query with parameters
 *
 * @param {string} query
 * @param {Array|Object} params
 * @param {Object} options
 *
 * @returns {Promise<{
 *   success: boolean,
 *   data?: any[],
 *   rowsAffected?: number,
 *   error?: string
 * }>}
 */
export async function executeQuery(
    query,
    params = [],
    options = {}
) {
    if (!oracleInitialized) {
        return {
            success: false,
            error: 'Oracle client is not initialized'
        };
    }

    if (!oraclePool) {
        return {
            success: false,
            error:
                'Oracle connection pool is not initialized. ' +
                'Check the Oracle pool creation error in the startup logs.'
        };
    }

    let connection;

    try {
        // --------------------------------------------------------
        // Oracle output configuration
        // --------------------------------------------------------

        oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

        oracledb.fetchAsString = [
            oracledb.CLOB
        ];

        oracledb.fetchAsBuffer = [
            oracledb.BLOB
        ];

        // --------------------------------------------------------
        // Get pooled connection
        // --------------------------------------------------------

        connection = await getConnection();

        // --------------------------------------------------------
        // Detect DML
        // --------------------------------------------------------

        const queryUpper = query.trim().toUpperCase();

        const isDML =
            queryUpper.startsWith('INSERT') ||
            queryUpper.startsWith('UPDATE') ||
            queryUpper.startsWith('DELETE') ||
            queryUpper.startsWith('MERGE');

        // --------------------------------------------------------
        // Execute query
        // --------------------------------------------------------

        const result = await connection.execute(
            query,
            params,
            {
                maxRows: 1000,

                // Automatically commit INSERT/UPDATE/DELETE/MERGE
                autoCommit: isDML,

                ...options
            }
        );

        return {
            success: true,
            data: result.rows || [],
            rowsAffected: result.rowsAffected || 0
        };

    } catch (error) {
        console.error('Database query error:', error);

        return {
            success: false,
            error: error.message
        };

    } finally {
        // --------------------------------------------------------
        // Return connection to pool
        // --------------------------------------------------------

        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error(
                    'Error returning connection to pool:',
                    err
                );
            }
        }
    }
}


// ============================================================
// Execute Transaction
// ============================================================

/**
 * Execute multiple queries in a transaction.
 *
 * @param {Array<{query: string, params: Array|Object}>} queries
 *
 * @returns {Promise<{
 *   success: boolean,
 *   error?: string
 * }>}
 */
export async function executeTransaction(queries) {
    if (!oracleInitialized) {
        return {
            success: false,
            error: 'Oracle client is not initialized'
        };
    }

    if (!oraclePool) {
        return {
            success: false,
            error:
                'Oracle connection pool is not initialized. ' +
                'Check the Oracle pool creation error in the startup logs.'
        };
    }

    let connection;

    try {
        // --------------------------------------------------------
        // Get pooled connection
        // --------------------------------------------------------

        connection = await getConnection();

        // --------------------------------------------------------
        // Execute queries
        // --------------------------------------------------------

        for (const { query, params = [] } of queries) {
            await connection.execute(
                query,
                params
            );
        }

        // --------------------------------------------------------
        // Commit transaction
        // --------------------------------------------------------

        await connection.commit();

        return {
            success: true
        };

    } catch (error) {

        // --------------------------------------------------------
        // Rollback transaction
        // --------------------------------------------------------

        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error(
                    'Rollback error:',
                    rollbackError
                );
            }
        }

        console.error(
            'Transaction error:',
            error
        );

        return {
            success: false,
            error: error.message
        };

    } finally {

        // --------------------------------------------------------
        // Return connection to pool
        // --------------------------------------------------------

        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error(
                    'Error returning transaction connection to pool:',
                    err
                );
            }
        }
    }
}


// ============================================================
// Read-only batch (Customer 360 section queries)
// ============================================================

/**
 * Runs several SELECTs for one page on ONE pooled connection, inside a read-only
 * transaction: Oracle itself refuses any change (ORA-01456), whatever the SQL says. Each
 * query has its own time limit and row limit, and a query that fails does not stop the
 * others. These queries are typed in by the Super Admin, so they never get more than this.
 *
 * @param {{ key: string, sql: string, binds: object }[]} queries
 * @param {{ timeoutMs?: number, maxRows?: number }} options
 * @returns {Promise<{ key: string, success: boolean, rows?: object[], error?: string, ms: number }[]>}
 */
export async function executeReadOnlyBatch(queries, { timeoutMs = 15000, maxRows = 200 } = {}) {
    const failAll = (error) => queries.map((query) => ({ key: query.key, success: false, error, ms: 0 }));

    if (!oracleInitialized || !oraclePool) {
        return failAll('FlexCube is not connected. Check the Oracle pool creation error in the startup logs.');
    }

    let connection;
    try {
        connection = await getConnection();
    } catch (err) {
        return failAll(err.message);
    }

    const results = [];
    try {
        connection.callTimeout = timeoutMs;
        await connection.execute('SET TRANSACTION READ ONLY');

        for (const query of queries) {
            const startedAt = Date.now();
            try {
                const result = await connection.execute(query.sql, query.binds || {}, {
                    outFormat: oracledb.OUT_FORMAT_OBJECT,
                    maxRows,
                    autoCommit: false,
                    // Text columns of any size (customer photo) come back as text.
                    fetchTypeHandler: (metaData) => (
                        metaData.dbType === oracledb.DB_TYPE_CLOB || metaData.dbType === oracledb.DB_TYPE_NCLOB
                            ? { type: oracledb.STRING }
                            : undefined
                    ),
                });
                results.push({ key: query.key, success: true, rows: result.rows || [], ms: Date.now() - startedAt });
            } catch (err) {
                results.push({ key: query.key, success: false, error: err.message, ms: Date.now() - startedAt });
            }
        }
    } catch (err) {
        // Could not even start the read-only transaction: nothing is run.
        for (const query of queries.slice(results.length)) {
            results.push({ key: query.key, success: false, error: err.message, ms: 0 });
        }
    } finally {
        try { await connection.rollback(); } catch (err) { /* the connection is gone; close() reports it */ }
        try {
            await connection.close();
        } catch (err) {
            console.error('Error returning read-only connection to pool:', err);
        }
    }

    return results;
}


// ============================================================
// Close Oracle Connection Pool
// ============================================================

export async function closePool() {
    // Prevent multiple shutdown calls
    if (isClosing) {
        return;
    }

    isClosing = true;

    // No pool exists
    if (!oraclePool) {
        console.log(
            'No Oracle connection pool exists. Nothing to close.'
        );

        return;
    }

    try {
        console.log(
            'Closing Oracle connection pool...'
        );

        await oraclePool.close(10);

        oraclePool = null;

        console.log(
            'Oracle connection pool closed successfully'
        );

    } catch (err) {

        // NJS-047 means the pool does not exist anymore.
        // It is safe to ignore during shutdown.
        if (err.code === 'NJS-047') {
            console.log(
                'Oracle connection pool was already closed.'
            );

            oraclePool = null;

            return;
        }

        console.error(
            'Error closing Oracle connection pool:',
            err
        );
    }
}


// ============================================================
// Graceful Shutdown
// ============================================================

async function gracefulShutdown(signal) {
    console.log(
        `\nReceived ${signal}. Shutting down application...`
    );

    try {
        await closePool();
    } catch (err) {
        console.error(
            'Error during shutdown:',
            err
        );
    } finally {
        process.exit(0);
    }
}


// ============================================================
// Process Signal Handlers
// ============================================================

process.once('SIGINT', () => {
    gracefulShutdown('SIGINT');
});

process.once('SIGTERM', () => {
    gracefulShutdown('SIGTERM');
});
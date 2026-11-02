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
// Session Initialization
// ============================================================

// Runs once for each newly-created pooled connection.
async function initSession(connection, _requestedTag) {
    if (FLEXCUBE_SCHEMA) {
        await connection.execute(
            `ALTER SESSION SET CURRENT_SCHEMA = ${FLEXCUBE_SCHEMA}`
        );
    }
}


// ============================================================
// Initialize Oracle Client + Connection Pool
// ============================================================

export async function initializeOracle() {
    // Read database configuration from environment variables
    dbConfig = {
        user: process.env.FLEXCUBE_DB_USER,
        password: process.env.FLEXCUBE_DB_PASSWORD,
        connectString: process.env.FLEXCUBE_DB_CONNECTION_STRING,
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

        try {
            oraclePool = await oracledb.createPool({
                ...dbConfig,

                poolMin: 2,
                poolMax: 10,
                poolIncrement: 2,

                sessionCallback: initSession,

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
        const connection = await oraclePool.getConnection();

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
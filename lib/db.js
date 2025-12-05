import oracledb from 'oracledb';

// Initialize Oracle client
let oracleInitialized = false;
let dbConfig = null;

// Export initialization function to be called after dotenv config()
export async function initializeOracle() {
    // Set database configuration from env
    dbConfig = {
        user: process.env.FLEXCUBE_DB_USER,
        password: process.env.FLEXCUBE_DB_PASSWORD,
        connectString: process.env.FLEXCUBE_DB_CONNECTION_STRING,
    };

    try {
        if (process.env.ORACLE_CLIENT_PATH) {
            oracledb.initOracleClient({ libDir: process.env.ORACLE_CLIENT_PATH });
            oracleInitialized = true;
            console.log('Oracle Client initialized successfully');

            // Create connection pool
            try {
                await oracledb.createPool({
                    ...dbConfig,
                    poolMin: 2,
                    poolMax: 10,
                    poolIncrement: 2
                });
                console.log('Oracle connection pool created successfully');
            } catch (err) {
                console.error('Pool creation error:', err.message);
                console.warn('Oracle database features may not work correctly');
            }
        } else {
            console.warn('ORACLE_CLIENT_PATH not set - Oracle features will be disabled');
        }
    } catch (err) {
        console.error('Oracle Client initialization error:', err.message);
        console.warn('Oracle features will be disabled. To enable, install Oracle Instant Client and set ORACLE_CLIENT_PATH in .env');
    }
}

// Get connection from pool
async function getConnection() {
    if (!oracleInitialized) {
        throw new Error('Oracle client not initialized');
    }
    try {
        const connection = await oracledb.getConnection(dbConfig);
        return connection;
    } catch (err) {
        console.error('Error getting database connection:', err);
        throw err;
    }
}

/**
 * Execute a query with parameters
 * @param {string} query - The SQL query to execute
 * @param {Array} params - Array of parameters for the query
 * @param {Object} options - Additional options for the query (optional)
 * @returns {Promise<{success: boolean, data?: any[], rowsAffected?: number, error?: string}>}
 */
export async function executeQuery(query, params = [], options = {}) {
    if (!oracleInitialized) {
        return {
            success: false,
            error: 'Oracle client not initialized'
        };
    }

    let connection;

    try {
        // Set some default options for oracledb
        oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
        oracledb.fetchAsString = [oracledb.CLOB];
        oracledb.fetchAsBuffer = [oracledb.BLOB];

        // Get connection
        connection = await getConnection();

        // Detect if this is a DML statement (INSERT, UPDATE, DELETE) that needs commit
        const queryUpper = query.trim().toUpperCase();
        const isDML = queryUpper.startsWith('INSERT') ||
                      queryUpper.startsWith('UPDATE') ||
                      queryUpper.startsWith('DELETE') ||
                      queryUpper.startsWith('MERGE');

        // Execute query with parameters
        // IMPORTANT: autoCommit: true for DML statements to persist changes
        const result = await connection.execute(
            query,
            params,
            {
                maxRows: 1000,
                autoCommit: isDML, // Auto-commit for INSERT/UPDATE/DELETE
                ...options
            }
        );

        // Return successful result with rowsAffected for DML statements
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
        if (connection) {
            try {
                // Always close the connection
                await connection.close();
            } catch (err) {
                console.error('Error closing connection:', err);
            }
        }
    }
}

/**
 * Execute multiple queries in a transaction
 * @param {Array<{query: string, params: Array}>} queries
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function executeTransaction(queries) {
    if (!oracleInitialized) {
        return {
            success: false,
            error: 'Oracle client not initialized'
        };
    }

    let connection;

    try {
        connection = await getConnection();

        // Start transaction
        await connection.execute('BEGIN');

        // Execute all queries
        for (const { query, params } of queries) {
            await connection.execute(query, params);
        }

        // Commit transaction
        await connection.execute('COMMIT');

        return { success: true };

    } catch (error) {
        if (connection) {
            try {
                // Rollback on error
                await connection.execute('ROLLBACK');
            } catch (rollbackError) {
                console.error('Rollback error:', rollbackError);
            }
        }

        console.error('Transaction error:', error);
        return {
            success: false,
            error: error.message
        };
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error('Error closing connection:', err);
            }
        }
    }
}

// Optional: Pool management functions
export async function closePool() {
    try {
        await oracledb.getPool().close(10);
    } catch (err) {
        console.error('Error closing pool:', err);
    }
}

// Handle process termination
process.on('SIGINT', async () => {
    try {
        await closePool();
    } finally {
        process.exit(0);
    }
});

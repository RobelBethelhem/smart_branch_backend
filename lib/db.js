import oracledb from 'oracledb';
import path from 'path';

// Initialize Oracle client
try {
    if (process.env.ORACLE_CLIENT_PATH) {
        oracledb.initOracleClient({ libDir: process.env.ORACLE_CLIENT_PATH });
    }
} catch (err) {
    console.error('Oracle Client initialization error:', err);
}

// Database configuration
const dbConfig = {
    user: process.env.FLEXCUBE_DB_USER,
    password: process.env.FLEXCUBE_DB_PASSWORD,
    connectString: process.env.FLEXCUBE_DB_CONNECTION_STRING,
};

// Get connection from pool
async function getConnection() {
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
 * @returns {Promise<{success: boolean, data?: any[], error?: string}>}
 */
export async function executeQuery(query, params = [], options = {}) {
    let connection;
    
    try {
        // Set some default options for oracledb
        oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
        oracledb.fetchAsString = [oracledb.CLOB];
        oracledb.fetchAsBuffer = [oracledb.BLOB];

        // Get connection
        connection = await getConnection();

        // Execute query with parameters
        const result = await connection.execute(
            query,
            params,
            {
                maxRows: 1000,
                ...options
            }
        );

        // Return successful result
        return {
            success: true,
            data: result.rows || []
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

// Create connection pool on startup
async function initialize() {
    try {
        await oracledb.createPool({
            ...dbConfig,
            poolMin: 2,
            poolMax: 10,
            poolIncrement: 2
        });
        console.log('Oracle connection pool created successfully');
    } catch (err) {
        console.error('Pool creation error:', err);
    }
}

// Initialize the pool
initialize();

// Handle process termination
process.on('SIGINT', async () => {
    try {
        await closePool();
    } finally {
        process.exit(0);
    }
});
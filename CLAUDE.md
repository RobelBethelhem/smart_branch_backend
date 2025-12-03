# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Node.js/Express backend for the ZSmart Branch system - a banking management application that handles multiple subsystems including:
- Real estate/rental management system (RMS)
- Banking transaction requests (deposits, withdrawals, transfers)
- Voting/candidate management system
- Branch request management

The application uses MongoDB for primary data storage and Oracle (Flexcube) for banking system integration.

## Architecture

### Core Structure

The codebase follows a modular Express architecture organized by domain:

- **`app.js`**: Main application entry point - sets up Express, middleware, database connections, and all route handlers
- **`dbConnect.js`**: MongoDB connection handler using Mongoose
- **`lib/db.js`**: Oracle database connection pooling and query execution utilities for Flexcube integration
- **`routes/rms/`**: Route handlers organized by feature (auth, admin operations, landing pages, etc.)
- **`models/rms/`**: Mongoose schemas defining data structures
- **`middleware/rms/`**: Authentication, authorization (role-based), and file upload middleware
- **`utils/rms/`**: Utility functions for validation, token generation, and business logic

### Key Subsystems

**1. RMS (Rental Management System)**
- Hierarchical location structure: Place → Site → Building → Floor → Room
- Pricing models at each level (`Price_per_*` models)
- Customer management and agreements with KPI tracking for site managers
- Admin routes in `routes/rms/Admin/` handle CRUD operations
- Landing routes in `routes/rms/Admin/Landing/` handle aggregated/reporting views

**2. Smart Branch Requests**
The `ZSmartBrannchRequests.js` route (138KB file) handles various banking transaction requests:
- Deposits, Withdrawals, Transfers (internal and other banks)
- Air ticket payments
- Uses queue management system with automatic teller assignment
- Integrates with Flexcube via Oracle queries

**3. Authentication & Authorization**
- JWT-based authentication with access (15min) and refresh (30d) tokens
- Token blacklist via `UsedToken` model to prevent token reuse
- Role-based access control with roles: `Teller`, `CSR`, `Admin`, `Authorizer`, `Auditor`, `Branch_Management`, `KYC`, `Super_Admin`, `Maker`
- Middleware in `middleware/rms/auth.js` validates JWT tokens
- Middleware in `middleware/rms/roleCheck.js` enforces role permissions

**4. Voting System**
- Candidate management with voting functionality
- Vote statistics and landing pages for results
- Support letters: Experience, Guaranty, Embassy, Supportive

## Database Connections

### MongoDB (Primary)
- Connection string in `.env` as `DB`
- Database name: `ZSmartBranch`
- Connected via Mongoose in `dbConnect.js`

### Oracle Flexcube (Banking Integration)
- Connection managed in `lib/db.js` with connection pooling
- Environment variables: `FLEXCUBE_DB_USER`, `FLEXCUBE_DB_PASSWORD`, `FLEXCUBE_DB_CONNECTION_STRING`, `ORACLE_CLIENT_PATH`
- Use `executeQuery(query, params, options)` for single queries
- Use `executeTransaction(queries)` for transactional operations

## Development Commands

### Prerequisites

**Oracle Instant Client (Required for Flexcube integration)**

The application requires Oracle Instant Client to connect to the Flexcube database. To set up:

1. Download Oracle Instant Client Basic from: https://www.oracle.com/database/technologies/instant-client/winx64-64-downloads.html
2. Extract to a location on your machine (e.g., `C:\oracle\instantclient_23_6`)
3. Update the `ORACLE_CLIENT_PATH` in `.env` to point to your installation path
4. Ensure you have the appropriate Microsoft Visual Studio Redistributable installed

**Note**: If Oracle/Flexcube integration is not needed for development, you can comment out or skip the Oracle initialization in `lib/db.js`.

### Installation

```bash
npm install
```

### Running the Application

```bash
# Start the server (default port 5000, configurable via .env PORT)
node app.js

# Or with nodemon for auto-reload
npm start
```

**Important**:
- The application uses ES modules (`import`/`export` syntax), requires Node.js 14+
- MongoDB must be running on `localhost:27017` (or update `DB` in `.env`)
- Update `.env` file with correct paths and credentials for your environment

## Common Patterns

### Adding New Routes
1. Create route file in `routes/rms/` or appropriate subdirectory
2. Import necessary models from `models/rms/`
3. Apply middleware: `auth` for authentication, `roleCheck(['role1', 'role2'])` for authorization
4. Register route in `app.js` with appropriate base path

### Working with Authentication
- Protected routes must use `auth` middleware
- Access token sent in header as `x-access-token`
- Check `req.user` for authenticated user details (contains `_id` and `roles`)

### Oracle Queries
```javascript
import { executeQuery } from "./lib/db.js";

const result = await executeQuery(
  'SELECT * FROM table WHERE id = :id',
  [value],  // parameters array
  { maxRows: 1000 }  // optional options
);

if (result.success) {
  // Use result.data
} else {
  // Handle result.error
}
```

### Request Validation
- Validation schemas in `utils/rms/validationSchema.js`
- Body validation utilities for specific entities in `utils/rms/*BodyValidation.js`

## Important Notes

- **File Uploads**: Handled by middleware in `middleware/rms/upload.js`, uploaded files stored in `uploads/` directory
- **CORS**: Configured to allow all origins in `app.js:70`
- **Error Handling**: Most routes return JSON with `{error: boolean, message: string, data?: any}` format
- **Queue System**: Several request types (deposits, withdrawals) use automated queue numbering and teller assignment
- **Webpack Config**: Present but appears legacy, primary runtime is Node.js directly

## Security Considerations

- Tokens are blacklisted after use via `UsedToken` model
- Password hashing uses bcrypt with configurable salt rounds (`.env` SALT)
- Default password for new users: `@Test1234`
- Role-based authorization enforced at route level
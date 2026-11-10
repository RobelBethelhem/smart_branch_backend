// Runs ONCE, on MongoDB's first start with an empty data directory (official image behaviour),
// already authenticated as the root user. Creates the application's least-privilege login:
// it can read and write the ZSmart Branch database (including creating indexes) and nothing else.
//
// The user lives in the "admin" database, so connection strings need ?authSource=admin.

const apps = [
  { user: 'smartbranch_app', db: process.env.SMARTBRANCH_DB_NAME, pwd: process.env.SMARTBRANCH_DB_PASSWORD },
];

const admin = db.getSiblingDB('admin');

for (const app of apps) {
  if (!app.db || !app.pwd) {
    throw new Error(`database name / password for ${app.user} is not set`);
  }
  if (admin.getUser(app.user)) {
    print(`[init] user ${app.user} already exists, leaving it as is`);
    continue;
  }
  admin.createUser({
    user: app.user,
    pwd: app.pwd,
    roles: [{ role: 'readWrite', db: app.db }],
  });
  print(`[init] created ${app.user} with readWrite on ${app.db}`);
}

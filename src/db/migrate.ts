import { db, migrate } from "./client.js";

migrate(db());
console.log("✓ schema up to date at", process.env.SANCHAR_DB_PATH ?? "./data/sanchar.db");

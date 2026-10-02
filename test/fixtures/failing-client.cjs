"use strict";
if (process.argv.includes("capabilities")) {
  require("./client.cjs");
} else {
  console.error("Error: credential exchange failed: unknown_org Bearer private-token");
  setTimeout(() => process.exit(2), 1000);
}

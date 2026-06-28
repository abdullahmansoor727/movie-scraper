import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { handleRequest } = require("./lib/core.cjs");

export default handleRequest;

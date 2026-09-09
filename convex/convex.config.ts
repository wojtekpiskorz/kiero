/**
 * Convex app definition (A3).
 *
 * Registers the @convex-dev/workflow component: the ONE canonical durable
 * workflow engine (architecture "Deployment and ownership"; no second engine
 * in Effect Cluster or Cloudflare Workflows). The native scheduler remains
 * the durable queue; see convex/platform/jobs.ts and outbox.ts.
 */

import { defineApp } from "convex/server";
import workflow from "@convex-dev/workflow/convex.config.js";

const app = defineApp();
app.use(workflow);
export default app;

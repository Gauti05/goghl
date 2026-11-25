First, fix one folder issue before running any commands: in your screenshot, Antigravity is opened on New folder (7) (which also contains __MACOSX), one level above the actual project folder starter.   
image_7e9265.jpg

Step 1: Open the starter Folder & Set Up Your Repo
Open starter as your workspace root.
In Antigravity, click File -> Open Folder..., select C:\Users\gauta\Desktop\New folder (7)\starter, and click Select Folder.

Verification: The left Explorer sidebar shows STARTER at the top, with BRIEF.md, PIGEON.md, package.json, and scaffold directly at the root.


image_7e9265.jpg
Initialize Git and create the starter commit.
Make sure Docker Desktop is open and green (Engine running). Open the terminal in Antigravity (Ctrl + ~) and run:

PowerShell
git init
git add -A
git commit -m "starter"
Verification: git status shows working tree clean and __MACOSX is excluded.

Start Docker containers, run doctor, and install scaffold packages.

PowerShell
npm run up
npm run doctor
npm run scaffold:install
Verification: npm run doctor reports all ports and services (MongoDB, Redis, idp, pigeon, paybox) ready.   
START_HERE.md
+ 1

Push to a new private GitHub repository.
On GitHub, create a new empty private repository (do not add a README or .gitignore), then link and push:   
START_HERE.md

PowerShell
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
Verification: Your GitHub repo shows the starter files and displays the Private badge.

Step 2: Phase-Wise Prompts for Antigravity
Copy and paste these prompts into Antigravity one phase at a time. Do not move to the next phase until the current phase passes its check.

Phase 0 — Project Rules & Architecture Plan (No Code Yet)
Plaintext
Read BRIEF.md, PIGEON.md, REFERENCE.html, and inspect the existing files inside scaffold/ and package.json.
Before writing any feature code, create an AGENT_RULES.md file in the root with strict project rules, then give me a concise implementation plan:

1. Stack & Structure: Use the exact language (plain JS/React if scaffold uses JS), libraries, and folder layout already in scaffold/. Do not introduce unnecessary frameworks.
2. Critical Assessment Rules:
   - The server MUST bind to `process.env.PORT || 4000` (the automated grader passes a custom PORT).
   - "Agent" means a human support agent (like u_ben or u_eli), never an AI bot.
   - Follow every Pigeon webhook quirk, signature/idempotency rule, retry/failure rule, and rate-limit rule documented in PIGEON.md and REFERENCE.html.
   - Enforce workspace isolation and role permissions (admin vs agent) using the mock IdP auth flow in REFERENCE.html.
3. Map out all required backend routes, MongoDB collections/indexes, Redis keys, and frontend views from BRIEF.md.

Do not modify application code yet—only create AGENT_RULES.md and show the plan.
Phase 1 — Vertical Slice: Webhook Ingestion + Outbound Reply + Level 1 Check
Plaintext
Follow AGENT_RULES.md, BRIEF.md, PIGEON.md, and REFERENCE.html.
Build the core end-to-end vertical slice first so we can verify against `npm run check`:

1. Ensure Express server reads `process.env.PORT || 4000`, connects to `MONGO_URL` and `REDIS_URL` (from .env.example), and exposes a clean health/boot setup.
2. Implement the Pigeon inbound webhook endpoint:
   - Verify signatures/headers exactly as specified in PIGEON.md and REFERENCE.html.
   - Handle duplicate webhook deliveries idempotently (using Redis/Mongo unique keys) and handle out-of-order or malformed events per PIGEON.md.
   - Store/update customers, conversations, and messages in MongoDB with proper workspace scoping.
3. Implement mock IdP authentication/session middleware so logged-in test users (u_asha, u_ben, u_chloe, u_dev, u_eli) resolve their active workspace and role.
4. Implement the outbound agent reply endpoint that saves the message and sends it to the Pigeon API, handling retries/errors per PIGEON.md.

Keep the code clean and modular. Tell me when ready so I can stop any running server and execute `npm run check`.
(After Phase 1 finishes: stop any running dev server, run npm run check in your terminal, and paste any failing output back into Antigravity before starting Phase 2.)

Phase 2 — Full Backend Spec (Assignment, Routing, Multi-Workspace, Edge Cases)
Plaintext
Now implement all remaining backend requirements from BRIEF.md, PIGEON.md, and REFERENCE.html:

1. Conversation lifecycle & human agent workflows:
   - Listing/filtering conversations by status, assignee, and workspace.
   - Claiming, assigning/unassigning, and resolving/reopening conversations.
   - Enforce strict workspace isolation (e.g., u_ben cannot access ws_globex; u_eli can switch between ws_acme and ws_globex).
   - Enforce admin vs agent permissions (e.g., workspace settings, routing rules, or admin-only actions in BRIEF.md).
2. Reliability & Redis usage:
   - Ensure idempotency, rate-limiting/locking (preventing double-claims or duplicate outbound sends), and Pigeon delivery receipt / status webhook updates work accurately.
3. Verify all API request/response shapes and HTTP status codes match REFERENCE.html exactly.

Review all modified files for edge cases, then tell me when ready to run `npm run check`.
Phase 3 — Frontend UI (scaffold/web)
Plaintext
Now build/complete the React frontend in scaffold/ according to BRIEF.md and REFERENCE.html:

1. Login & Workspace Switcher:
   - Integrate with the mock IdP login flow and support switching workspaces for multi-workspace agents like Eli Novak (u_eli).
   - Display current user name, role (admin/agent), and active workspace clearly.
2. Agent Inbox & Conversation View:
   - Conversation list with status/assignment filters and unread/latest message previews.
   - Message thread view showing inbound customer messages, outbound agent replies, delivery statuses, and system events.
   - Action controls to claim/assign, resolve/reopen, and send replies.
3. Admin Views:
   - Add any admin-only configuration or team/queue views specified in BRIEF.md, hidden or disabled for non-admin agents.
4. Ensure live updates (polling or WebSocket/SSE per BRIEF.md) work smoothly without duplicate messages.

Verify the frontend builds cleanly with zero errors.
Phase 4 — Full Grader Run (check:full), Polish & Bonus Check
Plaintext
Let's prepare for final verification and submission:

1. Audit the entire codebase against BRIEF.md, PIGEON.md, and REFERENCE.html for any missing endpoints, status codes, or edge cases.
2. Make sure no dev server is occupying ports, then help me run `npm run check:full` and inspect `CHECK_REPORT.json`.
3. Fix every failing test case until Levels 1, 2, 3, and 5 pass cleanly.
4. Only if all core levels pass and we have at least 20 minutes left, review `PAYBOX.md` and `BONUS_BILLING.md` and implement the billing bonus cleanly without breaking existing tests.
Quick Reminders While Running Antigravity
Before every npm run check or npm run check:full: Stop your running scaffold:server first, because the check script wipes app data and boots your server on its own random PORT.   
START_HERE.md

If npm run check fails: Copy the exact error lines from the terminal and paste them straight into Antigravity—it fixes targeted grader failures fastest when given the exact assertion output.

At 1:50 (10 minutes left): Open SUBMISSION.md, make your final commit and git push, switch your GitHub repo from Private to Public, export your Antigravity and Gemini conversations, and submit the form.   
START_HERE.md
import { api } from "./api.js";

let currentUser: any = null;
let currentTab: string = "users";

const app = document.getElementById("app")!;
const nav = document.getElementById("main-nav")!;
const authStatus = document.getElementById("auth-status")!;

async function init() {
  try {
    const sessionRes = await api.getSession();
    if (sessionRes.user && sessionRes.user.role === "admin") {
      currentUser = sessionRes.user;
      renderAdmin();
    } else {
      renderLogin();
    }
  } catch (err) {
    renderLogin();
  }
}

function renderLogin() {
  nav.style.display = "none";
  authStatus.innerHTML = "";
  app.innerHTML = `
    <div class="card" style="max-width: 400px; margin: 4rem auto;">
      <div class="card-header">
        <h2 class="card-title">Admin Sign In</h2>
      </div>
      <form id="login-form">
        <div style="margin-bottom: 1rem;">
          <label>Email or Username</label>
          <input type="text" id="login-username" required />
        </div>
        <div style="margin-bottom: 1.5rem;">
          <label>Password</label>
          <input type="password" id="login-password" required />
        </div>
        <button type="submit" class="btn" style="width: 100%;">Sign In</button>
      </form>
      <div id="login-error" style="color: var(--danger); margin-top: 1rem; font-size: 0.875rem;"></div>
    </div>
  `;

  document.getElementById("login-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = (document.getElementById("login-username") as HTMLInputElement).value;
    const password = (document.getElementById("login-password") as HTMLInputElement).value;
    const errEl = document.getElementById("login-error")!;
    errEl.textContent = "";

    try {
      const res = await api.signIn(username, password);
      if (res.user.role !== "admin") {
        errEl.textContent = "Access denied: Account is not an administrator.";
        return;
      }
      currentUser = res.user;
      renderAdmin();
    } catch (err: any) {
      errEl.textContent = err.message || "Failed to sign in.";
    }
  });
}

function renderAdmin() {
  nav.style.display = "flex";
  authStatus.innerHTML = `
    <div style="display: flex; align-items: center; gap: 1rem;">
      <span style="font-size: 0.875rem; color: var(--text-muted);">
        Signed in as <strong style="color: var(--text);">${currentUser.username}</strong>
      </span>
      <button id="logout-btn" class="btn btn-secondary" style="padding: 0.25rem 0.75rem; font-size: 0.8rem;">
        Sign Out
      </button>
    </div>
  `;

  document.getElementById("logout-btn")?.addEventListener("click", async () => {
    await api.signOut();
    currentUser = null;
    renderLogin();
  });

  // Nav buttons
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentTab = btn.getAttribute("data-tab") || "users";
      loadCurrentTab();
    });
  });

  loadCurrentTab();
}

async function loadCurrentTab() {
  if (currentTab === "users") {
    await renderUsersTab();
  } else if (currentTab === "reports") {
    await renderReportsTab();
  } else if (currentTab === "corrections") {
    await renderCorrectionsTab();
  } else if (currentTab === "audit") {
    await renderAuditTab();
  }
}

// 1. Users Tab
async function renderUsersTab() {
  app.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Account Lookup & Enforcement</h2>
      </div>
      <div style="display: flex; gap: 1rem; margin-bottom: 1rem;">
        <input type="text" id="user-search-input" placeholder="Search by username, email, or display name..." />
        <button id="user-search-btn" class="btn">Search</button>
      </div>
      <div id="users-table-container">Loading accounts...</div>
    </div>
    <div id="user-detail-card" style="display: none;"></div>
  `;

  const searchInput = document.getElementById("user-search-input") as HTMLInputElement;
  const searchBtn = document.getElementById("user-search-btn")!;

  const doSearch = async () => {
    const q = searchInput.value;
    const res = await api.searchUsers(q);
    renderUsersTable(res.users);
  };

  searchBtn.addEventListener("click", doSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });

  await doSearch();
}

function renderUsersTable(usersList: any[]) {
  const container = document.getElementById("users-table-container")!;
  if (usersList.length === 0) {
    container.innerHTML = `<p style="color: var(--text-muted);">No users found.</p>`;
    return;
  }

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Username</th>
          <th>Display Name</th>
          <th>Email</th>
          <th>Sex</th>
          <th>DOB</th>
          <th>Role</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${usersList
          .map(
            (u) => `
          <tr>
            <td><strong>@${u.username}</strong></td>
            <td>${u.displayName}</td>
            <td>${u.email}</td>
            <td>${u.sex}</td>
            <td>${u.dateOfBirth}</td>
            <td><span class="badge">${u.role}</span></td>
            <td>
              ${
                u.banned
                  ? `<span class="status-pill status-REJECTED">BANNED</span>`
                  : `<span class="status-pill status-APPROVED">ACTIVE</span>`
              }
            </td>
            <td>
              <button class="btn btn-secondary select-user-btn" data-id="${u.id}" style="padding: 0.2rem 0.5rem; font-size: 0.8rem;">
                Inspect
              </button>
            </td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;

  document.querySelectorAll(".select-user-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id")!;
      await showUserDetail(id);
    });
  });
}

async function showUserDetail(userId: string) {
  const card = document.getElementById("user-detail-card")!;
  card.style.display = "block";
  card.innerHTML = `<div class="card"><p>Loading details...</p></div>`;

  const { user, sessions } = await api.getUser(userId);

  card.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">User Operations: @${user.username} (${user.id})</h3>
        <button id="close-user-detail" class="btn btn-secondary" style="padding: 0.2rem 0.5rem;">Close</button>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-bottom: 1.5rem;">
        <div>
          <p><strong>Email:</strong> ${user.email}</p>
          <p><strong>Display Name:</strong> ${user.displayName}</p>
          <p><strong>Sex:</strong> ${user.sex}</p>
          <p><strong>Date of Birth:</strong> ${user.dateOfBirth}</p>
          <p><strong>Active Sessions:</strong> ${sessions.length}</p>
          ${user.banned ? `<p style="color: var(--danger);"><strong>Ban Reason:</strong> ${user.banReason}</p>` : ""}
        </div>
        <div style="display: flex; flex-direction: column; gap: 0.75rem;">
          <button id="btn-revoke-sessions" class="btn btn-secondary">
            Revoke All Sessions
          </button>
          <button id="btn-warn-user" class="btn btn-secondary">
            Issue Warning
          </button>
          ${
            !user.banned
              ? `<button id="btn-ban-user" class="btn btn-danger">Ban Account</button>`
              : ""
          }
        </div>
      </div>
    </div>
  `;

  document.getElementById("close-user-detail")?.addEventListener("click", () => {
    card.style.display = "none";
  });

  document.getElementById("btn-revoke-sessions")?.addEventListener("click", async () => {
    const reason = prompt("Enter reason for session revocation (required):");
    if (!reason) return;
    await api.revokeSessions(userId, reason);
    alert("Sessions revoked.");
    await showUserDetail(userId);
  });

  document.getElementById("btn-warn-user")?.addEventListener("click", async () => {
    const reason = prompt("Enter warning reason (required):");
    if (!reason) return;
    await api.enforceUser(userId, "WARN", reason);
    alert("Warning issued.");
  });

  document.getElementById("btn-ban-user")?.addEventListener("click", async () => {
    const reason = prompt("Enter reason for banning user (required):");
    if (!reason) return;
    await api.enforceUser(userId, "BAN", reason);
    alert("User has been banned.");
    await showUserDetail(userId);
    await renderUsersTab();
  });
}

// 2. Reports Tab
async function renderReportsTab() {
  app.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Safety Reports Queue</h2>
      </div>
      <div id="reports-container">Loading reports...</div>
    </div>
    <div id="report-detail-card" style="display: none;"></div>
  `;

  const { reports } = await api.getReports();
  const container = document.getElementById("reports-container")!;

  if (reports.length === 0) {
    container.innerHTML = `<p style="color: var(--text-muted);">No reports filed.</p>`;
    return;
  }

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Reporter</th>
          <th>Reason</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${reports
          .map(
            (r: any) => `
          <tr>
            <td>${new Date(r.report.createdAt).toLocaleString()}</td>
            <td>@${r.reporter.username}</td>
            <td>${r.report.reason}</td>
            <td><span class="status-pill status-${r.report.state}">${r.report.state}</span></td>
            <td>
              <button class="btn btn-secondary inspect-report-btn" data-id="${r.report.id}" style="padding: 0.2rem 0.5rem; font-size: 0.8rem;">
                Review Evidence
              </button>
            </td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;

  document.querySelectorAll(".inspect-report-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id")!;
      await showReportDetail(id);
    });
  });
}

async function showReportDetail(reportId: string) {
  const card = document.getElementById("report-detail-card")!;
  card.style.display = "block";
  card.innerHTML = `<div class="card"><p>Loading report evidence...</p></div>`;

  const { report, reporter, reportedUser } = await api.getReport(reportId);

  const evidenceHtml =
    report.evidence && report.evidence.length > 0
      ? `<div style="background: #0f172a; padding: 1rem; border-radius: 6px; margin: 1rem 0;">
          <h4 style="margin-bottom: 0.5rem;">Submitted Encrypted Messages Evidence:</h4>
          <ul>${report.evidence.map((e: string) => `<li style="font-family: monospace; font-size: 0.85rem; margin-bottom: 0.25rem;">${e}</li>`).join("")}</ul>
         </div>`
      : `<p style="color: var(--text-muted); margin: 1rem 0;">No attached message evidence.</p>`;

  card.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Report Investigation: ${report.id}</h3>
        <button id="close-report-detail" class="btn btn-secondary" style="padding: 0.2rem 0.5rem;">Close</button>
      </div>
      <div>
        <p><strong>Reporter:</strong> @${reporter?.username} (${report.reporterId})</p>
        <p><strong>Reported User:</strong> @${reportedUser?.username} (${report.reportedUserId})</p>
        <p><strong>Reason:</strong> ${report.reason}</p>
        <p><strong>Details:</strong> ${report.details || "None provided"}</p>
        <p><strong>Status:</strong> <span class="status-pill status-${report.state}">${report.state}</span></p>
        ${evidenceHtml}
        ${
          report.state === "PENDING"
            ? `
          <div style="display: flex; gap: 1rem; margin-top: 1.5rem;">
            <button id="btn-resolve-report" class="btn">Resolve Report</button>
            <button id="btn-resolve-ban" class="btn btn-danger">Resolve & Ban User</button>
            <button id="btn-dismiss-report" class="btn btn-secondary">Dismiss</button>
          </div>
        `
            : `<p style="color: var(--text-muted); margin-top: 1rem;"><strong>Resolution notes:</strong> ${report.resolutionNotes}</p>`
        }
      </div>
    </div>
  `;

  document.getElementById("close-report-detail")?.addEventListener("click", () => {
    card.style.display = "none";
  });

  document.getElementById("btn-resolve-report")?.addEventListener("click", async () => {
    const reason = prompt("Enter resolution notes (required):");
    if (!reason) return;
    await api.resolveReport(reportId, "RESOLVED", reason);
    alert("Report resolved.");
    await renderReportsTab();
  });

  document.getElementById("btn-resolve-ban")?.addEventListener("click", async () => {
    const reason = prompt("Enter reason for ban and resolution (required):");
    if (!reason) return;
    await api.resolveReport(reportId, "RESOLVED", reason, "BAN");
    alert("Report resolved and user banned.");
    await renderReportsTab();
  });

  document.getElementById("btn-dismiss-report")?.addEventListener("click", async () => {
    const reason = prompt("Enter dismissal reason (required):");
    if (!reason) return;
    await api.resolveReport(reportId, "DISMISSED", reason);
    alert("Report dismissed.");
    await renderReportsTab();
  });
}

// 3. Corrections Tab
async function renderCorrectionsTab() {
  app.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Date of Birth & Sex Correction Requests</h2>
      </div>
      <div id="corrections-container">Loading correction tickets...</div>
    </div>
    <div id="correction-detail-card" style="display: none;"></div>
  `;

  const { corrections } = await api.getCorrections();
  const container = document.getElementById("corrections-container")!;

  if (corrections.length === 0) {
    container.innerHTML = `<p style="color: var(--text-muted);">No profile correction requests.</p>`;
    return;
  }

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>User</th>
          <th>Field</th>
          <th>Proposed Value</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${corrections
          .map(
            (c: any) => `
          <tr>
            <td>${new Date(c.correction.createdAt).toLocaleString()}</td>
            <td>@${c.user.username}</td>
            <td><strong>${c.correction.field}</strong></td>
            <td>${c.correction.proposedValue}</td>
            <td><span class="status-pill status-${c.correction.status}">${c.correction.status}</span></td>
            <td>
              <button class="btn btn-secondary inspect-correction-btn" data-id="${c.correction.id}" style="padding: 0.2rem 0.5rem; font-size: 0.8rem;">
                Impact Analysis
              </button>
            </td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;

  document.querySelectorAll(".inspect-correction-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id")!;
      await showCorrectionDetail(id);
    });
  });
}

async function showCorrectionDetail(id: string) {
  const card = document.getElementById("correction-detail-card")!;
  card.style.display = "block";
  card.innerHTML = `<div class="card"><p>Loading impact assessment...</p></div>`;

  const { corrections } = await api.getCorrections();
  const item = corrections.find((c: any) => c.correction.id === id);
  if (!item) return;

  const impact = item.correction.impactReport;

  card.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Correction Case: @${item.user.username}</h3>
        <button id="close-correction-detail" class="btn btn-secondary" style="padding: 0.2rem 0.5rem;">Close</button>
      </div>
      <div>
        <p><strong>Field:</strong> ${item.correction.field}</p>
        <p><strong>Current Value:</strong> ${item.correction.field === "DOB" ? item.user.dateOfBirth : item.user.sex}</p>
        <p><strong>Proposed Value:</strong> ${item.correction.proposedValue}</p>
        <p><strong>User's Reason:</strong> ${item.correction.reason}</p>
        <p><strong>Status:</strong> <span class="status-pill status-${item.correction.status}">${item.correction.status}</span></p>

        <div class="impact-box">
          <h4 style="color: var(--warning); margin-bottom: 0.5rem;">Automated Impact Assessment (D16)</h4>
          <p><strong>Summary:</strong> ${impact.summary}</p>
          <p><strong>Impacted Chats Count:</strong> ${impact.impactedChats?.length || 0}</p>
          ${
            impact.impactedChats && impact.impactedChats.length > 0
              ? `<ul>${impact.impactedChats.map((c: any) => `<li>Chat ${c.chatId}: ${c.reason}</li>`).join("")}</ul>`
              : ""
          }
        </div>

        ${
          item.correction.status === "PENDING"
            ? `
          <div style="display: flex; gap: 1rem; margin-top: 1.5rem;">
            <button id="btn-approve-correction" class="btn">Approve Correction</button>
            <button id="btn-reject-correction" class="btn btn-danger">Reject</button>
          </div>
        `
            : `<p style="color: var(--text-muted); margin-top: 1rem;"><strong>Resolution:</strong> ${item.correction.resolution}</p>`
        }
      </div>
    </div>
  `;

  document.getElementById("close-correction-detail")?.addEventListener("click", () => {
    card.style.display = "none";
  });

  document.getElementById("btn-approve-correction")?.addEventListener("click", async () => {
    const reason = prompt("Enter approval justification and remediation notes (required):");
    if (!reason) return;
    await api.resolveCorrection(id, "APPROVED", reason, "Participant notice sent");
    alert("Correction approved and user profile updated.");
    await renderCorrectionsTab();
  });

  document.getElementById("btn-reject-correction")?.addEventListener("click", async () => {
    const reason = prompt("Enter rejection reason (required):");
    if (!reason) return;
    await api.resolveCorrection(id, "REJECTED", reason);
    alert("Correction rejected.");
    await renderCorrectionsTab();
  });
}

// 4. Audit Tab
async function renderAuditTab() {
  app.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Administrative Audit Trail</h2>
      </div>
      <div id="audit-container">Loading audit logs...</div>
    </div>
  `;

  const { logs } = await api.getAuditLogs();
  const container = document.getElementById("audit-container")!;

  if (logs.length === 0) {
    container.innerHTML = `<p style="color: var(--text-muted);">No audit logs found.</p>`;
    return;
  }

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Action</th>
          <th>Actor ID</th>
          <th>Target</th>
          <th>Metadata</th>
        </tr>
      </thead>
      <tbody>
        ${logs
          .map(
            (log: any) => `
          <tr>
            <td>${new Date(log.createdAt).toLocaleString()}</td>
            <td><strong>${log.action}</strong></td>
            <td><code>${log.actorId || "SYSTEM"}</code></td>
            <td>${log.targetType}:${log.targetId}</td>
            <td><code style="font-size: 0.75rem;">${JSON.stringify(log.meta || {})}</code></td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

init();

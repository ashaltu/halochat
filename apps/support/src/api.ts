const API_BASE = "/api";

export async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Request failed with status ${res.status}`);
  }
  return data;
}

export const api = {
  // Auth
  getSession: () => request("/auth/get-session"),
  signIn: (emailOrUsername: string, password: string) =>
    request("/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ emailOrUsername, password }),
    }),
  signOut: () => request("/auth/sign-out", { method: "POST" }),

  // Admin Users
  searchUsers: (query: string = "") => request(`/v1/admin/users?query=${encodeURIComponent(query)}`),
  getUser: (id: string) => request(`/v1/admin/users/${id}`),
  enforceUser: (id: string, action: string, reason: string, durationDays?: number) =>
    request(`/v1/admin/users/${id}/enforcement`, {
      method: "POST",
      body: JSON.stringify({ action, reason, durationDays }),
    }),
  revokeSessions: (id: string, reason: string) =>
    request(`/v1/admin/users/${id}/revoke-sessions`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  // Admin Reports
  getReports: () => request("/v1/admin/reports"),
  getReport: (id: string) => request(`/v1/admin/reports/${id}`),
  resolveReport: (id: string, decision: string, reason: string, enforcement?: string) =>
    request(`/v1/admin/reports/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ decision, reason, enforcement }),
    }),

  // Admin Profile Corrections
  getCorrections: () => request("/v1/admin/profile-corrections"),
  getCorrectionImpact: (id: string) => request(`/v1/admin/profile-corrections/${id}/impact`),
  resolveCorrection: (id: string, decision: string, reason: string, remediation?: string, noticePlan?: string) =>
    request(`/v1/admin/profile-corrections/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ decision, reason, remediation, noticePlan }),
    }),

  // Admin Audit Logs
  getAuditLogs: () => request("/v1/admin/audit-logs"),
};

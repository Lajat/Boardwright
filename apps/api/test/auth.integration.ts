/**
 * Basic tests for the auth flow: signup → login → refresh → /auth/me.
 * Updated to match the secure httpOnly cookie architecture.
 */
import assert from "assert";

const BASE = process.env.TEST_BASE_URL || "http://localhost:4000";

async function run() {
  console.log("Running auth tests against", BASE);

  const testEmail = `test-${Date.now()}@example.com`;
  const testPassword = "test-password-123";

  let cookieHeader = "";

  // Keep the latest auth cookies together so subsequent requests can reuse
  // the session established by signup, login, and refresh.
  function extractCookies(res: Response) {
    const rawCookie = res.headers.get("set-cookie");
    if (rawCookie) {
      // Split multiple cookies if present and extract key-value pairs
      const cookies = rawCookie.split(/,\s*(?=[^;]+=)/).map(c => c.split(";")[0]).join("; ");
      cookieHeader = cookies;
    }
  }

  // SIGNUP
  let res = await fetch(`${BASE}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: testPassword, displayName: "Test User" }),
  });
  assert.strictEqual(res.status, 201, "expected 201 on signup");
  const signupCookies = (res.headers.get("set-cookie") || "").split(/,\s*(?=[^;]+=)/);
  const refreshCookie = signupCookies.find((cookie) => cookie.trim().startsWith("refreshToken="));
  assert.ok(refreshCookie, "signup should set a refreshToken cookie");
  assert.match(
    refreshCookie || "",
    /refreshToken=[^;]*;.*Path=\/api-proxy\/auth\/refresh/i
  );
  extractCookies(res);
  const signupBody = await res.json();
  assert.ok(signupBody.user, "signup should return a user object");
  console.log("✓ POST /auth/signup creates a user and sets cookies");

  // DUPLICATE SIGNUP should fail
  res = await fetch(`${BASE}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: testPassword, displayName: "Test User" }),
  });
  assert.strictEqual(res.status, 409, "expected 409 on duplicate signup");
  console.log("✓ POST /auth/signup rejects a duplicate email");

  // LOGIN
  res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: testPassword }),
  });
  assert.strictEqual(res.status, 200, "expected 200 on login");
  extractCookies(res);
  const loginBody = await res.json();
  assert.ok(loginBody.user, "login should return a user object");
  console.log("✓ POST /auth/login returns user profile and sets cookies");

  // LOGIN with wrong password
  res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: "wrong-password" }),
  });
  assert.strictEqual(res.status, 401, "expected 401 on wrong password");
  console.log("✓ POST /auth/login rejects an incorrect password");

  // /auth/me with valid cookies
  res = await fetch(`${BASE}/auth/me`, {
    headers: { Cookie: cookieHeader },
  });
  assert.strictEqual(res.status, 200, "expected 200 on /auth/me with valid cookies");
  const meBody = await res.json();
  assert.strictEqual(meBody.email, testEmail);
  console.log("✓ GET /auth/me returns the logged-in user's profile");

  // /auth/me with no cookies
  res = await fetch(`${BASE}/auth/me`);
  assert.strictEqual(res.status, 401, "expected 401 with no cookies");
  console.log("✓ GET /auth/me rejects requests with no cookies");

  // SOCKET TICKET
  res = await fetch(`${BASE}/auth/socket-ticket`, {
    method: "POST",
    headers: { Cookie: cookieHeader },
  });
  assert.strictEqual(res.status, 200, "expected 200 for an authenticated socket-ticket request");
  const ticketBody = await res.json();
  assert.match(ticketBody.ticket, /^[\w-]+\.[\w-]+\.[\w-]+$/, "expected a signed socket ticket");
  const ticketClaims = JSON.parse(Buffer.from(ticketBody.ticket.split(".")[1], "base64url").toString());
  assert.strictEqual(ticketClaims.purpose, "socket");
  assert.strictEqual(ticketClaims.aud, "boardwright-socket");
  assert.ok(ticketClaims.exp > Math.floor(Date.now() / 1000), "socket ticket should expire in the future");
  console.log("✓ POST /auth/socket-ticket issues a short-lived authenticated ticket");

  res = await fetch(`${BASE}/auth/socket-ticket`, { method: "POST" });
  assert.strictEqual(res.status, 401, "expected 401 for a socket-ticket request without cookies");
  console.log("✓ POST /auth/socket-ticket rejects unauthenticated requests");

  // REFRESH
  res = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { Cookie: cookieHeader },
  });
  assert.strictEqual(res.status, 200, "expected 200 on refresh");
  extractCookies(res);
  const refreshBody = await res.json();
  assert.strictEqual(refreshBody.success, true, "refresh should return success true");
  console.log("✓ POST /auth/refresh refreshes the session successfully");

  console.log("\nAll auth tests passed.");
}

run().catch((err) => {
  console.error("TEST FAILED:", err.message);
  process.exit(1);
});
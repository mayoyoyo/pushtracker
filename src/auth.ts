import { createUser, getUserByUsername, getUserById, createSession, getSession, deleteSession, validateInviteCode, type User } from "./db";
import { getNextDayBoundary } from "./timezone";

export async function signup(username: string, passcode: string, timezone: string, inviteCode: string): Promise<{ user: User; token: string }> {
  if (!/^\d{4}$/.test(passcode)) {
    throw new Error("Passcode must be exactly 4 digits");
  }
  const code = (inviteCode || '').toUpperCase().trim();
  if (code.length !== 4) {
    throw new Error("Invite code must be 4 characters");
  }
  if (!validateInviteCode(code)) {
    throw new Error("Invalid invite code");
  }
  const hashedPasscode = await Bun.password.hash(passcode);
  const nowUtc = new Date().toISOString();
  const nextBoundary = getNextDayBoundary(timezone, nowUtc);
  const user = createUser(username, hashedPasscode, timezone, nextBoundary, code);
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  createSession(token, user.id, expiresAt);
  return { user, token };
}

export async function login(username: string, passcode: string): Promise<{ user: User; token: string }> {
  const user = getUserByUsername(username);
  if (!user) throw new Error("Invalid username or passcode");
  const valid = await Bun.password.verify(passcode, user.passcode);
  if (!valid) throw new Error("Invalid username or passcode");
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  createSession(token, user.id, expiresAt);
  return { user, token };
}

export function getSessionUser(token: string): User | null {
  const session = getSession(token);
  if (!session) return null;
  return getUserById(session.user_id);
}

export function logout(token: string): void {
  deleteSession(token);
}

function generateToken(): string {
  return crypto.randomUUID();
}

export function parseSessionToken(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  const match = cookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

export function sessionCookie(token: string): string {
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString();
  return `session=${token}; HttpOnly; SameSite=Strict; Path=/; Expires=${expires}`;
}

export function clearSessionCookie(): string {
  return "session=; HttpOnly; SameSite=Strict; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
}

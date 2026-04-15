import { describe, test, expect, beforeEach } from "bun:test";
import { getDb, linkAlias, updateTarget, updateDebt, getPairedUserForId, createUser, createSession } from "../src/db";
import { signup, login, getSessionUser, logout, switchSession } from "../src/auth";

describe("auth", () => {
  beforeEach(() => {
    getDb(":memory:");
  });

  describe("signup", () => {
    test("creates user with hashed passcode and returns session token", async () => {
      const result = await signup("hanson", "1234", "America/New_York", "DEV0");
      expect(result.user.username).toBe("hanson");
      expect(result.token).toBeTruthy();
      expect(result.user.passcode).not.toBe("1234"); // should be hashed
    });

    test("rejects duplicate username", async () => {
      await signup("hanson", "1234", "America/New_York", "DEV0");
      expect(signup("hanson", "5678", "America/New_York", "DEV0")).rejects.toThrow();
    });

    test("rejects non-4-digit passcode", async () => {
      expect(signup("hanson", "12", "America/New_York", "DEV0")).rejects.toThrow();
      expect(signup("hanson", "abcd", "America/New_York", "DEV0")).rejects.toThrow();
      expect(signup("hanson", "12345", "America/New_York", "DEV0")).rejects.toThrow();
    });
  });

  describe("login", () => {
    test("returns session token for valid credentials", async () => {
      await signup("hanson", "1234", "America/New_York", "DEV0");
      const result = await login("hanson", "1234");
      expect(result.token).toBeTruthy();
      expect(result.user.username).toBe("hanson");
    });

    test("rejects wrong passcode", async () => {
      await signup("hanson", "1234", "America/New_York", "DEV0");
      expect(login("hanson", "9999")).rejects.toThrow();
    });

    test("rejects unknown username", async () => {
      expect(login("nobody", "1234")).rejects.toThrow();
    });

    test("returns resolved user for an alias login", async () => {
      const { user: hanson } = await signup("hanson", "1111", "America/New_York", "DEV0");
      await signup("mayo", "2222", "America/New_York", "FRST");
      const mayoRaw = (await login("mayo", "2222")).user;
      linkAlias(mayoRaw.id, hanson.id);
      updateTarget(hanson.id, 55);
      updateDebt(hanson.id, 33);

      const result = await login("mayo", "2222");
      expect(result.user.id).toBe(mayoRaw.id);
      expect(result.user.username).toBe("mayo");
      expect(result.user.daily_target).toBe(55);
      expect(result.user.debt).toBe(33);
    });
  });

  describe("getSessionUser", () => {
    test("returns user for valid token", async () => {
      const { token } = await signup("hanson", "1234", "America/New_York", "DEV0");
      const user = getSessionUser(token);
      expect(user).not.toBeNull();
      expect(user!.username).toBe("hanson");
    });

    test("returns null for invalid token", () => {
      expect(getSessionUser("invalid-token")).toBeNull();
    });

    test("getSessionUser on alias session returns source's progress/settings", async () => {
      const { user: hanson } = await signup("hanson", "1111", "America/New_York", "DEV0");
      const { token, user: mayo } = await signup("mayo", "2222", "America/New_York", "FRST");
      linkAlias(mayo.id, hanson.id);
      updateTarget(hanson.id, 45);
      updateDebt(hanson.id, 12);

      const resolved = getSessionUser(token)!;
      expect(resolved.id).toBe(mayo.id);
      expect(resolved.username).toBe("mayo");
      expect(resolved.invite_code).toBe("FRST");
      expect(resolved.daily_target).toBe(45);
      expect(resolved.debt).toBe(12);
    });
  });

  describe("logout", () => {
    test("invalidates session token", async () => {
      const { token } = await signup("hanson", "1234", "America/New_York", "DEV0");
      logout(token);
      expect(getSessionUser(token)).toBeNull();
    });
  });

  describe("getPairedUserForId", () => {
    test("returns null for a user with no alias pair", () => {
      const user = createUser("solo", "h", "UTC", "2026-04-15T00:00:00Z", "DEV0");
      expect(getPairedUserForId(user.id)).toBeNull();
    });

    test("returns the source when called with the alias id", () => {
      const hanson = createUser("hanson", "h", "UTC", "2026-04-15T00:00:00Z", "FRST");
      const mayo   = createUser("mayo",   "h", "UTC", "2026-04-15T00:00:00Z", "DEV0");
      linkAlias(mayo.id, hanson.id);
      const paired = getPairedUserForId(mayo.id);
      expect(paired?.id).toBe(hanson.id);
      expect(paired?.username).toBe("hanson");
    });

    test("returns the alias when called with the source id", () => {
      const hanson = createUser("hanson", "h", "UTC", "2026-04-15T00:00:00Z", "FRST");
      const mayo   = createUser("mayo",   "h", "UTC", "2026-04-15T00:00:00Z", "DEV0");
      linkAlias(mayo.id, hanson.id);
      const paired = getPairedUserForId(hanson.id);
      expect(paired?.id).toBe(mayo.id);
      expect(paired?.username).toBe("mayo");
    });
  });

  describe("switchSession", () => {
    test("rotates session source → alias and invalidates the old token", async () => {
      const { user: hanson } = await signup("hanson", "1234", "America/New_York", "FRST");
      const mayo = createUser("mayo", "h", "America/New_York", "2026-04-15T00:00:00Z", "DEV0");
      linkAlias(mayo.id, hanson.id);

      const first = await login("hanson", "1234");
      const result = switchSession(first.token);

      expect(result).not.toBeNull();
      expect(result!.user.id).toBe(mayo.id);
      expect(result!.user.username).toBe("mayo");
      expect(result!.token).not.toBe(first.token);
      expect(getSessionUser(first.token)).toBeNull();
      const resolved = getSessionUser(result!.token)!;
      expect(resolved.username).toBe("mayo");
      expect(resolved.invite_code).toBe("DEV0");
    });

    test("rotates alias → source via a manually-seeded session", async () => {
      const { user: hanson } = await signup("hanson", "1234", "America/New_York", "FRST");
      const mayo = createUser("mayo", "h", "America/New_York", "2026-04-15T00:00:00Z", "DEV0");
      linkAlias(mayo.id, hanson.id);

      // Seed a session as mayo directly via the exported createSession helper.
      // Going through getDb() here would reopen a different DB connection and
      // lose the beforeEach :memory: state.
      const token = crypto.randomUUID();
      createSession(token, mayo.id, new Date(Date.now() + 1000 * 60 * 60).toISOString());

      const result = switchSession(token);
      expect(result).not.toBeNull();
      expect(result!.user.id).toBe(hanson.id);
      expect(result!.user.username).toBe("hanson");
      expect(getSessionUser(token)).toBeNull();
    });

    test("returns null when the user has no paired account", async () => {
      const { token } = await signup("solo", "1234", "America/New_York", "DEV0");
      expect(switchSession(token)).toBeNull();
      // Original session should still be valid (no-op on failure)
      expect(getSessionUser(token)?.username).toBe("solo");
    });

    test("returns null for an invalid token", () => {
      expect(switchSession("not-a-real-token")).toBeNull();
    });
  });
});

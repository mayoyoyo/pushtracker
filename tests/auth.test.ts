import { describe, test, expect, beforeEach } from "bun:test";
import { getDb, linkAlias, updateTarget, updateDebt } from "../src/db";
import { signup, login, getSessionUser, logout } from "../src/auth";

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
});

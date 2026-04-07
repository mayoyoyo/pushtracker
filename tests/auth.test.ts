import { describe, test, expect, beforeEach } from "bun:test";
import { getDb } from "../src/db";
import { signup, login, getSessionUser, logout } from "../src/auth";

describe("auth", () => {
  beforeEach(() => {
    getDb(":memory:");
  });

  describe("signup", () => {
    test("creates user with hashed passcode and returns session token", async () => {
      const result = await signup("hanson", "1234", "America/New_York");
      expect(result.user.username).toBe("hanson");
      expect(result.token).toBeTruthy();
      expect(result.user.passcode).not.toBe("1234"); // should be hashed
    });

    test("rejects duplicate username", async () => {
      await signup("hanson", "1234", "America/New_York");
      expect(signup("hanson", "5678", "America/New_York")).rejects.toThrow();
    });

    test("rejects non-4-digit passcode", async () => {
      expect(signup("hanson", "12", "America/New_York")).rejects.toThrow();
      expect(signup("hanson", "abcd", "America/New_York")).rejects.toThrow();
      expect(signup("hanson", "12345", "America/New_York")).rejects.toThrow();
    });
  });

  describe("login", () => {
    test("returns session token for valid credentials", async () => {
      await signup("hanson", "1234", "America/New_York");
      const result = await login("hanson", "1234");
      expect(result.token).toBeTruthy();
      expect(result.user.username).toBe("hanson");
    });

    test("rejects wrong passcode", async () => {
      await signup("hanson", "1234", "America/New_York");
      expect(login("hanson", "9999")).rejects.toThrow();
    });

    test("rejects unknown username", async () => {
      expect(login("nobody", "1234")).rejects.toThrow();
    });
  });

  describe("getSessionUser", () => {
    test("returns user for valid token", async () => {
      const { token } = await signup("hanson", "1234", "America/New_York");
      const user = getSessionUser(token);
      expect(user).not.toBeNull();
      expect(user!.username).toBe("hanson");
    });

    test("returns null for invalid token", () => {
      expect(getSessionUser("invalid-token")).toBeNull();
    });
  });

  describe("logout", () => {
    test("invalidates session token", async () => {
      const { token } = await signup("hanson", "1234", "America/New_York");
      logout(token);
      expect(getSessionUser(token)).toBeNull();
    });
  });
});

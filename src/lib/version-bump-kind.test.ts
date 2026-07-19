import { describe, it, expect } from "vitest";
import { getUpgradeType } from "./version-bump-kind.js";

describe("getUpgradeType", () => {
  it("detects major", () => {
    expect(getUpgradeType("1.0.0", "2.0.0")).toBe("major");
    expect(getUpgradeType("1.2.3", "2.1.0")).toBe("major");
  });
  it("detects minor", () => {
    expect(getUpgradeType("1.0.0", "1.1.0")).toBe("minor");
    expect(getUpgradeType("2.3.4", "2.4.0")).toBe("minor");
  });
  it("detects patch", () => {
    expect(getUpgradeType("1.0.0", "1.0.1")).toBe("patch");
    expect(getUpgradeType("3.2.1", "3.2.9")).toBe("patch");
  });
  it("treats uncoercable as major", () => {
    expect(getUpgradeType("not-a-version", "1.0.0")).toBe("major");
  });
});

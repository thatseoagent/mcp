import { describe, it, expect } from "vitest";
import {
  isRecord,
  isString,
  isNumber,
  isBoolean,
  isArray,
  isArrayOf,
  isJsonValue,
  isApiError,
  assertDefined,
  assertString,
  assertRecord,
  assertArray,
  assertNumber,
  success,
  failure,
  unwrap,
  mapResult,
  flatMapResult,
} from "@/lib/type-guards";

// ── isRecord ──────────────────────────────────────────────────────────────

describe("isRecord", () => {
  it("returns true for plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("returns false for arrays", () => {
    expect(isRecord([])).toBe(false);
  });

  it("returns false for null", () => {
    expect(isRecord(null)).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isRecord("string")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });
});

// ── isString ─────────────────────────────────────────────────────────────

describe("isString", () => {
  it("returns true for strings", () => {
    expect(isString("")).toBe(true);
    expect(isString("hello")).toBe(true);
  });

  it("returns false for non-strings", () => {
    expect(isString(42)).toBe(false);
    expect(isString(null)).toBe(false);
    expect(isString(undefined)).toBe(false);
  });
});

// ── isNumber ─────────────────────────────────────────────────────────────

describe("isNumber", () => {
  it("returns true for finite numbers", () => {
    expect(isNumber(0)).toBe(true);
    expect(isNumber(42)).toBe(true);
    expect(isNumber(-1.5)).toBe(true);
  });

  it("returns false for NaN", () => {
    expect(isNumber(NaN)).toBe(false);
  });

  it("returns false for non-numbers", () => {
    expect(isNumber("42")).toBe(false);
    expect(isNumber(null)).toBe(false);
  });
});

// ── isBoolean ────────────────────────────────────────────────────────────

describe("isBoolean", () => {
  it("returns true for booleans", () => {
    expect(isBoolean(true)).toBe(true);
    expect(isBoolean(false)).toBe(true);
  });

  it("returns false for non-booleans", () => {
    expect(isBoolean(1)).toBe(false);
    expect(isBoolean("true")).toBe(false);
  });
});

// ── isArray / isArrayOf ───────────────────────────────────────────────────

describe("isArray", () => {
  it("returns true for arrays", () => {
    expect(isArray([])).toBe(true);
    expect(isArray([1, 2, 3])).toBe(true);
  });

  it("returns false for non-arrays", () => {
    expect(isArray({})).toBe(false);
    expect(isArray("abc")).toBe(false);
  });
});

describe("isArrayOf", () => {
  it("returns true when all elements pass the guard", () => {
    expect(isArrayOf([1, 2, 3], isNumber)).toBe(true);
    expect(isArrayOf(["a", "b"], isString)).toBe(true);
  });

  it("returns false when any element fails the guard", () => {
    expect(isArrayOf([1, "two", 3], isNumber)).toBe(false);
  });

  it("returns true for an empty array", () => {
    expect(isArrayOf([], isNumber)).toBe(true);
  });
});

// ── isJsonValue ───────────────────────────────────────────────────────────

describe("isJsonValue", () => {
  it("accepts primitives and null", () => {
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue("str")).toBe(true);
    expect(isJsonValue(42)).toBe(true);
    expect(isJsonValue(true)).toBe(true);
  });

  it("accepts nested arrays and objects", () => {
    expect(isJsonValue({ a: [1, "two", null] })).toBe(true);
  });

  it("rejects undefined", () => {
    expect(isJsonValue(undefined)).toBe(false);
  });

  it("rejects NaN", () => {
    expect(isJsonValue(NaN)).toBe(false);
  });
});

// ── isApiError ────────────────────────────────────────────────────────────

describe("isApiError", () => {
  it("returns true for objects with code, message, or details", () => {
    expect(isApiError({ code: 404 })).toBe(true);
    expect(isApiError({ message: "not found" })).toBe(true);
    expect(isApiError({ details: [] })).toBe(true);
  });

  it("returns false for non-objects", () => {
    expect(isApiError("error string")).toBe(false);
    expect(isApiError(null)).toBe(false);
  });
});

// ── assertDefined ─────────────────────────────────────────────────────────

describe("assertDefined", () => {
  it("does not throw for defined values", () => {
    expect(() => assertDefined(0)).not.toThrow();
    expect(() => assertDefined("")).not.toThrow();
    expect(() => assertDefined(false)).not.toThrow();
  });

  it("throws for null", () => {
    expect(() => assertDefined(null)).toThrow();
  });

  it("throws for undefined", () => {
    expect(() => assertDefined(undefined)).toThrow();
  });

  it("uses the custom message when provided", () => {
    expect(() => assertDefined(null, "custom msg")).toThrow("custom msg");
  });
});

// ── assertString / assertRecord / assertArray / assertNumber ─────────────

describe("assertString", () => {
  it("does not throw for strings", () => {
    expect(() => assertString("hello")).not.toThrow();
  });

  it("throws for non-strings", () => {
    expect(() => assertString(42)).toThrow();
  });
});

describe("assertRecord", () => {
  it("does not throw for plain objects", () => {
    expect(() => assertRecord({})).not.toThrow();
  });

  it("throws for arrays and primitives", () => {
    expect(() => assertRecord([])).toThrow();
    expect(() => assertRecord("str")).toThrow();
  });
});

describe("assertArray", () => {
  it("does not throw for arrays", () => {
    expect(() => assertArray([])).not.toThrow();
  });

  it("throws for non-arrays", () => {
    expect(() => assertArray({})).toThrow();
  });
});

describe("assertNumber", () => {
  it("does not throw for numbers", () => {
    expect(() => assertNumber(42)).not.toThrow();
  });

  it("throws for NaN and non-numbers", () => {
    expect(() => assertNumber(NaN)).toThrow();
    expect(() => assertNumber("42")).toThrow();
  });
});

// ── Result combinators ────────────────────────────────────────────────────

describe("success / failure", () => {
  it("success() creates a successful Result", () => {
    const r = success(42);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe(42);
  });

  it("failure() creates a failed Result", () => {
    const r = failure(new Error("oops"));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toBe("oops");
  });
});

describe("unwrap", () => {
  it("returns the data from a successful Result", () => {
    expect(unwrap(success(99))).toBe(99);
  });

  it("throws the error from a failed Result", () => {
    expect(() => unwrap(failure(new Error("fail")))).toThrow("fail");
  });
});

describe("mapResult", () => {
  it("transforms data on success", () => {
    const r = mapResult(success(5), (x) => x * 2);
    expect(r).toEqual({ success: true, data: 10 });
  });

  it("passes error through unchanged on failure", () => {
    const err = failure(new Error("e"));
    const r = mapResult(err, (x: number) => x * 2);
    expect(r.success).toBe(false);
  });
});

describe("flatMapResult", () => {
  it("chains successful Results", () => {
    const r = flatMapResult(success(10), (x) =>
      x > 0 ? success(x / 2) : failure(new Error("neg"))
    );
    expect(r).toEqual({ success: true, data: 5 });
  });

  it("short-circuits on failure — second fn is never called", () => {
    let called = false;
    flatMapResult(failure(new Error("e")), (x: number) => {
      called = true;
      return success(x);
    });
    expect(called).toBe(false);
  });

  it("propagates inner failure", () => {
    const r = flatMapResult(success(-1), (x) =>
      x > 0 ? success(x) : failure(new Error("negative"))
    );
    expect(r.success).toBe(false);
  });
});

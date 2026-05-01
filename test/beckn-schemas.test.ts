/**
 * FN-087 — Beckn v2.0 LTS schema validation tests.
 *
 * Covers:
 *  - Valid search request passes
 *  - Missing context.bap_id fails with correct path
 *  - Invalid version (not "2.0.0") fails
 *  - Each of the 4 main actions (search, select, init, confirm) has at
 *    least one positive + one negative test
 *  - Callback actions (on_search, on_select, on_init, on_confirm) positive
 *    + negative
 *  - Stub actions return wired-error result
 */

import { describe, expect, it } from "vitest";
import {
  validateBecknRequest,
  type BecknAction,
  type ValidationResult,
} from "../src/gateway/beckn-schemas.js";

// ---------- Helpers ----------

function baseContext(action: BecknAction, overrides: Record<string, unknown> = {}) {
  return {
    domain: "retail",
    action,
    version: "2.0.0",
    bap_id: "bap.example.com",
    bap_uri: "https://bap.example.com/beckn",
    transaction_id: "550e8400-e29b-41d4-a716-446655440000",
    message_id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    timestamp: "2026-04-30T00:00:00.000Z",
    ...overrides,
  };
}

function assertOk(result: ValidationResult) {
  if (!result.ok) {
    throw new Error(`Expected ok, got errors: ${JSON.stringify(result.errors)}`);
  }
}

function assertFail(result: ValidationResult, pathOrFieldFragment?: string, reasonFragment?: string) {
  if (result.ok) {
    throw new Error("Expected validation failure but got ok");
  }
  // AJV puts "required" errors on the parent path, with the missing property name
  // embedded in the reason string ("must have required property 'field'").
  // For "minLength", "const", "format" etc., the field name appears in the path.
  // We check both path and reason so tests work across all error kinds.
  if (pathOrFieldFragment !== undefined) {
    const found = result.errors.some(
      (e) => e.path.includes(pathOrFieldFragment) || e.reason.includes(pathOrFieldFragment),
    );
    if (!found) {
      throw new Error(
        `Expected error referencing "${pathOrFieldFragment}", got: ${JSON.stringify(result.errors)}`,
      );
    }
  }
  if (reasonFragment !== undefined) {
    const found = result.errors.some((e) => e.reason.includes(reasonFragment));
    if (!found) {
      throw new Error(
        `Expected error with reason containing "${reasonFragment}", got: ${JSON.stringify(result.errors)}`,
      );
    }
  }
}

// ---------- Context-level tests ----------

describe("context envelope validation", () => {
  it("rejects missing bap_id with path /context/bap_id", () => {
    const ctx = baseContext("search");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { bap_id: _removed, ...ctxWithout } = ctx as any;
    const body = {
      context: ctxWithout,
      message: { intent: {} },
    };
    const result = validateBecknRequest("search", body);
    assertFail(result, "bap_id");
  });

  it("rejects version != '2.0.0'", () => {
    const body = {
      context: baseContext("search", { version: "1.0.0" }),
      message: { intent: {} },
    };
    const result = validateBecknRequest("search", body);
    assertFail(result, "version");
  });

  it("rejects invalid bap_uri (not a URI)", () => {
    const body = {
      context: baseContext("search", { bap_uri: "not-a-uri" }),
      message: { intent: {} },
    };
    const result = validateBecknRequest("search", body);
    assertFail(result, "bap_uri");
  });

  it("rejects invalid transaction_id (not a UUID)", () => {
    const body = {
      context: baseContext("search", { transaction_id: "not-a-uuid" }),
      message: { intent: {} },
    };
    const result = validateBecknRequest("search", body);
    assertFail(result, "transaction_id");
  });

  it("rejects invalid timestamp (not date-time)", () => {
    const body = {
      context: baseContext("search", { timestamp: "not-a-date" }),
      message: { intent: {} },
    };
    const result = validateBecknRequest("search", body);
    assertFail(result, "timestamp");
  });
});

// ---------- /search ----------

describe("search", () => {
  it("valid search with minimal intent passes", () => {
    const body = {
      context: baseContext("search"),
      message: { intent: {} },
    };
    assertOk(validateBecknRequest("search", body));
  });

  it("valid search with full intent passes", () => {
    const body = {
      context: baseContext("search"),
      message: {
        intent: {
          item: { descriptor: { name: "laptop" } },
          provider: { descriptor: { name: "tech shop" } },
          fulfillment: { type: "Delivery" },
          payment: { type: "PRE-FULFILLMENT" },
        },
      },
    };
    assertOk(validateBecknRequest("search", body));
  });

  it("rejects search missing message.intent", () => {
    const body = {
      context: baseContext("search"),
      message: {},
    };
    const result = validateBecknRequest("search", body);
    assertFail(result, "message", "required");
  });

  it("rejects search with missing context.domain", () => {
    const ctx = baseContext("search");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { domain: _removed, ...ctxWithout } = ctx as any;
    const body = { context: ctxWithout, message: { intent: {} } };
    assertFail(validateBecknRequest("search", body), "domain");
  });
});

// ---------- /select ----------

describe("select", () => {
  const validSelectBody = {
    context: baseContext("select"),
    message: {
      order: {
        provider: { id: "prov-001" },
        items: [{ id: "item-001", quantity: { selected: { count: 2 } } }],
      },
    },
  };

  it("valid select passes", () => {
    assertOk(validateBecknRequest("select", validSelectBody));
  });

  it("rejects select missing message.order.items", () => {
    const body = {
      context: baseContext("select"),
      message: { order: { provider: { id: "prov-001" } } },
    };
    assertFail(validateBecknRequest("select", body), "items", "required");
  });

  it("rejects select with empty items array", () => {
    const body = {
      context: baseContext("select"),
      message: { order: { provider: { id: "prov-001" }, items: [] } },
    };
    assertFail(validateBecknRequest("select", body), "items");
  });

  it("rejects select missing message.order.provider", () => {
    const body = {
      context: baseContext("select"),
      message: { order: { items: [{ id: "item-001" }] } },
    };
    assertFail(validateBecknRequest("select", body), "provider", "required");
  });
});

// ---------- /init ----------

describe("init", () => {
  const validInitBody = {
    context: baseContext("init"),
    message: {
      order: {
        provider: { id: "prov-001" },
        items: [{ id: "item-001" }],
        billing: { name: "Alice" },
        fulfillments: [{ id: "ff-001", type: "Delivery" }],
      },
    },
  };

  it("valid init passes", () => {
    assertOk(validateBecknRequest("init", validInitBody));
  });

  it("rejects init missing billing", () => {
    const { order } = validInitBody.message;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { billing: _removed, ...orderWithout } = order as any;
    const body = { context: baseContext("init"), message: { order: orderWithout } };
    assertFail(validateBecknRequest("init", body), "billing", "required");
  });

  it("rejects init missing fulfillments", () => {
    const { order } = validInitBody.message;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { fulfillments: _removed, ...orderWithout } = order as any;
    const body = { context: baseContext("init"), message: { order: orderWithout } };
    assertFail(validateBecknRequest("init", body), "fulfillments", "required");
  });

  it("rejects init with billing missing name", () => {
    const body = {
      context: baseContext("init"),
      message: {
        order: {
          provider: { id: "prov-001" },
          items: [{ id: "item-001" }],
          billing: { email: "alice@example.com" },
          fulfillments: [{ id: "ff-001" }],
        },
      },
    };
    assertFail(validateBecknRequest("init", body), "billing", "required");
  });
});

// ---------- /confirm ----------

describe("confirm", () => {
  const validConfirmBody = {
    context: baseContext("confirm"),
    message: {
      order: {
        id: "order-abc-123",
        state: "Created",
        provider: { id: "prov-001" },
        items: [{ id: "item-001" }],
      },
    },
  };

  it("valid confirm passes", () => {
    assertOk(validateBecknRequest("confirm", validConfirmBody));
  });

  it("rejects confirm missing order.id", () => {
    const { order } = validConfirmBody.message;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { id: _removed, ...orderWithout } = order as any;
    const body = { context: baseContext("confirm"), message: { order: orderWithout } };
    assertFail(validateBecknRequest("confirm", body), "id", "required");
  });

  it("rejects confirm missing order.state", () => {
    const { order } = validConfirmBody.message;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { state: _removed, ...orderWithout } = order as any;
    const body = { context: baseContext("confirm"), message: { order: orderWithout } };
    assertFail(validateBecknRequest("confirm", body), "state", "required");
  });
});

// ---------- Callback actions ----------

describe("on_search", () => {
  const validOnSearchBody = {
    context: baseContext("on_search"),
    message: {
      catalog: {
        providers: [
          {
            id: "prov-001",
            descriptor: { name: "Tech Store" },
            items: [{ id: "item-001" }],
          },
        ],
      },
    },
  };

  it("valid on_search passes", () => {
    assertOk(validateBecknRequest("on_search", validOnSearchBody));
  });

  it("rejects on_search missing catalog.providers", () => {
    const body = {
      context: baseContext("on_search"),
      message: { catalog: {} },
    };
    assertFail(validateBecknRequest("on_search", body), "providers", "required");
  });
});

describe("on_select", () => {
  const validOnSelectBody = {
    context: baseContext("on_select"),
    message: {
      order: {
        provider: { id: "prov-001" },
        items: [{ id: "item-001" }],
        quote: { price: { currency: "INR", value: "1000" } },
      },
    },
  };

  it("valid on_select passes", () => {
    assertOk(validateBecknRequest("on_select", validOnSelectBody));
  });

  it("rejects on_select missing order.items", () => {
    const body = {
      context: baseContext("on_select"),
      message: { order: { provider: { id: "prov-001" } } },
    };
    assertFail(validateBecknRequest("on_select", body), "items", "required");
  });
});

describe("on_init", () => {
  const validOnInitBody = {
    context: baseContext("on_init"),
    message: {
      order: {
        provider: { id: "prov-001" },
        items: [{ id: "item-001" }],
        billing: { name: "Alice" },
        fulfillments: [{ id: "ff-001" }],
        payments: [{ type: "PRE-FULFILLMENT", status: "NOT-PAID" }],
      },
    },
  };

  it("valid on_init passes", () => {
    assertOk(validateBecknRequest("on_init", validOnInitBody));
  });

  it("rejects on_init missing billing", () => {
    const { order } = validOnInitBody.message;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { billing: _removed, ...orderWithout } = order as any;
    const body = { context: baseContext("on_init"), message: { order: orderWithout } };
    assertFail(validateBecknRequest("on_init", body), "billing", "required");
  });
});

describe("on_confirm", () => {
  const validOnConfirmBody = {
    context: baseContext("on_confirm"),
    message: {
      order: {
        id: "order-abc-123",
        state: "Accepted",
        provider: { id: "prov-001" },
        items: [{ id: "item-001" }],
      },
    },
  };

  it("valid on_confirm passes", () => {
    assertOk(validateBecknRequest("on_confirm", validOnConfirmBody));
  });

  it("rejects on_confirm missing order.id", () => {
    const { order } = validOnConfirmBody.message;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { id: _removed, ...orderWithout } = order as any;
    const body = { context: baseContext("on_confirm"), message: { order: orderWithout } };
    assertFail(validateBecknRequest("on_confirm", body), "id", "required");
  });
});

// ---------- Stub / unwired actions ----------

describe("stub actions", () => {
  for (const action of ["status", "cancel", "rating", "support",
    "on_status", "on_cancel", "on_rating", "on_support"] as const) {
    it(`${action} returns not-yet-wired error`, () => {
      const result = validateBecknRequest(action, { context: baseContext(action), message: {} });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.reason).toContain("FN-087");
      }
    });
  }
});
